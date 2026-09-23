import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

const MINUTE_MS = 60_000;
const RATE_WINDOW_MS = 60 * MINUTE_MS;
const RETAINED_BUCKETS = 61;
export const SOURCE_REQUEST_TELEMETRY_FILENAME =
  "source-request-telemetry.json";

const CountsSchema = z.strictObject({
  attempted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
});
const BucketSchema = z.strictObject({
  feed: CountsSchema,
  minute: z.number().int().nonnegative(),
  navigation: CountsSchema,
});
const StoredSourceRequestTelemetrySchema = z.strictObject({
  buckets: z.array(BucketSchema).max(RETAINED_BUCKETS),
  firstRecordedAt: z.number().int().nonnegative().nullable(),
  lastRecordedAt: z.number().int().nonnegative().nullable(),
  schemaVersion: z.literal(1),
  totals: z.strictObject({
    feed: CountsSchema,
    navigation: CountsSchema,
  }),
});

type Counts = z.infer<typeof CountsSchema>;
type StoredSourceRequestTelemetry = z.infer<
  typeof StoredSourceRequestTelemetrySchema
>;
export type SourceRequestOutcome = "failed" | "succeeded";
export type SourceRequestSurface = "feed" | "navigation";

export interface SourceRequestTelemetryStatus {
  readonly firstRecordedAt: null | number;
  readonly lastRecordedAt: null | number;
  readonly rateWindowMs: number;
  readonly schemaVersion: 1;
  readonly surfaces: Readonly<
    Record<
      SourceRequestSurface,
      Counts & {
        readonly attemptsPerHour: number;
        readonly trailingWindowAttempts: number;
      }
    >
  >;
}

export interface InvalidSourceRequestTelemetryStatus {
  readonly errorCode: "SOURCE_REQUEST_TELEMETRY_INVALID";
  readonly state: "invalid";
}

interface SourceRequestTelemetryRecorder {
  record(
    surface: SourceRequestSurface,
    outcome: SourceRequestOutcome,
  ): Promise<void>;
  status(now?: number): SourceRequestTelemetryStatus;
}

export class SourceRequestTelemetry implements SourceRequestTelemetryRecorder {
  readonly #now: () => number;
  readonly #path: string;
  #state: StoredSourceRequestTelemetry;
  #tail: Promise<void> = Promise.resolve();

  static async open(
    root: string,
    options: { readonly now?: () => number } = {},
  ): Promise<SourceRequestTelemetry> {
    const path = resolve(root, SOURCE_REQUEST_TELEMETRY_FILENAME);
    let state: StoredSourceRequestTelemetry;
    try {
      state = await readStoredTelemetry(path);
    } catch {
      console.error("SAQI_SOURCE_REQUEST_TELEMETRY_INVALID");
      state = emptyTelemetry();
    }
    return new SourceRequestTelemetry(path, state, options.now ?? Date.now);
  }

  async record(
    surface: SourceRequestSurface,
    outcome: SourceRequestOutcome,
  ): Promise<void> {
    const pending = this.#tail.then(async () => {
      const now = this.#now();
      this.#state = recordRequest(this.#state, surface, outcome, now);
      const temporary = `${this.#path}.${process.pid.toString()}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.#state)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#path);
    });
    this.#tail = pending.catch((error: unknown) => {
      console.error("SAQI_SOURCE_REQUEST_TELEMETRY_WRITE_FAILED", error);
    });
    await pending;
  }

  status(now = this.#now()): SourceRequestTelemetryStatus {
    return sourceRequestTelemetryStatus(this.#state, now);
  }

  private constructor(
    path: string,
    state: StoredSourceRequestTelemetry,
    now: () => number,
  ) {
    this.#now = now;
    this.#path = path;
    this.#state = state;
  }
}

export async function readSourceRequestTelemetryStatus(
  root: string,
  now = Date.now(),
): Promise<
  InvalidSourceRequestTelemetryStatus | null | SourceRequestTelemetryStatus
> {
  const path = resolve(root, SOURCE_REQUEST_TELEMETRY_FILENAME);
  try {
    return sourceRequestTelemetryStatus(
      await readStoredTelemetry(path, true),
      now,
    );
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") return null;
    return {
      errorCode: "SOURCE_REQUEST_TELEMETRY_INVALID",
      state: "invalid",
    };
  }
}

function recordRequest(
  state: StoredSourceRequestTelemetry,
  surface: SourceRequestSurface,
  outcome: SourceRequestOutcome,
  now: number,
): StoredSourceRequestTelemetry {
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const buckets = state.buckets.map((bucket) => ({
    ...bucket,
    feed: { ...bucket.feed },
    navigation: { ...bucket.navigation },
  }));
  let bucket = buckets.find((candidate) => candidate.minute === minute);
  if (!bucket) {
    bucket = {
      feed: emptyCounts(),
      minute,
      navigation: emptyCounts(),
    };
    buckets.push(bucket);
    buckets.sort((left, right) => left.minute - right.minute);
  }
  increment(bucket[surface], outcome);
  const totals = {
    feed: { ...state.totals.feed },
    navigation: { ...state.totals.navigation },
  };
  increment(totals[surface], outcome);
  return {
    buckets: buckets.slice(-RETAINED_BUCKETS),
    firstRecordedAt: state.firstRecordedAt ?? now,
    lastRecordedAt: now,
    schemaVersion: 1,
    totals,
  };
}

function sourceRequestTelemetryStatus(
  state: StoredSourceRequestTelemetry,
  now: number,
): SourceRequestTelemetryStatus {
  const firstRecordedAt = state.firstRecordedAt;
  const rateWindowMs =
    firstRecordedAt === null
      ? RATE_WINDOW_MS
      : Math.max(1, Math.min(RATE_WINDOW_MS, now - firstRecordedAt));
  const threshold = now - RATE_WINDOW_MS;
  const trailing = {
    feed: 0,
    navigation: 0,
  };
  for (const bucket of state.buckets) {
    if (bucket.minute + MINUTE_MS <= threshold) continue;
    trailing.feed += bucket.feed.attempted;
    trailing.navigation += bucket.navigation.attempted;
  }
  const surface = (name: SourceRequestSurface) => ({
    ...state.totals[name],
    attemptsPerHour: roundRate(
      (trailing[name] * RATE_WINDOW_MS) / rateWindowMs,
    ),
    trailingWindowAttempts: trailing[name],
  });
  return {
    firstRecordedAt,
    lastRecordedAt: state.lastRecordedAt,
    rateWindowMs,
    schemaVersion: 1,
    surfaces: {
      feed: surface("feed"),
      navigation: surface("navigation"),
    },
  };
}

async function readStoredTelemetry(
  path: string,
  missingIsError = false,
): Promise<StoredSourceRequestTelemetry> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return StoredSourceRequestTelemetrySchema.parse(value);
  } catch (error) {
    if (!missingIsError && filesystemErrorCode(error) === "ENOENT")
      return emptyTelemetry();
    throw error;
  }
}

function increment(counts: Counts, outcome: SourceRequestOutcome): void {
  counts.attempted += 1;
  counts[outcome] += 1;
}

function emptyCounts(): Counts {
  return { attempted: 0, failed: 0, succeeded: 0 };
}

function emptyTelemetry(): StoredSourceRequestTelemetry {
  return {
    buckets: [],
    firstRecordedAt: null,
    lastRecordedAt: null,
    schemaVersion: 1,
    totals: { feed: emptyCounts(), navigation: emptyCounts() },
  };
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function filesystemErrorCode(error: unknown): null | string {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}
