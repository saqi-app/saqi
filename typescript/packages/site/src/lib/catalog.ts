import {
  APPROVED_ENRICHMENT_PROFILES,
  approvedEnrichmentValidations,
  PoemEnrichmentOutputV3Schema,
  PoemWordGlossesSchema,
  READABLE_ENRICHMENT_PROFILES,
  type ReadableEnrichmentProfile,
} from "@saqi/precedent-iso";
import { z } from "zod";

import {
  type CatalogDatabase,
  catalogDatabaseFromD1,
} from "./catalog-database";
import {
  LEGACY_GEMINI_ATTRIBUTION_NOTE,
  LEGACY_GEMINI_MODEL_ESTIMATE,
  LEGACY_TRANSLATION_ATTRIBUTION_NOTE,
  LEGACY_TRANSLATION_MODEL_ESTIMATE,
  translationModelName,
  type TranslationModelProvider,
  translationModelProvider,
} from "./poem-translations";
import {
  type Author,
  type Poem,
  SnapshotAuthorSchema,
  SnapshotPoemInsightsSchema,
  SnapshotPoemSchema,
} from "./snapshot-contract";

const UNSAFE_CONTROL =
  /[\u{0000}-\u{0008}\u{000b}\u{000c}\u{000e}-\u{001f}\u{007f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const UNSAFE_CONTROL_CODE_POINTS: readonly number[] = [
  ...Array.from({ length: 9 }, (_, index) => index),
  11,
  12,
  ...Array.from({ length: 18 }, (_, index) => index + 14),
  127,
  ...Array.from({ length: 5 }, (_, index) => index + 8_234),
  ...Array.from({ length: 4 }, (_, index) => index + 8_294),
];
const UNSAFE_CONTROL_CODE_POINTS_SQL = JSON.stringify(
  UNSAFE_CONTROL_CODE_POINTS,
);
const safeTextSql = (column: string) => `NOT EXISTS (
    SELECT 1
    FROM json_each('${UNSAFE_CONTROL_CODE_POINTS_SQL}') unsafe_code_point
    WHERE instr(${column}, char(unsafe_code_point.value)) > 0
  )`;
const SAFE_IDENTITY_SQL = (
  column: string,
) => `length(trim(${column})) BETWEEN 1 AND 500
  AND ${column} = trim(${column})
  AND ${safeTextSql(column)}`;
const SAFE_ROUTE_SEGMENT_SQL = (column: string) => `${SAFE_IDENTITY_SQL(column)}
  AND ${column} NOT IN ('.', '..')
  AND instr(${column}, '/') = 0`;
const PUBLISHABLE_POEM = `p.hidden = 0
  AND p.publishable = 1
  AND ${SAFE_ROUTE_SEGMENT_SQL("p.id")}
  AND ${SAFE_ROUTE_SEGMENT_SQL("p.slug")}
  AND ${SAFE_IDENTITY_SQL("p.name_arabic")}
  AND p.verses BETWEEN 1 AND 1000`;
const PUBLISHABLE_AUTHOR = `a.hidden = 0
  AND ${SAFE_IDENTITY_SQL("a.id")}
  AND ${SAFE_ROUTE_SEGMENT_SQL("a.slug")}
  AND instr(a.slug, '%') = 0
  AND ${SAFE_IDENTITY_SQL("a.name_arabic")}
  AND (a.name IS NULL OR trim(a.name) = '' OR ${SAFE_IDENTITY_SQL("a.name")})`;
const validTranslationSql = (column: string) => `CASE WHEN
  json_valid(${column})
  AND json_type(${column}, '$.content') = 'array'
  AND json_array_length(${column}, '$.content') BETWEEN 1 AND 2000
  AND json_array_length(${column}, '$.content') <= json_array_length(p.content_arabic, '$.content')
  AND EXISTS (
    SELECT 1 FROM json_each(${column}, '$.content') line
    WHERE line.type = 'text' AND trim(line.value) <> ''
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(${column}, '$.content') line
    WHERE line.type <> 'text'
      OR length(line.value) > 5000
      OR NOT (${safeTextSql("line.value")})
      OR lower(line.value) LIKE '%roses are red%'
      OR lower(line.value) LIKE '%unable to translate%'
      OR lower(line.value) LIKE '%cannot translate%'
      OR lower(line.value) LIKE '%can''t translate%'
      OR lower(line.value) LIKE '%as an ai%'
      OR lower(line.value) LIKE '%translation guidelines%'
      OR lower(line.value) LIKE '%translate the following%'
      OR lower(line.value) LIKE '%provide a summary instead%'
      OR (lower(line.value) LIKE '%i''m sorry%' AND lower(line.value) LIKE '%translat%')
  )
THEN 1 ELSE 0 END`;
const validInsightsSql = (column: string) => `CASE WHEN
  json_valid(${column})
  AND json_type(${column}) = 'object'
  AND (SELECT count(*) FROM json_each(${column})) = 6
  AND json_type(${column}, '$.summary') = 'text'
  AND length(trim(json_extract(${column}, '$.summary'))) BETWEEN 1 AND 20000
  AND ${safeTextSql(`json_extract(${column}, '$.summary')`)}
  AND json_type(${column}, '$.historicalContext') = 'text'
  AND length(trim(json_extract(${column}, '$.historicalContext'))) BETWEEN 1 AND 20000
  AND ${safeTextSql(`json_extract(${column}, '$.historicalContext')`)}
  AND json_type(${column}, '$.culturalSignificance') = 'text'
  AND length(trim(json_extract(${column}, '$.culturalSignificance'))) BETWEEN 1 AND 20000
  AND ${safeTextSql(`json_extract(${column}, '$.culturalSignificance')`)}
  AND json_type(${column}, '$.themes') = 'array'
  AND json_array_length(${column}, '$.themes') BETWEEN 1 AND 100
  AND NOT EXISTS (
    SELECT 1 FROM json_each(${column}, '$.themes') item
    WHERE item.type <> 'text'
      OR length(trim(item.value)) NOT BETWEEN 1 AND 20000
      OR NOT (${safeTextSql("item.value")})
  )
  AND json_type(${column}, '$.literaryDevices') = 'array'
  AND json_array_length(${column}, '$.literaryDevices') BETWEEN 1 AND 100
  AND NOT EXISTS (
    SELECT 1 FROM json_each(${column}, '$.literaryDevices') item
    WHERE item.type <> 'text'
      OR length(trim(item.value)) NOT BETWEEN 1 AND 20000
      OR NOT (${safeTextSql("item.value")})
  )
  AND json_type(${column}, '$.notableLines') = 'array'
  AND json_array_length(${column}, '$.notableLines') BETWEEN 1 AND 100
  AND NOT EXISTS (
    SELECT 1 FROM json_each(${column}, '$.notableLines') notable
    WHERE notable.type <> 'object'
      OR (SELECT count(*) FROM json_each(notable.value)) <> 2
      OR json_type(notable.value, '$.line') <> 'text'
      OR length(trim(json_extract(notable.value, '$.line'))) NOT BETWEEN 1 AND 20000
      OR NOT (${safeTextSql("json_extract(notable.value, '$.line')")})
      OR json_type(notable.value, '$.explanation') <> 'text'
      OR length(trim(json_extract(notable.value, '$.explanation'))) NOT BETWEEN 1 AND 20000
      OR NOT (${safeTextSql("json_extract(notable.value, '$.explanation')")})
  )
THEN 1 ELSE 0 END`;

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const approvedValidationSql = (
  validation: {
    readonly attempt: number;
    readonly validatorKey: string;
    readonly validatorVersion: string;
  },
  validationTable = "model_enrichment_validation",
) => `EXISTS (
        SELECT 1 FROM ${validationTable} accepted
        WHERE accepted.artifact_id = artifact.id
          AND accepted.validator_key = ${sqlText(validation.validatorKey)}
          AND accepted.validator_version = ${sqlText(validation.validatorVersion)}
          AND accepted.attempt = ${String(validation.attempt)}
          AND accepted.outcome = 'pass'
          AND accepted.highest_severity IN ('none', 'minor')
      )`;

const validatedModelPublicationSql = (profile: ReadableEnrichmentProfile) =>
  `p.active_source_revision_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM poem_model_publication_pointer publication
    JOIN model_enrichment_artifact artifact
      ON artifact.id = publication.enrichment_artifact_id
    WHERE publication.poem_id = p.id
      AND publication.model_key = ${sqlText(profile.modelKey)}
      AND publication.source_revision_id = p.active_source_revision_id
      AND artifact.source_revision_id = p.active_source_revision_id
      AND artifact.model_key = ${sqlText(profile.modelKey)}
      AND artifact.model = ${sqlText(profile.model)}
      AND artifact.reasoning_effort = ${sqlText(profile.reasoningEffort)}
      AND artifact.prompt_version = ${sqlText(profile.promptVersion)}
      AND ${approvedEnrichmentValidations(profile)
        .all.map((validation) => approvedValidationSql(validation))
        .join("\n      AND ")}
  )`;

const validatedModelArtifactSql = (profile: ReadableEnrichmentProfile) =>
  `artifact.model_key = ${sqlText(profile.modelKey)}
    AND artifact.model = ${sqlText(profile.model)}
    AND artifact.reasoning_effort = ${sqlText(profile.reasoningEffort)}
    AND artifact.prompt_version = ${sqlText(profile.promptVersion)}
    AND ${approvedEnrichmentValidations(profile)
      .all.map((validation) => approvedValidationSql(validation))
      .join("\n    AND ")}`;

const VALIDATED_MODEL_PUBLICATION = READABLE_ENRICHMENT_PROFILES.map(
  (profile) => `(${validatedModelPublicationSql(profile)})`,
).join("\n    OR ");
const VALIDATED_MODEL_ARTIFACT = READABLE_ENRICHMENT_PROFILES.map(
  (profile) => `(${validatedModelArtifactSql(profile)})`,
).join("\n    OR ");
const MODEL_DISPLAY_ORDER_SQL = APPROVED_ENRICHMENT_PROFILES.map(
  (profile) =>
    `WHEN ${sqlText(profile.modelKey)} THEN ${String(profile.displayOrder)}`,
).join("\n      ");
const MAX_PUBLIC_MODEL_TRACKS = 20;
const MODEL_AVAILABILITY_METADATA_SQL = (
  field: "displayName" | "modelVendorKey",
) =>
  `CASE artifact.model_key ${READABLE_ENRICHMENT_PROFILES.map(
    (profile) =>
      `WHEN ${sqlText(profile.modelKey)} THEN ${sqlText(profile[field])}`,
  ).join(" ")} END`;

// List metadata uses the existing validated publication authority. Detail pages
// retain full payload validation; lists do not transfer or reparse gloss payloads.
const MODEL_AVAILABILITY_SQL = `(SELECT json_group_array(json(available.model)) FROM (
  SELECT json_object(
    'key', artifact.model_key,
    'model', ${MODEL_AVAILABILITY_METADATA_SQL("displayName")},
    'provider', ${MODEL_AVAILABILITY_METADATA_SQL("modelVendorKey")}
  ) AS model
  FROM poem_model_publication_pointer publication
  JOIN model_enrichment_artifact artifact ON artifact.id = publication.enrichment_artifact_id
  WHERE publication.poem_id = p.id
    AND publication.source_revision_id = p.active_source_revision_id
    AND artifact.source_revision_id = p.active_source_revision_id
    AND publication.model_key = artifact.model_key
    AND (${VALIDATED_MODEL_ARTIFACT})
    AND json_type(artifact.payload, '$.translation.lines') = 'array'
    AND json_array_length(artifact.payload, '$.translation.lines') BETWEEN 1 AND 2000
    AND json_array_length(artifact.payload, '$.translation.lines') <= json_array_length(p.content_arabic, '$.content')
    AND EXISTS (
      SELECT 1 FROM json_each(artifact.payload, '$.translation.lines') line
      WHERE line.type = 'text' AND trim(line.value) <> ''
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(artifact.payload, '$.translation.lines') line
      WHERE line.type <> 'text'
    )
  ORDER BY CASE artifact.model_key ${MODEL_DISPLAY_ORDER_SQL} ELSE 2147483647 END,
    artifact.model_key
  LIMIT ${String(MAX_PUBLIC_MODEL_TRACKS)}
) available)`;

const LEGACY_AVAILABILITY_COLUMNS = `
  ${validTranslationSql("p.translation")} AS hasLegacyTranslation,
  ${validTranslationSql("p.translation_gemini")} AS hasGeminiTranslation,
  CASE WHEN json_valid(p.translation)
    THEN json_extract(p.translation, '$.model') ELSE NULL END AS legacyModel,
  CASE WHEN json_valid(p.translation_gemini)
    THEN json_extract(p.translation_gemini, '$.model') ELSE NULL END AS geminiModel`;

const AuthorRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  nameArabic: z.string(),
  nameEnglish: z.string().nullable(),
});

