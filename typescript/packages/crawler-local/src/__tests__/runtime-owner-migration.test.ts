import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  LedgerMigrationEngine,
  LedgerMigrator,
  MIGRATIONS,
} from "../persistence/migrations.js";
import { RuntimeOwnerStore } from "../persistence/runtime-owner-store.js";
import { importLegacySolOperations } from "../persistence/sol-operation-import.js";
import { stageLegacyOperationSchema34 } from "../persistence/stage-legacy-operation-schema34.js";
import { readRunLock } from "../runtime/run-lock.js";
import { configureSource, currentSource } from "../source-adapter/index.js";
import { initializeLegacyLedgerSchema } from "./support/legacy-ledger-schema.js";
import { trackedMkdtempSync } from "./support/tracked-test-root.js";

test("a fresh ledger opener accepts a schema initialized after its first inspection", () => {
  const root = trackedMkdtempSync(
    join(tmpdir(), "runtime-owner-bootstrap-race-"),
  );
  const path = join(root, "ledger.sqlite3");
  const winner = new Database(path);
  const follower = new Database(path);
  const schemaQuery =
    "SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'";
  const prepare = follower.prepare.bind(follower);
  let injected = false;
  const prepareSpy = vi.spyOn(follower, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql !== schemaQuery || injected) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all")
          return () => {
            const observed = target.all();
            injected = true;
            new LedgerMigrator(winner).migrate();
            return observed;
          };
        const value: unknown = Reflect.get(target, property);
        return value;
      },
    });
  });
  try {
    expect(new LedgerMigrator(follower).migrate()).toBe(CURRENT_SCHEMA_VERSION);
    expect(injected).toBe(true);
    expect(follower.prepare("SELECT version FROM local_schema").get()).toEqual({
      version: CURRENT_SCHEMA_VERSION,
    });
  } finally {
    prepareSpy.mockRestore();
    follower.close();
    winner.close();
  }
});

function fixture(
  run: (database: Database.Database, root: string) => void,
  receipt = "valid",
): void {
  const root = trackedMkdtempSync(join(tmpdir(), "runtime-owner-migration-"));
  const database = new Database(join(root, "ledger.sqlite3"));
  try {
    initializeLegacyLedgerSchema(database, 34);
    database.exec(
      "INSERT INTO runtime_control VALUES('service_enabled',0),('global_paused',1),('paid_work_paused',1),('legacy_pause_imported',1),('legacy_service_imported',1),('sol_operation_import_complete',1)",
    );
    if (receipt !== "missing-receipt") {
      if (receipt === "invalid-receipt")
        database.pragma("ignore_check_constraints=ON");
      database
        .prepare("INSERT INTO sol_operation_import_receipt VALUES(1,?,0,0,1)")
        .run(receipt === "invalid-receipt" ? "invalid" : "a".repeat(64));
      database.pragma("ignore_check_constraints=OFF");
    }
    run(database, root);
  } finally {
    database.close();
  }
}

test("stopped imported schema34 upgrades to empty owner35 without changing controls or paid state", () =>
  fixture((database) => {
    database
      .prepare(
        "INSERT INTO work_item(work_key,kind,input_json,input_hash,schema_version,implementation_version,priority,state,available_at,created_at,updated_at) VALUES(?,'author-manifest','{}',?,'fixture-v1','fixture-v1',0,'pending',0,0,0)",
      )
      .run("b".repeat(64), "c".repeat(64));
    database.exec(
      "INSERT INTO sol_paid_usage_budget VALUES('retained-exhausted',3,3,'exhausted',1,2)",
    );
    database
      .prepare(
        "INSERT INTO sol_paid_usage_reservation VALUES('retained-exhausted','retained-attempt',?,3,2)",
      )
      .run("b".repeat(64));
    const budgets = database
      .prepare("SELECT * FROM sol_paid_usage_budget")
      .all();
    const reservations = database
      .prepare("SELECT * FROM sol_paid_usage_reservation")
      .all();
    const controls = database
      .prepare("SELECT * FROM runtime_control ORDER BY control_key")
      .all();
    expect(new LedgerMigrator(database).migrate()).toBe(CURRENT_SCHEMA_VERSION);
    expect(new RuntimeOwnerStore(database).read()).toBeNull();
    expect(
      database
        .prepare("SELECT * FROM runtime_control ORDER BY control_key")
        .all(),
    ).toEqual(controls);
    expect(
      database.prepare("SELECT * FROM sol_paid_usage_budget").all(),
    ).toEqual(budgets);
    expect(
      database.prepare("SELECT * FROM sol_paid_usage_reservation").all(),
    ).toEqual(reservations);
  }));

