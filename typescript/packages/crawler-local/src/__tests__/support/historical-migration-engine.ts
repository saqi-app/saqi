import type Database from "better-sqlite3";
import { z } from "zod";

import {
  CURRENT_SCHEMA_VERSION,
  LedgerMigrationEngine,
  LedgerMigrator,
  MIGRATIONS,
} from "../../persistence/migrations.js";

const VersionSchema = z.object({ version: z.int().nonnegative() });

/** Exercise retained historical mechanics independently of operator admission.
 * Actual operator refusal and fixed34 staging have separate integration tests. */
export function migrateHistoricalFixture(database: Database.Database): number {
  if (
    database
      .prepare("SELECT name FROM sqlite_schema WHERE name='local_schema'")
      .get() === undefined
  )
    return new LedgerMigrator(database).migrate();
  const engine = new LedgerMigrationEngine(database);
  const readVersion = () =>
    VersionSchema.parse(
      database
        .prepare("SELECT version FROM local_schema WHERE singleton=1")
        .get(),
    ).version;
  if (readVersion() > CURRENT_SCHEMA_VERSION)
    return new LedgerMigrator(database).migrate();
  for (const migration of MIGRATIONS) {
    if (migration.version <= readVersion()) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      if (migration.version > readVersion()) engine.apply(migration);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  engine.assertConfiguredSourceIdentity();
  return CURRENT_SCHEMA_VERSION;
}