const AuthorIndexRowSchema = AuthorRowSchema.extend({
  poemCount: z.number().int().positive(),
});
const AuthorPageRowSchema = AuthorRowSchema.extend({
  poemCount: z.number().int().positive(),
});
const JoinedAuthorRowSchema = z.object({
  catalogAuthorId: z.string(),
  catalogAuthorSlug: z.string(),
  catalogAuthorNameArabic: z.string(),
  catalogAuthorNameEnglish: z.string().nullable(),
});
const PoemSummaryRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  authorId: z.string(),
  verses: z.number().int().positive(),
  nameArabic: z.string(),
  nameEnglish: z.string().nullable(),
  nameEnglishLegacy: z.string().nullable(),
  hasInsights: z.literal([0, 1]),
  hasLegacyTranslation: z.literal([0, 1]),
  hasGeminiTranslation: z.literal([0, 1]),
  geminiModel: z.unknown(),
  legacyModel: z.unknown(),
  translationModels: z.string(),
});
const SitemapPoemRowSchema = z.object({
  authorId: z.string(),
  authorSlug: z.string(),
  id: z.string(),
});

const PoemRowSchema = z.object({
  activeSourceRevisionId: z.string().nullable(),
  id: z.string(),
  slug: z.string(),
  authorId: z.string(),
  verses: z.number().int().positive(),
  nameArabic: z.string(),
  nameEnglish: z.string().nullable(),
  nameEnglishLegacy: z.string().nullable(),
  contentArabic: z.string(),
  translation: z.string().nullable(),
  legacyTranslationAttributions: z.string().nullable(),
  translationGemini: z.string().nullable(),
  insights: z.string().nullable(),
});

