import type { D1Database } from "@cloudflare/workers-types";
import { canonicalJson, sitemapShardForId } from "@saqi/precedent-iso";
import { z } from "zod";

const UnsafeControl =
  // eslint-disable-next-line no-control-regex -- The public catalog rejects these exact code points.
  /[\u{0000}-\u{0008}\u{000b}\u{000c}\u{000e}-\u{001f}\u{007f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const SafeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !UnsafeControl.test(value));
const SourceIdSchema = z
  .string()
  .max(512)
  .regex(/^[\p{L}\p{N}_.~-]+(?: [\p{L}\p{N}_.~-]+)*$/u);
const PoemIdSchema = z.string().regex(/^[1-9]\d{0,127}$/u);
const SourceUrlSchema = z.url({ protocol: /^https$/u }).max(4_096);
const RetryAfterSchema = z.number().int().nonnegative();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const DirectAuthorSchema = z.strictObject({
  sourceAuthorId: SourceIdSchema,
  sourceUrl: SourceUrlSchema,
  nameArabic: SafeTextSchema,
});
export const SourceManifestBatchSchema = z.strictObject({
  sourceAuthorId: SourceIdSchema,
  poemIds: z.array(PoemIdSchema).min(1).max(200),
});
export const DirectPoemSchema = z.strictObject({
  sourceAuthorId: SourceIdSchema,
  sourcePoemId: PoemIdSchema,
  sourceUrl: SourceUrlSchema,
  titleArabic: SafeTextSchema,
  linesArabic: z
    .array(
      z
        .string()
        .max(4_096)
        .refine((value) => !UnsafeControl.test(value))
    )
    .min(1)
    .max(2_000)
    .refine((lines) => lines.some((line) => line.trim() !== "")),
  expectedHash: HashSchema.nullable(),
});

export type DirectAuthorInput = z.infer<typeof DirectAuthorSchema>;
export type DirectPoemInput = z.infer<typeof DirectPoemSchema>;

const AuthorRowSchema = z.object({ id: z.string() });
const PoemRowSchema = z.object({
  id: z.string(),
  authorId: z.string().nullable(),
  sourceHash: HashSchema.nullable(),
});
type StoredPoem = z.infer<typeof PoemRowSchema>;

const AuthorBySourceSql = `SELECT id FROM author WHERE source_author_id = ?1`;

export interface AuthorUpsertResult {
  id: string;
  status: "created" | "updated";
}

export interface PoemUpsertResult {
  id: string;
  sourceHash: string;
  status: "created" | "unchanged" | "updated";
}

export class DirectSourceConflictError extends Error {
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "DirectSourceConflictError";
  }
}

/** Canonical rows own the current source key and content; no import ledger is written. */
// eslint-disable-next-line @sarj/require-port-for-service, @sarj/require-interface-for-exported-class -- One concrete D1 implementation; callers and real-SQL tests need no interchangeable service contract.
export class DirectSourceRepository {
  readonly #database: D1Database;
  readonly #sourceOrigin: string;

  constructor(database: D1Database, sourceOrigin: string) {
    this.#database = database;
    this.#sourceOrigin = sourceOrigin;
  }

  async sourceRetryAfter(): Promise<number> {
    const row = await this.#database
      .prepare(
        `SELECT coalesce(max(source_retry_after), 0) AS retryAfter
                FROM author`
      )
      .first<{ retryAfter: number }>();
    return row?.retryAfter ?? 0;
  }

  async deferSource(sourceAuthorId: string, retryAfter: number): Promise<void> {
    SourceIdSchema.parse(sourceAuthorId);
    RetryAfterSchema.parse(retryAfter);
    const result = await this.#database
      .prepare(
        `UPDATE author
                SET source_retry_after = max(coalesce(source_retry_after, 0), ?1)
                WHERE source_author_id = ?2 RETURNING id`
      )
      .bind(retryAfter, sourceAuthorId)
      .first<{ id: string }>();
    if (!result) throw new DirectSourceConflictError("SOURCE_AUTHOR_MISSING");
  }

  async nextAuthor(): Promise<unknown> {
    return this.#database
      .prepare(
        `SELECT id, source_author_id AS sourceAuthorId,
              source_url AS sourceUrl, name_arabic AS nameArabic,
              collected_at AS collectedAt
       FROM author WHERE source_author_id IS NOT NULL
         AND collected_at IS NULL
       ORDER BY id LIMIT 1`
      )
      .first();
  }

