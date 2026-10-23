import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const VALIDATOR = fileURLToPath(
  new URL("verify-production-canary.ts", import.meta.url)
);
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;
const PRIVATE_SENTINEL = "PRIVATE_PAID_STATE_SENTINEL";
const FAILURE_MESSAGE =
  "PRODUCTION_CANARY_FAILED: authenticated response was invalid\n";
const SITEMAP_XML =
  "<sitemapindex><sitemap><loc>https://saqi.app/sitemaps/poets-1.xml</loc></sitemap></sitemapindex>";

test("accepts each existing authenticated response without printing its body", () => {
  const cases = [
    [
      "sitemap",
      { xml: SITEMAP_XML },
      "PUBLIC_SITEMAP_OK: live XML fetched from public Worker\n",
    ],
    [
      "state",
      { ok: true, state: { checkpoint: PRIVATE_SENTINEL, arabic: "بيت" } },
      "RIG_STATE_OK: canonical D1 queue is readable\n",
    ],
    [
      "state",
      { ok: true, state: null },
      "RIG_STATE_OK: canonical D1 queue is readable\n",
    ],
    [
      "cache",
      { ok: true },
      "RIG_CACHE_PURGE_OK: production write path verified\n",
    ],
    [
      "bootstrap",
      { ok: true, purged: false, cachePending: true },
      "AUTHOR_INDEX_BOOTSTRAP_OK: public cache compatibility verified; concurrent work remains queued\n",
    ],
  ];
  for (const [mode, response, message] of cases) {
    const result = validate(mode, JSON.stringify(response));
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, message);
  }
});

test("state requires literal success and its own object-or-null state", () => {
  for (const response of [
    { ok: true },
    { ok: false, state: { checkpoint: PRIVATE_SENTINEL } },
    { ok: "true", state: {} },
    { ok: 1, state: {} },
    { state: {} },
    { ok: true, state: [] },
    { ok: true, state: PRIVATE_SENTINEL },
    { ok: true, state: 1 },
    { ok: true, state: false },
    { ok: true, xml: SITEMAP_XML },
  ]) {
    assertFailure(validate("state", JSON.stringify(response)));
  }
});

test("sitemap requires XML containing both the index and expected public shard", () => {
  for (const response of [
    {},
    { xml: null },
    { xml: [SITEMAP_XML] },
    { xml: "<sitemapindex/>" },
    {
      xml: "<sitemapindex><sitemap><loc>https://saqi.app/sitemaps/authors-1.xml</loc></sitemap></sitemapindex>",
    },
    {
      xml: SITEMAP_XML.replace(
        "</sitemapindex>",
        "<sitemap><loc>https://saqi.app/sitemaps/authors-1.xml</loc></sitemap></sitemapindex>"
      ),
    },
    { xml: "https://saqi.app/sitemaps/poets-1.xml" },
    { xml: "<sitemapindex>https://other.example/authors-1.xml</sitemapindex>" },
    { ok: true, state: { checkpoint: PRIVATE_SENTINEL } },
  ]) {
    assertFailure(validate("sitemap", JSON.stringify(response)));
  }
});

test("cache and bootstrap reject missing, false and truthy success values", () => {
  for (const mode of ["cache", "bootstrap"]) {
    for (const response of [
      {},
      { ok: false, checkpoint: PRIVATE_SENTINEL },
      { ok: "true" },
      { ok: 1 },
      { ok: null },
    ]) {
      assertFailure(validate(mode, JSON.stringify(response)));
    }
  }
});

test("malformed and non-object responses fail without exposing private excerpts", () => {
  for (const input of [
    "",
    PRIVATE_SENTINEL,
    `{"checkpoint":"${PRIVATE_SENTINEL}",`,
    JSON.stringify(PRIVATE_SENTINEL),
    "[]",
    "null",
    "true",
    "42",
  ]) {
    assertFailure(validate("state", input));
  }
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"ok":true,"state":{"checkpoint":"'),
    Buffer.from([255]),
    Buffer.from('"}}'),
  ]);
  assertFailure(validate("state", invalidUtf8));
});

test("the response bound is inclusive and counts bytes rather than characters", () => {
  const body = '{"ok":true}';
  const exactLimit = body.padEnd(MAXIMUM_RESPONSE_BYTES);
  const accepted = validate("cache", exactLimit);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stdout, "");
  assertFailure(validate("cache", `${exactLimit} `));
  const multibyte = JSON.stringify({
    ok: true,
    state: { checkpoint: "é".repeat(MAXIMUM_RESPONSE_BYTES / 2) },
  });
  assert.ok(multibyte.length < MAXIMUM_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(multibyte) > MAXIMUM_RESPONSE_BYTES);
  assertFailure(validate("state", multibyte));
});

test("unknown modes and extra arguments fail closed", () => {
  for (const mode of ["unknown", "__proto__", "toString"])
    assertFailure(validate(mode, '{"ok":true}'));
  assertFailure(validate("cache", '{"ok":true}', ["extra"]));
});

function validate(mode, input, extraArguments = []) {
  return spawnSync(process.execPath, [VALIDATOR, mode, ...extraArguments], {
    encoding: "utf8",
    input,
    maxBuffer: 8192,
    timeout: 8000,
  });
}

function assertFailure(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, FAILURE_MESSAGE);
  assert.equal(result.stderr.includes(PRIVATE_SENTINEL), false);
}