const SafeCatalogLineSchema = z
  .string()
  .max(5_000)
  .refine((line) => !UNSAFE_CONTROL.test(line));
const TranslationContentSchema = z.object({
  content: z
    .array(SafeCatalogLineSchema)
    .min(1)
    .max(2_000)
    .refine((lines) => lines.some((line) => line.trim().length > 0)),
  model: z.unknown().optional(),
  reasoningEffort: z.unknown().optional(),
});
const ArabicContentSchema = z.object({
  content: z
    .array(SafeCatalogLineSchema)
    .min(1)
    .max(2_000)
    .refine((lines) => lines.some((line) => line.trim().length > 0)),
});
const ProviderVendorSchema = z.enum(["anthropic", "google", "openai", "other"]);
const ModelEnrichmentSchema = z.strictObject({
  backendKey: z.string().trim().min(1).max(100).optional(),
  backendName: z.string().trim().min(1).max(100).optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(100),
  modelKey: z.string().trim().min(1).max(100),
  payload: z.union([
    z.strictObject({
      insights: SnapshotPoemInsightsSchema,
      translation: z.strictObject({
        lines: z.array(SafeCatalogLineSchema).min(1).max(2_000),
      }),
    }),
    PoemEnrichmentOutputV3Schema,
    z.strictObject({
      schemaId: z.literal("saqi.poem-enrichment-output"),
      schemaVersion: z.literal(2),
      translation: z.strictObject({
        lines: z.array(SafeCatalogLineSchema).min(1).max(2_000),
      }),
      wordGlosses: PoemWordGlossesSchema,
    }),
  ]),
  profileKey: z.string().trim().min(1).max(100).optional(),
  reasoningEffort: z.string().trim().min(1).max(100),
  vendorKey: ProviderVendorSchema.optional(),
});
const ModelEnrichmentRowSchema = z.object({ enrichment: z.string() });
const LegacyModelAttributionRowSchema = z.object({
  certainty: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(100),
  sourcePayloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  vendorKey: ProviderVendorSchema,
});

