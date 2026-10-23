import {
  firstEnglishPoemLine,
  isUsablePoemTitle,
  SITEMAP_SHARD_COUNT,
} from "@saqi/precedent-iso";
import { z } from "zod";

import {
  type CatalogDatabase,
  catalogDatabaseFromD1,
} from "./catalog-database-from-d1";
import { poemListLabel } from "./metadata";
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
  // eslint-disable-next-line no-control-regex -- Catalog text rejects these exact unsafe control characters.
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
  UNSAFE_CONTROL_CODE_POINTS
);
// Match String.prototype.trim() at the SQL boundary, including line breaks
// and Unicode spaces. SQLite's default trim removes only ASCII spaces.
const TRIM_WHITESPACE_CODE_POINTS: readonly number[] = [
  9,
  10,
  11,
  12,
  13,
  32,
  160,
  5760,
  ...Array.from({ length: 11 }, (_, index) => 8192 + index),
  8232,
  8233,
  8239,
  8287,
  12288,
  65279,
];
const TRIM_WHITESPACE_SQL = `char(${TRIM_WHITESPACE_CODE_POINTS.join(",")})`;
const TRIM_WHITESPACE_CHARACTERS = String.fromCodePoint(
  ...TRIM_WHITESPACE_CODE_POINTS
);
const trimmedSql = (column: string) =>
  `trim(${column}, ${TRIM_WHITESPACE_SQL})`;
