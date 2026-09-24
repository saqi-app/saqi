import type { CorpusContentArabic } from "@saqi/precedent-iso";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { uuidv7 } from "uuidv7";

export const AUTHOR_TABLE = sqliteTable(
  "author",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    slug: text("slug").notNull().unique(),
    nameArabic: text("name_arabic").notNull(),
    sortNameArabic: text("sort_name_arabic").notNull().default(""),
    name: text("name"),
    status: text("status").notNull().default("init"),
    poemCount: integer("poem_count").default(0),
    geminiTranslationCount: integer("gemini_translation_count").default(0),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    publicPoemCount: integer("public_poem_count").notNull().default(0),
  },
  (table) => [
    index("idx_author_status").on(table.status),
    index("idx_author_public_catalog")
      .on(table.sortNameArabic, table.id)
      .where(sql`${table.hidden} = 0 AND ${table.publicPoemCount} > 0`),
  ],
);

export const POEM_TABLE = sqliteTable(
  "poem",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    authorId: text("author_id").references(() => AUTHOR_TABLE.id),
    slug: text("slug").notNull().unique(),
    verses: integer("verses").notNull(),
    nameArabic: text("name_arabic").notNull(),
    sortNameArabic: text("sort_name_arabic").notNull().default(""),
    nameEnglish: text("name_english"),
    contentArabic: text("content_arabic", { mode: "json" }).notNull(),
    translation: text("translation", { mode: "json" }),
    translationGemini: text("translation_gemini", { mode: "json" }),
    insights: text("insights", { mode: "json" }),
    englishNameOriginalTranslation: text("english_name_original_translation"),
    poemTitleFirstLine: text("poem_title_first_line"),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    publishable: integer("publishable", { mode: "boolean" })
      .notNull()
      .default(false),
    hasEnglish: integer("has_english", { mode: "boolean" })
      .notNull()
      .default(false),
    hasInsights: integer("has_insights", { mode: "boolean" })
      .notNull()
      .default(false),
    sitemapShard: integer("sitemap_shard").notNull().default(0),
    activeSourceRevisionId: text("active_source_revision_id"),
    legacyTranslationAttributions: text("legacy_translation_attributions", {
      mode: "json",
    }),
  },
  (table) => [
    index("idx_poem_author_id").on(table.authorId),
    index("idx_poem_public_author_title")
      .on(table.authorId, table.sortNameArabic, table.id)
      .where(sql`${table.hidden} = 0 AND ${table.publishable} = 1`),
    index("idx_poem_public_sitemap")
      .on(table.sitemapShard, table.id, table.authorId)
      .where(sql`${table.hidden} = 0 AND ${table.publishable} = 1`),
  ],
);

