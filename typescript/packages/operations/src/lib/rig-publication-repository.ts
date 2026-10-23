import type { D1Database } from "@cloudflare/workers-types";
import { wordGlossesFromMeanings } from "@saqi/precedent-iso";
import { z } from "zod";

import { PublicationSnapshotSchema } from "../../../site/src/lib/publication-snapshot";
import { RequiredSql } from "./rig-requirements";

const ClearCacheDirtySql = `UPDATE poem SET publication_cache_dirty = 0,
       publication_cache_generation = publication_cache_generation + 1
       WHERE id = ?1 AND publication_cache_dirty = 1
       AND publication_hash IS ?2 AND source_hash IS ?3
       AND publication_cache_generation = ?6
       AND EXISTS (SELECT 1 FROM author a WHERE a.id = poem.author_id
         AND a.name_arabic = ?4 AND a.slug = ?5)`;

const PendingPurgeColumnsSql = `SELECT p.id AS poemId, p.publication_hash AS publicationHash,
  p.source_hash AS sourceHash, p.publication_cache_generation AS cacheGeneration,
  a.slug AS authorSlug, a.name_arabic AS authorName
  FROM poem p JOIN author a ON a.id = p.author_id
  WHERE p.publication_cache_dirty = 1`;
// Both statements are fixed alternatives; request values remain bound.
const PendingPurgeSql = `${PendingPurgeColumnsSql} ORDER BY p.id LIMIT 1`;
const PendingPoemPurgeSql = `${PendingPurgeColumnsSql} AND p.id = ?1 ORDER BY p.id LIMIT 1`;
const ClaimedSourceSql = `SELECT p.id AS poemId, a.name_arabic AS authorName,
  p.name_arabic AS titleArabic, p.content_arabic AS contentArabic,
  p.source_hash AS sourceHash, p.rig_version AS version,
  coalesce(json_extract(p.rig_checkpoint_json, '$.required'), ${RequiredSql}) AS requiredJson
  FROM poem p JOIN author a ON a.id = p.author_id
  WHERE p.id = ?1 AND p.rig_status = 'claimed'
    AND p.rig_lease_token = ?2 AND p.rig_lease_expires_at > ?3`;

