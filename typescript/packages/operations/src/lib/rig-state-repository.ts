import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";

import {
  EnrichmentPrioritySql,
  NeedsEnrichmentSql,
  RequiredSql,
} from "./rig-requirements";

const TokenSchema = z.uuid();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const InvocationSchema = z.object({
  attemptId: TokenSchema,
  deadlineAt: z.number().int(),
  inputHash: HashSchema,
  model: z.string().trim().min(1).max(100),
  reasoningEffort: z.string().trim().min(1).max(30).optional(),
  startedAt: z.number().int(),
  state: z.literal("possible_dispatch"),
});
const CheckpointSchema = z.object({
  model: z.string().trim().min(1).max(100).optional(),
  reasoningEffort: z.string().optional(),
  phase: z.enum(["generation", "publish"]),
  sourceHash: HashSchema,
  required: z.array(z.enum(["translation", "wordMeanings"])).optional(),
  invocation: InvocationSchema.optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
});
const StateRowSchema = z.object({
  poemId: z.string(),
  status: z
    .enum(["claimed", "dispatching", "unknown", "retry", "blocked", "complete"])
    .nullable(),
  version: z.number().int().nonnegative(),
  leaseToken: z.string().nullable(),
  leaseExpiresAt: z.number().int().nullable(),
  checkpointJson: z.string().nullable(),
});

const QueueDiagnosticsTimeSchema = z.number().int().nonnegative();
const QueueCountSchema = z.object({
  status: z.enum(["claimed", "dispatching", "unknown"]),
  poems: z.number().int().nonnegative(),
  activeSlots: z.number().int().nonnegative(),
});
const QueueCountsSchema = z.array(QueueCountSchema);
const ExpiredDispatchSchema = z.object({
  poemId: z.string(),
  version: z.number().int().nonnegative(),
  leaseExpiresAt: z.number().int(),
  attemptId: z.string().nullable(),
});

const ExpiredDispatchesSchema = z.array(ExpiredDispatchSchema);

export type RigStateRow = z.infer<typeof StateRowSchema>;

export interface RigCandidateCursor {
  afterPoemId: string;
  priority: number;
}

export interface InvocationIntent {
  readonly attemptId: string;
  readonly deadlineAt: number;
  readonly inputHash: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly startedAt: number;
}

/** Pending work is derived from canonical poems; only in-flight state persists. */
// eslint-disable-next-line @sarj/require-port-for-service, @sarj/require-interface-for-exported-class -- One concrete D1 implementation; callers and real-SQL tests need no interchangeable service contract.
export class RigStateRepository {
  readonly #database: D1Database;
  readonly #candidateCursor: RigCandidateCursor;

  constructor(database: D1Database, candidateCursor?: RigCandidateCursor) {
    this.#database = database;
    this.#candidateCursor = candidateCursor ?? { afterPoemId: "", priority: 0 };
  }

  async read(poemId: string): Promise<null | RigStateRow> {
    const raw = await this.#database
      .prepare(
        `SELECT id AS poemId, rig_status AS status, rig_version AS version,
                rig_lease_token AS leaseToken,
                rig_lease_expires_at AS leaseExpiresAt,
                rig_checkpoint_json AS checkpointJson
         FROM poem WHERE id = ?1`
      )
      .bind(poemId)
      .first<unknown>();
    return raw === null ? null : StateRowSchema.parse(raw);
  }

  async readUnknownAttempt(attemptId: string): Promise<null | RigStateRow> {
    TokenSchema.parse(attemptId);
    const raw = await this.#database
      .prepare(
        `SELECT id AS poemId, rig_status AS status, rig_version AS version,
                rig_lease_token AS leaseToken,
                rig_lease_expires_at AS leaseExpiresAt,
                rig_checkpoint_json AS checkpointJson
         FROM poem INDEXED BY poem_rig_active
         WHERE rig_status IN ('claimed', 'dispatching', 'unknown')
           AND rig_status = 'unknown'
           AND json_extract(rig_checkpoint_json, '$.invocation.attemptId') = ?1
         LIMIT 1`
      )
      .bind(attemptId)
      .first<unknown>();
    return raw === null ? null : StateRowSchema.parse(raw);
  }

