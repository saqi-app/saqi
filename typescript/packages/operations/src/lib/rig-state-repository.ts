import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";

const TokenSchema = z.uuid();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const InvocationSchema = z.object({
  attemptId: TokenSchema,
  deadlineAt: z.number().int(),
  inputHash: HashSchema,
  model: z.string().trim().min(1).max(100),
  startedAt: z.number().int(),
  state: z.literal("possible_dispatch"),
});
const CheckpointSchema = z.object({
  model: z.string().trim().min(1).max(100).optional(),
  phase: z.enum(["generation", "publish"]),
  sourceHash: HashSchema,
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

export type RigStateRow = z.infer<typeof StateRowSchema>;

export interface InvocationIntent {
  readonly attemptId: string;
  readonly deadlineAt: number;
  readonly inputHash: string;
  readonly model: string;
  readonly startedAt: number;
}

/** Pending work is derived from canonical poems; only in-flight state persists. */
export class RigStateRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
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

  async currentEnrichment(): Promise<null | RigStateRow> {
    const raw = await this.#database
      .prepare(
        `SELECT id AS poemId, rig_status AS status, rig_version AS version,
                rig_lease_token AS leaseToken,
                rig_lease_expires_at AS leaseExpiresAt,
                rig_checkpoint_json AS checkpointJson
         FROM poem WHERE rig_status IN ('claimed', 'dispatching', 'unknown')
         ORDER BY rig_updated_at, id LIMIT 1`
      )
      .first<unknown>();
    return raw === null ? null : StateRowSchema.parse(raw);
  }

  async claimNextPoem(token: string, now: number): Promise<null | RigStateRow> {
    TokenSchema.parse(token);
    const claimed = await this.#database
      .prepare(
        `UPDATE poem
         SET rig_status = 'claimed', rig_version = rig_version + 1,
             rig_lease_token = ?1, rig_lease_expires_at = ?2 + 300,
             rig_checkpoint_json = CASE
               WHEN rig_status = 'claimed'
                 AND json_extract(rig_checkpoint_json, '$.sourceHash') = source_hash
               THEN rig_checkpoint_json
               ELSE json_object('phase', 'generation', 'sourceHash', source_hash)
             END,
             rig_updated_at = ?2
         WHERE id = (
           SELECT p.id FROM poem p
           WHERE p.hidden = 0 AND p.publishable = 1
             AND p.source_hash IS NOT NULL
             AND (p.publication_json IS NULL
               OR p.publication_source_hash IS NULL
               OR p.publication_source_hash <> p.source_hash)
             AND (p.rig_status IS NULL
               OR p.rig_status IN ('retry', 'complete')
               OR (p.rig_status = 'claimed'
                 AND (p.rig_lease_expires_at IS NULL
                   OR p.rig_lease_expires_at <= ?2)))
           ORDER BY CASE p.rig_status
             WHEN 'claimed' THEN 0 WHEN 'retry' THEN 1 ELSE 2 END,
                    p.rig_updated_at, p.id LIMIT 1
         )
           AND NOT EXISTS (
             SELECT 1 FROM poem active
             WHERE active.rig_status IN ('dispatching', 'unknown')
               OR (active.rig_status = 'claimed' AND active.id <> poem.id
                 AND active.rig_lease_expires_at > ?2)
           )
         RETURNING id`
      )
      .bind(token, now)
      .first<{ id: string }>();
    return claimed ? this.read(claimed.id) : null;
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
      invocation: { ...intent, state: "possible_dispatch" },
    });
    const result = await this.#database
      .prepare(
        `UPDATE poem
         SET rig_checkpoint_json = ?1, rig_status = 'dispatching',
             rig_version = rig_version + 1,
             rig_lease_expires_at = ?2, rig_updated_at = ?3
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
             rig_lease_token = NULL, rig_lease_expires_at = NULL,
             rig_last_error = 'CODEX_OUTCOME_UNKNOWN',
             rig_updated_at = ?2
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
             rig_last_error = NULL,
             rig_lease_token = NULL, rig_lease_expires_at = NULL,
             rig_updated_at = unixepoch()
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
             rig_checkpoint_json = NULL,
             rig_last_error = 'MANUAL_RETRY_OF_UNKNOWN_ATTEMPT',
             rig_updated_at = unixepoch()
         WHERE id = ?1 AND rig_status = 'unknown' AND rig_version = ?2
           AND json_extract(rig_checkpoint_json, '$.invocation.attemptId') = ?3`
      )
      .bind(poemId, expectedVersion, attemptId)
      .run();
    return result.meta.changes === 1;
  }
}
