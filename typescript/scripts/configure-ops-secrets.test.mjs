import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

const validEnvironment = {
  CF_ACCESS_AUD: "a".repeat(64),
  CF_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  SAQI_PUBLIC_CACHE_PURGE_SECRET: "b".repeat(64),
  SAQI_SOURCE_BASE_URL: "https://source.example",
  SAQI_SOURCE_NAME: "source",
};

function validate(overrides = {}) {
  return spawnSync(
    process.execPath,
    [
      new URL("configure-ops-secrets.mjs", import.meta.url).pathname,
      "--validate-only",
    ],
    {
      encoding: "utf8",
      env: { ...validEnvironment, ...overrides },
    },
  );
}

assert.equal(validate().status, 0);
for (const [name, value] of [
  ["CF_ACCESS_AUD", "not-an-audience"],
  ["CF_ACCESS_TEAM_DOMAIN", "https://example.com"],
  ["SAQI_PUBLIC_CACHE_PURGE_SECRET", "not-a-secret"],
  ["SAQI_SOURCE_NAME", "INVALID NAME"],
  ["SAQI_SOURCE_BASE_URL", "not-a-url"],
]) {
  const result = validate({ [name]: value });
  assert.notEqual(result.status, 0, `${name} must fail closed`);
  assert.ok(!result.stderr.includes(value));
}