  async currentPoem(sourcePoemId: string): Promise<unknown> {
    PoemIdSchema.parse(sourcePoemId);
    return this.#database
      .prepare(
        `SELECT id, author_id AS authorId, source_hash AS sourceHash
       FROM poem WHERE source_poem_id = ?1`
      )
      .bind(sourcePoemId)
      .first();
  }

  async existingPoemIds(
    raw: z.infer<typeof SourceManifestBatchSchema>
  ): Promise<string[]> {
    const input = SourceManifestBatchSchema.parse(raw);
    const rows = await this.#database
      .prepare(
        `SELECT p.source_poem_id AS sourcePoemId
         FROM poem p JOIN author a ON a.id = p.author_id
         WHERE a.source_author_id = ?1 AND p.source_hash IS NOT NULL
           AND p.source_poem_id IN (SELECT value FROM json_each(?2))`
      )
      .bind(input.sourceAuthorId, JSON.stringify(input.poemIds))
      .all<{ sourcePoemId: string }>();
    return rows.results.map((row) => row.sourcePoemId);
  }

  async upsertAuthor(raw: DirectAuthorInput): Promise<AuthorUpsertResult> {
    const input = DirectAuthorSchema.parse(raw);
    this.#assertOrigin(input.sourceUrl);
    const existing = await this.#database
      .prepare(AuthorBySourceSql)
      .bind(input.sourceAuthorId)
      .first<unknown>();
    if (existing) {
      const id = AuthorRowSchema.parse(existing).id;
      const result = await this.#database
        .prepare(
          `UPDATE author SET name_arabic = ?1, source_url = ?2
         WHERE id = ?3 AND source_author_id = ?4 RETURNING id`
        )
        .bind(input.nameArabic, input.sourceUrl, id, input.sourceAuthorId)
        .first<{ id: string }>();
      if (result?.id !== id)
        throw new DirectSourceConflictError("AUTHOR_CHANGED");
      return { id, status: "updated" };
    }
    const legacy = await this.#database
      .prepare(`SELECT id FROM author WHERE slug = ?1 LIMIT 1`)
      .bind(input.sourceAuthorId)
      .first();
    if (legacy)
      throw new DirectSourceConflictError("UNMAPPED_AUTHOR_COLLISION");
    const sameName = await this.#database
      .prepare(
        `SELECT id FROM author WHERE source_author_id IS NULL AND name_arabic = ?1
         LIMIT 1`
      )
      .bind(input.nameArabic)
      .first();
    if (sameName)
      throw new DirectSourceConflictError("UNMAPPED_AUTHOR_COLLISION");
    const digest = await sha256(
      canonicalJson(["aldiwan", input.sourceAuthorId])
    );
    const id = await sha256(`author\u{1f}aldiwan\u{1f}${input.sourceAuthorId}`);
    const slug = `source-${digest}`;
    await this.#database
      .prepare(
        `INSERT OR IGNORE INTO author
       (id, slug, name_arabic, source_author_id, source_url, collected_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL)`
      )
      .bind(id, slug, input.nameArabic, input.sourceAuthorId, input.sourceUrl)
      .run();
    const created = await this.#database
      .prepare(AuthorBySourceSql)
      .bind(input.sourceAuthorId)
      .first<unknown>();
    if (!created)
      throw new DirectSourceConflictError("AUTHOR_IDENTITY_COLLISION");
    return { id: AuthorRowSchema.parse(created).id, status: "created" };
  }

  async completeAuthor(sourceAuthorId: string): Promise<void> {
    SourceIdSchema.parse(sourceAuthorId);
    const result = await this.#database
      .prepare(
        `UPDATE author SET collected_at = unixepoch()
         WHERE source_author_id = ?1 RETURNING id`
      )
      .bind(sourceAuthorId)
      .first<{ id: string }>();
    if (!result) throw new DirectSourceConflictError("AUTHOR_NOT_FOUND");
  }

  async upsertPoem(raw: DirectPoemInput): Promise<PoemUpsertResult> {
    const input = DirectPoemSchema.parse(raw);
    this.#assertOrigin(input.sourceUrl);
    const sourceHash = await sha256(
      canonicalJson({
        content: input.linesArabic,
        titleArabic: input.titleArabic,
      })
    );
    const author = await this.#database
      .prepare(AuthorBySourceSql)
      .bind(input.sourceAuthorId)
      .first<unknown>();
    if (!author) throw new DirectSourceConflictError("AUTHOR_NOT_FOUND");
    const authorId = AuthorRowSchema.parse(author).id;
    const storedRaw = await this.currentPoem(input.sourcePoemId);
    const stored = storedRaw ? PoemRowSchema.parse(storedRaw) : null;
    if (stored) return this.#updatePoem(input, sourceHash, authorId, stored);
    return this.#insertPoem(input, sourceHash, authorId);
  }

