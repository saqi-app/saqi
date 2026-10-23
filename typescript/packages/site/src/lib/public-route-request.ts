// Astro decodes route params recursively. Historical aliases require exactly
// one decode of the original request path, with no case or Unicode folding.
export type PublicRouteRequest =
  | { authorSlug: string; kind: "author"; pageNumber: number }
  | { authorSlug: string; kind: "poem"; poemSlug: string };

export function publicRouteRequest(
  requestUrl: string
): PublicRouteRequest | undefined {
  const path = new URL(requestUrl).pathname;
  const parts = path.split("/").filter(Boolean);
  const prefix = exactSegment(parts[0] ?? "");
  if (
    (parts.length !== 2 && parts.length !== 4) ||
    (prefix !== "poet" && prefix !== "author")
  )
    return undefined;
  const authorSlug = exactSegment(parts[1] ?? "");
  if (!authorSlug) return undefined;
  if (parts.length === 2) return { authorSlug, kind: "author", pageNumber: 1 };
  const kind = exactSegment(parts[2] ?? "");
  const text = exactSegment(parts[3] ?? "");
  if (kind === "poem")
    return text ? { authorSlug, kind: "poem", poemSlug: text } : undefined;
  if (kind !== "page" || !text) return undefined;
  const pageNumber = /^[1-9]\d*$/u.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(pageNumber) && pageNumber > 0
    ? { authorSlug, kind: "author", pageNumber }
    : undefined;
}

function exactSegment(encoded: string): string | undefined {
  try {
    const value = decodeURIComponent(encoded);
    if (
      !value ||
      value === "." ||
      value === ".." ||
      // eslint-disable-next-line no-control-regex -- Reject routing separators and unsafe control characters after exactly one decode.
      /[/\\\u{0000}-\u{001f}\u{007f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u.test(
        value
      )
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function publicRouteRedirectUrl(
  requestUrl: string,
  path: string
): undefined | URL {
  const url = new URL(requestUrl);
  const canonical = new URL(url);
  canonical.pathname = path;
  canonical.search = "";
  if (canonical.hostname === "www.saqi.app") canonical.hostname = "saqi.app";
  return canonical.href === url.href ? undefined : canonical;
}
