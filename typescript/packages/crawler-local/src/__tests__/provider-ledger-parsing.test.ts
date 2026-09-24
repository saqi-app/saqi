import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { Ledger } from "../persistence/ledger.js";
import { SqliteQueryValidationError } from "../persistence/sqlite-query.js";
import { inputHash } from "../persistence/work-key.js";
import { trackedMkdtempSync } from "./support/tracked-test-root.js";

function fixture() {
  const root = trackedMkdtempSync(join(tmpdir(), "saqi-provider-row-parsing-"));
  const path = join(root, "ledger.sqlite3");
  const ledger = Ledger.initialize(path);
  const database = new Database(path);
  database.pragma("ignore_check_constraints = ON");
  return { database, ledger };
}

describe("provider ledger row validation", () => {
  it("parses complete scheduler rows and never exposes their serialized contents on failure", () => {
    const { database, ledger } = fixture();
    try {
      const serialized = '{"private":"PRIVATE_SCHEDULER_CONTENT"}';
      expect(ledger.loadSchedulerState("missing")).toBeNull();
      ledger.saveSchedulerState("test", serialized, "a".repeat(64), null, 100);
      expect(ledger.loadSchedulerState("test")).toEqual({
        digest: "a".repeat(64),
        serialized,
      });
      database
        .prepare("UPDATE scheduler_state SET state_digest = ?")
        .run("PRIVATE_INVALID_DIGEST");
      expect(() => ledger.loadSchedulerState("test")).toThrow(
        SqliteQueryValidationError,
      );
      try {
        ledger.loadSchedulerState("test");
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE_INVALID_DIGEST");
        expect(String(error)).not.toContain("PRIVATE_SCHEDULER_CONTENT");
      }
    } finally {
      ledger.close();
      database.close();
    }
  });
});
