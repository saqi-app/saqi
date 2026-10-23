import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalHeaderBlock,
  publicRouteLocation,
  publicRouteUrl,
} from "./public-route-location.ts";

const base = "https://saqi.app/author/poet-old/poem/uuid";
const headers = (location) => `HTTP/2 308\r\nLocation: ${location}\r\n\r\n`;
test("relative and absolute public destinations preserve exact Unicode and one decode", () => {
  for (const token of [
    "first-line-0123456789abcdef",
    "a%2Bb.html",
    "%252F",
    "%C3%A9",
    "e%CC%81",
  ]) {
    for (const prefix of ["author", "poet"]) {
      const path = `/${prefix}/poet-old/poem/${token}`;
      assert.equal(
        publicRouteLocation("poem", base, headers(path)),
        `https://saqi.app${path}`
      );
    }
  }
  assert.equal(
    publicRouteLocation("author", base, headers("/author/old")),
    "https://saqi.app/author/old"
  );
  assert.equal(
    publicRouteLocation("author", base, headers("/poet/old")),
    "https://saqi.app/poet/old"
  );
  assert.equal(
    publicRouteLocation(
      "home",
      "https://www.saqi.app/",
      headers("https://saqi.app/")
    ),
    "https://saqi.app/"
  );
});
test("authority, private paths, unsafe identity segments and malformed locations are refused", () => {
  for (const location of [
    "https://foreign.test/author/a/poem/p",
    // eslint-disable-next-line unicorn/prefer-https -- An insecure redirect must be rejected.
    "http://saqi.app/author/a/poem/p",
    "https://user@saqi.app/author/a/poem/p",
    "/api/rig/state",
    "/poet/a/poem/%2F",
    "/Poet/a/poem/p",
    "/poet/a/poem/p?",
    "/poet/a/poem/p#",
    "/author/a/poem/p?",
    "/author/a/poem/p#",
    "/author/a/poem/%2F",
    "/author/a/poem/%5c",
    "/author/a/poem/%ff",
    "/author/a/poem/%00",
    "/author/a/poem/%2e%2e/p",
    "/author/a/poem/../poem/p",
    String.raw`/author/a/poem/p\q`,
    "/author/a/poem/",
    "/author/a/poem/p/page/2",
  ]) {
    assert.throws(() => publicRouteLocation("poem", base, headers(location)));
  }
  assert.throws(() =>
    publicRouteLocation("home", "https://www.saqi.app/", headers("/"))
  );
  assert.throws(() => publicRouteLocation("poem", base, "HTTP/2 308\n\n"));
  assert.throws(() =>
    publicRouteLocation(
      "poem",
      base,
      "HTTP/2 308\nLocation: /author/a/poem/p\nLocation: /author/a/poem/q\n\n"
    )
  );
});
test("only the final completed header block can classify a retry response", () => {
  const old =
    "HTTP/2 403\r\ncf-mitigated: challenge\r\nserver: cloudflare\r\n\r\n";
  const final = "HTTP/2 403\r\ncontent-type: text/html\r\n\r\n";
  assert.equal(
    finalHeaderBlock(`${old}${final}`),
    "HTTP/2 403\ncontent-type: text/html\n\n"
  );
  assert.throws(() =>
    finalHeaderBlock(`${old}HTTP/2 403\r\ncontent-type: text/html\r\n`)
  );
  assert.equal(
    publicRouteLocation("poem", base, `${old}${headers("/author/a/poem/p")}`),
    "https://saqi.app/author/a/poem/p"
  );
});
test("canonical route kind is checked independently of a redirect", () => {
  assert.equal(
    publicRouteUrl("author", "https://saqi.app/author/a"),
    "https://saqi.app/author/a"
  );
  assert.equal(
    publicRouteUrl("author", "https://saqi.app/poet/a"),
    "https://saqi.app/poet/a"
  );
  assert.throws(() =>
    publicRouteUrl("author", "https://saqi.app/author/a/poem/p")
  );
  assert.throws(() =>
    publicRouteUrl("author", "https://saqi.app/poet/a/poem/p")
  );
});
