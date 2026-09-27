import {
  parseAuthorPoemManifest,
  parsePoemDetail,
} from "../packages/source-collector/dist/source-adapter/index.js";

// eslint-disable-next-line @sarj/sole-export-matches-filename -- The rig-chrome prefix groups this bridge with its host and installation scripts.
export function collectorSession(api, report) {
  let author, manifest, prepared;
  const completed = new Set();
  const reviewIds = [];
  const counts = {
    processed: 0,
    total: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    reviewRequired: 0,
  };
  const current = () => ({
    authorName: author.nameArabic,
    sourceUrl: author.sourceUrl,
    ...counts,
  });
  function progress(message) {
    report({
      state: "collecting",
      current: current(),
      message,
      progress: true,
    });
  }
  async function handle(input) {
    switch (input.action) {
      case "begin":
        if (author) throw new Error("Author already selected");
        ({ author } = await api("?action=next-author"));
        report({
          state: author ? "collecting" : "idle",
          current: author ? current() : null,
          message: author
            ? `Collecting ${author.nameArabic}`
            : "No source-linked author available",
          progress: Boolean(author),
        });
        return { author };
      case "admit-author":
        return admitAuthor(input);
      case "origin":
        await api("?action=origin");
        return {};
      case "manifest": {
        if (!author || manifest) throw new Error("No pending author manifest");
        const candidate = verifiedManifest(input.projection);
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
        counts.total = manifest.poems.length;
        progress(`${author.nameArabic}: 0/${counts.total} poems`);
        return { poems: manifest.poems };
      }
      case "prepare": {
        if (
          prepared ||
          completed.has(input.poemId) ||
          !manifest?.poems.some((p) => p.numericId === input.poemId)
        )
          throw new Error("Unexpected poem");
        const stored = await api(
          `?action=poem&sourcePoemId=${encodeURIComponent(input.poemId)}`,
        );
        prepared = {
          id: input.poemId,
          expectedHash: stored.poem?.sourceHash ?? null,
        };
        return {};
      }
      case "poem": {
        return ingestPoem(input.projection);
      }
      case "complete":
        if (!manifest || prepared || completed.size !== manifest.poems.length)
          throw new Error("Incomplete author");
        await api("", {
          action: "complete-author",
          sourceAuthorId: author.sourceAuthorId,
        });
        reportCompleted();
        return {};
      default:
        throw new Error("Unknown collector action");
    }
  }
  function reportCompleted() {
    const patch = {
      state: "idle",
      current: null,
      lastCompleted: { ...current(), completedAt: new Date().toISOString() },
      message: `${author.nameArabic}: ${counts.processed} checked; ${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.reviewRequired} need identity review`,
      progress: true,
    };
    if (counts.reviewRequired)
      patch.reviewWarning = {
        authorName: author.nameArabic,
        sourceUrl: author.sourceUrl,
        total: counts.reviewRequired,
        poemIds: [...reviewIds],
        at: new Date().toISOString(),
      };
    report(patch);
  }
  async function admitAuthor(input) {
    const candidate = verifiedManifest(input.projection);
    const nameArabic =
      // eslint-disable-next-line no-restricted-syntax -- Native message name is untrusted input; reject non-string values before normalization.
      typeof input.nameArabic === "string"
        ? input.nameArabic.trim().normalize("NFC")
        : "";
    if (
      !nameArabic ||
      nameArabic.length > 500 ||
      /[\p{Cc}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u.test(nameArabic)
    )
      throw new Error("SOURCE_AUTHOR_NAME_INVALID");
    const admitted = {
      sourceAuthorId: candidate.author.slug,
      sourceUrl: candidate.author.href,
      nameArabic,
    };
    const { result } = await api("", {
      action: "upsert-author",
      author: admitted,
    });
    return { author: admitted, poemCount: candidate.poems.length, result };
  }
  async function ingestPoem(projection) {
    const poem = parsePoemDetail(projection);
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
      result = { status: "review_required" };
    }
    const counter =
      result.status === "review_required"
        ? "reviewRequired"
        : {
            created: "added",
            updated: "updated",
            unchanged: "unchanged",
          }[result.status];
    if (!counter) throw new Error("SOURCE_RESULT_INVALID");
    counts[counter]++;
    counts.processed++;
    if (result.status === "review_required" && reviewIds.length < 20)
      reviewIds.push(prepared.id);
    completed.add(prepared.id);
    prepared = null;
    progress(
      `${author.nameArabic}: ${counts.processed}/${counts.total} poems · ${poem.numericId}: ${result.status}`,
    );
    return { result };
  }
  return handle;
}

function verifiedManifest(projection) {
  const candidate = parseAuthorPoemManifest(projection);
  if (candidate.declaredPoemCount === null)
    throw new Error("SOURCE_MANIFEST_COUNT_MISSING");
  return candidate;
}