const UnsafeControl =
  // eslint-disable-next-line no-control-regex -- These exact control characters cannot be published.
  /[\u{0000}-\u{0008}\u{000b}\u{000c}\u{000e}-\u{001f}\u{007f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const SafeLineSchema = z
  .string()
  .max(5_000)
  .refine((line) => !UnsafeControl.test(line));
const GeneratedFailure =
  /(?:unable to translate|cannot translate|can't translate|i(?:'| a)m sorry.{0,80}translat|as an ai\b|translation guidelines|translate the following|provide (?:a )?summary instead)/iu;
const TranslatedLineSchema = SafeLineSchema.refine(
  (line) => !GeneratedFailure.test(line)
);
const InsightTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .refine((value) => !UnsafeControl.test(value));
const ModelLabelSchema = z.string().trim().min(1).max(100);
const ComponentSchema = z.enum(["translation", "wordMeanings"]);
const RequiredSchema = z.array(ComponentSchema).min(1).max(2);
const OutputSchema = z.object({
  translation: z
    .strictObject({
      lines: z.array(TranslatedLineSchema).min(1).max(2_000),
    })
    .optional(),
  wordMeanings: z
    .array(z.array(InsightTextSchema.max(2_000)).max(5_000))
    .min(1)
    .max(2_000)
    .optional(),
});
const SourceSchema = z.object({
  poemId: z.string(),
  authorName: z.string(),
  titleArabic: z.string(),
  contentArabic: z.string(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().nonnegative(),
  requiredJson: z.string(),
});
const PublishRowSchema = z.object({
  publicationJson: z.string().nullable(),
  publicationHash: z.string().nullable(),
  status: z.enum(["claimed", "blocked"]),
  checkpointJson: z.string(),
  contentArabic: z.string(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().nonnegative(),
});
const CheckpointSchema = z.object({
  required: RequiredSchema.optional(),
  reasoningEffort: z.string().optional(),
  model: ModelLabelSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputs: z.object({ generation: z.unknown() }),
});
const PublicationReadRowSchema = z.object({
  canonicalAuthorSlug: z.string(),
  canonicalPoemSlug: z.string(),
  authorSlug: z.string(),
  sourceHash: z.string().nullable(),
  publicationSourceHash: z.string().nullable(),
  publicationHash: z.string().nullable(),
  cacheDirty: z.number().int().min(0).max(1),
  publicationJson: z.string().nullable(),
});
const ArabicSchema = z.object({
  content: z.array(SafeLineSchema).min(1).max(2_000),
});

export type RigSourcePoem = Omit<
  z.infer<typeof SourceSchema>,
  "contentArabic" | "requiredJson"
> & {
  readonly linesArabic: readonly string[];
  readonly required: z.infer<typeof RequiredSchema>;
};

const PendingPurgeRouteSchema = z.strictObject({
  authorName: z.string(),
  authorSlug: z.string(),
  cacheGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  poemId: z.string(),
  publicationHash: z.string().nullable(),
  sourceHash: z.string().nullable(),
});
type PendingPurgeRoute = z.infer<typeof PendingPurgeRouteSchema>;

// eslint-disable-next-line @sarj/require-port-for-service, @sarj/require-interface-for-exported-class -- One concrete D1 implementation; callers and real-SQL tests need no interchangeable service contract.
export class RigPublicationRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async readPublication(poemId: string) {
    const raw = await this.#database
      .prepare(
        `SELECT a.slug AS authorSlug, coalesce(n.canonical_slug,a.slug) AS canonicalAuthorSlug,
       coalesce(p.public_slug,p.id) AS canonicalPoemSlug, p.source_hash AS sourceHash,
       p.publication_source_hash AS publicationSourceHash,
       p.publication_hash AS publicationHash,
       p.publication_cache_dirty AS cacheDirty,
       p.publication_json AS publicationJson
       FROM poem p JOIN author a ON a.id = p.author_id
       LEFT JOIN public_author_namespace n ON n.author_id=a.id WHERE p.id = ?1`
      )
      .bind(poemId)
      .first<unknown>();
    if (raw === null) return null;
    const { publicationJson, ...metadata } =
      PublicationReadRowSchema.parse(raw);
    if (publicationJson === null) return null;
    return {
      ...metadata,
      snapshot: PublicationSnapshotSchema.parse(JSON.parse(publicationJson)),
    };
  }

  async pendingPurge(poemId?: string): Promise<null | PendingPurgeRoute> {
    const statement = this.#database.prepare(
      poemId === undefined ? PendingPurgeSql : PendingPoemPurgeSql
    );
    const raw = await (
      poemId === undefined ? statement : statement.bind(poemId)
    ).first<unknown>();
    return raw === null ? null : PendingPurgeRouteSchema.parse(raw);
  }

  async pendingPurges(): Promise<PendingPurgeRoute[]> {
    const result = await this.#database
      .prepare(
        `SELECT p.id AS poemId, p.publication_hash AS publicationHash,
        p.source_hash AS sourceHash, p.publication_cache_generation AS cacheGeneration,
        a.slug AS authorSlug,
        a.name_arabic AS authorName
       FROM poem p INDEXED BY poem_publication_cache_dirty
       JOIN author a ON a.id = p.author_id
       WHERE p.publication_cache_dirty = 1
       ORDER BY p.id LIMIT 50`
      )
      .all<unknown>();
    return PendingPurgeRouteSchema.array().parse(result.results);
  }

  async clearCacheDirtyBatch(
    rows: readonly PendingPurgeRoute[]
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const results = await this.#database.batch(
      rows.map((row) =>
        this.#database
          .prepare(ClearCacheDirtySql)
          .bind(
            row.poemId,
            row.publicationHash,
            row.sourceHash,
            row.authorName,
            row.authorSlug,
            row.cacheGeneration
          )
      )
    );
    return results.reduce((count, result) => count + result.meta.changes, 0);
  }

  async clearCacheDirty(row: PendingPurgeRoute): Promise<boolean> {
    const result = await this.#database
      .prepare(ClearCacheDirtySql)
      .bind(
        row.poemId,
        row.publicationHash,
        row.sourceHash,
        row.authorName,
        row.authorSlug,
        row.cacheGeneration
      )
      .run();
    return result.meta.changes === 1;
  }

  async readClaimedSource(
    poemId: string,
    token: string,
    now: number
  ): Promise<null | RigSourcePoem> {
    const raw = await this.#database
      .prepare(ClaimedSourceSql)
      .bind(poemId, token, now)
      .first<unknown>();
    if (!raw) return null;
    const { contentArabic, requiredJson, ...source } = SourceSchema.parse(raw);
    const arabic = ArabicSchema.parse(JSON.parse(contentArabic));
    return {
      ...source,
      linesArabic: arabic.content,
      required: RequiredSchema.parse(JSON.parse(requiredJson)),
    };
  }

  async publish(
    poemId: string,
    expectedVersion: number
  ): Promise<"blocked" | boolean> {
    try {
      return await this.#publish(poemId, expectedVersion);
    } catch (error) {
      const invalid =
        error instanceof z.ZodError ||
        (error instanceof Error &&
          /^(GENERATION_COMPONENT_|GLOSS_|TRANSLATION_LINE_COUNT_MISMATCH$|TRANSLATION_HAS_BLANK_LINE$)/u.test(
            error.message
          ));
      if (!invalid) throw error;
      // A known, acknowledged invalid result must not block unrelated poems.
      // Keep its checkpoint for review; never automatically invoke Codex again.
      const blocked = await this.#database
        .prepare(
          `UPDATE poem
        SET rig_status = 'blocked', rig_version = rig_version + 1,
            rig_lease_token = NULL, rig_lease_expires_at = NULL
        WHERE id = ?1 AND rig_status IN ('claimed', 'blocked') AND rig_version = ?2
          AND rig_checkpoint_json IS NOT NULL`
        )
        .bind(poemId, expectedVersion)
        .run();
      if (blocked.meta.changes !== 1) return false;
      console.warn("[ops] Publication retained for review", {
        poemId,
        code: error instanceof Error ? error.message : "INVALID_OUTPUT",
      });
      return "blocked";
    }
  }

  async #publish(poemId: string, expectedVersion: number): Promise<boolean> {
    const raw = await this.#database
      .prepare(
        `SELECT rig_status AS status, rig_checkpoint_json AS checkpointJson,
              content_arabic AS contentArabic, source_hash AS sourceHash,
              rig_version AS version, publication_json AS publicationJson,
              publication_hash AS publicationHash
       FROM poem WHERE id = ?1`
      )
      .bind(poemId)
      .first<unknown>();
    const parsed = PublishRowSchema.safeParse(raw);
    if (!parsed.success || parsed.data.version !== expectedVersion)
      return false;
    const row = parsed.data;
    const checkpoint = CheckpointSchema.parse(JSON.parse(row.checkpointJson));
    if (checkpoint.sourceHash !== row.sourceHash) {
      // Known output for obsolete Arabic is safe to supersede. Public data stays.
      await this.#database
        .prepare(
          `UPDATE poem SET rig_status = 'retry',
        rig_version = rig_version + 1, rig_lease_token = NULL,
        rig_lease_expires_at = NULL
        WHERE id = ?1 AND rig_status IN ('claimed', 'blocked') AND rig_version = ?2
          AND rig_checkpoint_json = ?3`
        )
        .bind(poemId, expectedVersion, row.checkpointJson)
        .run();
      return false;
    }
    const { output, arabic } = validatedGeneration(
      checkpoint,
      row.contentArabic
    );
    const existing = row.publicationJson
      ? PublicationSnapshotSchema.parse(JSON.parse(row.publicationJson)).fields
      : {};
    const fields = { ...existing };
    if (output.translation) {
      fields.modelEnrichments = [
        ...(existing.modelEnrichments ?? []).filter(
          (track) => track.modelKey !== "saqi-current"
        ),
        {
          lines: output.translation.lines,
          model: checkpoint.model,
          modelKey: "saqi-current",
          reasoningEffort: checkpoint.reasoningEffort ?? "unknown",
          vendorKey: "openai",
        },
      ];
    }
    if (output.wordMeanings)
      fields.wordGlosses = {
        sourceHash: row.sourceHash,
        model: checkpoint.model,
        meanings: wordGlossesFromMeanings(arabic.content, output.wordMeanings),
      };
    const publication = JSON.stringify(
      PublicationSnapshotSchema.parse({
        schemaVersion: 2,
        active: true,
        fields,
      })
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(publication)
    );
    const publicationHash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const result = await this.#database
      .prepare(
        `UPDATE poem
       SET publication_json = ?1, publication_source_hash = ?2,
           publication_hash = ?3, publication_cache_dirty = 1,
           rig_status = 'complete',
           rig_version = rig_version + 1,
           rig_checkpoint_json = NULL, rig_lease_token = NULL,
           rig_lease_expires_at = NULL
       WHERE id = ?4 AND rig_status IN ('claimed', 'blocked') AND rig_version = ?5
         AND source_hash = ?2 AND rig_checkpoint_json = ?6
         AND publication_hash IS ?7 RETURNING id`
      )
      .bind(
        publication,
        row.sourceHash,
        publicationHash,
        poemId,
        expectedVersion,
        row.checkpointJson,
        row.publicationHash
      )
      .first<{ id: string }>();
    return result?.id === poemId;
  }
}

function validatedGeneration(
  checkpoint: z.infer<typeof CheckpointSchema>,
  contentArabic: string
) {
  const output = OutputSchema.parse(checkpoint.outputs.generation);
  const required = checkpoint.required ?? ["translation", "wordMeanings"];
  if (
    (required.includes("translation") && !output.translation) ||
    (required.includes("wordMeanings") && !output.wordMeanings)
  )
    throw new Error("GENERATION_COMPONENT_MISSING");
  if (
    Object.keys(output).some(
      (component) => !required.includes(ComponentSchema.parse(component))
    )
  )
    throw new Error("GENERATION_COMPONENT_UNREQUESTED");
  const arabic = ArabicSchema.parse(JSON.parse(contentArabic));
  if (output.translation) {
    if (output.translation.lines.length !== arabic.content.length)
      throw new Error("TRANSLATION_LINE_COUNT_MISMATCH");
    if (
      output.translation.lines.some(
        (line, index) => arabic.content[index]?.trim() && !line.trim()
      )
    )
      throw new Error("TRANSLATION_HAS_BLANK_LINE");
  }
  return { output, arabic };
}