  async #updatePoem(
    input: DirectPoemInput,
    sourceHash: string,
    authorId: string,
    stored: StoredPoem
  ): Promise<PoemUpsertResult> {
    if (stored.authorId !== authorId)
      throw new DirectSourceConflictError("POEM_AUTHOR_CONFLICT");
    if (stored.sourceHash === null)
      throw new DirectSourceConflictError("SOURCE_HASH_UNRECONCILED");
    if (stored.sourceHash === sourceHash)
      return { id: stored.id, sourceHash, status: "unchanged" };
    if (stored.sourceHash !== input.expectedHash)
      throw new DirectSourceConflictError("SOURCE_CHANGED");
    const contentArabic = JSON.stringify({
      content: input.linesArabic,
      titleArabic: input.titleArabic,
    });
    const updated = await this.#database
      .prepare(
        `UPDATE poem SET name_arabic = ?1, content_arabic = ?2,
                verses = ?3, source_hash = ?4,
                publication_cache_dirty = 1
         WHERE id = ?5 AND author_id = ?6 AND source_hash = ?7
         RETURNING id`
      )
      .bind(
        input.titleArabic,
        contentArabic,
        Math.ceil(input.linesArabic.length / 2),
        sourceHash,
        stored.id,
        authorId,
        input.expectedHash
      )
      .first<{ id: string }>();
    if (updated?.id !== stored.id)
      throw new DirectSourceConflictError("SOURCE_CHANGED");
    return { id: stored.id, sourceHash, status: "updated" };
  }

  async #insertPoem(
    input: DirectPoemInput,
    sourceHash: string,
    authorId: string
  ): Promise<PoemUpsertResult> {
    if (input.expectedHash !== null)
      throw new DirectSourceConflictError("SOURCE_CHANGED");
    // Without an established source key, changed title/text cannot prove that
    // an incoming poem is new. Resolve this author's legacy identities first.
    const unmapped = await this.#database
      .prepare(
        `SELECT id FROM poem WHERE author_id = ?1 AND source_poem_id IS NULL
         LIMIT 1`
      )
      .bind(authorId)
      .first();
    if (unmapped)
      throw new DirectSourceConflictError("UNMAPPED_POEM_COLLISION");
    // Old unmapped poems often use the source's poemNNN slug. Never merge by
    // slug: a collision requires explicit identity review.
    const legacy = await this.#database
      .prepare(`SELECT id FROM poem WHERE slug = ?1 LIMIT 1`)
      .bind(`poem${input.sourcePoemId}`)
      .first();
    if (legacy) throw new DirectSourceConflictError("UNMAPPED_POEM_COLLISION");
    const id = await sha256(`poem\u{1f}aldiwan\u{1f}${input.sourcePoemId}`);
    const contentArabic = JSON.stringify({
      content: input.linesArabic,
      titleArabic: input.titleArabic,
    });
    await this.#database
      .prepare(
        `INSERT OR IGNORE INTO poem
       (id, author_id, slug, verses, name_arabic, content_arabic,
        sitemap_shard, source_poem_id, source_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        id,
        authorId,
        `source-${id}`,
        Math.ceil(input.linesArabic.length / 2),
        input.titleArabic,
        contentArabic,
        sitemapShardForId(id),
        input.sourcePoemId,
        sourceHash
      )
      .run();
    const createdRaw = await this.currentPoem(input.sourcePoemId);
    if (!createdRaw)
      throw new DirectSourceConflictError("POEM_IDENTITY_COLLISION");
    const created = PoemRowSchema.parse(createdRaw);
    if (created.authorId !== authorId || created.sourceHash !== sourceHash)
      throw new DirectSourceConflictError("POEM_IDENTITY_COLLISION");
    return { id: created.id, sourceHash, status: "created" };
  }

  #assertOrigin(value: string): void {
    if (new URL(value).origin !== this.#sourceOrigin)
      throw new DirectSourceConflictError("SOURCE_ORIGIN_MISMATCH");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
