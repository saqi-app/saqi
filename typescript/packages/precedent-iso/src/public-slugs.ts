// Persist allocated slugs. This v1 policy must not rewrite existing routes.
const MAX_SLUG_UNITS = 128;
const MAX_ENCODED_SLUG_BYTES = 768;

function normalizedWords(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[\p{M}\p{Cf}\u{0640}]/gu, "")
    .replaceAll(/['‘’ʼ]/gu, "")
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

function boundedWords(value: string, suffix: string): string {
  const budget = MAX_SLUG_UNITS - suffix.length;
  const encodedBudget =
    MAX_ENCODED_SLUG_BYTES - encodeURIComponent(suffix).length;
  const points: string[] = [];
  let prefixUnits = 0;
  let encodedLength = 0;
  for (const point of value) {
    const encodedSize = encodeURIComponent(point).length;
    if (
      prefixUnits + point.length > budget ||
      encodedLength + encodedSize > encodedBudget
    )
      break;
    points.push(point);
    prefixUnits += point.length;
    encodedLength += encodedSize;
  }
  let prefix = points.join("");
  if (prefix.length < value.length && value[prefix.length] !== "-") {
    const boundary = prefix.lastIndexOf("-");
    if (boundary > 0) prefix = prefix.slice(0, boundary);
  }
  return `${prefix.replaceAll(/-+$/gu, "")}${suffix}`;
}

async function identitySuffix(
  kind: "author" | "poem",
  id: string
): Promise<string> {
  if (id.length === 0 || !id.isWellFormed())
    throw new Error("INVALID_PUBLIC_ROUTE_IDENTITY");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`saqi.public-${kind}.v1\u{0000}${id}`)
  );
  return `-${[...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)}`;
}

export async function poemPublicSlug(
  firstLine: string,
  poemId: string
): Promise<string> {
  let words = normalizedWords(firstLine) || "poem";
  if (/^\p{N}+$/u.test(words)) words = `poem-${words}`;
  return boundedWords(words, await identitySuffix("poem", poemId));
}

export function authorPublicSlugBase(seed: string): string {
  const normalized = normalizedWords(seed).replace(/^(?:poet-)+/u, "");
  const words = !normalized || normalized === "poet" ? "author" : normalized;
  return boundedWords(words, "");
}

export async function authorCollisionSlug(
  seed: string,
  authorId: string
): Promise<string> {
  return boundedWords(
    authorPublicSlugBase(seed),
    await identitySuffix("author", authorId)
  );
}
