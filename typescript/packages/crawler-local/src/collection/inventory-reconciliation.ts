import { z } from "zod";

import {
  canonicalAuthorUrl,
  canonicalPoemUrl,
  LIMITS,
} from "../source-adapter/index.js";

const CatalogAuthorSchema = z
  .object({
    poemCount: z.int().min(0).max(LIMITS.poemsPerAuthor).nullish(),
    slug: z.string().min(1).max(LIMITS.authorSlug),
  })
  .strict();
const CatalogAuthorRecordsSchema = z.array(CatalogAuthorSchema).max(50_000);

interface CatalogAuthor {
  readonly canonicalId: string;
  readonly href: string;
  readonly name?: string;
  readonly poemCount: null | number;
  readonly slug: string;
}

export interface CatalogInventory {
  readonly authors: readonly CatalogAuthor[];
  readonly declaredPoems: number;
  readonly unknownPoemCounts: number;
}

export function parseCatalogInventory(input: unknown): CatalogInventory {
  const records = CatalogAuthorRecordsSchema.parse(input);
  const seen = new Set<string>();
  const authors = records.map((record) => {
    const author = canonicalAuthorUrl(
      `/cat-${encodeURIComponent(record.slug.normalize("NFC"))}`,
    );
    if (seen.has(author.canonicalId)) {
      throw new Error("SOURCE_CATALOG_AUTHOR_DUPLICATE");
    }
    seen.add(author.canonicalId);
    return {
      canonicalId: author.canonicalId,
      href: author.href,
      poemCount: record.poemCount ?? null,
      slug: author.slug,
    };
  });
  authors.sort((left, right) =>
    left.canonicalId.localeCompare(right.canonicalId),
  );
  return {
    authors,
    declaredPoems: authors.reduce(
      (sum, author) => sum + (author.poemCount ?? 0),
      0,
    ),
    unknownPoemCounts: authors.filter(({ poemCount }) => poemCount === null)
      .length,
  };
}

export function canonicalPoemIdFromLegacySlug(slug: string): string {
  return canonicalPoemUrl(`/poem${sourcePoemIdFromLegacySlug(slug)}.html`)
    .canonicalId;
}

export function sourcePoemIdFromLegacySlug(slug: string): string {
  const match = /^poem([1-9]\d*)$/.exec(slug);
  if (!match?.[1]) throw new Error("SOURCE_LEGACY_POEM_SLUG_INVALID");
  return match[1];
}
