import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SourceConfigurationSchema } from "@saqi/precedent-iso";
import type { z } from "zod";

import {
  loadScraperOperationConfig,
  operationConfigDigestForSource,
} from "./operations-contract.js";
import { RUNTIME_ENVIRONMENT } from "./runtime-environment.js";

const executeFile = promisify(execFile);
const SOURCE_KEYCHAIN_ACCOUNT = "saqi-publication";
// Access credentials use their own namespace. Items are installed by the same
// /usr/bin/security client that reads them, so launchd never pauses on a GUI
// Keychain authorization dialog after unattended restarts or token rotation.
const ACCESS_KEYCHAIN_ACCOUNT = "saqi-publication-access-v2";
const SOURCE_BASE_URL_SERVICE = "saqi-source-base-url";
const SOURCE_NAME_SERVICE = "saqi-source-name";
const ACCESS_CLIENT_ID_SERVICE = "saqi-cf-access-client-id";
const ACCESS_CLIENT_SECRET_SERVICE = "saqi-cf-access-client-secret";

export type KeychainSecretReader = (
  account: string,
  service: string,
) => Promise<string>;

type SourceConfiguration = z.infer<typeof SourceConfigurationSchema>;

/**
 * Loads the launchd-only source identity without placing secret values in the
 * plist, command line, or diagnostics. Any missing or invalid value fails with
 * one stable, value-free error code.
 */
export async function loadLaunchdSourceConfiguration(
  readSecret: KeychainSecretReader = readKeychainSecret,
): Promise<SourceConfiguration> {
  try {
    const [name, origin] = await Promise.all([
      readSecret(SOURCE_KEYCHAIN_ACCOUNT, SOURCE_NAME_SERVICE),
      readSecret(SOURCE_KEYCHAIN_ACCOUNT, SOURCE_BASE_URL_SERVICE),
    ]);
    return SourceConfigurationSchema.parse({
      name: name.trim(),
      origin: origin.trim(),
    });
  } catch {
    throw new Error("SOURCE_KEYCHAIN_UNAVAILABLE");
  }
}

/** Loads the unattended Access service-token pair into the live process only.
 * Values remain absent from launchd plists, command lines, and diagnostics. */
export async function installLaunchdPublicationAccessCredentials(
  readSecret: KeychainSecretReader = readKeychainSecret,
  environment: NodeJS.ProcessEnv = RUNTIME_ENVIRONMENT,
): Promise<boolean> {
  if (
    environment["CF_ACCESS_CLIENT_ID"] &&
    environment["CF_ACCESS_CLIENT_SECRET"]
  )
    return true;
  try {
    const [clientId, clientSecret] = await Promise.all([
      readSecret(ACCESS_KEYCHAIN_ACCOUNT, ACCESS_CLIENT_ID_SERVICE),
      readSecret(ACCESS_KEYCHAIN_ACCOUNT, ACCESS_CLIENT_SECRET_SERVICE),
    ]);
    if (clientId.trim().length === 0 || clientSecret.trim().length === 0)
      return false;
    environment["CF_ACCESS_CLIENT_ID"] = clientId.trim();
    environment["CF_ACCESS_CLIENT_SECRET"] = clientSecret.trim();
    return true;
  } catch {
    return false;
  }
}

/** Computes desired identity from a fresh Keychain read without mutating the active source. */
export async function loadLaunchdDesiredConfigDigest(
  configPath: string,
  readSecret: KeychainSecretReader = readKeychainSecret,
): Promise<string> {
  const [loaded, source] = await Promise.all([
    loadScraperOperationConfig(configPath),
    loadLaunchdSourceConfiguration(readSecret),
  ]);
  return operationConfigDigestForSource(loaded.config, source);
}

async function readKeychainSecret(
  account: string,
  service: string,
): Promise<string> {
  const { stdout } = await executeFile(
    "/usr/bin/security",
    ["find-generic-password", "-a", account, "-s", service, "-w"],
    { encoding: "utf8", maxBuffer: 4_096 },
  );
  return stdout;
}
