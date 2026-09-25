import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";

const UnsafeControl =
  // eslint-disable-next-line no-control-regex -- These exact control characters cannot be published.
  /[\u{0000}-\u{0008}\u{000b}\u{000c}\u{000e}-\u{001f}\u{007f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const SafeLineSchema = z
  .string()
  .max(5_000)
  .refine((line) => !UnsafeControl.test(line));
const GeneratedFailure =
  /(?:roses are red|unable to translate|cannot translate|can't translate|i(?:'| a)m sorry.{0,80}translat|as an ai|translation guidelines|translate the following|provide (?:a )?summary instead)/iu;
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
const InsightsSchema = z.strictObject({
  summary: InsightTextSchema,
  themes: z.array(InsightTextSchema).min(1).max(100),
  historicalContext: InsightTextSchema,
  literaryDevices: z.array(InsightTextSchema).min(1).max(100),
  culturalSignificance: InsightTextSchema,
  notableLines: z
    .array(
      z.strictObject({
        line: InsightTextSchema,
        explanation: InsightTextSchema,
      })
    )
    .min(1)
    .max(100),
});
const OutputSchema = z.strictObject({
  translation: z.strictObject({
    lines: z.array(TranslatedLineSchema).min(1).max(2_000),
  }),
  insights: InsightsSchema,
});
const SourceSchema = z.object({
  poemId: z.string(),
  authorName: z.string(),
  titleArabic: z.string(),
  contentArabic: z.string(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().nonnegative(),
});
const PublishRowSchema = z.object({
  status: z.literal("claimed"),
  checkpointJson: z.string(),
  contentArabic: z.string(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().nonnegative(),
});
const CheckpointSchema = z.object({
  model: ModelLabelSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputs: z.object({ generation: z.unknown() }),
});
const ArabicSchema = z.object({
  content: z.array(SafeLineSchema).min(1).max(2_000),
});

export type RigSourcePoem = z.infer<typeof SourceSchema> & {
  readonly linesArabic: readonly string[];
};

interface PendingPurgeRoute {
  authorSlug: string;
  poemId: string;
  publicationHash: string;
}

export class RigPublicationRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async pendingPurge(poemId?: string): Promise<null | PendingPurgeRoute> {
    return this.#database
      .prepare(
        `SELECT p.id AS poemId, p.publication_hash AS publicationHash,
              a.slug AS authorSlug
       FROM poem p JOIN author a ON a.id = p.author_id
       WHERE p.publication_cache_dirty = 1
         AND (?1 IS NULL OR p.id = ?1)
       ORDER BY p.id LIMIT 1`
      )
      .bind(poemId ?? null)
      .first<PendingPurgeRoute>();
  }

  async clearCacheDirty(
    poemId: string,
    publicationHash: string
  ): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `UPDATE poem SET publication_cache_dirty = 0
       WHERE id = ?1 AND publication_hash = ?2`
      )
      .bind(poemId, publicationHash)
      .run();
    return result.meta.changes === 1;
  }

  async readClaimedSource(
    poemId: string,
    token: string,
    now: number
  ): Promise<null | RigSourcePoem> {
    const raw = await this.#database
      .prepare(
        `SELECT p.id AS poemId, a.name_arabic AS authorName,
              p.name_arabic AS titleArabic, p.content_arabic AS contentArabic,
              p.source_hash AS sourceHash, p.rig_version AS version
       FROM poem p JOIN author a ON a.id = p.author_id
       WHERE p.id = ?1 AND p.rig_status = 'claimed'
         AND p.rig_lease_token = ?2 AND p.rig_lease_expires_at > ?3`
      )
      .bind(poemId, token, now)
      .first<unknown>();
    if (!raw) return null;
    const source = SourceSchema.parse(raw);
    const arabic = ArabicSchema.parse(JSON.parse(source.contentArabic));
    return { ...source, linesArabic: arabic.content };
  }

  async publish(poemId: string, expectedVersion: number): Promise<boolean> {
    const raw = await this.#database
      .prepare(
        `SELECT rig_status AS status, rig_checkpoint_json AS checkpointJson,
              content_arabic AS contentArabic, source_hash AS sourceHash,
              rig_version AS version
       FROM poem WHERE id = ?1`
      )
      .bind(poemId)
      .first<unknown>();
    const parsed = PublishRowSchema.safeParse(raw);
    if (!parsed.success || parsed.data.version !== expectedVersion)
      return false;
    const row = parsed.data;
    const checkpoint = CheckpointSchema.parse(JSON.parse(row.checkpointJson));
    const output = OutputSchema.parse(checkpoint.outputs.generation);
    const arabic = ArabicSchema.parse(JSON.parse(row.contentArabic));
    if (checkpoint.sourceHash !== row.sourceHash)
      throw new Error("SOURCE_CHANGED_BEFORE_PUBLICATION");
    if (output.translation.lines.length !== arabic.content.length)
      throw new Error("TRANSLATION_LINE_COUNT_MISMATCH");
    if (
      output.translation.lines.some(
        (line, index) => arabic.content[index]?.trim() && !line.trim()
      )
    )
      throw new Error("TRANSLATION_HAS_BLANK_LINE");
    const sourceLines = new Set(arabic.content.map((line) => line.trim()));
    if (
      output.insights.notableLines.some(
        ({ line }) => !sourceLines.has(line.trim())
      )
    )
      throw new Error("INSIGHT_LINE_NOT_IN_SOURCE");
    const publication = JSON.stringify({
      model: checkpoint.model,
      provider: "openai",
      ...output,
    });
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
           publication_version = publication_version + 1,
           publication_hash = ?3, publication_cache_dirty = 1,
           rig_status = 'complete',
           rig_version = rig_version + 1,
           rig_checkpoint_json = NULL, rig_lease_token = NULL,
           rig_lease_expires_at = NULL, rig_updated_at = unixepoch()
       WHERE id = ?4 AND rig_status = 'claimed' AND rig_version = ?5
         AND source_hash = ?2 AND rig_checkpoint_json = ?6`
      )
      .bind(
        publication,
        row.sourceHash,
        publicationHash,
        poemId,
        expectedVersion,
        row.checkpointJson
      )
      .run();
    return result.meta.changes === 1;
  }
}
