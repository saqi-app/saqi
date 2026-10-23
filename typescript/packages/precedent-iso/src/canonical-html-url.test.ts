import { expect, test } from "vitest";

import { canonicalHtmlUrl } from "./canonical-html-url.js";

const URL = "https://saqi.app/author/a/poem/first-line-0123456789abcdef";
const LINK = `<link rel="canonical" href="${URL}">`;
test("only one actual canonical head link is accepted regardless of attribute order/case", () => {
  expect(
    canonicalHtmlUrl(
      `<html><head><LINK HREF='${URL}' rel="canonical"></head><body>${LINK}</body></html>`
    )
  ).toBe(URL);
  expect(canonicalHtmlUrl(`<head>${LINK}${LINK}</head>`)).toBeUndefined();
  expect(
    canonicalHtmlUrl(`<head><link rel="canonical"></head>`)
  ).toBeUndefined();
});
test.each([
  `<!--${LINK}-->`,
  `<script>const fake='${LINK}';</script>`,
  `<style>/*${LINK}*/</style>`,
  `<template>${LINK}</template>`,
  `<noscript>${LINK}</noscript>`,
  `<template><template>${LINK}</template></template>`,
  `<meta content='${LINK}'>`,
])(
  "comments/raw text/templates/attributes cannot stand in for a canonical: %s",
  (fake) => {
    expect(canonicalHtmlUrl(`<head>${fake}</head>`)).toBeUndefined();
    expect(
      canonicalHtmlUrl(
        `<head><link rel="canonical" href="wrong">${fake}</head>`
      )
    ).toBe("wrong");
  }
);
test("attribute entities are decoded while script-like source text remains inert", () => {
  expect(
    canonicalHtmlUrl(
      '<head><link rel="canon&#105;cal" href="https://saqi.app/author/a/poem/a&#39;b"></head>'
    )
  ).toBe("https://saqi.app/author/a/poem/a'b");
});
