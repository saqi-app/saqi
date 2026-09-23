const POEM_PATH = /^\/author\/([^/]+)\/poem\/([^/]+)\/?$/u;
const AUTHOR_PATH = /^\/author\/([^/]+)(?:\/page\/\d+)?\/?$/u;

export function cacheTags(pathname: string): string[] {
  const tags = ["saqi-corpus"];
  const poemId = POEM_PATH.exec(pathname)?.[2];
  if (poemId) {
    tags.push(`saqi-poem-${poemId}`);
  } else {
    const authorSlug = AUTHOR_PATH.exec(pathname)?.[1];
    if (authorSlug) tags.push(`saqi-author-${authorSlug}`);
  }
  if (pathname === "/insights") tags.push("saqi-insights");
  return tags;
}

export function publicationCacheTags(
  authorSlug: string,
  poemId: string,
): string[] {
  if (!authorSlug || authorSlug.length > 128 || !poemId || poemId.length > 128)
    throw new Error("Invalid publication cache route");
  return [
    `saqi-poem-${encodeURIComponent(poemId)}`,
    `saqi-author-${encodeURIComponent(authorSlug)}`,
    "saqi-insights",
  ];
}