test.each([
  "service_enabled",
  "global_paused",
  "paid_work_paused",
  "missing-receipt-marker",
  "missing-receipt",
  "invalid-receipt",
  "running-sol",
  "legacy-owner",
])("schema34 migration rejects %s without advancing authority", (kind) =>
  fixture((database, root) => {
    switch (kind) {
      case "legacy-owner": {
        writeFileSync(join(root, "RUN.lock"), "retained unverified owner");
        break;
      }
      case "missing-receipt-marker": {
        database.exec(
          "DELETE FROM runtime_control WHERE control_key='sol_operation_import_complete'",
        );
        break;
      }
      case "running-sol": {
        database
          .prepare(
            "INSERT INTO work_item(work_key,kind,input_json,input_hash,schema_version,implementation_version,priority,state,available_at,lease_owner,lease_token,lease_epoch,lease_expires_at,created_at,updated_at) VALUES(?,'poem-enrichment-sol','{}',?,'fixture-v1','fixture-v1',0,'running',0,'standalone-fixture','lease-fixture',1,1,0,0)",
          )
          .run("d".repeat(64), "e".repeat(64));
        break;
      }
      default:
        if (kind !== "missing-receipt" && kind !== "invalid-receipt")
          database
            .prepare("UPDATE runtime_control SET enabled=? WHERE control_key=?")
            .run(kind === "service_enabled" ? 1 : 0, kind);
    }
    const before = database
      .prepare("SELECT * FROM runtime_control ORDER BY control_key")
      .all();
    expect(() => new LedgerMigrator(database).migrate()).toThrow();
    expect(database.prepare("SELECT version FROM local_schema").get()).toEqual({
      version: 34,
    });
    expect(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE name='runtime_owner'")
        .all(),
    ).toEqual([]);
    expect(
      database
        .prepare("SELECT * FROM runtime_control ORDER BY control_key")
        .all(),
    ).toEqual(before);
    if (kind === "legacy-owner")
      expect(existsSync(join(root, "RUN.lock"))).toBe(true);
  }, kind),
);

test("fresh schema0 initializes owner35 without imported control prerequisites", () => {
  const database = new Database(":memory:");
  try {
    expect(new LedgerMigrator(database).migrate()).toBe(CURRENT_SCHEMA_VERSION);
    expect(new RuntimeOwnerStore(database).read()).toBeNull();
  } finally {
    database.close();
  }
});

test("schema34 source mismatch refuses before owner DDL and preserves its source identity", () =>
  fixture((database) => {
    const source = currentSource();
    const before = database
      .prepare("SELECT * FROM local_source_identity")
      .all();
    try {
      configureSource({ ...source, name: "owner-migration-wrong-source" });
      expect(() => new LedgerMigrator(database).migrate()).toThrow(
        "LOCAL_SOURCE_IDENTITY_MISMATCH",
      );
      expect(
        database.prepare("SELECT version FROM local_schema").get(),
      ).toEqual({ version: 34 });
      expect(
        database.prepare("SELECT * FROM local_source_identity").all(),
      ).toEqual(before);
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name='runtime_owner'")
          .all(),
      ).toEqual([]);
    } finally {
      configureSource(source);
    }
  }));

test("internal engine cannot execute DDL without a caller-owned transaction", () => {
  const database = new Database(":memory:");
  try {
    const migration = MIGRATIONS[0];
    if (migration === undefined) throw new Error("Expected first migration");
    expect(() => new LedgerMigrationEngine(database).apply(migration)).toThrow(
      "MIGRATION_ENGINE_REQUIRES_TRANSACTION",
    );
    expect(database.prepare("SELECT name FROM sqlite_schema").all()).toEqual(
      [],
    );
  } finally {
    database.close();
  }
});

test("fresh bootstrap failure rolls back every earlier schema and can retry", () => {
  const database = new Database(":memory:");
  try {
    const execute = database.exec.bind(database);
    const fault = new Error("injected mid-bootstrap failure");
    const spy = vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql.includes("CREATE TABLE work_event")) throw fault;
      return execute(sql);
    });
    expect(() => new LedgerMigrator(database).migrate()).toThrow(fault);
    spy.mockRestore();
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
        )
        .all(),
    ).toEqual([]);
    expect(new LedgerMigrator(database).migrate()).toBe(CURRENT_SCHEMA_VERSION);
    expect(new RuntimeOwnerStore(database).read()).toBeNull();
  } finally {
    database.close();
  }
});

test("read-only missing authority never creates a ledger", async () => {
  const root = trackedMkdtempSync(join(tmpdir(), "runtime-owner-readonly-"));
  await expect(readRunLock(join(root, "RUN.lock"))).rejects.toThrow();
  expect(existsSync(join(root, "ledger.sqlite3"))).toBe(false);
});

