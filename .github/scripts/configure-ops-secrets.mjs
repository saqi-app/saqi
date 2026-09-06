import { spawnSync } from "node:child_process";

const SECRET_BINDINGS = [
  ["CF_CACHE_PURGE_TOKEN", "CF_CACHE_PURGE_TOKEN"],
  ["CF_ZONE_ID", "CF_ZONE_ID"],
  ["SAQI_ACCESS_AUDIENCE", "CF_ACCESS_AUD"],
  ["SAQI_ACCESS_SERVICE_IDENTITIES", "CF_ACCESS_SERVICE_TOKEN_COMMON_NAMES"],
  ["SAQI_ACCESS_TEAM_ORIGIN", "CF_ACCESS_TEAM_DOMAIN"],
  ["SAQI_SOURCE_BASE_URL", "SAQI_SOURCE_BASE_URL"],
  ["SAQI_SOURCE_ADAPTER_CONFIG", "SAQI_SOURCE_ADAPTER_CONFIG"],
  ["SAQI_SOURCE_NAME", "SAQI_SOURCE_NAME"],
];

const secrets = Object.fromEntries(
  SECRET_BINDINGS.map(([binding, environmentName]) => {
    const value = process.env[environmentName];
    if (value === undefined || value.length === 0) {
      throw new Error(
        `Missing required operations secret: ${environmentName}`,
      );
    }
    return [binding, value];
  }),
);

const result = spawnSync(
  "yarn",
  ["workspace", "@saqi/app", "wrangler", "secret", "bulk"],
  {
    cwd: new URL("../../typescript/", import.meta.url),
    input: JSON.stringify(secrets),
    stdio: ["pipe", "inherit", "inherit"],
  },
);

if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
