#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const account = "saqi-publication-access-v2";

const [operation, ...args] = process.argv.slice(2);
if (operation !== "translate")
  throw new Error(
    "Usage: rig-local.ts translate [POEM_ID | retry-unknown POEM_ID ATTEMPT_ID | recover-attempt ATTEMPT_ID [--accept-incomplete]]"
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
    // eslint-disable-next-line preserve-caught-error -- Keychain command failures may embed secret stdout; expose only the stable failure code.
    throw new Error("LOCAL_ACCESS_CREDENTIALS_UNAVAILABLE");
  }
}
if (!environment.CF_ACCESS_CLIENT_ID || !environment.CF_ACCESS_CLIENT_SECRET)
  throw new Error("LOCAL_ACCESS_CREDENTIALS_INCOMPLETE");
const script = fileURLToPath(new URL("rig-lite.ts", import.meta.url));
process.stdout.write(`${new Date().toISOString()} Starting ${operation}\n`);
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
    { encoding: "utf8", maxBuffer: 4_096 }
  );
  const value = stdout.trim();
  if (!value) throw new Error("EMPTY_KEYCHAIN_VALUE");
  return value;
}