  async currentEnrichment(): Promise<null | RigStateRow> {
    const raw = await this.#database
      .prepare(
        `SELECT id AS poemId, rig_status AS status, rig_version AS version,
                rig_lease_token AS leaseToken,
                rig_lease_expires_at AS leaseExpiresAt,
                rig_checkpoint_json AS checkpointJson
         FROM poem WHERE rig_status IN ('claimed', 'dispatching', 'unknown')
         ORDER BY CASE WHEN rig_status = 'unknown' THEN 1 ELSE 0 END,
                  id LIMIT 1`
      )
      .first<unknown>();
    return raw === null ? null : StateRowSchema.parse(raw);
  }

  async queueDiagnostics(now: number) {
    QueueDiagnosticsTimeSchema.parse(now);
    const counts = await this.#database
      .prepare(
        `SELECT rig_status AS status, count(*) AS poems,
          sum(CASE WHEN rig_status = 'dispatching'
            OR (rig_status = 'claimed' AND rig_lease_expires_at > ?1)
            THEN 1 ELSE 0 END) AS activeSlots
         FROM poem INDEXED BY poem_rig_active
         WHERE rig_status IN ('claimed', 'dispatching', 'unknown')
         GROUP BY rig_status`
      )
      .bind(now)
      .all();
    const expired = await this.#database
      .prepare(
        `SELECT id AS poemId, rig_version AS version,
          rig_lease_expires_at AS leaseExpiresAt,
          json_extract(rig_checkpoint_json, '$.invocation.attemptId') AS attemptId
         FROM poem INDEXED BY poem_rig_active
         WHERE rig_status IN ('claimed', 'dispatching', 'unknown')
           AND rig_status = 'dispatching' AND rig_lease_expires_at <= ?1
         ORDER BY id LIMIT 80`
      )
      .bind(now)
      .all();
    const states = QueueCountsSchema.parse(counts.results);
    return {
      checkedAt: now,
      activeSlots: states.reduce((total, row) => total + row.activeSlots, 0),
      states,
      expiredDispatches: ExpiredDispatchesSchema.parse(expired.results),
    };
  }

  async claimNextPoem(
    token: string,
    now: number,
    preferredPoemId?: string,
    maxConcurrent = 1
  ): Promise<null | RigStateRow> {
    TokenSchema.parse(token);
    z.number().int().min(1).max(80).parse(maxConcurrent);
    if (maxConcurrent > 1) {
      const candidate =
        preferredPoemId ??
        (await this.#nextRetryPoem()) ??
        (await this.#nextDuePoem(now, maxConcurrent));
      return candidate
        ? this.#claimPoem(candidate, token, now, maxConcurrent)
        : null;
    }
    const current = await this.currentEnrichment();
    // An unknown result stays on its own poem for exact recovery or review.
    // It cannot be claimed again, but it must not freeze unrelated poems.
    const active = current?.status === "unknown" ? null : current;
    if (preferredPoemId) {
      if (active && active.poemId !== preferredPoemId) return null;
      return this.#claimPoem(preferredPoemId, token, now);
    }
    if (active) {
      if (
        active.status !== "claimed" ||
        (active.leaseExpiresAt !== null && active.leaseExpiresAt > now)
      )
        return null;
      const recovered = await this.#claimPoem(active.poemId, token, now);
      if (recovered) return recovered;
    }
    const retryId = await this.#nextRetryPoem();
    if (retryId) {
      const retried = await this.#claimPoem(retryId, token, now);
      if (retried) return retried;
    }
    const dueId = await this.#nextDuePoem(now);
    return dueId ? this.#claimPoem(dueId, token, now) : null;
  }

  async beginInvocation(
    poemId: string,
    token: string,
    expectedVersion: number,
    intent: InvocationIntent
  ): Promise<boolean> {
    TokenSchema.parse(token);
    TokenSchema.parse(intent.attemptId);
    HashSchema.parse(intent.inputHash);
    InvocationSchema.shape.model.parse(intent.model);
    if (intent.deadlineAt <= intent.startedAt)
      throw new Error("INVALID_DEADLINE");
    const row = await this.read(poemId);
    if (row?.status !== "claimed" || row.version !== expectedVersion)
      return false;
    const checkpoint = CheckpointSchema.parse(
      JSON.parse(row.checkpointJson ?? "")
    );
    if (checkpoint.phase !== "generation" || checkpoint.invocation)
      throw new Error("INVALID_INVOCATION_PHASE");
    const next = JSON.stringify({
      ...checkpoint,
      model: intent.model,
      reasoningEffort: intent.reasoningEffort,
      invocation: { ...intent, state: "possible_dispatch" },
    });
    const result = await this.#database
      .prepare(
        `UPDATE poem
         SET rig_checkpoint_json = ?1, rig_status = 'dispatching',
             rig_version = rig_version + 1,
             rig_lease_expires_at = ?2
         WHERE id = ?4 AND rig_status = 'claimed'
           AND rig_lease_token = ?5 AND rig_version = ?6
           AND rig_lease_expires_at > ?3 AND source_hash = ?7`
      )
      .bind(
        next,
        intent.deadlineAt,
        intent.startedAt,
        poemId,
        token,
        expectedVersion,
        checkpoint.sourceHash
      )
      .run();
    return result.meta.changes === 1;
  }

  async markExpiredUnknown(poemId: string, now: number): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `UPDATE poem
         SET rig_status = 'unknown', rig_version = rig_version + 1,
             rig_lease_token = NULL, rig_lease_expires_at = NULL
         WHERE id = ?1 AND rig_status = 'dispatching'
           AND rig_lease_expires_at <= ?2`
      )
      .bind(poemId, now)
      .run();
    return result.meta.changes === 1;
  }

