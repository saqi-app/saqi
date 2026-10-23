import { hash } from "node:crypto";

const POEM_PATH = /^\/(?:poet|author)\/([^/]+)\/poem\/([^/]+)\/?$/u;
const AUTHOR_PATH = /^\/(?:poet|author)\/([^/]+)(?:\/page\/\d+)?\/?$/u;
export const AUTHOR_INDEX_CACHE_TAG = "saqi-author-index";
export const SITEMAP_CACHE_TAG = "saqi-sitemaps";

export interface PublicCacheRoute {
  authorSlug: string;
  poemId?: string;
}

// Cloudflare requires printable ASCII and at most 1,024 characters per tag.
// Keep existing tags where possible; the digest namespace cannot collide with
// any literal identity under the legacy saqi-poem-/saqi-author- prefixes.
export function identityCacheTag(
  kind: "author" | "poem",
  identity: string
): string {
  if (!identity || identity.length > 500 || !identity.isWellFormed())
    throw new Error("Invalid publication cache identity");
  const encoded = `saqi-${kind}-${encodeURIComponent(identity)}`;
  return encoded.length <= 1_024
    ? encoded
    : `saqi-key-${kind}-${hash("sha256", identity, "hex")}`;
}

export function cacheTags(
  pathname: string,
  owner?: PublicCacheRoute
): string[] {
  const tags = ["saqi-corpus"];
  if (pathname === "/") tags.push(AUTHOR_INDEX_CACHE_TAG);
  if (pathname === "/sitemap-index.xml" || pathname.startsWith("/sitemaps/"))
    tags.push(SITEMAP_CACHE_TAG);
  if (owner) {
    tags.push(identityCacheTag("author", owner.authorSlug));
    if (owner.poemId) tags.push(identityCacheTag("poem", owner.poemId));
    return tags;
  }
  const poemId = POEM_PATH.exec(pathname)?.[2];
  const authorSlug = AUTHOR_PATH.exec(pathname)?.[1];
  // Unresolved paths must never supply trusted ownership. This fallback keeps
  // pre-resolution legacy redirects compatible; resolved pages pass the owner.
  try {
    if (poemId) tags.push(identityCacheTag("poem", decodeURIComponent(poemId)));
    else if (authorSlug)
      tags.push(identityCacheTag("author", decodeURIComponent(authorSlug)));
  } catch {
    return tags;
  }
  return tags;
}

export function publicationCacheTags(
  authorSlug: string,
  poemId: string
): string[] {
  return [
    identityCacheTag("poem", poemId),
    identityCacheTag("author", authorSlug),
  ];
}
