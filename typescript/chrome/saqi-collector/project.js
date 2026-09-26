/* exported projectSaqiPage -- Chrome serializes this function into the source tab. */
// Runs in an isolated extension world, only on the configured poetry source.
function projectSaqiPage(expectedAuthor) {
  const challenge =
    /just a moment|verify you are human|attention required/i.test(
      document.title,
    ) ||
    !!document.querySelector(
      "#challenge-form, .cf-challenge-running, .cf-turnstile",
    );
  if (challenge) return { error: "SOURCE_HUMAN_REQUIRED" };
  const base = {
    schemaVersion: 1,
    sourceUrl: location.href,
    challengeDetected: false,
    authorHref: expectedAuthor,
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping -- This helper must travel with the self-contained executeScript callback.
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  if (location.pathname.startsWith("/cat-")) return projectAuthor();
  return projectPoem();
  function projectAuthor() {
    const found = new Map();
    for (const a of document.querySelectorAll('a[href*="poem"]')) {
      const u = new URL(a.href, location.href);
      if (
        u.origin !== location.origin ||
        !/^\/poem[1-9]\d*\.html$/.test(u.pathname)
      )
        continue;
      const title =
        text(a.querySelector("h1,h2,h3,h4,h5,h6,.poet-poem-line")) || text(a);
      if (!title) continue;
      const old = found.get(u.pathname);
      if (!old || /^[٠-٩۰-۹\d,٬\s]+$/u.test(old.title))
        found.set(u.pathname, {
          href: u.pathname,
          title,
          verseCountText: null,
        });
    }
    const stats = [
      ...document.querySelectorAll(
        ".poet-profile-stats > div, .poet-identity-stats > div",
      ),
    ].find((el) =>
      [...el.querySelectorAll(":scope > span")].some((s) =>
        /^(قصيدة|قصائد)$/u.test(text(s)),
      ),
    );
    const count =
      text(stats) ||
      /[٠-٩۰-۹\d][٠-٩۰-۹\d,٬ \t]*(?:قصيدة|قصائد)/u.exec(
        text(document.body),
      )?.[0] ||
      null;
    // Never declare a paginated/unknown-size manifest complete by assumption.
    return {
      ...base,
      kind: "author_poem_manifest",
      declaredPoemCountText: count,
      poems: found.values().toArray(),
      terminal: count !== null,
    };
  }
  function projectPoem() {
    const modern = document.querySelector("#poemText");
    const legacy = document.querySelector("#poem_content");
    const rows = [...(modern?.querySelectorAll(":scope > .poem-line") || [])];
    const legacyRows = [...(legacy?.querySelectorAll(":scope > h3") || [])];
    const content = modern || legacy;
    if (!content) return { error: "SOURCE_CONTENT_NOT_READY" };
    const reader = content.closest(".poem-reader-card") || content;
    const free = [...reader.querySelectorAll("a,span")].some((n) =>
      ["التفعيله", "التفعيلة", "شعر حر", "قصيدة النثر"].includes(
        text(n).normalize("NFC"),
      ),
    );
    const structure = free
      ? "free_verse"
      : rows.length || legacyRows.length
        ? "classical"
        : "unknown";
    const lines = readLines(rows, legacyRows, content, free);
    const author = [...document.querySelectorAll('a[href*="cat-"]')].some(
      (a) =>
        new URL(a.href).pathname.replaceAll(/(?:%20|\s)+$/gu, "") ===
        new URL(expectedAuthor).pathname.replaceAll(/(?:%20|\s)+$/gu, ""),
    );
    const title = (
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title
    )
      .split(/\s+-\s+/u, 1)[0]
      .trim();
    const verseCount =
      /[٠-٩۰-۹\d][٠-٩۰-۹\d,٬\s]*(?:بيت|أبيات)/u.exec(
        text(reader.querySelector(".poem-meta-inline")),
      )?.[0] || null;
    return {
      ...base,
      authorHref: author ? expectedAuthor : "",
      kind: "poem_detail",
      title,
      lines,
      structure,
      declaredVerseCountText: free
        ? null
        : verseCount ||
          (structure === "classical" && lines.length % 2 === 0
            ? String(lines.length / 2)
            : null),
    };
  }
  function readLines(rows, legacyRows, content, free) {
    let lines;
    if (rows.length && !free) {
      const pairs = rows.map((r) =>
        [...r.querySelectorAll(":scope > span")].map(text),
      );
      if (
        pairs.some(
          (p, i) =>
            p.some((v) => !v) ||
            (p.length !== 2 && !(i === pairs.length - 1 && p.length === 1)),
        )
      )
        throw new Error("SOURCE_POEM_STRUCTURE_INVALID");
      lines = pairs.flatMap((p) => (p.length === 1 ? [p[0], ""] : p));
    } else {
      const nodes = legacyRows.length
        ? legacyRows
        : [...content.querySelectorAll(":scope > p, :scope > div")];
      lines = nodes
        .flatMap((n) => text(n).split(/\r?\n/u))
        .map((l) => l.trim());
      while (lines[0] === "") lines.shift();
      while (lines.at(-1) === "") lines.pop();
    }
    return lines;
  }
}
