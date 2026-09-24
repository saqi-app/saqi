import type { Ledger } from "../persistence/ledger.js";
import type { CdpDiagnostic } from "./cdp-diagnostics-client.js";
import type { ScraperOperationConfig } from "./operations-contract.js";
import type { PipelineHealth } from "./pipeline-diagnostics.js";
import type { RunLockRecord } from "./run-lock.js";
import type { StateInventory } from "./state-inventory.js";

type LedgerStatus = ReturnType<Ledger["status"]>;
type Severity = "error" | "warning";

interface DoctorFinding {
  readonly code: string;
  readonly detail: string;
  readonly fix: {
    readonly command: null | string;
    readonly explanation: string;
  } | null;
  readonly severity: Severity;
  readonly title: string;
}

export interface DoctorReportInput {
  readonly cdp: CdpDiagnostic | null;
  readonly config: null | ScraperOperationConfig;
  readonly configDigest: null | string;
  readonly configPath: null | string;
  readonly controlReadError: null | string;
  readonly currentEnrichmentCompleted: number;
  readonly health: null | PipelineHealth;
  readonly healthReadError: null | string;
  readonly ledgerReport: ReturnType<Ledger["doctor"]>;
  readonly ledgerStatus: LedgerStatus;
  readonly now: number;
  readonly paidWorkPaused: boolean;
  readonly paused: boolean;
  readonly root: string;
  readonly runLock: null | RunLockRecord;
  readonly runtimeOwnerIssue: null | string;
  readonly stateInventory: StateInventory;
}

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
  readonly healthy: boolean;
  readonly nextAction: DoctorFinding["fix"] | null;
  readonly snapshot: {
    readonly authors: { readonly active: number; readonly queued: number };
    readonly inventory: { readonly active: number; readonly queued: number };
    readonly enrichments: {
      readonly combinedCompleted: number;
      readonly insightsGenerated: number;
      readonly wordGlossesGenerated: number;
    };
    readonly poems: {
      readonly active: number;
      readonly deadLetter: number;
      readonly queued: number;
      readonly scraped: number;
    };
    readonly runtime: "not_running" | "running" | "unknown";
    readonly translations: {
      readonly active: number;
      readonly awaitingIdentityResolution: number;
      readonly queued: number;
      readonly translated: number;
    };
  };
  readonly summary: {
    readonly errors: number;
    readonly warnings: number;
  };
}

