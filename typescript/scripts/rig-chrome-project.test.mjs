import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";

import {
  configureSource,
  parsePoemDetail,
} from "../packages/source-collector/dist/source-adapter/index.js";

configureSource({ name: "aldiwan", origin: "https://www.aldiwan.net" });
const code = readFileSync(
  new URL("../chrome/saqi-collector/project.js", import.meta.url),
  "utf8",
);
const author = "https://www.aldiwan.net/cat-poet-Test";
function fixture({
  byline = author,
  count = "عدد الأبيات: 2",
  breadcrumbs = 1,
  footer = author,
  free = false,
  url = "https://www.aldiwan.net/poem1.html",
  heading = "شاعر",
} = {}) {
  const line = (values) => ({
    querySelectorAll: () => values.map((innerText) => ({ innerText })),
  });
  const rows = [
    line(["قلب المحب", "نور القمر"]),
    line(["سار الرفيق", "بين الشجر"]),
  ];
  const reader = {
    querySelectorAll(selector) {
      if (selector === "a,span") return free ? [{ innerText: "شعر حر" }] : [];
      if (selector === ".poem-meta-inline > span")
        return count === null
          ? []
          : [{ innerText: count }, { innerText: "5,569 قراءة" }];
      throw new Error(`Unexpected reader query: ${selector}`);
    },
  };
  const content = {
    closest: () => reader,
    querySelectorAll(selector) {
      if (selector === ":scope > .poem-line") return rows;
      if (selector === ":scope > p, :scope > div")
        return [{ innerText: "قلب المحب\nنور القمر" }];
      throw new Error(`Unexpected poem query: ${selector}`);
    },
  };
  const document = {
    title: "قصيدة - شاعر",
    querySelector(selector) {
      if (selector === "#poemText") return content;
      if (selector === 'meta[property="og:title"]')
        return { content: "قصيدة - شاعر" };
      if (selector === "#poet-page-title")
        return heading === null ? null : { innerText: heading };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".poem-breadcrumb")
        return Array.from({ length: breadcrumbs }, () => ({
          querySelectorAll: () =>
            byline
              ? [
                  { href: "https://www.aldiwan.net/cat-poets-veteran" },
                  { href: byline },
                ]
              : [],
        }));
      // Recommendation links deliberately contain the expected author.
      if (selector === 'a[href*="cat-"]') return [{ href: footer }];
      throw new Error(`Unexpected document query: ${selector}`);
    },
  };
  const scope = { document, location: new URL(url), URL };
  return {
    poem: () =>
      runInNewContext(
        `${code}\nprojectSaqiPage(${JSON.stringify(author)})`,
        scope,
      ),
    preview: () =>
      runInNewContext(`${code}\nprojectSaqiAuthorPreview()`, scope),
  };
}

test("actual breadcrumb and independent source verse count produce a valid poem", () => {
  const projection = fixture({ byline: `${author}%20` }).poem();
  assert.equal(projection.authorHref, `${author}%20`);
  assert.equal(projection.declaredVerseCountText, "عدد الأبيات: 2");
  assert.equal(parsePoemDetail(projection).lines.length, 4);
});

test("recommendation links cannot replace missing or mismatched author evidence", () => {
  assert.equal(
    fixture({ byline: null }).poem().error,
    "SOURCE_POEM_AUTHOR_MISSING",
  );
  assert.equal(
    fixture({ byline: "https://www.aldiwan.net/cat-poet-Other" }).poem().error,
    "SOURCE_POEM_AUTHOR_MISMATCH",
  );
  assert.equal(
    fixture({ byline: "https://evil.example/cat-poet-Test" }).poem().error,
    "SOURCE_POEM_AUTHOR_MISMATCH",
  );
  assert.equal(
    fixture({ breadcrumbs: 2 }).poem().error,
    "SOURCE_POEM_AUTHOR_MISSING",
  );
});

test("missing independent count fails closed and a partial poem fails native validation", () => {
  assert.equal(
    fixture({ count: null }).poem().error,
    "SOURCE_POEM_COUNT_MISSING",
  );
  assert.throws(
    () => parsePoemDetail(fixture({ count: "عدد الأبيات: 3" }).poem()),
    /SOURCE_CLASSICAL_LINE_COUNT_MISMATCH/u,
  );
  assert.equal(
    parsePoemDetail(fixture({ free: true, count: null }).poem()).structure,
    "free_verse",
  );
});

test("author preview requires a source author page and its actual heading", () => {
  const preview = fixture({ url: `${author}%20` }).preview();
  assert.equal(preview.sourceUrl, author);
  assert.equal(preview.nameArabic, "شاعر");
  assert.equal(fixture().preview().error, "SOURCE_AUTHOR_PAGE_REQUIRED");
  assert.equal(
    fixture({ url: "https://evil.example/cat-poet-Test" }).preview().error,
    "SOURCE_AUTHOR_PAGE_REQUIRED",
  );
  assert.equal(
    fixture({ url: author, heading: null }).preview().error,
    "SOURCE_AUTHOR_NAME_MISSING",
  );
});
