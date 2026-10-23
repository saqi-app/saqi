import type { D1Database } from "@cloudflare/workers-types";

const COVERED_PREFIX = `SELECT id FROM poem INDEXED BY poem_public_route_cache_pending
  WHERE public_route_cache_epoch>0 AND public_route_cache_epoch<=(
    SELECT public_routes_purged_epoch FROM author_index_cache WHERE id=1)
  ORDER BY public_route_cache_epoch,id LIMIT 1000`;

// eslint-disable-next-line @sarj/require-port-for-service, @sarj/require-interface-for-exported-class -- One D1 metadata outbox; real-SQL tests verify bounded acknowledgement and generation ownership.
export class PublicRouteCacheRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async status(): Promise<{ pending: number; purgedEpoch: number }> {
    const row = await this.#database
      .prepare(
        `SELECT (EXISTS(SELECT 1 FROM poem INDEXED BY poem_public_route_cache_pending
      WHERE public_route_cache_epoch>0) OR bootstrap_generation IS NOT NULL) AS pending,public_routes_purged_epoch AS purgedEpoch
      FROM author_index_cache WHERE id=1`
      )
      .first<{ pending: number; purgedEpoch: number }>();
    if (!row) throw new Error("AUTHOR_INDEX_CACHE_STATE_MISSING");
    return row;
  }

  async recordPurge(capturedEpoch: number): Promise<void> {
    if (!Number.isSafeInteger(capturedEpoch) || capturedEpoch < 1)
      throw new RangeError("INVALID_PUBLIC_ROUTE_PURGE_EPOCH");
    const row = await this.#database
      .prepare(
        `UPDATE author_index_cache
      SET public_routes_purged_epoch=max(public_routes_purged_epoch,?1)
      WHERE id=1 RETURNING id`
      )
      .bind(capturedEpoch)
      .first();
    if (!row) throw new Error("AUTHOR_INDEX_CACHE_STATE_MISSING");
  }

  async acknowledge(): Promise<{ acknowledged: number; pending: boolean }> {
    // Select the bounded indexed prefix BEFORE filtering mismatched cache
    // generations. Stale captures must not force a corpus-sized candidate scan.
    const changed = await this.#database
      .prepare(
        `UPDATE poem SET
      publication_cache_dirty=0,publication_cache_generation=publication_cache_generation+1,
      public_route_cache_epoch=0,public_route_cache_generation=0
      WHERE id IN (${COVERED_PREFIX}) AND publication_cache_dirty=1
        AND publication_cache_generation=public_route_cache_generation RETURNING id`
      )
      .all();
    // A newer publication keeps its own dirty flag and generation. Retiring
    // only its obsolete route receipt cannot acknowledge that newer work.
    await this.#database
      .prepare(
        `UPDATE poem SET public_route_cache_epoch=0,public_route_cache_generation=0
      WHERE id IN (${COVERED_PREFIX}) AND (publication_cache_dirty=0
        OR publication_cache_generation<>public_route_cache_generation)`
      )
      .run();
    const row = await this.#database
      .prepare(`SELECT EXISTS(${COVERED_PREFIX}) AS pending`)
      .first<{ pending: number }>();
    return {
      acknowledged: changed.results.length,
      pending: row?.pending === 1,
    };
  }
}
