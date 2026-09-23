import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";

// These are the Worker bindings consumed by the active public deployment.
const SECRET_BINDINGS = [
  ["SAQI_PUBLIC_CACHE_PURGE_SECRET", "SAQI_PUBLIC_CACHE_PURGE_SECRET"],
  ["SAQI_ACCESS_AUDIENCE", "CF_ACCESS_AUD"],
  ["SAQI_ACCESS_TEAM_ORIGIN", "CF_ACCESS_TEAM_DOMAIN"],
  ["SAQI_SOURCE_BASE_URL", "SAQI_SOURCE_BASE_URL"],
  ["SAQI_SOURCE_NAME", "SAQI_SOURCE_NAME"],
];

function invalid(name) {
  throw new Error(`Invalid required operations secret: ${name}`);
}

function cleanHttpsOrigin(value, cloudflareAccess = false) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.pathname === "/" || url.pathname === "") &&
    !url.search &&
    !url.hash &&
    (!cloudflareAccess ||
      (url.hostname.endsWith(".cloudflareaccess.com") &&
        url.hostname !== "cloudflareaccess.com"))
  );
}

const secrets = Object.fromEntries(
  SECRET_BINDINGS.map(([binding, environmentName]) => {
    const value = process.env[environmentName];
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing required operations secret: ${environmentName}`);
    }
    return [binding, value];
  }),
);

if (!/^[\da-f]{64}$/u.test(secrets.SAQI_ACCESS_AUDIENCE))
  invalid("CF_ACCESS_AUD");
if (!cleanHttpsOrigin(secrets.SAQI_ACCESS_TEAM_ORIGIN, true))
  invalid("CF_ACCESS_TEAM_DOMAIN");
if (!/^[\da-f]{64}$/u.test(secrets.SAQI_PUBLIC_CACHE_PURGE_SECRET)) invalid("SAQI_PUBLIC_CACHE_PURGE_SECRET");
if (!/^[a-z][a-z0-9_-]{1,63}$/u.test(secrets.SAQI_SOURCE_NAME))
  invalid("SAQI_SOURCE_NAME");
if (!cleanHttpsOrigin(secrets.SAQI_SOURCE_BASE_URL))
  invalid("SAQI_SOURCE_BASE_URL");

if (process.argv[2] === "--validate-only") process.exit(0);

const result = spawnSync(
  "yarn",
  ["workspace", "@saqi/operations", "wrangler", "secret", "bulk"],
  {
    cwd: new URL("../", import.meta.url),
    input: JSON.stringify(secrets),
    stdio: ["pipe", "inherit", "inherit"],
  },
);

if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
