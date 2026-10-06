import type { D1Database } from "@cloudflare/workers-types";
import { wordGlossesFromMeanings } from "@saqi/precedent-iso";
import { z } from "zod";

import { PublicationSnapshotSchema } from "../../../site/src/lib/publication-snapshot";
import { RequiredSql } from "./rig-requirements";

const ClearCacheDirtySql = `UPDATE poem SET publication_cache_dirty = 0
       WHERE id = ?1 AND publication_hash IS ?2 AND source_hash = ?3`;

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
  status: z.literal("claimed"),
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

export type RigSourcePoem = z.infer<typeof SourceSchema> & {
  readonly linesArabic: readonly string[];
  readonly required: z.infer<typeof RequiredSchema>;
};

interface PendingPurgeRoute {
  authorSlug: string;
  poemId: string;
  publicationHash: null | string;
  sourceHash: string;
}

// eslint-disable-next-line @sarj/require-port-for-service, @sarj/require-interface-for-exported-class -- One concrete D1 implementation; callers and real-SQL tests need no interchangeable service contract.
export class RigPublicationRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async readPublication(poemId: string) {
    const raw = await this.#database
      .prepare(
        `SELECT a.slug AS authorSlug, p.source_hash AS sourceHash,
       p.publication_source_hash AS publicationSourceHash,
       p.publication_hash AS publicationHash,
       p.publication_cache_dirty AS cacheDirty,
       p.publication_json AS publicationJson
       FROM poem p JOIN author a ON a.id = p.author_id WHERE p.id = ?1`
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
    return this.#database
      .prepare(
        `SELECT p.id AS poemId, p.publication_hash AS publicationHash,
              p.source_hash AS sourceHash,
              a.slug AS authorSlug
       FROM poem p JOIN author a ON a.id = p.author_id
       WHERE p.publication_cache_dirty = 1
         AND (?1 IS NULL OR p.id = ?1)
       ORDER BY p.id LIMIT 1`
      )
      .bind(poemId ?? null)
      .first<PendingPurgeRoute>();
  }

  async pendingPurges(): Promise<PendingPurgeRoute[]> {
    const result = await this.#database
      .prepare(
        `SELECT p.id AS poemId, p.publication_hash AS publicationHash,
        p.source_hash AS sourceHash, a.slug AS authorSlug
       FROM poem p INDEXED BY poem_publication_cache_dirty
       JOIN author a ON a.id = p.author_id
       WHERE p.publication_cache_dirty = 1
       ORDER BY p.id LIMIT 50`
      )
      .all<PendingPurgeRoute>();
    return result.results;
  }

  async clearCacheDirtyBatch(
    rows: readonly PendingPurgeRoute[]
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.#database.batch(
      rows.map((row) =>
        this.#database
          .prepare(ClearCacheDirtySql)
          .bind(row.poemId, row.publicationHash, row.sourceHash)
      )
    );
  }

  async clearCacheDirty(
    poemId: string,
    publicationHash: null | string,
    sourceHash: string
  ): Promise<boolean> {
    const result = await this.#database
      .prepare(ClearCacheDirtySql)
      .bind(poemId, publicationHash, sourceHash)
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
              p.source_hash AS sourceHash, p.rig_version AS version,
              coalesce(json_extract(p.rig_checkpoint_json, '$.required'), ${RequiredSql}) AS requiredJson
       FROM poem p JOIN author a ON a.id = p.author_id
       WHERE p.id = ?1 AND p.rig_status = 'claimed'
         AND p.rig_lease_token = ?2 AND p.rig_lease_expires_at > ?3`
      )
      .bind(poemId, token, now)
      .first<unknown>();
    if (!raw) return null;
    const source = SourceSchema.parse(raw);
    const arabic = ArabicSchema.parse(JSON.parse(source.contentArabic));
    return {
      ...source,
      linesArabic: arabic.content,
      required: RequiredSchema.parse(JSON.parse(source.requiredJson)),
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
        WHERE id = ?1 AND rig_status = 'claimed' AND rig_version = ?2
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
        WHERE id = ?1 AND rig_status = 'claimed' AND rig_version = ?2
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
       WHERE id = ?4 AND rig_status = 'claimed' AND rig_version = ?5
         AND source_hash = ?2 AND rig_checkpoint_json = ?6
         AND publication_hash IS ?7`
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
      .run();
    return result.meta.changes === 1;
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
