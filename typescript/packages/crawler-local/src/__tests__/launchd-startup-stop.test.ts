import type * as ChildProcess from "node:child_process";
import { writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { Ledger } from "../persistence/ledger.js";
import { controlLaunchdService } from "../runtime/launchd-control.js";
import {
  readServiceEnabled,
  writeServiceEnabled,
} from "../runtime/service-enabled-control.js";
import { initializeLegacyLedgerSchema } from "./support/legacy-ledger-schema.js";
import { trackedMkdtempSync } from "./support/tracked-test-root.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>();
  const { promisify } = await import("node:util");
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }),
  };
});

describe("stop during unacknowledged managed startup", () => {
  it("recovers an aged control lock with an invalid negative PID", async () => {
    const root = trackedMkdtempSync(join(tmpdir(), "saqi-control-lock-pid-"));
    Ledger.initialize(join(root, "ledger.sqlite3")).close();
    writeServiceEnabled(root, true);
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, stateDirectory: root }),
    );
    const controlLockPath = join(root, "CONTROL.lock");
    writeFileSync(controlLockPath, JSON.stringify({ pid: -1 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(controlLockPath, old, old);
    execute.mockRejectedValue(
      Object.assign(new Error("service not loaded"), { code: 113 }),
    );
    try {
      const result = await controlLaunchdService({
        action: "stop",
        configPath,
        label: "net.saqi.test",
      });
      expect(result.actualState).toBe("stopped");
      expect(readServiceEnabled(root)).toBe(false);
    } finally {
      execute.mockReset();
    }
  });

  it("historical owner authority disables service without migrating or signaling unverified PID", async () => {
    const root = trackedMkdtempSync(join(tmpdir(), "saqi-historical-stop-"));
    const database = new Database(join(root, "ledger.sqlite3"));
    initializeLegacyLedgerSchema(database, 34);
    database.exec(
      "INSERT INTO runtime_control VALUES('service_enabled',1),('legacy_service_imported',1),('global_paused',1),('paid_work_paused',1),('legacy_pause_imported',1)",
    );
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, stateDirectory: root }),
    );
    execute.mockResolvedValue({
      stdout: "state = running\npid = 12345\nexit timeout = 180\n",
      stderr: "",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(
        controlLaunchdService({
          action: "stop",
          configPath,
          label: "net.saqi.test",
        }),
      ).rejects.toThrow(
        "LAUNCHD_STOP_DISABLED_BUT_UNACKNOWLEDGED: RUNTIME_OWNER_AUTHORITY_UNAVAILABLE",
      );
      expect(
        database.prepare("SELECT version FROM local_schema").get(),
      ).toEqual({ version: 34 });
      expect(
        database
          .prepare(
            "SELECT enabled FROM runtime_control WHERE control_key='service_enabled'",
          )
          .get(),
      ).toEqual({ enabled: 0 });
      expect(
        database
          .prepare(
            "SELECT control_key,enabled FROM runtime_control WHERE control_key IN ('global_paused','paid_work_paused') ORDER BY control_key",
          )
          .all(),
      ).toEqual([
        { control_key: "global_paused", enabled: 1 },
        { control_key: "paid_work_paused", enabled: 1 },
      ]);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      database.close();
      execute.mockClear();
    }
  });
  it("disables future recovery while refusing to signal an unverified process", async () => {
    const root = trackedMkdtempSync(join(tmpdir(), "saqi-startup-stop-"));
    Ledger.initialize(join(root, "ledger.sqlite3")).close();
    writeServiceEnabled(root, true);
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, stateDirectory: root }),
    );
    execute.mockResolvedValue({
      stdout: "state = running\npid = 12345\nexit timeout = 180\n",
      stderr: "",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(
        controlLaunchdService({
          action: "stop",
          configPath,
          label: "net.saqi.test",
        }),
      ).rejects.toThrow(
        "LAUNCHD_STOP_DISABLED_BUT_UNACKNOWLEDGED: SERVICE_PID_MISMATCH",
      );
      expect(readServiceEnabled(root)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        "/bin/launchctl",
        ["print", expect.any(String)],
        expect.any(Object),
      );
    } finally {
      kill.mockRestore();
    }
  });
});
