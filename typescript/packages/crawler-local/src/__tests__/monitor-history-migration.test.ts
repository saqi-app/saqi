import Database from "better-sqlite3";
import { expect, test } from "vitest";

import { MIGRATIONS } from "../persistence/migrations.js";
import { migrateHistoricalFixture } from "./support/historical-migration-engine.js";
import { initializeLegacyLedgerSchema } from "./support/legacy-ledger-schema.js";

test("monitor history migration preserves controls and enforces one bounded row", () => {
  const database = new Database(":memory:");
  try {
    initializeLegacyLedgerSchema(database, 30);
    database.exec("INSERT INTO runtime_control VALUES ('paid_work_paused', 1)");
    migrateHistoricalFixture(database);
    expect(
      database.prepare("SELECT enabled FROM runtime_control").get(),
    ).toEqual({ enabled: 1 });
    const insert = database.prepare(
      "INSERT INTO monitor_progress_history VALUES (?, ?, 1)",
    );
    insert.run(1, Buffer.from('{"schemaVersion":1,"samples":[]}'));
    expect(() => insert.run(2, Buffer.from("{}"))).toThrow();
    database.exec("DELETE FROM monitor_progress_history");
    expect(() => insert.run(1, Buffer.alloc(131_073))).toThrow();
    expect(MIGRATIONS.some((migration) => migration.version === 31)).toBe(true);
  } finally {
    database.close();
  }
});