export type { CatalogDatabase } from "./catalog-database";

export interface IndexedAuthor {
  author: Author;
  poemCount: number;
}

export interface AuthorIndexPage {
  authors: IndexedAuthor[];
}

interface PoemSummary {
  authorId: string;
  hasEnglish: boolean;
  hasInsights: boolean;
  id: string;
  nameArabic: string;
  nameEnglish?: string;
  slug: string;
  translationModels: TranslationAvailability[];
  verses: number;
}

interface TranslationAvailability {
  attributionCertainty?: string;
  attributionNote?: string;
  key: string;
  model: string;
  provider: TranslationModelProvider;
}

const TranslationAvailabilitySchema = z.object({
  key: z.string().min(1),
  model: z.string().min(1),
  provider: ProviderVendorSchema,
});

function summaryTranslationModels(
  row: z.infer<typeof PoemSummaryRowSchema>,
): TranslationAvailability[] {
  const models: TranslationAvailability[] =
    TranslationAvailabilitySchema.array().parse(
      JSON.parse(row.translationModels),
    );
  if (row.hasLegacyTranslation === 1) {
    // Exact legacy attribution is hash-scoped on detail reads. Do not attach a
    // poem-level attribution to list metadata without verifying its payload hash.
    const model = storedModelLabel(row.legacyModel);
    models.push({
      key: "legacy",
      model: translationModelName(model ?? LEGACY_TRANSLATION_MODEL_ESTIMATE),
      provider: model ? translationModelProvider(model) : "anthropic",
      ...(model
        ? {}
        : {
            attributionCertainty: "inferred_range",
            attributionNote: LEGACY_TRANSLATION_ATTRIBUTION_NOTE,
          }),
    });
  }
  if (row.hasGeminiTranslation === 1) {
    const storedModel = storedModelLabel(row.geminiModel);
    const model = storedModel ?? LEGACY_GEMINI_MODEL_ESTIMATE;
    models.push({
      key: "gemini",
      model: translationModelName(model),
      provider: translationModelProvider(model),
      ...(storedModel
        ? {}
        : {
            attributionCertainty: "user_supplied",
            attributionNote: LEGACY_GEMINI_ATTRIBUTION_NOTE,
          }),
    });
  }
  return models;
}

function storedModelLabel(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 100 &&
    !UNSAFE_CONTROL.test(value)
    ? value.trim()
    : undefined;
}

// Keep every current poet on one page; retain a high safety bound for future
// corpus growth so a single pathological record cannot create an unbounded page.
export const AUTHOR_PAGE_SIZE = 2_500;

export interface AuthorPage {
  author: Author;
  pageCount: number;
  pageNumber: number;
  poemCount: number;
  poems: PoemSummary[];
}

export interface PoemPage {
  author: Author;
  poem: Poem;
}

export interface SitemapPoem {
  author: Pick<Author, "id" | "slug">;
  poem: Pick<Poem, "authorId" | "id">;
}

interface CatalogReader {
  getAuthorIndex(): Promise<AuthorIndexPage>;
  getAuthorPage(
    slug: string,
    pageNumber?: number,
  ): Promise<AuthorPage | undefined>;
  getPoemPage(
    authorSlug: string,
    poemId: string,
  ): Promise<PoemPage | undefined>;
  listAuthors(): Promise<IndexedAuthor[]>;
  listSitemapPoems(shard: number): Promise<SitemapPoem[]>;
}

function authorFromRow(raw: unknown): Author {
  const row = AuthorRowSchema.parse(raw);
  return SnapshotAuthorSchema.parse({
    id: row.id,
    slug: row.slug,
    nameArabic: row.nameArabic,
    ...(row.nameEnglish ? { nameEnglish: row.nameEnglish } : {}),
  });
}

function authorFromJoinedRow(raw: unknown): Author {
  const row = JoinedAuthorRowSchema.parse(raw);
  return SnapshotAuthorSchema.parse({
    id: row.catalogAuthorId,
    slug: row.catalogAuthorSlug,
    nameArabic: row.catalogAuthorNameArabic,
    ...(row.catalogAuthorNameEnglish
      ? { nameEnglish: row.catalogAuthorNameEnglish }
      : {}),
  });
}

