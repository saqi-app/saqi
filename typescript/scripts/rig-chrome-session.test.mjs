import assert from "node:assert/strict";
import { test } from "node:test";

import { configureSource } from "../packages/source-collector/dist/source-adapter/index.js";
import { collectorSession } from "./rig-chrome-session.mjs";
configureSource({ name: "aldiwan", origin: "https://www.aldiwan.net" });
const author = {
  sourceAuthorId: "poet-Test",
  sourceUrl: "https://www.aldiwan.net/cat-poet-Test",
  nameArabic: "شاعر",
};
const manifest = {
  schemaVersion: 1,
  challengeDetected: false,
  kind: "author_poem_manifest",
  authorHref: author.sourceUrl,
  sourceUrl: author.sourceUrl,
  declaredPoemCountText: "1",
  terminal: true,
  poems: [{ href: "/poem1.html", title: "قصيدة", verseCountText: null }],
};
const poem = {
  schemaVersion: 1,
  challengeDetected: false,
  kind: "poem_detail",
  authorHref: author.sourceUrl,
  sourceUrl: "https://www.aldiwan.net/poem1.html",
  declaredVerseCountText: "1",
  structure: "classical",
  title: "قصيدة",
  lines: ["قلب المحب", "نور القمر"],
};
function fixture() {
  const writes = [],
    reports = [];
  const session = collectorSession(
    async (query, body) => {
      if (body) {
        writes.push(body);
        return { result: { status: "unchanged" } };
      }
      return query === "?action=next-author"
        ? { author }
        : { poem: { sourceHash: "before-fetch" } };
    },
    (...args) => {
      reports.push(args);
    },
  );
  return { session, writes, reports };
}
test("rejects partial manifests and does not advance author", async () => {
  const { session, writes } = fixture();
  await session({ action: "begin" });
  await assert.rejects(
    session({
      action: "manifest",
      projection: { ...manifest, declaredPoemCountText: "2" },
    }),
  );
  assert.deepEqual(writes, []);
  await assert.rejects(session({ action: "complete" }));
});
test("preserves pre-fetch source hash and completes only after every poem", async () => {
  const { session, writes, reports } = fixture();
  await session({ action: "begin" });
  await session({ action: "manifest", projection: manifest });
  await assert.rejects(session({ action: "complete" }));
  await session({ action: "prepare", poemId: "1" });
  await assert.rejects(
    session({
      action: "poem",
      projection: { ...poem, sourceUrl: "https://www.aldiwan.net/poem2.html" },
    }),
  );
  await session({ action: "poem", projection: poem });
  await session({ action: "complete" });
  assert.equal(writes[1].poem.expectedHash, "before-fetch");
  assert.equal(writes.at(-1).action, "complete-author");
  assert.equal(reports.at(-1)[1], "scheduled");
});
test("challenge and unknown commands cannot mutate corpus", async () => {
  const { session, writes } = fixture();
  await session({ action: "begin" });
  await assert.rejects(
    session({
      action: "manifest",
      projection: { ...manifest, challengeDetected: true },
    }),
  );
  await assert.rejects(session({ action: "delete-everything" }));
  assert.deepEqual(writes, []);
});

test("a mismatched empty author manifest cannot complete the selected author", async () => {
  const { session, writes } = fixture();
  await session({ action: "begin" });
  await assert.rejects(
    session({
      action: "manifest",
      projection: {
        ...manifest,
        authorHref: "https://www.aldiwan.net/cat-poet-Other",
        sourceUrl: "https://www.aldiwan.net/cat-poet-Other",
        poems: [],
        declaredPoemCountText: "0",
      },
    }),
  );
  await assert.rejects(session({ action: "complete" }));
  assert.deepEqual(writes, []);
});