test("active schema33 cannot partially advance to34 before the owner cutover guard", () => {
  const statements: string[] = [];
  const database = new Database(":memory:", {
    verbose: (statement) => {
      statements.push(String(statement));
    },
  });
  try {
    initializeLegacyLedgerSchema(database, 33);
    database.exec("INSERT INTO runtime_control VALUES('service_enabled',1)");
    const before = database
      .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
      .all();
    statements.length = 0;
    expect(() => new LedgerMigrator(database).migrate()).toThrow(
      "RUNTIME_OWNER_REQUIRES_STAGED_SCHEMA34_IMPORT",
    );
    expect(
      statements.every((statement) => statement.startsWith("SELECT ")),
    ).toBe(true);
    expect(database.prepare("SELECT version FROM local_schema").get()).toEqual({
      version: 33,
    });
    expect(
      database
        .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
        .all(),
    ).toEqual(before);
    expect(database.prepare("SELECT * FROM runtime_control").all()).toEqual([
      { control_key: "service_enabled", enabled: 1 },
    ]);
  } finally {
    database.close();
  }
});

test.each(["unversioned", "sqlite-prefix", "rewound-zero"])(
  "%s existing database is not treated as a fresh bootstrap",
  (kind) => {
    const statements: string[] = [];
    const database = new Database(":memory:", {
      verbose: (statement) => {
        statements.push(String(statement));
      },
    });
    try {
      if (kind === "unversioned")
        database.exec("CREATE TABLE unrelated(value TEXT)");
      else if (kind === "sqlite-prefix")
        database.exec("CREATE TABLE sqlitex(value TEXT)");
      else
        database.exec(
          "CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY, version INTEGER); INSERT INTO local_schema VALUES(1,0)",
        );
      const before = database
        .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
        .all();
      statements.length = 0;
      expect(() => new LedgerMigrator(database).migrate()).toThrow(
        kind !== "rewound-zero"
          ? "RUNTIME_OWNER_UNVERSIONED_NONEMPTY_LEDGER"
          : "RUNTIME_OWNER_EXISTING_SCHEMA_ZERO",
      );
      expect(
        statements.every((statement) => statement.startsWith("SELECT ")),
      ).toBe(true);
      expect(
        database
          .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
          .all(),
      ).toEqual(before);
    } finally {
      database.close();
    }
  },
);

test("historical33 stages and imports through strict legacy maintenance before ownership35", async () => {
  const root = trackedMkdtempSync(
    join(tmpdir(), "runtime-owner-staged-import-"),
  );
  const path = join(root, "ledger.sqlite3");
  const database = new Database(path);
  try {
    initializeLegacyLedgerSchema(database, 33);
    database.exec(
      "INSERT INTO runtime_control VALUES('service_enabled',0),('global_paused',1),('paid_work_paused',1),('legacy_pause_imported',1),('legacy_service_imported',1)",
    );
  } finally {
    database.close();
  }
  mkdirSync(join(root, "sol-attempts", "operation-index"), { recursive: true });
  await expect(
    stageLegacyOperationSchema34({ stateDirectory: root, apply: true }),
  ).resolves.toEqual({ mode: "applied", fromVersion: 33, targetVersion: 34 });
  expect(existsSync(join(root, "RUN.lock"))).toBe(false);
  const plan = await importLegacySolOperations({ stateDirectory: root });
  if (plan.mode !== "dry_run")
    throw new Error("Expected real offline import plan");
  const result = await importLegacySolOperations({
    stateDirectory: root,
    apply: true,
    expectedDigest: plan.sourceDigest,
  });
  expect(result.mode).toBe("applied");
  expect(existsSync(join(root, "RUN.lock"))).toBe(false);
  const migrated = new Database(path);
  try {
    expect(new LedgerMigrator(migrated).migrate()).toBe(CURRENT_SCHEMA_VERSION);
    expect(new RuntimeOwnerStore(migrated).read()).toBeNull();
    expect(
      migrated
        .prepare(
          "SELECT enabled FROM runtime_control WHERE control_key='sol_operation_import_complete'",
        )
        .get(),
    ).toEqual({ enabled: 1 });
  } finally {
    migrated.close();
  }
});

test("future schema refuses with SELECT-only inspection", () => {
  const statements: string[] = [];
  const database = new Database(":memory:", {
    verbose: (statement) => {
      statements.push(String(statement));
    },
  });
  try {
    database.exec(
      `CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY,version INTEGER); INSERT INTO local_schema VALUES(1,${String(CURRENT_SCHEMA_VERSION + 1)})`,
    );
    statements.length = 0;
    expect(() => new LedgerMigrator(database).migrate()).toThrow(
      "newer than supported",
    );
    expect(
      statements.every((statement) => statement.startsWith("SELECT ")),
    ).toBe(true);
    expect(database.prepare("SELECT version FROM local_schema").get()).toEqual({
      version: CURRENT_SCHEMA_VERSION + 1,
    });
  } finally {
    database.close();
  }
});