export const SCRAPER_WRITER_CONTROL_TABLE = sqliteTable(
  "scraper_writer_control",
  {
    singleton: integer("singleton").primaryKey(),
    writerEpoch: integer("writer_epoch").notNull(),
    writerId: text("writer_id"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
);

export const CRAWL_IMPORT_BUNDLE_TABLE = sqliteTable(
  "crawl_import_bundle",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    manifestHash: text("manifest_hash").notNull().unique(),
    rootHash: text("root_hash"),
    planHash: text("plan_hash"),
    promotionPlan: text("promotion_plan", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    expectedRecordCount: integer("expected_record_count").notNull(),
    status: text("status").notNull().default("open"),
    writerEpoch: integer("writer_epoch").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    sealedAt: integer("sealed_at", { mode: "timestamp" }),
    promotedAt: integer("promoted_at", { mode: "timestamp" }),
    receiptCreatedAt: integer("receipt_created_at", { mode: "timestamp" }),
    insertedRevisions: integer("inserted_revisions"),
    reusedRevisions: integer("reused_revisions"),
    advancedPointers: integer("advanced_pointers"),
    unchangedPointers: integer("unchanged_pointers"),
  },
  (table) => [
    index("idx_crawl_import_bundle_status").on(table.status, table.createdAt),
  ],
);

export const CRAWL_IMPORT_RECORD_TABLE = sqliteTable(
  "crawl_import_record",
  {
    bundleId: text("bundle_id")
      .notNull()
      .references(() => CRAWL_IMPORT_BUNDLE_TABLE.id),
    ordinal: integer("ordinal").notNull(),
    recordHash: text("record_hash").notNull(),
    sourceName: text("source_name").notNull(),
    sourceAuthorId: text("source_author_id").notNull(),
    sourceAuthorUrl: text("source_author_url").notNull(),
    authorNameArabic: text("author_name_arabic").notNull(),
    canonicalAuthorId: text("canonical_author_id")
      .references(() => AUTHOR_TABLE.id)
      .notNull(),
    sourcePoemId: text("source_poem_id").notNull(),
    sourcePoemUrl: text("source_poem_url").notNull(),
    canonicalPoemId: text("canonical_poem_id").references(() => POEM_TABLE.id),
    titleArabic: text("title_arabic").notNull(),
    contentArabic: text("content_arabic", { mode: "json" })
      .notNull()
      .$type<CorpusContentArabic>(),
    contentHash: text("content_hash").notNull(),
    observedAt: integer("observed_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bundleId, table.ordinal] }),
    uniqueIndex("crawl_import_record_bundle_hash_unique").on(
      table.bundleId,
      table.recordHash,
    ),
    uniqueIndex("crawl_import_record_bundle_source_unique").on(
      table.bundleId,
      table.sourceName,
      table.sourcePoemId,
    ),
    index("idx_crawl_import_record_source_poem").on(
      table.sourceName,
      table.sourcePoemId,
    ),
  ],
);

export const SOURCE_AUTHOR_IDENTITY_TABLE = sqliteTable(
  "source_author_identity",
  {
    id: text("id").primaryKey(),
    sourceName: text("source_name").notNull(),
    externalId: text("external_id").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    nameArabic: text("name_arabic").notNull(),
    canonicalAuthorId: text("canonical_author_id")
      .references(() => AUTHOR_TABLE.id)
      .notNull(),
    firstObservedAt: integer("first_observed_at", {
      mode: "timestamp",
    }).notNull(),
    lastObservedAt: integer("last_observed_at", {
      mode: "timestamp",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("source_author_identity_external_unique").on(
      table.sourceName,
      table.externalId,
    ),
    uniqueIndex("source_author_identity_url_unique").on(
      table.sourceName,
      table.canonicalUrl,
    ),
  ],
);

export const SOURCE_POEM_IDENTITY_TABLE = sqliteTable(
  "source_poem_identity",
  {
    id: text("id").primaryKey(),
    sourceName: text("source_name").notNull(),
    externalId: text("external_id").notNull(),
    sourceAuthorId: text("source_author_id")
      .notNull()
      .references(() => SOURCE_AUTHOR_IDENTITY_TABLE.id),
    canonicalUrl: text("canonical_url").notNull(),
    canonicalPoemId: text("canonical_poem_id").references(() => POEM_TABLE.id),
    firstObservedAt: integer("first_observed_at", {
      mode: "timestamp",
    }).notNull(),
    lastObservedAt: integer("last_observed_at", {
      mode: "timestamp",
    }).notNull(),
    tombstonedAt: integer("tombstoned_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("source_poem_identity_external_unique").on(
      table.sourceName,
      table.externalId,
    ),
    uniqueIndex("source_poem_identity_url_unique").on(
      table.sourceName,
      table.canonicalUrl,
    ),
    index("idx_source_poem_author").on(table.sourceAuthorId, table.externalId),
  ],
);

export const POEM_SOURCE_REVISION_TABLE = sqliteTable(
  "poem_source_revision",
  {
    id: text("id").primaryKey(),
    sourcePoemId: text("source_poem_id")
      .notNull()
      .references(() => SOURCE_POEM_IDENTITY_TABLE.id),
    schemaVersion: integer("schema_version").notNull(),
    contentHash: text("content_hash").notNull(),
    titleArabic: text("title_arabic").notNull(),
    contentArabic: text("content_arabic", { mode: "json" })
      .notNull()
      .$type<{ content: string[] }>(),
    observedAt: integer("observed_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    importBundleId: text("import_bundle_id")
      .notNull()
      .references(() => CRAWL_IMPORT_BUNDLE_TABLE.id),
    importOrdinal: integer("import_ordinal").notNull(),
    fingerprintAlgorithm: text("fingerprint_algorithm"),
    fingerprintCreatedAt: integer("fingerprint_created_at", {
      mode: "timestamp",
    }),
    lineNfcHash: text("line_nfc_hash"),
    promptMaterialHash: text("prompt_material_hash"),
  },
  (table) => [
    uniqueIndex("poem_source_revision_content_unique").on(
      table.sourcePoemId,
      table.schemaVersion,
      table.contentHash,
    ),
    index("idx_source_revision_poem_created").on(
      table.sourcePoemId,
      table.createdAt,
    ),
    index("idx_source_revision_fingerprint_line_nfc").on(
      table.lineNfcHash,
      table.id,
    ),
    index("idx_source_revision_fingerprint_prompt_material").on(
      table.promptMaterialHash,
      table.id,
    ),
  ],
);

export const SOURCE_ADMISSION_CLOCK_TABLE = sqliteTable(
  "source_admission_clock",
  {
    admissionId: text("admission_id").primaryKey(),
    issuedAt: integer("issued_at", { mode: "timestamp" }).notNull(),
  },
);

export const POEM_SOURCE_POINTER_TABLE = sqliteTable("poem_source_pointer", {
  sourcePoemId: text("source_poem_id")
    .primaryKey()
    .references(() => SOURCE_POEM_IDENTITY_TABLE.id),
  revisionId: text("revision_id")
    .notNull()
    .references(() => POEM_SOURCE_REVISION_TABLE.id),
  pointerVersion: integer("pointer_version").notNull(),
  writerEpoch: integer("writer_epoch").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const ENRICHMENT_PROFILE_TABLE = sqliteTable(
  "enrichment_profile",
  {
    profileKey: text("profile_key").primaryKey(),
    publicTrackKey: text("public_track_key").notNull(),
    modelKey: text("model_key").notNull(),
    backendKey: text("backend_key").notNull(),
    vendorKey: text("vendor_key").notNull(),
    vendorDisplayName: text("vendor_display_name").notNull(),
    vendorCreatedAt: integer("vendor_created_at", {
      mode: "timestamp",
    }).notNull(),
    modelFamilyKey: text("model_family_key").notNull(),
    modelVersionLabel: text("model_version_label").notNull(),
    modelDisplayName: text("model_display_name").notNull(),
    modelCreatedAt: integer("model_created_at", {
      mode: "timestamp",
    }).notNull(),
    backendDisplayName: text("backend_display_name").notNull(),
    backendCreatedAt: integer("backend_created_at", {
      mode: "timestamp",
    }).notNull(),
    runtimeModelId: text("runtime_model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    inputSchemaVersion: integer("input_schema_version").notNull(),
    outputSchemaVersion: integer("output_schema_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("idx_enrichment_profile_model").on(table.modelKey),
    index("idx_enrichment_profile_backend").on(table.backendKey),
    uniqueIndex("enrichment_profile_identity_unique").on(
      table.publicTrackKey,
      table.runtimeModelId,
      table.backendKey,
      table.promptVersion,
      table.reasoningEffort,
      table.inputSchemaVersion,
      table.outputSchemaVersion,
    ),
    uniqueIndex("enrichment_profile_artifact_identity_unique").on(
      table.publicTrackKey,
      table.runtimeModelId,
      table.promptVersion,
      table.reasoningEffort,
      table.inputSchemaVersion,
      table.outputSchemaVersion,
    ),
  ],
);

export const ENRICHMENT_ARTIFACT_TABLE = sqliteTable(
  "model_enrichment_artifact",
  {
    id: text("id").primaryKey(),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => POEM_SOURCE_REVISION_TABLE.id),
    taskKey: text("task_key").notNull(),
    variant: integer("variant").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    modelKey: text("model_key").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: text("payload", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("model_enrichment_artifact_task_variant_unique").on(
      table.taskKey,
      table.variant,
      table.modelKey,
    ),
    uniqueIndex("model_enrichment_artifact_revision_payload_unique").on(
      table.sourceRevisionId,
      table.payloadHash,
      table.modelKey,
    ),
    index("idx_model_enrichment_artifact_revision").on(
      table.sourceRevisionId,
      table.modelKey,
      table.createdAt,
    ),
  ],
);

export const ENRICHMENT_VALIDATION_TABLE = sqliteTable(
  "model_enrichment_validation",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => ENRICHMENT_ARTIFACT_TABLE.id),
    validatorKey: text("validator_key").notNull(),
    validatorVersion: text("validator_version").notNull(),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome").notNull(),
    highestSeverity: text("highest_severity").notNull(),
    reportHash: text("report_hash").notNull(),
    report: text("report", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("model_enrichment_validation_identity_unique").on(
      table.artifactId,
      table.validatorKey,
      table.validatorVersion,
      table.attempt,
    ),
    index("idx_model_enrichment_validation_artifact").on(
      table.artifactId,
      table.outcome,
      table.highestSeverity,
    ),
  ],
);

export const POEM_MODEL_PUBLICATION_POINTER_TABLE = sqliteTable(
  "poem_model_publication_pointer",
  {
    poemId: text("poem_id")
      .notNull()
      .references(() => POEM_TABLE.id),
    modelKey: text("model_key").notNull(),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => POEM_SOURCE_REVISION_TABLE.id),
    enrichmentArtifactId: text("enrichment_artifact_id")
      .notNull()
      .references(() => ENRICHMENT_ARTIFACT_TABLE.id),
    pointerVersion: integer("pointer_version").notNull(),
    writerEpoch: integer("writer_epoch").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.poemId, table.modelKey] }),
    uniqueIndex("poem_model_publication_artifact_unique").on(
      table.enrichmentArtifactId,
    ),
    index("idx_poem_model_publication_revision").on(
      table.sourceRevisionId,
      table.modelKey,
    ),
  ],
);

export const MODEL_PUBLICATION_RECEIPT_TABLE = sqliteTable(
  "model_publication_receipt",
  {
    intentId: text("intent_id").primaryKey(),
    actionHash: text("action_hash").notNull().unique(),
    poemId: text("poem_id")
      .notNull()
      .references(() => POEM_TABLE.id),
    modelKey: text("model_key").notNull(),
    promptVersion: text("prompt_version").notNull(),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => POEM_SOURCE_REVISION_TABLE.id),
    enrichmentArtifactId: text("enrichment_artifact_id")
      .notNull()
      .references(() => ENRICHMENT_ARTIFACT_TABLE.id),
    expectedPointerVersion: integer("expected_pointer_version"),
    pointerVersion: integer("pointer_version").notNull(),
    writerEpoch: integer("writer_epoch").notNull(),
    outcome: text("outcome").notNull(),
    committedAt: integer("committed_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("model_publication_receipt_pointer_unique").on(
      table.poemId,
      table.modelKey,
      table.pointerVersion,
    ),
    uniqueIndex("model_publication_receipt_artifact_unique").on(
      table.enrichmentArtifactId,
    ),
    index("idx_model_publication_receipt_lookup").on(
      table.poemId,
      table.modelKey,
      table.committedAt,
    ),
  ],
);
