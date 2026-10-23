import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import {
  authorCollisionSlug,
  authorPublicSlugBase,
  firstEnglishPoemLine,
  poemPublicSlug,
} from "@saqi/precedent-iso";
import { z } from "zod";

import { poemTranslationTracks } from "../../../site/src/lib/poem-translations";
import { PublicationSnapshotSchema } from "../../../site/src/lib/publication-snapshot";

const AuthorCandidateSchema = z.object({
  namespaceId: z.string(),
  authorId: z.string(),
  slug: z.string(),
  sourceAuthorId: z.string().nullable(),
});
const PoemCandidateSchema = z.object({
  id: z.string(),
  authorId: z.string(),
  namespaceId: z.string(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  publicSlug: z.string().nullable(),
  language: z.enum(["ar", "en"]).nullable(),
  contentArabic: z.string().nullable(),
  publicationJson: z.string().nullable(),
});
const AuthorAllocationSchema = z
  .object({ canonicalSlug: z.string().nullable(), sameSource: z.number() })
  .optional();
const ArabicContentSchema = z.object({
  content: z.array(z.string().max(5_000)).min(1).max(2_000),
});

export interface PublicRouteProgress {
  authorsActivated: number;
  authorsChecked: number;
  pending: boolean;
  poemsActivated: number;
  poemsChecked: number;
}

interface PoemAllocation {
  activates: boolean;
  statement: D1PreparedStatement;
}

const AUTHOR_SNAPSHOT = `n.id=?2 AND n.author_id=?3 AND n.canonical_slug IS NULL
  AND EXISTS(SELECT 1 FROM author a WHERE a.id=n.author_id AND a.slug IS ?4 AND a.source_author_id IS ?5)`;

// eslint-disable-next-line @sarj/require-port-for-service, @sarj/require-interface-for-exported-class -- One concrete metadata-only D1 allocator; real-SQL tests exercise atomic ownership and source-generation fences.
export class PublicRouteRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async pending(): Promise<boolean> {
    const row = await this.#database
      .prepare(
        `SELECT
      EXISTS(SELECT 1 FROM public_author_namespace n JOIN author a ON a.id=n.author_id WHERE n.canonical_slug IS NULL)
      OR EXISTS(SELECT 1 FROM poem p INDEXED BY poem_public_routes_pending
        WHERE public_route_checked_generation<public_route_generation AND EXISTS(SELECT 1 FROM author a WHERE a.id=p.author_id)) AS pending`
      )
      .first<{ pending: number }>();
    return row?.pending === 1;
  }

  async advance(limit = 20): Promise<PublicRouteProgress> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError("INVALID_PUBLIC_ROUTE_BATCH_LIMIT");
    const progress: PublicRouteProgress = {
      authorsActivated: 0,
      authorsChecked: 0,
      pending: true,
      poemsActivated: 0,
      poemsChecked: 0,
    };
    const authors = await this.#database
      .prepare(
        `SELECT n.id AS namespaceId,n.author_id AS authorId,a.slug,a.source_author_id AS sourceAuthorId
      FROM public_author_namespace n JOIN author a ON a.id=n.author_id
      WHERE n.canonical_slug IS NULL ORDER BY n.id LIMIT ?1`
      )
      .bind(limit)
      .all<unknown>();
    for (const raw of authors.results) {
      // eslint-disable-next-line no-await-in-loop -- Each bounded allocation is one atomic batch; never retain all corpus publications in memory.
      if (await this.#allocateAuthor(AuthorCandidateSchema.parse(raw)))
        progress.authorsActivated += 1;
      progress.authorsChecked += 1;
    }
    if (authors.results.length === 0) {
      const poems = await this.#database
        .prepare(
          `SELECT p.id FROM poem p INDEXED BY poem_public_routes_pending
        WHERE public_route_checked_generation<public_route_generation AND EXISTS(SELECT 1 FROM author a WHERE a.id=p.author_id)
        ORDER BY p.id LIMIT ?1`
        )
        .bind(limit)
        .all<{ id: string }>();
      const allocations: PoemAllocation[] = [];
      for (const { id } of poems.results) {
        // eslint-disable-next-line no-await-in-loop -- Read and release one publication at a time to bound Worker memory independently of corpus size.
        const allocation = await this.#preparePoemAllocation(id);
        if (allocation) allocations.push(allocation);
        progress.poemsChecked += 1;
      }
      if (allocations.length > 0) {
        // Retain only small guarded updates between reads. One atomic write
        // batch avoids a separate D1 round trip for every prepared poem.
        const results = await this.#database.batch(
          allocations.map(({ statement }) => statement)
        );
        progress.poemsActivated = results.filter(
          (result, index) =>
            allocations[index]?.activates && result.results.length > 0
        ).length;
      }
    }
    progress.pending = await this.pending();
    return progress;
  }

  async #allocateAuthor(
    row: z.infer<typeof AuthorCandidateSchema>
  ): Promise<boolean> {
    const seed = /^source-[a-f0-9]{64}$/u.test(row.slug)
      ? (row.sourceAuthorId ?? row.slug)
      : row.slug;
    const base = authorPublicSlugBase(seed);
    const fallback = await authorCollisionSlug(seed, row.authorId);
    const values = [
      base,
      row.namespaceId,
      row.authorId,
      row.slug,
      row.sourceAuthorId,
      fallback,
    ];
    const activate = (candidate: string) =>
      this.#database
        .prepare(
          `UPDATE public_author_namespace AS n SET canonical_slug=?1 WHERE ${AUTHOR_SNAPSHOT}
      AND EXISTS(SELECT 1 FROM public_author_segment s WHERE s.segment=?1 AND s.namespace_id=n.id) RETURNING id`
        )
        .bind(
          candidate,
          row.namespaceId,
          row.authorId,
          row.slug,
          row.sourceAuthorId
        );
    const results = await this.#database.batch([
      this.#database
        .prepare(
          `INSERT INTO public_author_segment(segment,namespace_id)
        SELECT ?1,n.id FROM public_author_namespace n WHERE ${AUTHOR_SNAPSHOT}
        AND NOT EXISTS(SELECT 1 FROM public_author_segment WHERE segment=?1)`
        )
        .bind(...values.slice(0, 5)),
      activate(base),
      this.#database
        .prepare(
          `INSERT INTO public_author_segment(segment,namespace_id)
        SELECT ?6,n.id FROM public_author_namespace n WHERE ${AUTHOR_SNAPSHOT}
        AND EXISTS(SELECT 1 FROM public_author_segment s WHERE s.segment=?1 AND s.namespace_id<>n.id)
        AND NOT EXISTS(SELECT 1 FROM public_author_segment WHERE segment=?6)`
        )
        .bind(...values),
      activate(fallback),
      this.#database
        .prepare(
          `SELECT n.canonical_slug AS canonicalSlug,
        a.slug IS ?3 AND a.source_author_id IS ?4 AS sameSource
        FROM public_author_namespace n JOIN author a ON a.id=n.author_id WHERE n.id=?1 AND n.author_id=?2`
        )
        .bind(row.namespaceId, row.authorId, row.slug, row.sourceAuthorId),
    ]);
    const final = AuthorAllocationSchema.parse(results[4]?.results[0]);
    if (final?.canonicalSlug === null && final.sameSource === 1)
      throw new Error("PUBLIC_AUTHOR_ROUTE_CONFLICT");
    return (
      (results[1]?.results.length ?? 0) + (results[3]?.results.length ?? 0) > 0
    );
  }

  async #preparePoemAllocation(
    id: string
  ): Promise<PoemAllocation | undefined> {
    const raw = await this.#database
      .prepare(
        `SELECT p.id,p.author_id AS authorId,n.id AS namespaceId,p.public_route_generation AS generation,
      p.public_slug AS publicSlug,p.public_slug_language AS language,
      CASE WHEN p.public_slug_language='en' THEN NULL ELSE p.content_arabic END AS contentArabic,
      CASE WHEN p.public_slug_language='en' THEN NULL ELSE p.publication_json END AS publicationJson
      FROM poem p JOIN public_author_namespace n ON n.author_id=p.author_id
      WHERE p.id=?1 AND public_route_checked_generation<public_route_generation`
      )
      .bind(id)
      .first<unknown>();
    if (!raw) return undefined;
    const row = PoemCandidateSchema.parse(raw);
    let slug = row.publicSlug;
    let language = row.language;
    if (language !== "en" || !slug) {
      const arabic = ArabicContentSchema.parse(
        JSON.parse(row.contentArabic ?? "null")
      ).content;
      const indexes = arabic
        .map((line, index) => (line.trim() ? index : -1))
        .filter((index) => index >= 0);
      const firstArabic =
        indexes.length > 0 ? arabic[indexes[0] ?? 0] : undefined;
      if (!firstArabic) throw new Error("PUBLIC_ROUTE_SOURCE_UNREADABLE");
      let english: string | undefined;
      try {
        const parsed = PublicationSnapshotSchema.safeParse(
          JSON.parse(row.publicationJson ?? "null")
        );
        if (parsed.success)
          english = firstEnglishPoemLine(
            poemTranslationTracks(parsed.data.fields),
            indexes
          );
      } catch {
        /* Invalid legacy publications retain readable Arabic routes. */
      }
      if (!slug || english) {
        slug = await poemPublicSlug(english ?? firstArabic, row.id);
        language = english ? "en" : "ar";
      }
    }
    const statement = this.#database
      .prepare(
        `UPDATE poem SET public_slug=?1,public_slug_language=?2,
      public_route_checked_generation=?3 WHERE id=?4 AND public_route_generation=?3 AND public_route_checked_generation<?3 AND author_id IS ?5
      AND EXISTS(SELECT 1 FROM public_author_namespace n WHERE n.id=?6 AND n.author_id=poem.author_id) RETURNING id`
      )
      .bind(
        slug,
        language,
        row.generation,
        row.id,
        row.authorId,
        row.namespaceId
      );
    return { activates: slug !== row.publicSlug, statement };
  }
}
