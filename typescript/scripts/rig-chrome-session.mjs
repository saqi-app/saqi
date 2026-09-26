import {
  parseAuthorPoemManifest,
  parsePoemDetail,
} from "../packages/source-collector/dist/source-adapter/index.js";

export function collectorSession(api, report) {
  let author, manifest, prepared;
  const completed = new Set();
  async function handle(input) {
    switch (input.action) {
      case "begin":
        if (author) throw new Error("Author already selected");
        ({ author } = await api("?action=next-author"));
        report(
          author
            ? `Collecting ${author.nameArabic}: ${author.sourceUrl}`
            : "No source-linked author available",
          author ? "running" : "scheduled",
        );
        return { author };
      case "origin":
        await api("?action=origin");
        return {};
      case "manifest": {
        if (!author || manifest) throw new Error("No pending author manifest");
        const candidate = parseAuthorPoemManifest(input.projection);
        if (candidate.author.slug !== author.sourceAuthorId)
          throw new Error("SOURCE_MANIFEST_AUTHOR_MISMATCH");
        manifest = candidate;
        await api("", {
          action: "upsert-author",
          author: {
            sourceAuthorId: author.sourceAuthorId,
            sourceUrl: author.sourceUrl,
            nameArabic: author.nameArabic,
          },
        });
        report(`${author.nameArabic}: 0/${manifest.poems.length} poems`);
        return { poems: manifest.poems };
      }
      case "prepare": {
        if (
          prepared ||
          !manifest?.poems.some((p) => p.numericId === input.poemId)
        )
          throw new Error("Unexpected poem");
        const current = await api(
          `?action=poem&sourcePoemId=${encodeURIComponent(input.poemId)}`,
        );
        prepared = {
          id: input.poemId,
          expectedHash: current.poem?.sourceHash ?? null,
        };
        return {};
      }
      case "poem": {
        const poem = parsePoemDetail(input.projection);
        if (
          !prepared ||
          poem.numericId !== prepared.id ||
          poem.author.slug !== author.sourceAuthorId
        )
          throw new Error("SOURCE_POEM_ID_MISMATCH");
        let result;
        try {
          ({ result } = await api("", {
            action: "upsert-poem",
            poem: {
              sourceAuthorId: author.sourceAuthorId,
              sourcePoemId: poem.numericId,
              sourceUrl: poem.href,
              titleArabic: poem.title,
              linesArabic: poem.lines,
              expectedHash: prepared.expectedHash,
            },
          }));
        } catch (error) {
          if (error.message !== "UNMAPPED_POEM_COLLISION") throw error;
          result = { status: "identity review required; not imported" };
        }
        completed.add(prepared.id);
        prepared = null;
        report(
          `${author.nameArabic}: ${completed.size}/${manifest.poems.length} poems · ${poem.numericId}: ${result.status}`,
        );
        return { result };
      }
      case "complete":
        if (!manifest || prepared || completed.size !== manifest.poems.length)
          throw new Error("Incomplete author");
        await api("", {
          action: "complete-author",
          sourceAuthorId: author.sourceAuthorId,
        });
        report(
          `${author.nameArabic}: complete (${completed.size} poems)`,
          "scheduled",
        );
        return {};
      default:
        throw new Error("Unknown collector action");
    }
  }
  return handle;
}