export function buildDoctorReport(input: DoctorReportInput): DoctorReport {
  const findings: DoctorFinding[] = [];
  const poems = progress(input.ledgerStatus, "aldiwan_poem_detail");
  const authors = progress(input.ledgerStatus, "aldiwan_author_manifest");
  const inventory = progress(
    input.ledgerStatus,
    "aldiwan_author_inventory_discovery",
  );
  const translations = progress(input.ledgerStatus, "poem-enrichment-sol");
  const identityResolution = progressByKindPrefix(
    input.ledgerStatus,
    "local-enrichment-source-",
  );
  const runCommand = input.configPath
    ? `saqi-crawler run --config ${shellQuote(input.configPath)}`
    : `saqi-crawler run --config /path/to/saqi-rig.json`;

  if (input.ledgerReport.integrity !== "ok")
    findings.push(
      finding(
        "LEDGER_INTEGRITY_FAILED",
        "error",
        "Ledger integrity check failed",
        `SQLite reported ${input.ledgerReport.integrity}. Stop the rig and preserve the state directory before recovery.`,
        "Run a deep read-only integrity check and recover from a verified backup if it fails.",
        `saqi-crawler doctor --state-dir ${shellQuote(input.root)} --deep-integrity`,
      ),
    );
  if (!input.stateInventory.codexScheduler.safeToOperate)
    findings.push(
      finding(
        "SOL_SCHEDULER_AUTHORITY_INVALID",
        "error",
        "Translation scheduler authority is unsafe",
        `Current authority is ${input.stateInventory.codexScheduler.authority.state}; fallback is ${input.stateInventory.codexScheduler.fallback}.`,
        "Stage and apply the durable Sol operation import before enabling paid work.",
        input.configPath
          ? `saqi-crawler stage-sol-operation-import --config ${shellQuote(input.configPath)}`
          : null,
      ),
    );
  if (input.runtimeOwnerIssue !== null)
    findings.push(
      finding(
        input.runtimeOwnerIssue,
        "error",
        "Runtime ownership cannot be verified",
        "The authoritative runtime-owner record could not be read safely.",
        "Inspect the ledger and legacy RUN.lock evidence before restarting.",
        null,
      ),
    );
  else if (input.runLock === null && totalQueued(input.ledgerStatus) > 0)
    findings.push(
      finding(
        "RUNTIME_NOT_RUNNING",
        "error",
        "Queued work has no running collector",
        `${String(totalQueued(input.ledgerStatus))} work items are queued, but no runtime owns the ledger.`,
        "Start the unified rig; it will resume durable queue state.",
        runCommand,
      ),
    );
  const stalledOrigin = input.ledgerStatus.origins.find(
    ({ active, consecutiveFailures, cooldownUntil, stopReason }) =>
      !active &&
      stopReason === null &&
      consecutiveFailures > 0 &&
      cooldownUntil > input.now,
  );
  if (stalledOrigin && input.ledgerStatus.ready > 0)
    findings.push(
      finding(
        "SOURCE_ORIGIN_COOLDOWN_STALL",
        "error",
        "Ready collection work is blocked by a source cooldown",
        `${String(input.ledgerStatus.ready)} work items are ready, but ${stalledOrigin.origin} is idle until ${new Date(stalledOrigin.cooldownUntil).toISOString()}.`,
        "After verifying source access, clear the stale failure cooldown without changing queued work or durable attempt history.",
        `saqi-crawler clear-source-failures --state-dir ${shellQuote(input.root)} --confirm`,
      ),
    );
  if (input.controlReadError !== null)
    findings.push(
      finding(
        "PAUSE_CONTROL_UNINITIALIZED",
        "warning",
        "Pause controls are not initialized",
        input.controlReadError,
        "Start the rig once to migrate legacy pause markers into durable SQLite controls.",
        runCommand,
      ),
    );
  if (input.paused)
    findings.push(
      finding(
        "RIG_PAUSED",
        "error",
        "All work is paused",
        "The global pause control is active.",
        "Resume all lanes.",
        `saqi-crawler resume --state-dir ${shellQuote(input.root)}`,
      ),
    );
  if (input.health === null)
    findings.push(
      finding(
        "PIPELINE_HEALTH_UNAVAILABLE",
        "warning",
        "Pipeline heartbeat is unavailable",
        input.healthReadError ?? "No valid health snapshot was found.",
        "Start or restart the rig to publish a fresh heartbeat.",
        runCommand,
      ),
    );
  else {
    const maximumAge = Math.max(
      15 * 60_000,
      input.health.heartbeatIntervalMs * 3,
    );
    if (input.now - input.health.observedAt > maximumAge)
      findings.push(
        finding(
          "PIPELINE_HEALTH_STALE",
          "error",
          "Pipeline heartbeat is stale",
          `The last heartbeat is ${String(Math.floor((input.now - input.health.observedAt) / 1_000))} seconds old.`,
          "Restart the rig; durable leases and checkpoints will resume safely.",
          runCommand,
        ),
      );
    for (const check of input.health.checks) {
      if (check.state === "ok") continue;
      findings.push(
        finding(
          check.code,
          check.state === "blocked" ||
            check.code === "PUBLICATION_AUTH_GATED" ||
            check.code === "PUBLICATION_CAPACITY_GATED" ||
            (check.code === "LOCAL_ENRICHMENT_FANOUT_DISABLED" &&
              input.config?.collector.enabled === true &&
              input.config.sol.enabled)
            ? "error"
            : "warning",
          humanize(check.code),
          check.detail ?? `Pipeline check state is ${check.state}.`,
          check.code === "LOCAL_ENRICHMENT_FANOUT_DISABLED"
            ? "Configure localFanout.resolutionPath and enable localFanout after obtaining an authorized production-resolution export."
            : check.code === "PUBLICATION_AUTH_GATED"
              ? publicationAuthFix(input.config)
              : check.code === "PUBLICATION_CAPACITY_GATED"
                ? "Resolve every D1 capacity preflight blocker reported above; publication remains fail-closed until the capacity proof is current."
                : check.retryAt === null
                  ? "Review the reported gate and configuration."
                  : `The rig will retry automatically after ${new Date(check.retryAt).toISOString()}.`,
          null,
        ),
      );
    }
    const authoritativeRuntimeIsCurrent =
      input.configDigest !== null &&
      input.runLock?.configDigest === input.configDigest;
    if (
      input.health.desiredConfigDigest !== null &&
      input.health.desiredConfigDigest !== input.health.configDigest &&
      !authoritativeRuntimeIsCurrent
    )
      findings.push(
        finding(
          "CONFIG_DIGEST_DRIFT",
          "error",
          "Runtime is using an old configuration",
          "The desired and loaded configuration digests differ.",
          "Restart the rig to load the desired configuration.",
          runCommand,
        ),
      );
  }
  if (
    input.configDigest !== null &&
    input.runLock !== null &&
    input.runLock.configDigest !== input.configDigest &&
    !findings.some(({ code }) => code === "CONFIG_DIGEST_DRIFT")
  )
    findings.push(
      finding(
        "CONFIG_DIGEST_DRIFT",
        "error",
        "Runtime is using an old configuration",
        "The authoritative runtime-owner digest does not match the requested configuration.",
        "Restart the rig to load the requested configuration.",
        runCommand,
      ),
    );
  if (input.cdp && !input.cdp.reachable)
    findings.push(
      finding(
        "CHROME_CDP_UNREACHABLE",
        "error",
        "Dedicated Chrome is not reachable",
        `${input.cdp.endpoint} did not answer its bounded DevTools probe (${input.cdp.detail ?? "unknown error"}).`,
        "Launch the dedicated Chrome profile, complete any visible human verification, and leave it running.",
        input.configPath
          ? `saqi-crawler verify-source --config ${shellQuote(input.configPath)} --author https://www.aldiwan.net/authers-1`
          : null,
      ),
    );
  if (poems.deadLetter > 0)
    findings.push(
      finding(
        "POEM_DEAD_LETTERS_PRESENT",
        "warning",
        "Some poems need bounded recovery",
        `${String(poems.deadLetter)} poem-detail jobs are in dead letter.`,
        "Inspect and arm the bounded collector recovery lane.",
        input.configPath
          ? `saqi-crawler collector-recovery --action status --config ${shellQuote(input.configPath)}`
          : `saqi-crawler collector-recovery --action status --state-dir ${shellQuote(input.root)}`,
      ),
    );
  if (authors.deadLetter > 0)
    findings.push(
      finding(
        "AUTHOR_MANIFEST_DEAD_LETTERS_PRESENT",
        "warning",
        "Some authors need manifest recovery",
        `${String(authors.deadLetter)} author-manifest jobs are in dead letter.`,
        "Inspect each failed author and its terminal-certificate error before requeueing it; other authors continue independently.",
        null,
      ),
    );
  if (input.config?.collector.continuousDiscoveryRequired) {
    if (
      !input.config.inventory.enabled ||
      input.config.inventory.refreshIntervalMs === null
    )
      findings.push(
        finding(
          "CONTINUOUS_DISCOVERY_DISABLED",
          "error",
          "Continuous author discovery is not scheduled",
          "The collector requires continuous discovery, but recurring inventory is disabled.",
          "Enable inventory.enabled and set inventory.refreshIntervalMs in the rig config.",
          null,
        ),
      );
  }
  if (
    input.config?.sol.enabled &&
    input.config.collector.enabled &&
    !input.config.localFanout.enabled &&
    !findings.some(({ code }) => code === "LOCAL_ENRICHMENT_FANOUT_DISABLED")
  )
    findings.push(
      finding(
        "LOCAL_ENRICHMENT_FANOUT_DISABLED",
        "warning",
        "Scraped poems are not entering translation",
        `${String(poems.scraped)} poems are collected, but local Sol fanout is disabled and ${String(translations.queued)} translations are queued.`,
        "Configure localFanout.resolutionPath and enable localFanout after obtaining an authorized production-resolution export.",
        null,
      ),
    );
  if (identityResolution.active + identityResolution.queued > 0)
    findings.push(
      finding(
        "TRANSLATION_IDENTITY_RESOLUTION_BACKLOG",
        "warning",
        "Collected poems are awaiting production identities",
        `${String(identityResolution.active + identityResolution.queued)} collected poems await production identity resolution before Sol work can be seeded; ${String(translations.queued)} queued translations does not mean translation demand is zero.`,
        "Restore the authorized production-resolution refresh or export. Local fanout will seed translation work automatically after canonical production identities arrive.",
        null,
      ),
    );
  if (input.config?.sol.enabled && input.paidWorkPaused)
    findings.push(
      finding(
        "PAID_WORK_PAUSED",
        "warning",
        "Translation work is paused",
        "The paid-work safety control is active.",
        "Resume translation work when ready.",
        input.configPath
          ? `saqi-crawler resume-paid --config ${shellQuote(input.configPath)}`
          : `saqi-crawler resume-paid --state-dir ${shellQuote(input.root)}`,
      ),
    );

  const errors = findings.filter(({ severity }) => severity === "error").length;
  const warnings = findings.length - errors;
  const nextAction =
    findings.find(({ severity }) => severity === "error")?.fix ??
    findings.find(({ fix }) => fix !== null && fix.command !== null)?.fix ??
    findings[0]?.fix ??
    null;
  return {
    findings,
    healthy: errors === 0,
    nextAction,
    snapshot: {
      authors: { active: authors.active, queued: authors.queued },
      enrichments: {
        combinedCompleted: input.currentEnrichmentCompleted,
        insightsGenerated: input.currentEnrichmentCompleted,
        wordGlossesGenerated: input.currentEnrichmentCompleted,
      },
      inventory: { active: inventory.active, queued: inventory.queued },
      poems,
      runtime:
        input.runtimeOwnerIssue !== null
          ? "unknown"
          : input.runLock === null
            ? "not_running"
            : "running",
      translations: {
        active: translations.active,
        awaitingIdentityResolution:
          identityResolution.active + identityResolution.queued,
        queued: translations.queued,
        translated: translations.scraped,
      },
    },
    summary: { errors, warnings },
  };
}