const SAFE_IDENTITY_SQL = (
  column: string
) => `length(${trimmedSql(column)}) BETWEEN 1 AND 500
  AND ${column} = ${trimmedSql(column)}
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
const PUBLISHABLE_POEM = `${SAFE_ROUTE_SEGMENT_SQL("p.id")}
  AND ${SAFE_ROUTE_SEGMENT_SQL("p.slug")}
  AND ${SAFE_IDENTITY_SQL("p.name_arabic")}
  AND p.verses BETWEEN 1 AND 1000`;
const PUBLISHABLE_AUTHOR = `${SAFE_IDENTITY_SQL("a.id")}
  AND ${SAFE_ROUTE_SEGMENT_SQL("a.slug")}
  AND instr(a.slug, '%') = 0
  AND ${SAFE_IDENTITY_SQL("a.name_arabic")}
  AND (a.name IS NULL OR ${trimmedSql("a.name")} = '' OR ${SAFE_IDENTITY_SQL("a.name")})`;
const PUBLIC_POEM_COUNT = `(SELECT count(*) FROM poem public_poem
  WHERE public_poem.author_id = a.id)`;
const HAS_PUBLIC_POEM = `EXISTS (SELECT 1 FROM poem public_poem
  WHERE public_poem.author_id = a.id)`;
const AuthorRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  publicSlug: z.string().nullable(),
  nameArabic: z.string(),
  nameEnglish: z.string().nullable(),
});

const AuthorIndexRowSchema = AuthorRowSchema.extend({
  poemCount: z.number().int().positive(),
});
const JoinedAuthorRowSchema = z.object({
  catalogAuthorId: z.string(),
  catalogAuthorSlug: z.string(),
  catalogAuthorPublicSlug: z.string().nullable(),
  catalogAuthorNameArabic: z.string(),
  catalogAuthorNameEnglish: z.string().nullable(),
});
const PoemSummaryRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  publicSlug: z.string().nullable(),
  authorId: z.string(),
  nonblankArabicLineIndexesJson: z.string(),
  nameArabic: z.string(),
  nameEnglish: z.string().nullable(),
  publicationJson: z.string().nullable(),
});

const ArabicLineIndexesSchema = z
  .array(z.number().int().min(0).max(1_999))
  .max(2_000);
const SitemapPoemRowSchema = z.object({
  authorId: z.string(),
  authorSlug: z.string(),
  authorPublicSlug: z.string().nullable(),
  publicSlug: z.string().nullable(),
  id: z.string(),
});

const PoemRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  publicSlug: z.string().nullable(),
  authorId: z.string(),
  verses: z.number().int().positive(),
  nameArabic: z.string(),
  nameEnglish: z.string().nullable(),
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
export type { CatalogDatabase } from "./catalog-database-from-d1";

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
  id: string;
  nameArabic: string;
  nameEnglish?: string;
  publicSlug?: string;
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
  tracks: ReturnType<typeof poemTranslationTracks>
): TranslationAvailability[] {
  return tracks.flatMap((track) => {
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

interface AuthorPageOptions {
  // The caller already knows that the request URL needs normalization.
  redirectOnly?: boolean;
}

interface AuthorPageRedirect {
  author: Author;
  pageNumber: number;
  redirect: true;
}

export interface PoemPage {
  author: Author;
  poem: Poem;
}

export interface SitemapPoem {
  author: Pick<Author, "id" | "publicSlug" | "slug">;
  poem: Pick<Poem, "authorId" | "id" | "publicSlug">;
}

interface CatalogReader {
  getAuthorIndex(): Promise<AuthorIndexPage>;
  getAuthorPage(
    slug: string,
    pageNumber?: number,
    options?: AuthorPageOptions
  ): Promise<AuthorPage | AuthorPageRedirect | undefined>;
  getPoemPage(
    authorSlug: string,
    poemId: string
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
  if (row.publicSlug) author.publicSlug = row.publicSlug;
  if (row.nameEnglish) author.nameEnglish = row.nameEnglish;
  return SnapshotAuthorSchema.parse(author);
}

function authorFromJoinedRow(raw: unknown): Author {
  const row = JoinedAuthorRowSchema.parse(raw);
  return authorFromRow({
    id: row.catalogAuthorId,
    slug: row.catalogAuthorSlug,
    publicSlug: row.catalogAuthorPublicSlug,
    nameArabic: row.catalogAuthorNameArabic,
    nameEnglish: row.catalogAuthorNameEnglish,
  });
}

function englishTitleFields(
  value: null | string
): { nameEnglish: string } | Record<string, never> {
  return value !== null && isUsablePoemTitle(value)
    ? { nameEnglish: value }
    : {};
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
    (_, index) => index * 2
  ).flatMap((firstIndex) =>
    sourceLines[firstIndex]?.trim() || sourceLines[firstIndex + 1]?.trim()
      ? [firstIndex, firstIndex + 1].filter(
          (index) => index < sourceLines.length
        )
      : []
  );
  const linesArabic = retainedLineIndexes.map(
    (index) => sourceLines[index] ?? ""
  );
  const snapshot = activePublicationSnapshot(row.publicationJson);
  const candidate: Poem = {
    id: row.id,
    slug: row.slug,
    authorId: row.authorId,
    verses: Math.ceil(linesArabic.length / 2),
    nameArabic: row.nameArabic,
    ...englishTitleFields(row.nameEnglish),
    linesArabic,
    ...snapshot?.fields,
  };
  if (row.publicSlug) candidate.publicSlug = row.publicSlug;
  const parsedPoem = SnapshotPoemSchema.safeParse(candidate);
  if (!parsedPoem.success) return undefined;
  alignPublicationLines(parsedPoem.data, retainedLineIndexes);
  if (parsedPoem.data.wordGlosses?.sourceHash !== row.sourceHash)
    delete parsedPoem.data.wordGlosses;
  if (
    snapshot &&
    row.sourceHash &&
    row.publicationSourceHash &&
    row.sourceHash !== row.publicationSourceHash
  )
    parsedPoem.data.publicationOutdated = true;
  return parsedPoem.data;
}

function alignPublicationLines(
  poem: Poem,
  retainedLineIndexes: number[]
): void {
  const projectLines = (lines: string[]) =>
    retainedLineIndexes.map((index) => lines[index] ?? "");
  const lineIndexes = new Map(
    retainedLineIndexes.map((oldIndex, newIndex) => [oldIndex, newIndex])
  );
  const projectGlosses = (
    glosses: NonNullable<Poem["wordGlosses"]>["meanings"]
  ) => {
    const seen = new Set<number>();
    for (const { lineIndex } of glosses.lines) {
      if (seen.has(lineIndex)) return undefined;
      seen.add(lineIndex);
    }
    const lines: typeof glosses.lines = [];
    for (const line of glosses.lines) {
      const lineIndex = lineIndexes.get(line.lineIndex);
      if (lineIndex === undefined) continue;
      const surface = line.segments.map((segment) => segment.surface).join("");
      if (surface.normalize("NFKC") === poem.linesArabic[lineIndex]) {
        lines.push({ ...line, lineIndex });
      }
    }
    return lines.length > 0 ? { ...glosses, lines } : undefined;
  };
  for (const field of [
    "linesEnglish",
    "linesEnglishGemini",
    "linesEnglishSol",
  ] as const) {
    const lines = poem[field];
    if (lines) poem[field] = projectLines(lines);
  }
  if (poem.modelEnrichments)
    for (const enrichment of poem.modelEnrichments) {
      enrichment.lines = projectLines(enrichment.lines);
      if (enrichment.wordGlosses) {
        const glosses = projectGlosses(enrichment.wordGlosses);
        if (glosses) enrichment.wordGlosses = glosses;
        else delete enrichment.wordGlosses;
      }
    }
  if (poem.wordGlosses) {
    const glosses = projectGlosses(poem.wordGlosses.meanings);
    if (glosses) poem.wordGlosses.meanings = glosses;
    else delete poem.wordGlosses;
  }
}

const AUTHOR_COLUMNS = `a.id,
  a.slug,
  (SELECT n.canonical_slug FROM public_author_namespace n WHERE n.author_id=a.id) AS publicSlug,
  a.name_arabic AS nameArabic,
  NULLIF(${trimmedSql("a.name")}, '') AS nameEnglish`;

const JOINED_AUTHOR_COLUMNS = `a.id AS catalogAuthorId,
  a.slug AS catalogAuthorSlug,
  (SELECT n.canonical_slug FROM public_author_namespace n WHERE n.author_id=a.id) AS catalogAuthorPublicSlug,
  a.name_arabic AS catalogAuthorNameArabic,
  NULLIF(${trimmedSql("a.name")}, '') AS catalogAuthorNameEnglish`;

const POEM_COLUMNS = `p.id,
  p.slug,
  p.public_slug AS publicSlug,
  p.author_id AS authorId,
  p.verses,
  p.name_arabic AS nameArabic,
  NULLIF(${trimmedSql("p.name_english")}, '') AS nameEnglish,
  p.content_arabic AS contentArabic,
  p.publication_json AS publicationJson,
  p.source_hash AS sourceHash,
  p.publication_source_hash AS publicationSourceHash`;

const BASE_POEM_SUMMARY_COLUMNS = `p.id,
  p.slug,
  p.public_slug AS publicSlug,
  p.author_id AS authorId,
  (
    SELECT json_group_array(CAST(line.key AS INTEGER))
    FROM json_each(CASE WHEN json_valid(p.content_arabic)
      THEN p.content_arabic ELSE '{"content":[]}' END, '$.content') line
    WHERE line.type = 'text' AND trim(line.value, ?4) <> ''
  ) AS nonblankArabicLineIndexesJson,
  p.name_arabic AS nameArabic,
  NULLIF(${trimmedSql("p.name_english")}, '') AS nameEnglish`;

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
        ORDER BY a.sort_name_arabic, a.id`
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
    options?: AuthorPageOptions
  ): Promise<AuthorPage | AuthorPageRedirect | undefined> {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return undefined;
    const offset = (pageNumber - 1) * AUTHOR_PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) return undefined;

    const authorStatement = this.#database
      .prepare(
        `SELECT ${AUTHOR_COLUMNS}, ${PUBLIC_POEM_COUNT} AS poemCount
           FROM author a
          WHERE a.id = (SELECT n.author_id FROM public_author_segment s JOIN public_author_namespace n ON n.id=s.namespace_id WHERE s.segment=?1 COLLATE BINARY)
            AND ${PUBLISHABLE_AUTHOR}
            AND ${HAS_PUBLIC_POEM}
          LIMIT 1`
      )
      .bind(slug);
    // Alias and URL-normalization redirects need only validated author metadata.
    const poemsStatement = this.#database
      .prepare(
        // eslint-disable-next-line @sarj/no-offset-pagination -- Canonical author/page/N URLs require random page access without a prior cursor. Preserve indexed (sort_name_arabic, id) ordering; LIMIT bounds returned rows, not skipped work. Cursor migration needs revision-bound page anchors.
        `SELECT ${POEM_SUMMARY_COLUMNS}
         FROM poem p
        WHERE p.author_id = (
          SELECT a.id
            FROM author a
           WHERE a.id = (SELECT n.author_id FROM public_author_segment s JOIN public_author_namespace n ON n.id=s.namespace_id WHERE s.segment=?1 COLLATE BINARY)
             AND ${PUBLISHABLE_AUTHOR}
             AND ${HAS_PUBLIC_POEM}
             AND COALESCE((SELECT NULLIF(n.canonical_slug, '') FROM public_author_namespace n WHERE n.author_id=a.id), a.slug) = ?1 COLLATE BINARY
           LIMIT 1
        )
          AND ${PUBLISHABLE_POEM}
          AND json_valid(p.content_arabic)
          AND json_type(p.content_arabic, '$.content') = 'array'
          AND json_array_length(p.content_arabic, '$.content') BETWEEN 1 AND 2000
          AND EXISTS (
            SELECT 1 FROM json_each(p.content_arabic, '$.content') line
            WHERE line.type = 'text' AND trim(line.value, ?4) <> ''
          )
        ORDER BY p.sort_name_arabic,
                 p.id
        LIMIT ?2 OFFSET ?3`
      )
      .bind(slug, AUTHOR_PAGE_SIZE, offset, TRIM_WHITESPACE_CHARACTERS);
    const pageResults = await this.#database.batch(
      options?.redirectOnly
        ? [authorStatement]
        : [authorStatement, poemsStatement]
    );
    const authorRow = pageResults.at(0)?.results.at(0);
    if (!authorRow) return undefined;
    const parsedAuthor = AuthorIndexRowSchema.parse(authorRow);
    const pageCount = Math.ceil(parsedAuthor.poemCount / AUTHOR_PAGE_SIZE);
    if (pageNumber > pageCount) return undefined;
    const author = authorFromRow(parsedAuthor);
    if (options?.redirectOnly || (author.publicSlug ?? author.slug) !== slug)
      return { author, pageNumber, redirect: true };
    return {
      author,
      pageCount,
      pageNumber,
      poemCount: parsedAuthor.poemCount,
      poems: PoemSummaryRowSchema.array()
        .parse(pageResults.at(1)?.results ?? [])
        .map((row) => {
          const snapshot = activePublicationSnapshot(row.publicationJson);
          const tracks = snapshot ? poemTranslationTracks(snapshot.fields) : [];
          const translationModels = summaryTranslationModels(tracks);
          const indexes = ArabicLineIndexesSchema.parse(
            JSON.parse(row.nonblankArabicLineIndexesJson)
          );
          const nonblankIndexes = [...new Set(indexes)].toSorted(
            (a, b) => a - b
          );
          const englishLine = firstEnglishPoemLine(tracks, nonblankIndexes);
          const summary: PoemSummary = {
            authorId: row.authorId,
            hasEnglish: translationModels.length > 0,
            id: row.id,
            nameArabic: row.nameArabic,
            ...(englishLine
              ? { nameEnglish: poemListLabel(englishLine) }
              : englishTitleFields(row.nameEnglish)),
            slug: row.slug,
            verses: new Set(
              nonblankIndexes.map((index) => Math.floor(index / 2))
            ).size,
            translationModels,
          };
          if (row.publicSlug) summary.publicSlug = row.publicSlug;
          return summary;
        }),
    };
  }

  async getPoemPage(
    authorSlug: string,
    poemId: string
  ): Promise<PoemPage | undefined> {
    const result = await this.#database
      .prepare(
        `SELECT ${JOINED_AUTHOR_COLUMNS}, ${POEM_COLUMNS}
         FROM public_author_segment requested
         JOIN public_poem_alias alias ON alias.author_namespace_id=requested.namespace_id AND alias.segment=?2 COLLATE BINARY
         JOIN poem p ON p.id=alias.poem_id
         JOIN author a ON a.id=p.author_id
        WHERE requested.segment=?1 COLLATE BINARY
          AND ${PUBLISHABLE_AUTHOR}
          AND ${PUBLISHABLE_POEM}
        LIMIT 1`
      )
      .bind(authorSlug, poemId)
      .all();
    const row = result.results[0];
    if (!row) return undefined;
    const poem = poemFromRow(row);
    return poem ? { author: authorFromJoinedRow(row), poem } : undefined;
  }

  async listSitemapPoems(shard: number): Promise<SitemapPoem[]> {
    if (
      !Number.isSafeInteger(shard) ||
      shard < 1 ||
      shard > SITEMAP_SHARD_COUNT
    )
      return [];
    const result = await this.#database
      .prepare(
        `SELECT a.id AS authorId, a.slug AS authorSlug, p.id, p.public_slug AS publicSlug,
         (SELECT n.canonical_slug FROM public_author_namespace n WHERE n.author_id=a.id) AS authorPublicSlug
         FROM poem p
         JOIN author a ON a.id = p.author_id
        WHERE ${PUBLISHABLE_AUTHOR}
          AND ${PUBLISHABLE_POEM}
          AND p.sitemap_shard = ?1
        ORDER BY p.id
        LIMIT 50001`
      )
      .bind(shard - 1)
      .all();
    return SitemapPoemRowSchema.array()
      .parse(result.results)
      .map((row) => {
        const author: SitemapPoem["author"] = {
          id: row.authorId,
          slug: row.authorSlug,
        };
        const poem: SitemapPoem["poem"] = {
          id: row.id,
          authorId: row.authorId,
        };
        if (row.authorPublicSlug) author.publicSlug = row.authorPublicSlug;
        if (row.publicSlug) poem.publicSlug = row.publicSlug;
        return { author, poem };
      });
  }
}
