import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceRequestTelemetryStatus,
  SOURCE_REQUEST_TELEMETRY_FILENAME,
  SourceRequestTelemetry,
} from "../collection/source-request-telemetry";
import { trackedMkdtempSync as mkdtempSync } from "./support/tracked-test-root";

describe("source request telemetry", () => {
  it("persists bounded token-free counts and survives restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "saqi-source-request-telemetry-"));
    let now = Date.UTC(2026, 8, 15, 12);
    const first = await SourceRequestTelemetry.open(root, { now: () => now });

    await first.record("navigation", "succeeded");
    now += 30_000;
    await first.record("feed", "failed");

    const second = await SourceRequestTelemetry.open(root, { now: () => now });
    now += 30_000;
    await second.record("feed", "succeeded");

    expect(second.status()).toMatchObject({
      firstRecordedAt: Date.UTC(2026, 8, 15, 12),
      lastRecordedAt: now,
      rateWindowMs: 60_000,
      schemaVersion: 1,
      surfaces: {
        feed: {
          attempted: 2,
          attemptsPerHour: 120,
          failed: 1,
          succeeded: 1,
          trailingWindowAttempts: 2,
        },
        navigation: {
          attempted: 1,
          attemptsPerHour: 60,
          failed: 0,
          succeeded: 1,
          trailingWindowAttempts: 1,
        },
      },
    });
    const serialized = readFileSync(
      join(root, SOURCE_REQUEST_TELEMETRY_FILENAME),
      "utf8",
    );
    expect(serialized).not.toMatch(/https|token|cursor/iu);
  });

  it("reports null without creating state during a read-only probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "saqi-source-request-status-"));
    await expect(readSourceRequestTelemetryStatus(root)).resolves.toBeNull();
  });

  it("reports corrupt state without breaking read-only status", async () => {
    const root = mkdtempSync(join(tmpdir(), "saqi-source-request-corrupt-"));
    writeFileSync(join(root, SOURCE_REQUEST_TELEMETRY_FILENAME), "not-json");
    await expect(readSourceRequestTelemetryStatus(root)).resolves.toEqual({
      errorCode: "SOURCE_REQUEST_TELEMETRY_INVALID",
      state: "invalid",
    });
  });

  it("uses only the trailing hour while retaining lifetime totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "saqi-source-request-window-"));
    let now = Date.UTC(2026, 8, 15, 12);
    const telemetry = await SourceRequestTelemetry.open(root, {
      now: () => now,
    });
    await telemetry.record("navigation", "succeeded");
    now += 61 * 60_000;
    await telemetry.record("feed", "succeeded");

    expect(telemetry.status()).toMatchObject({
      rateWindowMs: 3_600_000,
      surfaces: {
        feed: { attempted: 1, attemptsPerHour: 1 },
        navigation: { attempted: 1, attemptsPerHour: 0 },
      },
    });
  });
});