function publicationAuthFix(config: null | ScraperOperationConfig): string {
  const auth = config?.publication.auth;
  if (!auth)
    return "Configure authorized production publication credentials, then restart the rig and rerun doctor.";
  return auth.mode === "service_token"
    ? `Set ${auth.clientIdEnvironment} and ${auth.clientSecretEnvironment} in the supervisor environment, then restart the rig and rerun doctor.`
    : `Set ${auth.tokenEnvironment} to a current Access JWT in the supervisor environment, then restart the rig and rerun doctor.`;
}

function progress(status: LedgerStatus, kind: string) {
  const row = status.kindProgress.find((entry) => entry.kind === kind);
  return {
    active: row?.byState.running ?? 0,
    deadLetter: row?.byState.dead_letter ?? 0,
    queued:
      (row?.byState.pending ?? 0) +
      (row?.byState.retry_wait ?? 0) +
      (row?.byState.quota_wait ?? 0),
    scraped: row?.completed ?? 0,
  };
}

function progressByKindPrefix(status: LedgerStatus, prefix: string) {
  return status.kindProgress
    .filter(({ kind }) => kind.startsWith(prefix))
    .reduce(
      (aggregate, row) => ({
        active: aggregate.active + row.byState.running,
        deadLetter: aggregate.deadLetter + row.byState.dead_letter,
        queued:
          aggregate.queued +
          row.byState.pending +
          row.byState.retry_wait +
          row.byState.quota_wait,
        scraped: aggregate.scraped + row.completed,
      }),
      { active: 0, deadLetter: 0, queued: 0, scraped: 0 },
    );
}

function totalQueued(status: LedgerStatus): number {
  return (
    status.byState.pending +
    status.byState.retry_wait +
    status.byState.quota_wait
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function humanize(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function finding(
  code: string,
  severity: Severity,
  title: string,
  detail: string,
  explanation: string,
  command: null | string,
): DoctorFinding {
  return {
    code,
    detail,
    fix: { command, explanation },
    severity,
    title,
  };
}
