import { canonicalHtmlUrl } from "@saqi/precedent-iso/canonical-html-url";

import {
  poemTranslationTracks,
  poemWordGlossTracks,
} from "../../../site/src/lib/poem-translations";
import { fetchPublicPoemPage } from "./fetch-public-poem-page";
import type { CloudflareEnv } from "./parse-cloudflare-env";
import type { RigPublicationRepository } from "./rig-publication-repository";

type Publication = NonNullable<
  Awaited<ReturnType<RigPublicationRepository["readPublication"]>>
>;

export async function verifyPublishedPage(
  publication: Publication,
  poemId: string,
  env: CloudflareEnv
) {
  const url = `https://saqi.app/poet/${encodeURIComponent(publication.authorSlug)}/poem/${encodeURIComponent(poemId)}`;
  if (!env.PUBLIC_SITE) return { url, error: "PUBLIC_SITE_UNAVAILABLE" };
  try {
    const expectedUrl = `https://saqi.app/poet/${encodeURIComponent(publication.canonicalAuthorSlug)}/poem/${encodeURIComponent(publication.canonicalPoemSlug)}`;
    // A source token may belong to a retired author incarnation. The current
    // namespace always owns this poem's stable UUID; historical canaries are
    // checked independently by deployment verification.
    const checkedUrl = `https://saqi.app/poet/${encodeURIComponent(publication.canonicalAuthorSlug)}/poem/${encodeURIComponent(poemId)}`;
    const response = await fetchPublicPoemPage(
      env.PUBLIC_SITE,
      checkedUrl,
      expectedUrl
    );
    const html = response.html;
    const canonicalMatches =
      response.url === expectedUrl && canonicalHtmlUrl(html) === expectedUrl;
    const matches =
      response.status === 200 && canonicalMatches
        ? publicationTextMatches(publication, html)
        : undefined;
    return {
      url,
      status: response.status,
      checkedUrl,
      resolvedUrl: response.url,
      expectedUrl,
      canonicalMatches,
      translationMatches: matches?.translation ?? false,
      wordMeaningsMatch: matches?.wordMeanings ?? false,
    };
  } catch {
    return { url, error: "PUBLIC_PAGE_UNAVAILABLE" };
  }
}

function publicationTextMatches(publication: Publication, html: string) {
  const contains = (text: string) => {
    const escaped = text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    return (
      html.includes(escaped) ||
      html.includes(
        escaped.replaceAll('"', "&quot;").replaceAll("'", "&#39;")
      ) ||
      html.includes(escaped.replaceAll('"', "&quot;").replaceAll("'", "&#x27;"))
    );
  };
  const lines = poemTranslationTracks(publication.snapshot.fields)
    .flatMap((track) => track.lines)
    .filter((line) => line.trim().length > 0);
  const meanings = poemWordGlossTracks(publication.snapshot.fields).flatMap(
    (track) =>
      track.wordGlosses.lines.flatMap((line) =>
        line.segments
          .filter((segment) => segment.kind === "word")
          .map((segment) => segment.meaning)
      )
  );
  return {
    translation: lines.length > 0 && lines.every(contains),
    wordMeanings: meanings.length > 0 && meanings.every(contains),
  };
}
