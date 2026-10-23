import assert from "node:assert/strict";
import { test } from "node:test";

import { productionRouteExpectations } from "./production-route-expectations.ts";

const id = "5cf197dd-692d-4024-acc5-ee081560263f";
function fixture() {
  return [
    {
      success: true,
      results: [
        {
          poemId: id,
          legacyAuthorSlug: "poet-abn-rumi",
          authorSlug: "abn-rumi",
          poemSlug: "first-line-0123456789abcdef",
          poemLanguage: "en",
          legacyAuthorOwned: 1,
          legacyPoemOwned: 1,
          canonicalAuthorOwned: 1,
          canonicalPoemOwned: 1,
        },
      ],
    },
  ];
}
test("strict expectations come only from independently owned persisted route metadata", () => {
  assert.deepEqual(productionRouteExpectations(fixture(), true), {
    author: "https://saqi.app/poet/abn-rumi",
    poem: "https://saqi.app/poet/abn-rumi/poem/first-line-0123456789abcdef",
  });
  const input = fixture();
  Object.assign(input[0].results[0], {
    authorSlug: null,
    poemSlug: null,
    poemLanguage: null,
    canonicalAuthorOwned: 0,
    canonicalPoemOwned: 0,
  });
  assert.equal(
    productionRouteExpectations(input).poem,
    `https://saqi.app/poet/poet-abn-rumi/poem/${id}`
  );
  assert.throws(() => productionRouteExpectations(input, true));
});
test("missing, duplicate, failed, unowned and mismatched metadata fail closed", () => {
  for (const input of [
    null,
    [],
    [...fixture(), ...fixture()],
    [{ success: false, results: fixture()[0].results }],
    [{ success: true, results: [] }],
    [
      {
        success: true,
        results: [...fixture()[0].results, ...fixture()[0].results],
      },
    ],
  ])
    assert.throws(() => productionRouteExpectations(input, true));
  for (const fields of [
    { poemId: "other" },
    { legacyAuthorOwned: 0 },
    { legacyPoemOwned: 0 },
    { canonicalAuthorOwned: 0 },
    { canonicalPoemOwned: 0 },
    { poemLanguage: "fr" },
    { poemSlug: null },
    { authorSlug: null },
    { poemSlug: "/private" },
    { authorSlug: ".." },
    { poemSlug: "" },
    { authorSlug: 123 },
    { extra: "PRIVATE_SENTINEL" },
    { authorSlug: "poet-abn-rumi" },
    { poemSlug: id },
  ]) {
    const input = fixture();
    Object.assign(input[0].results[0], fields);
    assert.throws(() => productionRouteExpectations(input, true));
  }
});
test("Arabic and literal percent identities are encoded once without normalization", () => {
  const input = fixture();
  Object.assign(input[0].results[0], {
    authorSlug: "شاعر",
    poemSlug: "%2F-é",
    poemLanguage: "ar",
  });
  assert.equal(
    productionRouteExpectations(input, true).poem,
    "https://saqi.app/poet/%D8%B4%D8%A7%D8%B9%D8%B1/poem/%252F-%C3%A9"
  );
});
