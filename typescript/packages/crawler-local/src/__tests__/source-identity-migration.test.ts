import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureSource } from "@saqi/source-adapter";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import { Ledger } from "../persistence/ledger.js";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
} from "../persistence/migrations.js";
import { migrateHistoricalFixture } from "./support/historical-migration-engine.js";
import { trackedMkdtempSync as mkdtempSync } from "./support/tracked-test-root.js";

const DEFAULT_SOURCE = {
  name: "source",
  origin: "https://source.invalid",
} as const;
const ARCHIVE_SOURCE = {
  name: "archive",
  origin: "https://example.test",
} as const;

afterEach(() => {
  configureSource(DEFAULT_SOURCE);
});

function migrateThroughVersion28(database: Database.Database): void {
  database.exec(`
    CREATE TABLE local_schema(
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      version INTEGER NOT NULL CHECK(version >= 0)
    ) STRICT;
    INSERT INTO local_schema VALUES(1, 0);
  `);
  for (const migration of MIGRATIONS) {
    if (migration.version > 28) continue;
    database.exec(migration.statements);
    database
      .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
      .run(migration.version);
  }
}

describe("local ledger source identity", () => {
  test("persists the configured identity for a fresh ledger", () => {
    configureSource(ARCHIVE_SOURCE);
    const database = new Database(":memory:");

    expect(migrateHistoricalFixture(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database
        .prepare(
          `SELECT source_name, source_origin
             FROM local_source_identity WHERE singleton = 1`,
        )
        .get(),
    ).toEqual({
      source_name: ARCHIVE_SOURCE.name,
      source_origin: ARCHIVE_SOURCE.origin,
    });
    database.close();
  });

  test("adopts a matching v28 schema identity", () => {
    configureSource(ARCHIVE_SOURCE);
    const database = new Database(":memory:");
    migrateThroughVersion28(database);

    expect(migrateHistoricalFixture(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database
        .prepare("SELECT source_name, source_origin FROM local_source_identity")
        .get(),
    ).toEqual({
      source_name: ARCHIVE_SOURCE.name,
      source_origin: ARCHIVE_SOURCE.origin,
    });
    database.close();
  });

  test("rejects a configured typo instead of blessing it on a v28 ledger", () => {
    configureSource(ARCHIVE_SOURCE);
    const database = new Database(":memory:");
    migrateThroughVersion28(database);
    configureSource({ ...ARCHIVE_SOURCE, name: "archivf" });

    expect(() => migrateHistoricalFixture(database)).toThrow(
      "LOCAL_SOURCE_IDENTITY_MISMATCH",
    );
    expect(database.prepare("SELECT version FROM local_schema").get()).toEqual({
      version: 28,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_schema
            WHERE type = 'table' AND name = 'local_source_identity'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  test("rejects future writable opens under a different source identity", () => {
    configureSource(ARCHIVE_SOURCE);
    const path = join(
      mkdtempSync(join(tmpdir(), "saqi-source-identity-")),
      "ledger.sqlite3",
    );
    Ledger.open(path).close();
    configureSource({
      name: ARCHIVE_SOURCE.name,
      origin: "https://other.test",
    });

    expect(() => Ledger.open(path)).toThrow("LOCAL_SOURCE_IDENTITY_MISMATCH");
  });

  test("rejects readonly health opens under a different source identity", () => {
    configureSource(ARCHIVE_SOURCE);
    const path = join(
      mkdtempSync(join(tmpdir(), "saqi-source-identity-readonly-")),
      "ledger.sqlite3",
    );
    Ledger.open(path).close();
    configureSource({
      name: ARCHIVE_SOURCE.name,
      origin: "https://other.test",
    });

    expect(() => Ledger.open(path, { readonly: true })).toThrow(
      "LOCAL_SOURCE_IDENTITY_MISMATCH",
    );
  });
});
