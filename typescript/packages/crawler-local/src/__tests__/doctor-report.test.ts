import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Ledger } from "../persistence/ledger.js";
import { inputHash } from "../persistence/work-key.js";
import { buildDoctorReport } from "../runtime/doctor-report.js";
import { parseScraperOperationConfig } from "../runtime/operations-contract.js";
import { ZPIPELINE_HEALTH } from "../runtime/pipeline-diagnostics.js";
import type { StateInventory } from "../runtime/state-inventory.js";
import { trackedMkdtempSync as mkdtempSync } from "./support/tracked-test-root.js";

const DIGEST = "a".repeat(64);

describe("doctor report", () => {
  it("makes a gated publication path actionable when translation is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "saqi-doctor-publication-gate-"));
    const ledger = Ledger.initialize(join(root, "ledger.sqlite3"));
    ledger.armSolPaidUsageBudget(3);
    const config = parseScraperOperationConfig({
      collector: { enabled: true },
      localFanout: {
        enabled: true,
        resolutionFormat: "sqlite-v1",
        resolutionPath: join(root, "production-resolution.sqlite3"),
      },
      publication: {
        enabled: true,
        endpoint: "https://ops.saqi.app/api/corpus-import",
      },
      retention: { enabled: false },
      schemaVersion: 1,
      sol: { enabled: true },
      stateDirectory: root,
    });
    const report = buildDoctorReport({
      cdp: null,
      config,
      configDigest: DIGEST,
      configPath: join(root, "config.json"),
      controlReadError: null,
      currentEnrichmentCompleted: 7,
      health: ZPIPELINE_HEALTH.parse({
        checks: [
          {
            code: "PUBLICATION_AUTH_GATED",
            detail:
              "Production publication and resolution are gated by authorization",
            retryAt: null,
            state: "warning",
          },
        ],
        configDigest: DIGEST,
        growth: {
          local: {
            enabledLanes: 2,
            lastSuccessAt: null,
            state: "retrying",
            viableLanes: 2,
          },
          production: {
            configured: true,
            lastSuccessAt: null,
            state: "gated",
          },
        },
        lanes: [],
        lastProgressAt: null,
        observedAt: 1_000,
        queues: [],
        runId: "run-1",
        schemaId: "saqi.pipeline-health",
        schemaVersion: 1,
        sol: null,
        state: "degraded",
      }),
      healthReadError: null,
      ledgerReport: ledger.doctor(1_000),
      ledgerStatus: ledger.status(1_000),
      now: 1_000,
      paidWorkPaused: true,
      paused: false,
      root,
      runLock: null,
      runtimeOwnerIssue: null,
      solBudget: ledger.solPaidUsageBudgetStatus(),
      stateInventory: healthyStateInventory(),
    });
    ledger.close();

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PUBLICATION_AUTH_GATED",
          fix: expect.objectContaining({
            explanation: expect.stringContaining(
              "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET",
            ),
          }),
          severity: "error",
        }),
      ]),
    );
    expect(report.snapshot.enrichments).toEqual({
      combinedCompleted: 7,
      insightsGenerated: 7,
      wordGlossesGenerated: 7,
    });
    expect(
      report.findings.find(({ code }) => code === "PAID_WORK_PAUSED")?.fix
        ?.command,
    ).toBe(
      `saqi-crawler resume-paid --config '${join(root, "config.json")}' --maximum-sol-operations 3`,
    );
  });

  it("reports identity-resolution backlog as translation demand", () => {
    const root = mkdtempSync(join(tmpdir(), "saqi-doctor-resolution-demand-"));
    const ledger = Ledger.initialize(join(root, "ledger.sqlite3"));
    for (const [profile, poemId] of [
      ["profile-a", "poem-1"],
      ["profile-b", "poem-2"],
    ] as const) {
      const input = { poemId };
      ledger.seed({
        implementationVersion: "local-enrichment-fanout-v2",
        input,
        inputHash: inputHash(input),
        kind: `local-enrichment-source-${profile}`,
        priority: 0,
        schemaVersion: "local-enrichment-fanout@2",
      });
    }
    const report = buildDoctorReport({
      cdp: null,
      config: null,
      configDigest: null,
      configPath: null,
      controlReadError: null,
      currentEnrichmentCompleted: 0,
      health: null,
      healthReadError: "fixture",
      ledgerReport: ledger.doctor(1_000),
      ledgerStatus: ledger.status(1_000),
      now: 1_000,
      paidWorkPaused: false,
      paused: false,
      root,
      runLock: null,
      runtimeOwnerIssue: null,
      solBudget: ledger.solPaidUsageBudgetStatus(),
      stateInventory: healthyStateInventory(),
    });
    ledger.close();

    expect(report.snapshot.translations).toMatchObject({
      awaitingIdentityResolution: 2,
      queued: 0,
      translated: 0,
    });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TRANSLATION_IDENTITY_RESOLUTION_BACKLOG",
          detail: expect.stringMatching(
            /2 collected poems.*0 queued translations.*demand is zero/,
          ),
          severity: "warning",
        }),
      ]),
    );
  });
});

function healthyStateInventory(): StateInventory {
  return {
    codexScheduler: {
      authority: {
        digestValid: true,
        key: "provider-v10:sol",
        schemaVersion: 11,
        state: "valid",
      },
      fallback: "none",
      fallbackName: null,
      safeToOperate: true,
    },
    inertCandidates: [],
    retiredProviderKeys: [],
    rootEntries: { inspected: 0, truncated: false },
    schemaId: "saqi.state-inventory",
    schemaVersion: 1,
    surfaces: [],
  };
}
