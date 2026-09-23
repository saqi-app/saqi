import { currentSource, LIMITS } from "./constants.js";

const POEM_PATH = /^\/(poem([1-9]\d*))\.html$/;
const AUTHOR_PATH = /^\/cat-([\p{L}\p{N}_%-][\p{L}\p{N}_.%~-]*)$/u;
const INVENTORY_PATH = /^\/authers-[1-9]\d*$/;

export interface CanonicalAuthorUrl {
  canonicalId: string;
  href: string;
  path: string;
  slug: string;
}

export interface CanonicalPoemUrl {
  canonicalId: string;
  href: string;
  numericId: string;
  path: string;
  slug: string;
}

export interface CanonicalInventoryUrl {
  cursor?: null | string;
  href: string;
  page: number;
  path: string;
}

function exactSourceUrl(value: string): URL {
  if (value.length === 0 || value.length > LIMITS.url) {
    throw new Error("SOURCE_URL_LENGTH");
  }
  let url: URL;
  try {
    url = new URL(value, currentSource().origin);
  } catch {
    throw new Error("SOURCE_URL_INVALID");
  }
  const configuredOrigin = new URL(currentSource().origin);
  if (
    url.origin !== configuredOrigin.origin ||
    url.protocol !== "https:" ||
    url.hostname !== configuredOrigin.hostname ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("SOURCE_URL_FORBIDDEN");
  }
  return url;
}

export function canonicalAuthorUrl(value: string): CanonicalAuthorUrl {
  const url = exactSourceUrl(value);
  const match = AUTHOR_PATH.exec(url.pathname);
  const encodedSlug = match?.[1];
  if (!encodedSlug) throw new Error("SOURCE_AUTHOR_PATH_INVALID");

  let slug: string;
  let transportSlug: string;
  try {
    transportSlug = decodeURIComponent(encodedSlug).trim();
    slug = transportSlug
      .normalize("NFC")
      .replaceAll(
        /[\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]/gu,
        "",
      )
      .trim();
  } catch {
    throw new Error("SOURCE_AUTHOR_ENCODING_INVALID");
  }
  if (slug.length === 0 || slug.length > LIMITS.authorSlug) {
    throw new Error("SOURCE_AUTHOR_SLUG_LENGTH");
  }
  if (!/^[\p{L}\p{N}\p{Pd}_.~]+(?: [\p{L}\p{N}\p{Pd}_.~]+)*$/u.test(slug)) {
    throw new Error("SOURCE_AUTHOR_SLUG_INVALID");
  }

  // Aldiwan occasionally uses decomposed Unicode and bidi marks as material
  // path bytes even though they are presentation noise for author identity.
  // Preserve those bytes for transport while keeping the canonical identity
  // normalized, otherwise a valid inventory link can become a source 404.
  const path = `/cat-${encodeURIComponent(transportSlug)}`;
  const source = currentSource();
  const href = `${source.origin}${path}`;
  return { canonicalId: `${source.name}:author:${slug}`, href, path, slug };
}

export function canonicalPoemUrl(value: string): CanonicalPoemUrl {
  const url = exactSourceUrl(value);
  const match = POEM_PATH.exec(url.pathname);
  const slug = match?.[1];
  const numericId = match?.[2];
  if (!slug || !numericId) throw new Error("SOURCE_POEM_PATH_INVALID");
  const parsedId = Number(numericId);
  if (!Number.isSafeInteger(parsedId)) throw new Error("SOURCE_POEM_ID_RANGE");
  const path = `/${slug}.html`;
  return {
    canonicalId: `${currentSource().name}:poem:${numericId}`,
    href: `${currentSource().origin}${path}`,
    numericId,
    path,
    slug,
  };
}

export function canonicalInventoryUrl(value: string): CanonicalInventoryUrl {
  const url = exactSourceUrl(value);
  const match = INVENTORY_PATH.exec(url.pathname);
  if (!match) throw new Error("SOURCE_INVENTORY_PATH_INVALID");
  const page = Number(url.pathname.slice("/authers-".length));
  if (!Number.isSafeInteger(page))
    throw new Error("SOURCE_INVENTORY_PAGE_RANGE");
  return { href: url.href, page, path: url.pathname };
}

export function canonicalInventoryPaginationUrl(
  value: string,
): CanonicalInventoryUrl & { readonly cursor: null | string } {
  if (value.length === 0 || value.length > LIMITS.url)
    throw new Error("SOURCE_URL_LENGTH");
  let url: URL;
  try {
    url = new URL(value, currentSource().origin);
  } catch {
    throw new Error("SOURCE_URL_INVALID");
  }
  const configuredOrigin = new URL(currentSource().origin);
  if (
    url.origin !== configuredOrigin.origin ||
    url.protocol !== "https:" ||
    url.hostname !== configuredOrigin.hostname ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  )
    throw new Error("SOURCE_URL_FORBIDDEN");
  const match = INVENTORY_PATH.exec(url.pathname);
  if (!match) throw new Error("SOURCE_INVENTORY_PATH_INVALID");
  const page = Number(url.pathname.slice("/authers-".length));
  if (!Number.isSafeInteger(page))
    throw new Error("SOURCE_INVENTORY_PAGE_RANGE");
  const cursorValues = url.searchParams.getAll("cursor");
  if (
    (url.searchParams.size !== 0 &&
      (url.searchParams.size !== 1 || cursorValues.length !== 1)) ||
    cursorValues[0] === ""
  )
    throw new Error("SOURCE_INVENTORY_CURSOR_INVALID");
  return {
    cursor: cursorValues[0] ?? null,
    href: url.href,
    page,
    path: url.pathname,
  };
}
