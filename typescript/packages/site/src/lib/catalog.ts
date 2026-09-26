import { z } from "zod";

import {
  type CatalogDatabase,
  catalogDatabaseFromD1,
} from "./catalog-database";
import {
  LEGACY_TRANSLATION_MODEL_ESTIMATE,
  poemTranslationTracks,
  type TranslationModelProvider,
} from "./poem-translations";
import { PublicationSnapshotSchema } from "./publication-snapshot";
import {
  type Author,
  type Poem,
  SnapshotAuthorSchema,
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
const SAFE_IDENTITY_SQL = (
  column: string,
) => `length(trim(${column})) BETWEEN 1 AND 500
  AND ${column} = trim(${column})
  AND ${safeTextSql(column)}`;
function safeTextSql(column: string) {
  return `NOT EXISTS (
    SELECT 1
    FROM json_each('${UNSAFE_CONTROL_CODE_POINTS_SQL}') unsafe_code_point
    WHERE instr(${column}, char(unsafe_code_point.value)) > 0
  )`;
}

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
const PUBLIC_POEM_COUNT = `(SELECT count(*) FROM poem public_poem
  WHERE public_poem.author_id = a.id
    AND public_poem.hidden = 0 AND public_poem.publishable = 1)`;
const HAS_PUBLIC_POEM = `EXISTS (SELECT 1 FROM poem public_poem
  WHERE public_poem.author_id = a.id
    AND public_poem.hidden = 0 AND public_poem.publishable = 1)`;
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
  publicationJson: z.string().nullable(),
});
const SitemapPoemRowSchema = z.object({
  authorId: z.string(),
  authorSlug: z.string(),
  id: z.string(),
});

const PoemRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  authorId: z.string(),
  verses: z.number().int().positive(),
  nameArabic: z.string(),
  nameEnglish: z.string().nullable(),
  nameEnglishLegacy: z.string().nullable(),
  contentArabic: z.string(),
  publicationJson: z.string().nullable(),
  sourceHash: z.string().nullable(),
  publicationSourceHash: z.string().nullable(),
});

const SafeCatalogLineSchema = z
  .string()
  .max(5_000)
  .refine((line) => !UNSAFE_CONTROL.test(line));
const ArabicContentSchema = z.object({
  content: z
    .array(SafeCatalogLineSchema)
    .min(1)
    .max(2_000)
    .refine((lines) => lines.some((line) => line.trim().length > 0)),
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

function summaryTranslationModels(
  row: z.infer<typeof PoemSummaryRowSchema>,
): TranslationAvailability[] {
  const projected = activePublicationSnapshot(row.publicationJson);
  if (projected) {
    return poemTranslationTracks(projected.fields).flatMap((track) => {
      if (!track.model || !track.provider) return [];
      const model: TranslationAvailability = {
        key: track.key,
        model:
          track.key === "legacy" &&
          track.attributionCertainty === "inferred_range"
            ? LEGACY_TRANSLATION_MODEL_ESTIMATE
            : track.model,
        provider: track.provider,
      };
      if (
        track.attributionCertainty ||
        (track.key === "gemini" && track.attributionNote)
      )
        model.attributionCertainty =
          track.attributionCertainty ?? "user_supplied";
      if (track.attributionNote) model.attributionNote = track.attributionNote;
      return [model];
    });
  }
  return [];
}

function activePublicationSnapshot(raw: null | string) {
  if (!raw) return undefined;
  try {
    const parsed = PublicationSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
  const author: Author = {
    id: row.id,
    slug: row.slug,
    nameArabic: row.nameArabic,
  };
  if (row.nameEnglish) author.nameEnglish = row.nameEnglish;
  return SnapshotAuthorSchema.parse(author);
}

function authorFromJoinedRow(raw: unknown): Author {
  const row = JoinedAuthorRowSchema.parse(raw);
  return authorFromRow({
    id: row.catalogAuthorId,
    slug: row.catalogAuthorSlug,
    nameArabic: row.catalogAuthorNameArabic,
    nameEnglish: row.catalogAuthorNameEnglish,
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
    (value): value is string => value !== null && isUsableGeneratedText(value),
  );
}

function poemFromRow(raw: unknown): Poem | undefined {
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
  const snapshot = activePublicationSnapshot(row.publicationJson);
  const parsedPoem = SnapshotPoemSchema.safeParse({
    id: row.id,
    slug: row.slug,
    authorId: row.authorId,
    verses: Math.ceil(linesArabic.length / 2),
    nameArabic: row.nameArabic,
    ...englishTitleFields(row.nameEnglish, row.nameEnglishLegacy),
    linesArabic,
    ...snapshot?.fields,
  });
  if (!parsedPoem.success) return undefined;
  if (
    snapshot &&
    row.sourceHash &&
    row.publicationSourceHash &&
    row.sourceHash !== row.publicationSourceHash
  )
    parsedPoem.data.publicationOutdated = true;
  return parsedPoem.data;
}

const AUTHOR_COLUMNS = `a.id,
  a.slug,
  a.name_arabic AS nameArabic,
  NULLIF(trim(a.name), '') AS nameEnglish`;

const JOINED_AUTHOR_COLUMNS = `a.id AS catalogAuthorId,
  a.slug AS catalogAuthorSlug,
  a.name_arabic AS catalogAuthorNameArabic,
  NULLIF(trim(a.name), '') AS catalogAuthorNameEnglish`;

const POEM_COLUMNS = `p.id,
  p.slug,
  p.author_id AS authorId,
  p.verses,
  p.name_arabic AS nameArabic,
  NULLIF(trim(p.name_english), '') AS nameEnglish,
  NULLIF(trim(p.poem_title_first_line), '') AS nameEnglishLegacy,
  p.content_arabic AS contentArabic,
  p.publication_json AS publicationJson,
  p.source_hash AS sourceHash,
  p.publication_source_hash AS publicationSourceHash`;

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

const POEM_SUMMARY_COLUMNS = `${BASE_POEM_SUMMARY_COLUMNS},
  p.publication_json AS publicationJson`;

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
        `SELECT ${AUTHOR_COLUMNS}, ${PUBLIC_POEM_COUNT} AS poemCount
         FROM author a
        WHERE ${PUBLISHABLE_AUTHOR}
          AND ${HAS_PUBLIC_POEM}
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
          `SELECT ${AUTHOR_COLUMNS}, ${PUBLIC_POEM_COUNT} AS poemCount
           FROM author a
          WHERE a.slug = ?1
            AND ${PUBLISHABLE_AUTHOR}
            AND ${HAS_PUBLIC_POEM}
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
             AND ${HAS_PUBLIC_POEM}
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
    const pageResults = await loadPage(POEM_SUMMARY_COLUMNS);
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
          const publication = activePublicationSnapshot(row.publicationJson);
          return {
            authorId: row.authorId,
            hasEnglish: translationModels.length > 0,
            hasInsights: publication
              ? publication.fields.insights !== undefined ||
                (publication.fields.modelEnrichments ?? []).some(
                  (enrichment) => enrichment.wordGlosses !== undefined,
                )
              : false,
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
    const result = await loadPoem(POEM_COLUMNS);
    const row = result.results[0];
    if (!row) return undefined;
    const parsedRow = PoemRowSchema.safeParse(row);
    if (!parsedRow.success) return undefined;
    const poem = poemFromRow(row);
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
}
