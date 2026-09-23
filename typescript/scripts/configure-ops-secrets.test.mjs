import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const configurator = readFileSync(
  new URL("configure-ops-secrets.mjs", import.meta.url),
  "utf8",
);
const configuration = readFileSync(
  new URL("../packages/app/wrangler.jsonc", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
);

const requiredSecrets = [
  ["CF_CACHE_PURGE_TOKEN", "CF_CACHE_PURGE_TOKEN"],
  ["CF_ZONE_ID", "CF_ZONE_ID"],
  ["SAQI_ACCESS_AUDIENCE", "CF_ACCESS_AUD"],
  ["SAQI_ACCESS_TEAM_ORIGIN", "CF_ACCESS_TEAM_DOMAIN"],
  ["SAQI_SOURCE_BASE_URL", "SAQI_SOURCE_BASE_URL"],
  ["SAQI_SOURCE_NAME", "SAQI_SOURCE_NAME"],
];

for (const [binding, environmentName] of requiredSecrets) {
  assert.ok(configurator.includes(`"${binding}"`));
  assert.ok(configuration.includes(`"${binding}"`));
  assert.ok(workflow.includes(`${environmentName}:`));
}

assert.doesNotMatch(
  configuration,
  /"CF_ACCESS_(?:AUD|TEAM_DOMAIN)"\s*:\s*"[^\n]+"/u,
);

const validEnvironment = {
  CF_ACCESS_AUD: "a".repeat(64),
  CF_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  CF_CACHE_PURGE_TOKEN: "cache-token",
  CF_ZONE_ID: "b".repeat(32),
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
  ["CF_ZONE_ID", "not-a-zone"],
  ["SAQI_SOURCE_NAME", "INVALID NAME"],
  ["SAQI_SOURCE_BASE_URL", "not-a-url"],
]) {
  const result = validate({ [name]: value });
  assert.notEqual(result.status, 0, `${name} must fail closed`);
  assert.ok(!result.stderr.includes(value));
}
