import { currentSource } from "@saqi/source-adapter";
import type Database from "better-sqlite3";

import { MIGRATIONS } from "../../persistence/migrations.js";

/** Construct an empty historical fixture, never rewind a newer schema. */
export function initializeLegacyLedgerSchema(
  database: Database.Database,
  version: number,
): void {
  if (!MIGRATIONS.some((migration) => migration.version === version)) {
    throw new Error("Unknown historical ledger fixture version");
  }
  database.exec(`CREATE TABLE local_schema (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    version INTEGER NOT NULL CHECK(version >= 0)
  ) STRICT; INSERT INTO local_schema VALUES(1, 0);`);
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    database.exec(migration.statements);
    // The empty v29 fixture needs the same immutable source authority that
    // the migrator seeds after executing that version's DDL.
    if (migration.version === 29) {
      const source = currentSource();
      database
        .prepare(
          "INSERT INTO local_source_identity(singleton, source_name, source_origin) VALUES(1, ?, ?)",
        )
        .run(source.name, source.origin);
    }
    database
      .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
      .run(migration.version);
  }
}
