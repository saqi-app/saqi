import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../../", import.meta.url);
const [configuration, configurator, workflow] = await Promise.all([
  readFile(
    new URL("typescript/packages/app/wrangler.jsonc", repositoryRoot),
    "utf8",
  ),
  readFile(
    new URL(".github/scripts/configure-ops-secrets.mjs", repositoryRoot),
    "utf8",
  ),
  readFile(new URL(".github/workflows/deploy.yml", repositoryRoot), "utf8"),
]);

const requiredSecrets = [
  ["CF_CACHE_PURGE_TOKEN", "CF_CACHE_PURGE_TOKEN"],
  ["CF_ZONE_ID", "CF_ZONE_ID"],
  ["SAQI_ACCESS_AUDIENCE", "CF_ACCESS_AUD"],
  ["SAQI_ACCESS_SERVICE_IDENTITIES", "CF_ACCESS_SERVICE_TOKEN_COMMON_NAMES"],
  ["SAQI_ACCESS_TEAM_ORIGIN", "CF_ACCESS_TEAM_DOMAIN"],
  ["SAQI_SOURCE_BASE_URL", "SAQI_SOURCE_BASE_URL"],
  ["SAQI_SOURCE_ADAPTER_CONFIG", "SAQI_SOURCE_ADAPTER_CONFIG"],
  ["SAQI_SOURCE_NAME", "SAQI_SOURCE_NAME"],
];

for (const [binding, environmentName] of requiredSecrets) {
  assert.match(configurator, new RegExp(`"${binding}"`));
  assert.match(configuration, new RegExp(`"${binding}"`));
  assert.match(
    workflow,
    new RegExp(
      `${environmentName}: \\$\\{\\{ secrets\\.${environmentName} \\}\\}`,
    ),
  );
}

assert.doesNotMatch(
  configuration,
  /"CF_ACCESS_(?:AUD|SERVICE_TOKEN_COMMON_NAMES|TEAM_DOMAIN)"\s*:\s*"[^\n]+"/u,
);