  async acknowledgeInvocation(
    poemId: string,
    attemptId: string,
    expectedVersion: number,
    output: unknown
  ): Promise<boolean> {
    TokenSchema.parse(attemptId);
    const row = await this.read(poemId);
    if (row?.version !== expectedVersion) return false;
    if (row.status !== "dispatching" && row.status !== "unknown") return false;
    const checkpoint = CheckpointSchema.parse(
      JSON.parse(row.checkpointJson ?? "")
    );
    if (checkpoint.invocation?.attemptId !== attemptId) return false;
    if (checkpoint.phase !== "generation")
      throw new Error("INVALID_PHASE_TRANSITION");
    const next = JSON.stringify({
      ...checkpoint,
      phase: "publish",
      invocation: undefined,
      outputs: { generation: output },
    });
    if (new TextEncoder().encode(next).length > 1_048_576)
      throw new Error("RIG_CHECKPOINT_TOO_LARGE");
    const result = await this.#database
      .prepare(
        `UPDATE poem
         SET rig_checkpoint_json = ?1, rig_status = 'claimed',
             rig_version = rig_version + 1,
             rig_lease_token = NULL, rig_lease_expires_at = NULL
         WHERE id = ?2 AND rig_version = ?3
           AND rig_status IN ('dispatching', 'unknown')
           AND json_extract(rig_checkpoint_json, '$.invocation.attemptId') = ?4`
      )
      .bind(next, poemId, expectedVersion, attemptId)
      .run();
    return result.meta.changes === 1;
  }

  async retryUnknown(
    poemId: string,
    attemptId: string,
    expectedVersion: number
  ): Promise<boolean> {
    TokenSchema.parse(attemptId);
    const result = await this.#database
      .prepare(
        `UPDATE poem
         SET rig_status = 'retry', rig_version = rig_version + 1,
             rig_checkpoint_json = NULL
         WHERE id = ?1 AND rig_status = 'unknown' AND rig_version = ?2
           AND json_extract(rig_checkpoint_json, '$.invocation.attemptId') = ?3`
      )
      .bind(poemId, expectedVersion, attemptId)
      .run();
    return result.meta.changes === 1;
  }