const GENERATION_FAILURE_PATTERN =
  /(?:roses are red|unable to translate|cannot translate|can't translate|i(?:'| a)m sorry.{0,80}translat|as an ai|translation guidelines|translate the following|provide (?:a )?summary instead)/iu;
const GENERATED_TITLE_FAILURE_PATTERN =
  /(?:i (?:do not|don't).{0,80}translat|i (?:have )?translated|i have (?:chosen|given|made).{0,80}translat|i(?:'m| am) an ai|assistant created by|here(?:'s| is).{0,100}(?:attempt|english|translat)|english translation|arabic poem title|title translated|from english to arabic|you are an arabic|attempt at translat|^i (?:will not|have nothing|have not|presume not|did not|am not able).{0,180}(?:translat|output|provide|copyright|permission|context)|^you(?:'re| are) right.{0,180}translat|^translated to\b|^titles? translated(?: to english)?$|^my poem translation:?$|without proper context|copyrighted material|let's have (?:a |an )?(?:engaging|respectful|thoughtful) (?:conversation|discussion)|please provide (?:an |the )?(?:arabic|english|translation)|as requested.{0,120}(?:output|translat)|do not speak arabic|don't speak arabic|not attempt to translat|refrain from translat|kept the translated poem private|translation capabilities|translation services|rough translation of the title|entrust you.{0,80}translate|nice try.{0,80}translate|without permission.{0,80}(?:translate|copyright)|my friend.{0,120}(?:cannot provide|thoughtful discussion))/iu;
function isUsableGeneratedText(value: string): boolean {
  const text = value.trim();
  return (
    text.length > 0 &&
    text.length <= 200 &&
    !/[\r\n]/u.test(text) &&
    !UNSAFE_CONTROL.test(text) &&
    !GENERATION_FAILURE_PATTERN.test(text) &&
    !GENERATED_TITLE_FAILURE_PATTERN.test(text)
  );
}

function englishTitleFields(
  ...values: (null | string)[]
): { nameEnglish: string } | Record<string, never> {
  const nameEnglish = usableTitle(...values);
  return nameEnglish ? { nameEnglish } : {};
}

function usableTitle(...values: (null | string)[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && isUsableGeneratedText(value),
  );
}

function optionalModelEnrichment(
  raw: null | string,
  sourceLineCount: number,
  retainedLineIndexes: number[],
) {
  if (!raw) return undefined;
  try {
    const parsed = ModelEnrichmentSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.payload.translation.lines.length > sourceLineCount
    )
      return undefined;
    const source = parsed.data.payload.translation.lines;
    const payload = parsed.data.payload;
    if (source.some((line) => GENERATION_FAILURE_PATTERN.test(line)))
      return undefined;
    return {
      ...(parsed.data.backendKey ? { backendKey: parsed.data.backendKey } : {}),
      ...(parsed.data.backendName
        ? { backendName: parsed.data.backendName }
        : {}),
      ...(parsed.data.displayName
        ? { displayName: parsed.data.displayName }
        : {}),
      lines:
        source.length === retainedLineIndexes.length
          ? source
          : retainedLineIndexes.map((index) => source[index] ?? ""),
      model: parsed.data.model,
      modelKey: parsed.data.modelKey,
      ...(parsed.data.profileKey ? { profileKey: parsed.data.profileKey } : {}),
      reasoningEffort: parsed.data.reasoningEffort,
      ...(parsed.data.vendorKey ? { vendorKey: parsed.data.vendorKey } : {}),
      ...("wordGlosses" in payload
        ? {
            wordGlosses: {
              ...payload.wordGlosses,
              lines: retainedLineIndexes.map((sourceIndex, lineIndex) => ({
                lineIndex,
                segments:
                  payload.wordGlosses.lines.find(
                    (line) => line.lineIndex === sourceIndex,
                  )?.segments ?? [],
              })),
            },
          }
        : {}),
      ...("insights" in payload ? { insights: payload.insights } : {}),
    };
  } catch {
    return undefined;
  }
}

