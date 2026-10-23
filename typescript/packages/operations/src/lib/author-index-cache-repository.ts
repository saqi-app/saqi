import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";

const StateSchema = z.strictObject({
  bootstrapGeneration: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  dirty: z.number().int().min(0).max(1),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export interface PendingAuthorIndexCache {
  bootstrapGeneration: null | number;
  generation: number;
}

// eslint-disable-next-line @sarj/require-port-for-service, @sarj/require-interface-for-exported-class -- One concrete D1 outbox; real-SQL tests verify trigger and acknowledgement ownership.
export class AuthorIndexCacheRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async pending(): Promise<null | PendingAuthorIndexCache> {
    const raw = await this.#database
      .prepare(
        `SELECT generation, dirty, bootstrap_generation AS bootstrapGeneration
       FROM author_index_cache WHERE id = 1`
      )
      .first<unknown>();
    if (!raw) throw new Error("AUTHOR_INDEX_CACHE_STATE_MISSING");
    const row = StateSchema.parse(raw);
    return row.dirty === 1
      ? {
          generation: row.generation,
          bootstrapGeneration: row.bootstrapGeneration,
        }
      : null;
  }

  async requestBootstrap(): Promise<void> {
    const row = await this.#database
      .prepare(
        `UPDATE author_index_cache SET generation = generation + 1,
         bootstrap_generation = generation + 1, dirty = 1
         WHERE id = 1 RETURNING id`
      )
      .first<{ id: number }>();
    if (!row) throw new Error("AUTHOR_INDEX_CACHE_STATE_MISSING");
  }

  async reservePurge(now = Date.now()): Promise<boolean> {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - 15_000
    )
      throw new Error("INVALID_PUBLIC_CACHE_PURGE_TIME");
    const row = await this.#database
      .prepare(
        `UPDATE author_index_cache SET next_purge_at = ?1 + 15000
         WHERE id = 1 AND next_purge_at <= ?1 RETURNING id`
      )
      .bind(now)
      .first<{ id: number }>();
    // Never release a reservation: a failed response can follow a completed
    // external purge. All isolates must wait for the same durable deadline.
    return row !== null;
  }

  async acknowledge(pending: PendingAuthorIndexCache): Promise<boolean> {
    const row = await this.#database
      .prepare(
        `UPDATE author_index_cache
       SET dirty = CASE WHEN generation = ?1 THEN 0 ELSE dirty END,
           bootstrap_generation = CASE WHEN bootstrap_generation IS ?2 THEN NULL ELSE bootstrap_generation END
       WHERE id = 1 RETURNING dirty`
      )
      .bind(pending.generation, pending.bootstrapGeneration)
      .first<{ dirty: number }>();
    if (!row) throw new Error("AUTHOR_INDEX_CACHE_STATE_MISSING");
    // Content changes retain dirty work without repeating a completed bootstrap.
    // A newer deployment epoch survives an older request's acknowledgement.
    return row.dirty === 0;
  }
}
