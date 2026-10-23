import assert from "node:assert/strict";
import test from "node:test";

import {
  publicRouteRedirectUrl,
  publicRouteRequest,
} from "../src/lib/public-route-request";
import {
  authorPagePath,
  authorPath,
  englishAuthorLabel,
  poemPath,
  sitemapShard,
} from "../src/lib/routes";

const AUTHOR = {
  id: "author-id",
  slug: "poet عربي",
  nameArabic: "شاعر",
};

await test("route paths encode database identity exactly once", () => {
  const path = authorPath(AUTHOR);
  assert.equal(path, "/poet/poet%20%D8%B9%D8%B1%D8%A8%D9%8A");
  assert.equal(
    poemPath(AUTHOR, { authorId: AUTHOR.id, id: "poem%20/id" }),
    `${path}/poem/poem%2520%2Fid`
  );
});

await test("author pagination uses a single canonical URL for page one", () => {
  assert.equal(authorPagePath(AUTHOR, 1), authorPath(AUTHOR));
  assert.equal(authorPagePath(AUTHOR, 2), `${authorPath(AUTHOR)}/page/2`);
  assert.throws(() => authorPagePath(AUTHOR, 0), RangeError);
  assert.throws(() => authorPagePath(AUTHOR, 1.5), RangeError);
});

await test("sitemap shards accept only the sixteen stable partitions", () => {
  assert.equal(sitemapShard("1"), 1);
  assert.equal(sitemapShard("16"), 16);
  for (const value of [undefined, "", "0", "01", "+1", "1e2", "17"]) {
    assert.equal(sitemapShard(value), undefined);
  }
});

await test("breadcrumb labels use names, safe slugs, and Arabic fallbacks", () => {
  assert.equal(
    englishAuthorLabel({ ...AUTHOR, nameEnglish: "  Al Mutanabbi  " }),
    "Al Mutanabbi"
  );
  assert.equal(
    englishAuthorLabel({ ...AUTHOR, slug: "poet-amna-bnt-otaiba" }),
    "Amna Bnt Otaiba"
  );
  assert.equal(englishAuthorLabel(AUTHOR), AUTHOR.nameArabic);
  const collected = {
    ...AUTHOR,
    slug: "source-d4c37691756dd33f39fb111412827fd4d5188b9c0ecf712c32213db778ea02ee",
    nameArabic: "ابن عمر الضمدي",
  };
  assert.equal(englishAuthorLabel(collected), collected.nameArabic);
  assert.equal(
    englishAuthorLabel({ ...collected, nameEnglish: "Ibn Umar al-Damadi" }),
    "Ibn Umar al-Damadi"
  );
});

await test("public paths use persisted names while preserving immutable identities", () => {
  const author = { ...AUTHOR, publicSlug: "clean-author" };
  const poem = {
    authorId: AUTHOR.id,
    id: "stable-uuid",
    publicSlug: "the-first-line-0123456789abcdef",
  };
  assert.equal(authorPath(author), "/poet/clean-author");
  assert.equal(
    poemPath(author, poem),
    "/poet/clean-author/poem/the-first-line-0123456789abcdef"
  );
  assert.equal(poem.id, "stable-uuid");
});

for (const [path, expected] of [
  [
    "/author/Poet/poem/%252F",
    { kind: "poem", authorSlug: "Poet", poemSlug: "%2F" },
  ],
  [
    "/author/e%CC%81/poem/a+b.html",
    { kind: "poem", authorSlug: "e\u{301}", poemSlug: "a+b.html" },
  ],
  [
    "/poet/Poet/poem/%252F",
    { kind: "poem", authorSlug: "Poet", poemSlug: "%2F" },
  ],
  [
    "/poet/e%CC%81/poem/a+b.html",
    { kind: "poem", authorSlug: "e\u{301}", poemSlug: "a+b.html" },
  ],
  [
    "/%61uthor/poet/%70age/%32",
    { kind: "author", authorSlug: "poet", pageNumber: 2 },
  ],
  [
    "/%70oet/poet/%70age/%32",
    { kind: "author", authorSlug: "poet", pageNumber: 2 },
  ],
  [
    "//poet//poet///page/%31/",
    { kind: "author", authorSlug: "poet", pageNumber: 1 },
  ],
] as const) {
  await test(`decodes the original public route once: ${path}`, () => {
    assert.deepEqual(
      publicRouteRequest(`https://saqi.app${path}?tracking=1`),
      expected
    );
  });
}

