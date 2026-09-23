import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

import { MIGRATIONS } from "../persistence/migrations.js";
import { stageLegacyOperationSchema34 } from "../persistence/stage-legacy-operation-schema34.js";
import { currentSource } from "../source-adapter/index.js";
import { trackedMkdtempSync as mkdtempSync } from "./support/tracked-test-root.js";

function fixture(version = 33, sourceMismatch = false) {
  const root = mkdtempSync(join(tmpdir(), "saqi-schema34-stage-"));
  const file = join(root, "ledger.sqlite3");
  const database = new Database(file);
  database.exec(
    "CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT; INSERT INTO local_schema VALUES(1,0)",
  );
  for (const migration of MIGRATIONS) {
    if (migration.version > version) continue;
    database.exec(migration.statements);
    database
      .prepare("UPDATE local_schema SET version=?")
      .run(migration.version);
  }
  const source = currentSource();
  database
    .prepare("INSERT INTO local_source_identity VALUES(1,?,?)")
    .run(sourceMismatch ? "unexpected" : source.name, source.origin);
  if (version >= 30)
    database.exec(`INSERT INTO runtime_control VALUES
    ('global_paused',1),('paid_work_paused',1),('service_enabled',0),
    ('legacy_pause_imported',1),('legacy_service_imported',1)`);
  database.exec(
    "INSERT INTO sol_paid_usage_budget VALUES('closed-fixture',3,3,'exhausted',1,1)",
  );
  database
    .prepare(
      `INSERT INTO work_item(work_key,kind,input_json,input_hash,schema_version,
    implementation_version,available_at,created_at,updated_at) VALUES(?, 'poem-enrichment-sol','{}',?,'fixture','fixture',1,1,1)`,
    )
    .run("a".repeat(64), "b".repeat(64));
  database
    .prepare(
      "INSERT INTO sol_paid_usage_reservation VALUES('closed-fixture','retained-attempt',?,3,1)",
    )
    .run("a".repeat(64));
  database.close();
  return { root, file };
}

test.each([30, 31, 32, 33, 34])(
  "genuine offline schema %i staging is read-only by default and ends exactly at34",
  async (version) => {
    const { root, file } = fixture(version);
    const before = readFileSync(file);
    await expect(
      stageLegacyOperationSchema34({ stateDirectory: root }),
    ).resolves.toEqual({
      mode: "dry_run",
      fromVersion: version,
      targetVersion: 34,
    });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(join(root, "RUN.lock"))).toBe(false);
    await expect(
      stageLegacyOperationSchema34({ stateDirectory: root, apply: true }),
    ).resolves.toEqual({
      mode: "applied",
      fromVersion: version,
      targetVersion: 34,
    });
    const database = new Database(file, { readonly: true });
    try {
      expect(
        database.prepare("SELECT version FROM local_schema").get(),
      ).toEqual({ version: 34 });
      expect(
        database.prepare("SELECT * FROM sol_paid_usage_budget").all(),
      ).toEqual([
        {
          budget_id: "closed-fixture",
          maximum_operations: 3,
          reserved_operations: 3,
          state: "exhausted",
          created_at: 1,
          updated_at: 1,
        },
      ]);
      expect(
        database.prepare("SELECT * FROM sol_paid_usage_reservation").all(),
      ).toEqual([
        {
          budget_id: "closed-fixture",
          attempt_id: "retained-attempt",
          work_key: "a".repeat(64),
          reserved_operations: 3,
          created_at: 1,
        },
      ]);
      expect(
        database
          .prepare(
            "SELECT * FROM runtime_control WHERE control_key='sol_operation_import_complete'",
          )
          .all(),
      ).toEqual([]);
      expect(
        database.prepare("SELECT * FROM sol_operation_import_receipt").all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
    expect(existsSync(join(root, "RUN.lock"))).toBe(false);
  },
);

test.each([
  "service",
  "pause",
  "source",
  "run-lock",
  "legacy-lock",
  "pre30",
  "ddl-failure",
  "running",
  "symlink",
])("staging refuses %s without schema/data mutation", async (failure) => {
  const { root, file } = fixture(
    failure === "pre30" ? 29 : 30,
    failure === "source",
  );
  const database = new Database(file);
  if (failure === "service")
    database.exec(
      "UPDATE runtime_control SET enabled=1 WHERE control_key='service_enabled'",
    );
  if (failure === "pause")
    database.exec(
      "DELETE FROM runtime_control WHERE control_key='legacy_pause_imported'",
    );
  if (failure === "ddl-failure")
    database.exec("CREATE TABLE sol_operation(blocker TEXT)");
  if (failure === "running")
    database.exec(
      "UPDATE work_item SET state='running',lease_owner='old',lease_token='old',lease_expires_at=999999",
    );
  database.close();
  if (failure === "symlink") {
    renameSync(file, `${file}.external`);
    symlinkSync(`${file}.external`, file);
  }
  if (failure === "run-lock")
    writeFileSync(join(root, "RUN.lock"), "do-not-clear");
  if (failure === "legacy-lock") {
    mkdirSync(join(root, "sol-attempts/operation-index"), { recursive: true });
    writeFileSync(
      join(root, "sol-attempts/operation-index/operation.lock"),
      "do-not-clear",
    );
  }
  const before = readFileSync(file);
  await expect(
    stageLegacyOperationSchema34({ stateDirectory: root, apply: true }),
  ).rejects.toThrow();
  expect(readFileSync(file).equals(before)).toBe(true);
  expect(existsSync(join(root, "RUN.lock"))).toBe(failure === "run-lock");
});

test("explicit CLI stages34 while default CLI remains read-only", async () => {
  const { root, file } = fixture(33);
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      stateDirectory: root,
      collector: { enabled: false },
      sol: { enabled: true },
    }),
  );
  const source = currentSource();
  const run = (args: string[]): unknown =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(import.meta.dirname, "../cli.ts"),
          "stage-sol-operation-import",
          "--config",
          config,
          ...args,
        ],
        {
          encoding: "utf8",
          stdio: "pipe",
          env: {
            ...process.env,
            SAQI_SOURCE_NAME: source.name,
            SAQI_SOURCE_BASE_URL: source.origin,
          },
        },
      ),
    );
  const before = readFileSync(file);
  expect(run([])).toMatchObject({
    command: "stage-sol-operation-import",
    result: { mode: "dry_run", fromVersion: 33, targetVersion: 34 },
  });
  expect(readFileSync(file).equals(before)).toBe(true);
  expect(run(["--apply"])).toMatchObject({
    result: { mode: "applied", fromVersion: 33, targetVersion: 34 },
  });
  await expect(
    stageLegacyOperationSchema34({ stateDirectory: root, apply: true }),
  ).resolves.toMatchObject({ fromVersion: 34, targetVersion: 34 });
});

test("staging never creates a missing ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "saqi-stage-missing-"));
  await expect(
    stageLegacyOperationSchema34({ stateDirectory: root, apply: true }),
  ).rejects.toThrow();
  expect(existsSync(join(root, "ledger.sqlite3"))).toBe(false);
  expect(existsSync(join(root, "RUN.lock"))).toBe(false);
});