function poemFromRow(
  raw: unknown,
  dynamicModelEnrichments: readonly string[] = [],
  legacyAttribution?: z.infer<typeof LegacyModelAttributionRowSchema>,
): Poem | undefined {
  const parsedRow = PoemRowSchema.safeParse(raw);
  if (!parsedRow.success) return undefined;
  const row = parsedRow.data;
  let parsedArabic: z.infer<typeof ArabicContentSchema>;
  try {
    const result = ArabicContentSchema.safeParse(JSON.parse(row.contentArabic));
    if (!result.success) return undefined;
    parsedArabic = result.data;
  } catch {
    return undefined;
  }
  const sourceLines = parsedArabic.content;
  const retainedLineIndexes = Array.from(
    { length: Math.ceil(sourceLines.length / 2) },
    (_, index) => index * 2,
  ).flatMap((firstIndex) =>
    sourceLines[firstIndex]?.trim() || sourceLines[firstIndex + 1]?.trim()
      ? [firstIndex, firstIndex + 1].filter(
          (index) => index < sourceLines.length,
        )
      : [],
  );
  const linesArabic = retainedLineIndexes.map(
    (index) => sourceLines[index] ?? "",
  );
  const english = optionalLines(
    row.translation,
    sourceLines.length,
    retainedLineIndexes,
  );
  const englishGemini = optionalLines(
    row.translationGemini,
    sourceLines.length,
    retainedLineIndexes,
  );
  const modelEnrichments = dynamicModelEnrichments
    .map((enrichment) =>
      optionalModelEnrichment(
        enrichment,
        sourceLines.length,
        retainedLineIndexes,
      ),
    )
    .filter((value): value is NonNullable<typeof value> => value !== undefined);
  const primaryModelEnrichment = modelEnrichments.at(0);
  const insights =
    (primaryModelEnrichment && "insights" in primaryModelEnrichment
      ? primaryModelEnrichment.insights
      : undefined) ?? optionalInsights(row.insights);
  const parsedPoem = SnapshotPoemSchema.safeParse({
    id: row.id,
    slug: row.slug,
    authorId: row.authorId,
    verses: Math.ceil(linesArabic.length / 2),
    nameArabic: row.nameArabic,
    ...englishTitleFields(row.nameEnglish, row.nameEnglishLegacy),
    linesArabic,
    ...(english ? { linesEnglish: english.lines } : {}),
    ...((english?.model ?? legacyAttribution?.displayName)
      ? {
          linesEnglishModel:
            english?.model ?? legacyAttribution?.displayName ?? undefined,
        }
      : {}),
    ...(legacyAttribution && !english?.model
      ? {
          linesEnglishAttributionCertainty: legacyAttribution.certainty,
          linesEnglishModelVendor: legacyAttribution.vendorKey,
        }
      : {}),
    ...(englishGemini ? { linesEnglishGemini: englishGemini.lines } : {}),
    ...(englishGemini?.model
      ? { linesEnglishGeminiModel: englishGemini.model }
      : {}),
    ...(modelEnrichments.length > 0 ? { modelEnrichments } : {}),
    ...(insights ? { insights } : {}),
    ...(insights
      ? {
          insightsTrack: primaryModelEnrichment
            ? ("model" as const)
            : ("legacy" as const),
        }
      : {}),
    ...(primaryModelEnrichment?.model
      ? { insightsModel: primaryModelEnrichment.model }
      : {}),
    ...(primaryModelEnrichment?.reasoningEffort
      ? { insightsReasoningEffort: primaryModelEnrichment.reasoningEffort }
      : {}),
  });
  return parsedPoem.success ? parsedPoem.data : undefined;
}