for (const path of [
  "/author/a/poem/%2F",
  "/author/a/poem/%5C",
  "/author/a/poem/%00",
  "/author/a/poem/%E2%80%AE",
  "/author/a/poem/%FF",
  "/author/a/poem/%",
  "/author/a/page/01",
  "/author/a/page/9007199254740992",
  "/author/a/poem/p/extra",
  "/Poet/a/poem/p",
  "/Author/a/poem/p",
  "/poet/a/poem/%2F",
  "/poet/a/poem/%5C",
  "/poet/a/poem/%00",
  "/poet/a/poem/%E2%80%AE",
  "/poet/a/poem/%FF",
  "/poet/a/poem/%",
  "/poet/a/page/01",
  "/poet/a/page/9007199254740992",
  "/poet/a/poem/p/extra",
]) {
  await test(`rejects malformed original route: ${path}`, () => {
    assert.equal(publicRouteRequest(`https://saqi.app${path}`), undefined);
  });
}

await test("combines canonical path, host, and query without changing preview hosts", () => {
  assert.equal(
    publicRouteRedirectUrl(
      "https://www.saqi.app/poet/old/poem/id/?q=1",
      "/poet/clean/poem/first-line"
    )?.href,
    "https://saqi.app/poet/clean/poem/first-line"
  );
  assert.equal(
    publicRouteRedirectUrl("http://localhost:4321/poet/old", "/poet/clean")
      ?.href,
    "http://localhost:4321/poet/clean"
  );
  assert.equal(
    publicRouteRedirectUrl("https://saqi.app/poet/clean", "/poet/clean"),
    undefined
  );
});

await test("historical author URLs select the poet canonical in one redirect", () => {
  const author = {
    ...AUTHOR,
    slug: "ibrahim-jabari",
    publicSlug: "ibrahim-jabari",
  };
  const poem = {
    authorId: AUTHOR.id,
    id: "stable-id",
    publicSlug: "others-can-find-consolation-77b30ca771dce25b",
  };
  const path = poemPath(author, poem);
  assert.equal(
    path,
    "/poet/ibrahim-jabari/poem/others-can-find-consolation-77b30ca771dce25b"
  );
  assert.equal(
    publicRouteRedirectUrl(
      "https://www.saqi.app/author/ibrahim-jabari/poem/others-can-find-consolation-77b30ca771dce25b/?tracking=1",
      path
    )?.href,
    `https://saqi.app${path}`
  );
});

await test("detects author URL normalization before loading poem summaries", () => {
  for (const [url, expected] of [
    ["https://saqi.app/author/poet", "https://saqi.app/poet/poet"],
    [
      "https://saqi.app/author/poet/page/2",
      "https://saqi.app/poet/poet/page/2",
    ],
    ["https://saqi.app/author/poet/page/1?q=1", "https://saqi.app/poet/poet"],
    ["https://saqi.app/poet/poet", undefined],
    ["https://saqi.app/poet/poet/page/2", undefined],
    ["https://saqi.app/poet/poet/page/1", "https://saqi.app/poet/poet"],
    ["https://saqi.app/poet/poet?q=1", "https://saqi.app/poet/poet"],
    ["https://saqi.app/poet/poet/", "https://saqi.app/poet/poet"],
    ["https://saqi.app/%61uthor/poet", "https://saqi.app/poet/poet"],
    ["https://saqi.app/poet/%70oet", "https://saqi.app/poet/poet"],
    ["https://www.saqi.app/poet/poet", "https://saqi.app/poet/poet"],
    ["http://localhost:4321/poet/poet", undefined],
    ["http://localhost:4321/poet/poet?q=1", "http://localhost:4321/poet/poet"],
    ["https://saqi.app/poet/e%cc%81", "https://saqi.app/poet/e%CC%81"],
  ] as const) {
    const route = publicRouteRequest(url);
    assert.ok(route?.kind === "author");
    assert.equal(
      publicRouteRedirectUrl(
        url,
        authorPagePath({ slug: route.authorSlug }, route.pageNumber)
      )?.href,
      expected
    );
  }
});

await test("cache tags bound exact Unicode identities without literal/digest collisions", async () => {
  const { identityCacheTag, publicationCacheTags, cacheTags } =
    await import("../src/lib/cache-tags");
  const boundary = `${"漢".repeat(112)}aaaaaa`;
  assert.equal(identityCacheTag("poem", boundary).length, 1024);
  const long = "漢".repeat(500);
  const key = identityCacheTag("poem", long);
  assert.match(key, /^saqi-key-poem-[a-f0-9]{64}$/u);
  assert.notEqual(key, identityCacheTag("poem", key.slice("saqi-".length)));
  assert.notEqual(
    identityCacheTag("poem", "é"),
    identityCacheTag("poem", "e\u{301}")
  );
  assert.deepEqual(publicationCacheTags("poet-عربي", "a+b"), [
    "saqi-poem-a%2Bb",
    `saqi-author-${encodeURIComponent("poet-عربي")}`,
  ]);
  for (const path of [
    "/sitemap-index.xml",
    "/sitemaps/authors-1.xml",
    "/sitemaps/poets-1.xml",
    "/sitemaps/poems-16.xml",
  ])
    assert.deepEqual(cacheTags(path), ["saqi-corpus", "saqi-sitemaps"]);
});