  async #nextRetryPoem(): Promise<null | string> {
    const candidate = await this.#database
      .prepare(
        `SELECT p.id FROM poem p INDEXED BY poem_rig_retry
         WHERE p.rig_status = 'retry'
           AND p.source_hash IS NOT NULL
           AND EXISTS (SELECT 1 FROM author a
                       WHERE a.id = p.author_id)
           AND ${NeedsEnrichmentSql}
         ORDER BY ${EnrichmentPrioritySql}, p.id LIMIT 1`
      )
      .first<{ id: string }>();
    return candidate?.id ?? null;
  }

  async #nextDuePoem(now: number, maxConcurrent = 1): Promise<null | string> {
    const cursor = this.#candidateCursor;
    // Bound JSON work before filtering: LIMIT on the final sorted query would
    // still evaluate the entire corpus. A lost cursor only repeats safe reads.
    for (let page = 0; page < 8; page += 1) {
      const afterPoemId = cursor.afterPoemId;
      const priority = cursor.priority;
      // eslint-disable-next-line no-await-in-loop -- Read one bounded page at a time; stop as soon as eligible work is found.
      const result = await this.#database
        .prepare(
          `WITH candidates AS MATERIALIZED (
             SELECT id FROM poem WHERE id > ?1 ORDER BY id LIMIT 128
           )
           SELECT (
             SELECT p.id FROM candidates c JOIN poem p ON p.id = c.id
             WHERE p.source_hash IS NOT NULL
               AND EXISTS (SELECT 1 FROM author a WHERE a.id = p.author_id)
               AND (p.rig_status IS NULL
                 OR p.rig_status IN ('retry', 'complete')
                 OR (p.rig_status = 'claimed'
                   AND (p.rig_lease_expires_at IS NULL
                     OR p.rig_lease_expires_at <= ?2)))
               AND (?3 = 1 OR p.rig_status IS NOT 'claimed'
                 OR json_extract(p.rig_checkpoint_json, '$.phase') = 'generation')
               AND ${EnrichmentPrioritySql} = ?4
               AND ${NeedsEnrichmentSql}
             ORDER BY p.id LIMIT 1
           ) AS poemId, (SELECT max(id) FROM candidates) AS scannedThrough`
        )
        .bind(afterPoemId, now, maxConcurrent, priority)
        .first<{ poemId: null | string; scannedThrough: null | string }>();
      if (result?.poemId) return result.poemId;
      // Concurrent requests may have advanced the shared hint. Never rewind it
      // on the strength of an older page; the atomic claim remains the fence.
      if (cursor.afterPoemId !== afterPoemId || cursor.priority !== priority)
        continue;
      cursor.afterPoemId = result?.scannedThrough ?? "";
      if (!result?.scannedThrough) {
        cursor.priority = (priority + 1) % 3;
        if (cursor.priority === 0) return null;
      }
    }
    return null;
  }

  async #claimPoem(
    poemId: string,
    token: string,
    now: number,
    maxConcurrent = 1
  ): Promise<null | RigStateRow> {
    const claimed = await this.#database
      .prepare(
        `UPDATE poem
         SET rig_status = 'claimed', rig_version = rig_version + 1,
             rig_lease_token = ?1, rig_lease_expires_at = ?2 + 300,
             rig_checkpoint_json = CASE
               WHEN rig_status = 'claimed'
                 AND json_extract(rig_checkpoint_json, '$.sourceHash') = source_hash
               THEN rig_checkpoint_json
               ELSE json_object('phase', 'generation', 'sourceHash', source_hash, 'required', json(${RequiredSql}))
             END
         WHERE id = ?3 AND source_hash IS NOT NULL
           AND EXISTS (SELECT 1 FROM author a
                       WHERE a.id = poem.author_id)
           AND ${NeedsEnrichmentSql}
           AND (rig_status IS NULL OR rig_status IN ('retry', 'complete')
             OR (rig_status = 'claimed' AND
               (rig_lease_expires_at IS NULL OR rig_lease_expires_at <= ?2)))
           AND (?4 = 1 OR rig_status IS NOT 'claimed'
             OR json_extract(rig_checkpoint_json, '$.phase') = 'generation')
           AND (
             SELECT count(*) FROM poem active INDEXED BY poem_rig_active
             WHERE active.rig_status IN ('claimed', 'dispatching', 'unknown')
               AND (active.rig_status = 'dispatching'
                 OR (active.rig_status = 'claimed' AND active.id <> poem.id
                   AND active.rig_lease_expires_at > ?2))
           ) < ?4
         RETURNING id`
      )
      .bind(token, now, poemId, maxConcurrent)
      .first<{ id: string }>();
    return claimed ? this.read(claimed.id) : null;
  }
}
