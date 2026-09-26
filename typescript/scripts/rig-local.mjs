#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const account = "saqi-publication-access-v2";
const scripts = {
  collect: "rig-collect.mjs",
  translate: "rig-lite.mjs",
};

const [operation, ...args] = process.argv.slice(2);
if (!Object.hasOwn(scripts, operation))
  throw new Error(
    "Usage: rig-local.mjs collect [next-author | author URL NAME] | translate [retry-unknown POEM_ID ATTEMPT_ID]",
  );

const environment = { ...process.env };
if (!environment.CF_ACCESS_CLIENT_ID && !environment.CF_ACCESS_CLIENT_SECRET) {
  try {
    const [id, secret] = await Promise.all([
      keychain("saqi-cf-access-client-id"),
      keychain("saqi-cf-access-client-secret"),
    ]);
    environment.CF_ACCESS_CLIENT_ID = id;
    environment.CF_ACCESS_CLIENT_SECRET = secret;
  } catch {
    throw new Error("LOCAL_ACCESS_CREDENTIALS_UNAVAILABLE");
  }
}
if (!environment.CF_ACCESS_CLIENT_ID || !environment.CF_ACCESS_CLIENT_SECRET)
  throw new Error("LOCAL_ACCESS_CREDENTIALS_INCOMPLETE");
if (operation === "collect") {
  environment.SAQI_SOURCE_ORIGIN ??= "https://www.aldiwan.net";
  if (args.length === 0) args.push("next-author");
}

const script = fileURLToPath(new URL(scripts[operation], import.meta.url));
const child = spawn(process.execPath, [script, ...args], {
  env: environment,
  stdio: "inherit",
});
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
process.exitCode = code ?? 1;

async function keychain(service) {
  const { stdout } = await executeFile(
    "/usr/bin/security",
    ["find-generic-password", "-a", account, "-s", service, "-w"],
    { encoding: "utf8", maxBuffer: 4_096 },
  );
  const value = stdout.trim();
  if (!value) throw new Error("EMPTY_KEYCHAIN_VALUE");
  return value;
}
