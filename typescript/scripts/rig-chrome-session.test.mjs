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
function fixture(statuses = [], existingIds = []) {
  const writes = [],
    reports = [];
  const session = collectorSession(
    async (query, body) => {
      if (body) {
        writes.push(body);
        if (body.action === "reconcile-manifest")
          return {
            existingPoemIds: existingIds.filter((id) =>
              body.poemIds.includes(id),
            ),
          };
        if (body.action === "upsert-poem") {
          const status = statuses.shift() || "unchanged";
          if (status === "review") throw new Error("UNMAPPED_POEM_COLLISION");
          return { result: { status } };
        }
        return { result: { status: "updated" } };
      }
      return query === "?action=next-author"
        ? { author }
        : { poem: { sourceHash: "before-fetch" } };
    },
    (...args) => {
      reports.push(args[0]);
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
  assert.equal(
    writes.find((body) => body.action === "upsert-poem").poem.expectedHash,
    "before-fetch",
  );
  assert.equal(writes.at(-1).action, "complete-author");
  assert.equal(reports.at(-1).state, "idle");
});

test("canonical poems are skipped in bounded manifest batches on restart", async () => {
  const ids = Array.from({ length: 201 }, (_, index) => String(index + 1));
  const { session, writes, reports } = fixture([], ids.slice(0, 200));
  await session({ action: "begin" });
  const result = await session({
    action: "manifest",
    projection: {
      ...manifest,
      declaredPoemCountText: "201",
      poems: ids.map((id) => ({
        ...manifest.poems[0],
        href: `/poem${id}.html`,
      })),
    },
  });
  assert.deepEqual(
    result.poems.map((value) => value.numericId),
    ["201"],
  );
  assert.deepEqual(
    writes
      .filter((body) => body.action === "reconcile-manifest")
      .map((body) => body.poemIds.length),
    [200, 1],
  );
  assert.equal(reports.at(-1).current.processed, 200);
  await assert.rejects(session({ action: "prepare", poemId: "1" }));
  await session({ action: "prepare", poemId: "201" });
  await session({
    action: "poem",
    projection: { ...poem, sourceUrl: "https://www.aldiwan.net/poem201.html" },
  });
  await session({ action: "complete" });
  assert.equal(reports.at(-1).lastCompleted.processed, 201);
});

test("a complete manifest of stored poems finishes without poem fetches and resets the session", async () => {
  const { session, writes, reports } = fixture([], ["1"]);
  await session({ action: "begin" });
  assert.deepEqual(
    await session({ action: "manifest", projection: manifest }),
    { poems: [] },
  );
  await session({ action: "complete" });
  assert.equal(
    writes.some((body) => body.action === "upsert-poem"),
    false,
  );
  assert.equal(reports.at(-1).lastCompleted.unchanged, 1);
  await session({ action: "begin" });
  assert.equal(reports.at(-1).current.processed, 0);
  assert.deepEqual(
    await session({ action: "manifest", projection: manifest }),
    { poems: [] },
  );
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

test("mixed imports retain accurate review evidence in the completed summary", async () => {
  const { session, writes, reports } = fixture([
    "created",
    "updated",
    "unchanged",
    "review",
  ]);
  await session({ action: "begin" });
  await session({
    action: "manifest",
    projection: {
      ...manifest,
      declaredPoemCountText: "4",
      poems: [1, 2, 3, 4].map((id) => ({
        ...manifest.poems[0],
        href: `/poem${id}.html`,
      })),
    },
  });
  for (const id of [1, 2, 3, 4]) {
    await session({ action: "prepare", poemId: String(id) });
    await session({
      action: "poem",
      projection: {
        ...poem,
        sourceUrl: `https://www.aldiwan.net/poem${id}.html`,
      },
    });
  }
  await session({ action: "complete" });
  const final = reports.at(-1);
  assert.equal(final.lastCompleted.processed, 4);
  assert.equal(final.lastCompleted.added, 1);
  assert.equal(final.lastCompleted.updated, 1);
  assert.equal(final.lastCompleted.unchanged, 1);
  assert.equal(final.lastCompleted.reviewRequired, 1);
  assert.deepEqual(final.reviewWarning.poemIds, ["4"]);
  assert.equal(final.reviewWarning.total, 1);
  assert.equal(writes.at(-1).action, "complete-author");
});

test("all collisions remain visible and review identifiers are bounded", async () => {
  const ids = Array.from({ length: 22 }, (_, index) => String(index + 1));
  const { session, reports } = fixture(ids.map(() => "review"));
  await session({ action: "begin" });
  await session({
    action: "manifest",
    projection: {
      ...manifest,
      declaredPoemCountText: "22",
      poems: ids.map((id) => ({
        ...manifest.poems[0],
        href: `/poem${id}.html`,
      })),
    },
  });
  for (const id of ids) {
    await session({ action: "prepare", poemId: id });
    await session({
      action: "poem",
      projection: {
        ...poem,
        sourceUrl: `https://www.aldiwan.net/poem${id}.html`,
      },
    });
  }
  await session({ action: "complete" });
  assert.equal(reports.at(-1).lastCompleted.added, 0);
  assert.equal(reports.at(-1).reviewWarning.total, 22);
  assert.deepEqual(reports.at(-1).reviewWarning.poemIds, ids.slice(0, 20));
});

test("successful completion omits reviewWarning so host preserves prior warning", async () => {
  const { session, reports } = fixture();
  await session({ action: "begin" });
  await session({ action: "manifest", projection: manifest });
  await session({ action: "prepare", poemId: "1" });
  await session({ action: "poem", projection: poem });
  await assert.rejects(session({ action: "prepare", poemId: "1" }));
  await session({ action: "complete" });
  assert.equal(Object.hasOwn(reports.at(-1), "reviewWarning"), false);
});

test("admission validates full manifest and name without changing active author", async () => {
  const { session, writes, reports } = fixture();
  await session({ action: "begin" });
  const otherUrl = "https://www.aldiwan.net/cat-poet-New";
  const other = { ...manifest, authorHref: otherUrl, sourceUrl: otherUrl };
  const reportCount = reports.length;
  const admitted = await session({
    action: "admit-author",
    projection: other,
    nameArabic: " شاعر جديد ",
  });
  assert.equal(admitted.author.sourceAuthorId, "poet-New");
  assert.equal(admitted.author.nameArabic, "شاعر جديد");
  assert.equal(admitted.poemCount, 1);
  assert.equal(reports.length, reportCount);
  await assert.rejects(
    session({
      action: "admit-author",
      projection: { ...other, terminal: false },
      nameArabic: "شاعر",
    }),
  );
  await assert.rejects(
    session({
      action: "admit-author",
      projection: other,
      nameArabic: "\u{202e}شاعر",
    }),
  );
  assert.equal(writes.length, 1);
  await session({ action: "manifest", projection: manifest });
  assert.equal(reports.at(-1).current.authorName, author.nameArabic);
});

test("admission and collection reject an asserted-complete manifest without independent count", async () => {
  const { session, writes } = fixture();
  const projection = { ...manifest, declaredPoemCountText: null };
  await assert.rejects(
    session({ action: "admit-author", projection, nameArabic: "شاعر" }),
    /SOURCE_MANIFEST_COUNT_MISSING/u,
  );
  await session({ action: "begin" });
  await assert.rejects(
    session({ action: "manifest", projection }),
    /SOURCE_MANIFEST_COUNT_MISSING/u,
  );
  assert.deepEqual(writes, []);
});
