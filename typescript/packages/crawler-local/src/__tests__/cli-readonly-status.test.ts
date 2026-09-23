import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { currentSource } from "@saqi/source-adapter";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
} from "../persistence/migrations.js";
import { trackedMkdtempSync as mkdtempSync } from "./support/tracked-test-root.js";

const CLI = resolve(import.meta.dirname, "../cli.ts");

function status(root: string, source = currentSource()): unknown {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", CLI, "status", "--state-dir", root],
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
}

function fixture(version: number) {
  const root = mkdtempSync(join(tmpdir(), "saqi-status-readonly-"));
  const path = join(root, "ledger.sqlite3");
  const database = new Database(path);
  database.exec(
    "CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY,version INTEGER); INSERT INTO local_schema VALUES(1,0)",
  );
  for (const migration of MIGRATIONS) {
    if (migration.version > version) continue;
    database.exec(migration.statements);
    database
      .prepare("UPDATE local_schema SET version=? WHERE singleton=1")
      .run(migration.version);
  }
  const source = currentSource();
  database
    .prepare("INSERT INTO local_source_identity VALUES(1,?,?)")
    .run(source.name, source.origin);
  database.exec(
    "INSERT INTO runtime_control VALUES('global_paused',1),('paid_work_paused',1),('legacy_pause_imported',1); INSERT INTO sol_paid_usage_budget VALUES('fixture-exhausted',3,3,'exhausted',1,1)",
  );
  database.close();
  return { root, path };
}

it.each([30, 33, CURRENT_SCHEMA_VERSION])(
  "status inspects schema%s without migration, budget or control changes",
  (version) => {
    const f = fixture(version);
    const before = readFileSync(f.path);
    expect(status(f.root)).toMatchObject({
      command: "status",
      paused: true,
      paidWorkPaused: true,
      runtimeOwnerIssue:
        version === CURRENT_SCHEMA_VERSION
          ? null
          : "RUNTIME_OWNER_AUTHORITY_UNAVAILABLE",
    });
    expect(readFileSync(f.path)).toEqual(before);
    const database = new Database(f.path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        database.prepare("SELECT version FROM local_schema").get(),
      ).toEqual({ version });
      expect(
        database
          .prepare(
            "SELECT state,reserved_operations FROM sol_paid_usage_budget",
          )
          .get(),
      ).toEqual({ state: "exhausted", reserved_operations: 3 });
    } finally {
      database.close();
    }
  },
);

it("source mismatch cannot migrate the inspected older ledger", () => {
  const f = fixture(33);
  const before = readFileSync(f.path);
  expect(() =>
    status(f.root, {
      name: "different-source",
      origin: "https://different.example",
    }),
  ).toThrow("LOCAL_SOURCE_IDENTITY_MISMATCH");
  expect(readFileSync(f.path)).toEqual(before);
});

it("missing legacy controls fail without importing pause files", () => {
  const f = fixture(30);
  const db = new Database(f.path);
  db.exec("DELETE FROM runtime_control");
  db.close();
  writeFileSync(join(f.root, "PAUSED"), "retained");
  const before = readFileSync(f.path);
  expect(() => status(f.root)).toThrow("readonly");
  expect(readFileSync(f.path)).toEqual(before);
  expect(readFileSync(join(f.root, "PAUSED"), "utf8")).toBe("retained");
});

it("status never creates a missing ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "saqi-status-missing-"));
  expect(() => status(root)).toThrow("Ledger does not exist");
  expect(existsSync(join(root, "ledger.sqlite3"))).toBe(false);
});