function optionalLines(
  raw: null | string,
  sourceLineCount: number,
  retainedLineIndexes: number[],
): { lines: string[]; model?: string; reasoningEffort?: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = TranslationContentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.content.length > sourceLineCount)
      return undefined;
    if (
      parsed.data.content.some((line) => GENERATION_FAILURE_PATTERN.test(line))
    ) {
      return undefined;
    }
    const lines =
      parsed.data.content.length === retainedLineIndexes.length
        ? parsed.data.content
        : retainedLineIndexes.map((index) => parsed.data.content[index] ?? "");
    return {
      lines,
      ...(typeof parsed.data.model === "string" &&
      parsed.data.model.trim().length > 0 &&
      parsed.data.model.trim().length <= 100 &&
      !UNSAFE_CONTROL.test(parsed.data.model)
        ? { model: parsed.data.model.trim() }
        : {}),
      ...(typeof parsed.data.reasoningEffort === "string" &&
      parsed.data.reasoningEffort.trim().length > 0 &&
      parsed.data.reasoningEffort.trim().length <= 100 &&
      !UNSAFE_CONTROL.test(parsed.data.reasoningEffort)
        ? { reasoningEffort: parsed.data.reasoningEffort.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function optionalInsights(raw: null | string) {
  if (!raw) return undefined;
  try {
    const parsed = SnapshotPoemInsightsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const AUTHOR_COLUMNS = `a.id,
  a.slug,
  a.name_arabic AS nameArabic,
  NULLIF(trim(a.name), '') AS nameEnglish`;

const JOINED_AUTHOR_COLUMNS = `a.id AS catalogAuthorId,
  a.slug AS catalogAuthorSlug,
  a.name_arabic AS catalogAuthorNameArabic,
  NULLIF(trim(a.name), '') AS catalogAuthorNameEnglish`;

const BASE_POEM_COLUMNS = `p.id,
  p.active_source_revision_id AS activeSourceRevisionId,
  p.slug,
  p.author_id AS authorId,
  p.verses,
  p.name_arabic AS nameArabic,
  NULLIF(trim(p.name_english), '') AS nameEnglish,
  NULLIF(trim(p.poem_title_first_line), '') AS nameEnglishLegacy,
  p.content_arabic AS contentArabic,
  p.translation,
  p.translation_gemini AS translationGemini,
  p.insights`;

const NORMALIZED_POEM_COLUMNS = `${BASE_POEM_COLUMNS},
  p.legacy_translation_attributions AS legacyTranslationAttributions`;

const BASE_POEM_SUMMARY_COLUMNS = `p.id,
  p.slug,
  p.author_id AS authorId,
  CAST((
    SELECT count(DISTINCT CAST(line.key AS INTEGER) / 2)
    FROM json_each(p.content_arabic, '$.content') line
    WHERE line.type = 'text' AND trim(line.value) <> ''
  ) AS INTEGER) AS verses,
  p.name_arabic AS nameArabic,
  NULLIF(trim(p.name_english), '') AS nameEnglish,
  NULLIF(trim(p.poem_title_first_line), '') AS nameEnglishLegacy`;

const NORMALIZED_POEM_SUMMARY_COLUMNS = `${BASE_POEM_SUMMARY_COLUMNS},
  ${LEGACY_AVAILABILITY_COLUMNS},
  ${MODEL_AVAILABILITY_SQL} AS translationModels,
  CASE WHEN ${validInsightsSql("p.insights")} = 1
    OR (${VALIDATED_MODEL_PUBLICATION})
    THEN 1 ELSE 0 END AS hasInsights`;

async function sha256Utf8Exact(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class CatalogRepository implements CatalogReader {
  readonly #database: CatalogDatabase;

  constructor(database: CatalogDatabase) {
    this.#database = database;
  }

  static fromD1(database: D1Database): CatalogRepository {
    return new CatalogRepository(catalogDatabaseFromD1(database));
  }

  async listAuthors(): Promise<IndexedAuthor[]> {
    const result = await this.#database
      .prepare(
        `SELECT ${AUTHOR_COLUMNS}, a.public_poem_count AS poemCount
         FROM author a
        WHERE ${PUBLISHABLE_AUTHOR}
          AND a.public_poem_count > 0
        ORDER BY a.sort_name_arabic, a.id`,
      )
      .all();
    return AuthorIndexRowSchema.array()
      .parse(result.results)
      .map((row) => ({
        author: authorFromRow(row),
        poemCount: row.poemCount,
      }));
  }

  async getAuthorIndex(): Promise<AuthorIndexPage> {
    return {
      authors: await this.listAuthors(),
    };
  }

  async getAuthorPage(
    slug: string,
    pageNumber = 1,
  ): Promise<AuthorPage | undefined> {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return undefined;
    const offset = (pageNumber - 1) * AUTHOR_PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) return undefined;

    const loadPage = (poemColumns: string) => {
      const authorStatement = this.#database
        .prepare(
          `SELECT ${AUTHOR_COLUMNS}, a.public_poem_count AS poemCount
           FROM author a
          WHERE a.slug = ?1
            AND ${PUBLISHABLE_AUTHOR}
            AND a.public_poem_count > 0
          LIMIT 1`,
        )
        .bind(slug);
      const poemsStatement = this.#database
        .prepare(
          // eslint-disable-next-line @sarj/no-offset-pagination -- Canonical author/page/N URLs require random page access without a prior cursor. Preserve indexed (sort_name_arabic, id) ordering; LIMIT bounds returned rows, not skipped work. Cursor migration needs revision-bound page anchors.
          `SELECT ${poemColumns}
         FROM poem p
        WHERE p.author_id = (
          SELECT a.id
            FROM author a
           WHERE a.slug = ?1
             AND ${PUBLISHABLE_AUTHOR}
             AND a.public_poem_count > 0
           LIMIT 1
        )
          AND ${PUBLISHABLE_POEM}
          AND json_valid(p.content_arabic)
          AND json_type(p.content_arabic, '$.content') = 'array'
          AND json_array_length(p.content_arabic, '$.content') BETWEEN 1 AND 2000
          AND EXISTS (
            SELECT 1 FROM json_each(p.content_arabic, '$.content') line
            WHERE line.type = 'text' AND trim(line.value) <> ''
          )
        ORDER BY p.sort_name_arabic,
                 p.id
        LIMIT ?2 OFFSET ?3`,
        )
        .bind(slug, AUTHOR_PAGE_SIZE, offset);
      return this.#database.batch([authorStatement, poemsStatement]);
    };
    const pageResults = await loadPage(NORMALIZED_POEM_SUMMARY_COLUMNS);
    const authorRow = pageResults.at(0)?.results.at(0);
    if (!authorRow) return undefined;
    const parsedAuthor = AuthorPageRowSchema.parse(authorRow);
    const pageCount = Math.ceil(parsedAuthor.poemCount / AUTHOR_PAGE_SIZE);
    if (pageNumber > pageCount) return undefined;
    return {
      author: authorFromRow(parsedAuthor),
      pageCount,
      pageNumber,
      poemCount: parsedAuthor.poemCount,
      poems: PoemSummaryRowSchema.array()
        .parse(pageResults.at(1)?.results ?? [])
        .map((row) => {
          const translationModels = summaryTranslationModels(row);
          return {
            authorId: row.authorId,
            hasEnglish: translationModels.length > 0,
            hasInsights: row.hasInsights === 1,
            id: row.id,
            nameArabic: row.nameArabic,
            ...englishTitleFields(row.nameEnglish, row.nameEnglishLegacy),
            slug: row.slug,
            verses: row.verses,
            translationModels,
          };
        }),
    };
  }

  async getPoemPage(
    authorSlug: string,
    poemId: string,
  ): Promise<PoemPage | undefined> {
    const loadPoem = (poemColumns: string) =>
      this.#database
        .prepare(
          `SELECT ${JOINED_AUTHOR_COLUMNS}, ${poemColumns}
         FROM poem p
         JOIN author a ON a.id = p.author_id
        WHERE a.slug = ?1
          AND p.id = ?2
          AND ${PUBLISHABLE_AUTHOR}
          AND ${PUBLISHABLE_POEM}
        LIMIT 1`,
        )
        .bind(authorSlug, poemId)
        .all();
    const result = await loadPoem(NORMALIZED_POEM_COLUMNS);
    const row = result.results[0];
    if (!row) return undefined;
    const parsedRow = PoemRowSchema.safeParse(row);
    if (!parsedRow.success) return undefined;
    const [dynamicModelEnrichments, legacyAttribution] = await Promise.all([
      this.#loadRegistryModelEnrichments(poemId),
      this.#loadLegacyModelAttribution(
        parsedRow.data.translation,
        parsedRow.data.legacyTranslationAttributions,
      ),
    ]);
    const poem = poemFromRow(row, dynamicModelEnrichments, legacyAttribution);
    return poem ? { author: authorFromJoinedRow(row), poem } : undefined;
  }

  async listSitemapPoems(shard: number): Promise<SitemapPoem[]> {
    if (!Number.isSafeInteger(shard) || shard < 1 || shard > 16) return [];
    const result = await this.#database
      .prepare(
        `SELECT a.id AS authorId, a.slug AS authorSlug, p.id
         FROM poem p
         JOIN author a ON a.id = p.author_id
        WHERE ${PUBLISHABLE_AUTHOR}
          AND ${PUBLISHABLE_POEM}
          AND p.sitemap_shard = ?1
        ORDER BY p.id
        LIMIT 50001`,
      )
      .bind(shard - 1)
      .all();
    return SitemapPoemRowSchema.array()
      .parse(result.results)
      .map((row) => ({
        author: { id: row.authorId, slug: row.authorSlug },
        poem: { id: row.id, authorId: row.authorId },
      }));
  }

  async #loadLegacyModelAttribution(
    storedPayload: null | string,
    storedAttributions: null | string,
  ): Promise<undefined | z.infer<typeof LegacyModelAttributionRowSchema>> {
    if (!storedPayload || !storedAttributions) return undefined;
    const sourcePayloadHash = await sha256Utf8Exact(storedPayload);
    try {
      const parsed = LegacyModelAttributionRowSchema.array().safeParse(
        JSON.parse(storedAttributions),
      );
      return parsed.success
        ? parsed.data.find(
            (attribution) =>
              attribution.sourcePayloadHash === sourcePayloadHash,
          )
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #loadRegistryModelEnrichments(poemId: string): Promise<string[]> {
    const result = await this.#database
      .prepare(
        `SELECT json_object(
                  'backendKey', profile.backend_key,
                  'backendName', profile.backend_display_name,
                  'displayName', profile.model_display_name,
                  'model', profile.runtime_model_id,
                  'modelKey', profile.public_track_key,
                  'profileKey', profile.profile_key,
                  'reasoningEffort', profile.reasoning_effort,
                  'vendorKey', CASE profile.vendor_key
                    WHEN 'anthropic' THEN 'anthropic'
                    WHEN 'google' THEN 'google'
                    WHEN 'openai' THEN 'openai'
                    ELSE 'other'
                  END,
                  'payload', json(artifact.payload)
                ) AS enrichment
           FROM poem_model_publication_pointer publication
           JOIN model_enrichment_artifact artifact
             ON artifact.id = publication.enrichment_artifact_id
           JOIN poem_source_revision revision
             ON revision.id = artifact.source_revision_id
           JOIN enrichment_profile profile
             ON profile.public_track_key = artifact.model_key
            AND profile.runtime_model_id = artifact.model
            AND profile.prompt_version = artifact.prompt_version
            AND profile.reasoning_effort = artifact.reasoning_effort
            AND profile.input_schema_version = revision.schema_version
            AND profile.output_schema_version = artifact.schema_version
           JOIN poem p ON p.id = publication.poem_id
          WHERE publication.poem_id = ?1
            AND p.active_source_revision_id IS NOT NULL
            AND publication.source_revision_id = p.active_source_revision_id
            AND artifact.source_revision_id = p.active_source_revision_id
            AND publication.model_key = artifact.model_key
            AND profile.public_track_key = publication.model_key
            AND profile.runtime_model_id = artifact.model
            AND profile.prompt_version = artifact.prompt_version
            AND profile.reasoning_effort = artifact.reasoning_effort
            AND (${VALIDATED_MODEL_ARTIFACT})
          ORDER BY CASE profile.public_track_key
              ${MODEL_DISPLAY_ORDER_SQL}
              ELSE 2147483647
            END,
            profile.public_track_key
          LIMIT ${String(MAX_PUBLIC_MODEL_TRACKS)}`,
      )
      .bind(poemId)
      .all();
    return ModelEnrichmentRowSchema.array()
      .parse(result.results)
      .map(({ enrichment }) => enrichment);
  }
}
