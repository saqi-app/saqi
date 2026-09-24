import Database from "better-sqlite3";
import { expect, test } from "vitest";

import { MIGRATIONS } from "../persistence/migrations.js";
import { migrateHistoricalFixture } from "./support/historical-migration-engine.js";
import { initializeLegacyLedgerSchema } from "./support/legacy-ledger-schema.js";

test("monitor history is retired without changing runtime controls", () => {
  const database = new Database(":memory:");
  try {
    initializeLegacyLedgerSchema(database, 30);
    database.exec("INSERT INTO runtime_control VALUES ('paid_work_paused', 1)");
    migrateHistoricalFixture(database);
    expect(
      database.prepare("SELECT enabled FROM runtime_control").get(),
    ).toEqual({ enabled: 1 });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'monitor_progress_history'",
        )
        .get(),
    ).toBeUndefined();
    expect(MIGRATIONS.some((migration) => migration.version === 31)).toBe(true);
  } finally {
    database.close();
  }
});
