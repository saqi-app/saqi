import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { z } from "zod";

import { defaultChromeProfile } from "../collection/collector.js";
import { loadScraperOperationConfig } from "./operations-contract.js";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "launchd paths must be absolute");

const ChromeCdpLaunchdOptionsSchema = z
  .object({
    configPath: AbsolutePathSchema,
    executablePath: AbsolutePathSchema,
    label: z
      .string()
      .regex(/^[a-zA-Z\d][a-zA-Z\d.-]{2,127}$/)
      .default("net.saqi.chrome"),
    standardErrorPath: AbsolutePathSchema,
    standardOutPath: AbsolutePathSchema,
    // eslint-disable-next-line @sarj/prefer-millisecond-control-duration-schema -- launchd uses seconds.
    throttleIntervalSeconds: z.int().min(30).max(3_600).default(60),
  })
  .strict();

export type ChromeCdpLaunchdOptions = z.infer<
  typeof ChromeCdpLaunchdOptionsSchema
>;

interface ChromeCdpLaunchdIssue {
  readonly code: string;
  readonly message: string;
}

export interface ChromeCdpLaunchdPreflightReport {
  readonly cdpEndpoint: null | string;
  readonly issues: readonly ChromeCdpLaunchdIssue[];
  readonly ok: boolean;
  readonly options: ChromeCdpLaunchdOptions;
  readonly plist: null | string;
  readonly profileDirectory: null | string;
}

interface ChromeCdpLaunchdPreflightEnvironment {
  readonly platform?: NodeJS.Platform;
}

/** Read-only preflight. It never reads browser storage, writes, or invokes launchctl. */
export async function preflightChromeCdpLaunchdService(
  input: unknown,
  environment: ChromeCdpLaunchdPreflightEnvironment = {},
): Promise<ChromeCdpLaunchdPreflightReport> {
  const options = ChromeCdpLaunchdOptionsSchema.parse(input);
  const issues: ChromeCdpLaunchdIssue[] = [];
  let cdpEndpoint: null | string = null;
  let profileDirectory: null | string = null;

  if ((environment.platform ?? process.platform) !== "darwin") {
    issues.push(
      issue(
        "PLATFORM_UNSUPPORTED",
        "The Chrome CDP LaunchAgent is supported only on macOS",
      ),
    );
  }

  try {
    const loaded = await loadScraperOperationConfig(options.configPath);
    cdpEndpoint = loaded.config.collector.cdpEndpoint;
    profileDirectory = defaultChromeProfile(loaded.config.stateDirectory);
    if (cdpEndpoint === null) {
      issues.push(
        issue(
          "CDP_ENDPOINT_REQUIRED",
          "collector.cdpEndpoint must be a root loopback HTTP URL",
        ),
      );
    }
    if (!loaded.config.collector.enabled) {
      issues.push(
        issue(
          "COLLECTOR_DISABLED",
          "collector.enabled must be true before supervising dedicated Chrome",
        ),
      );
    }
    if (loaded.config.collector.headless) {
      issues.push(
        issue(
          "VISIBLE_BROWSER_REQUIRED",
          "collector.headless must be false for attended source verification",
        ),
      );
    }
    await requireDedicatedProfilePath(profileDirectory, issues);
  } catch (error) {
    issues.push(
      issue(
        "CONFIG_INVALID",
        error instanceof Error ? error.message : "Configuration is invalid",
      ),
    );
  }

  await requireExecutable(options.executablePath, issues);
  await Promise.all(
    [options.standardOutPath, options.standardErrorPath].map((path) =>
      requireLogDestination(path, issues),
    ),
  );

  return {
    cdpEndpoint,
    issues,
    ok: issues.length === 0,
    options,
    plist:
      cdpEndpoint === null || profileDirectory === null
        ? null
        : renderChromeCdpLaunchdService({
            cdpEndpoint,
            options,
            profileDirectory,
          }),
    profileDirectory,
  };
}

export function renderChromeCdpLaunchdService(input: {
  readonly cdpEndpoint: string;
  readonly options: ChromeCdpLaunchdOptions;
  readonly profileDirectory: string;
}): string {
  const options = ChromeCdpLaunchdOptionsSchema.parse(input.options);
  const endpoint = new URL(input.cdpEndpoint);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    Number(endpoint.port) < 1_024 ||
    Number(endpoint.port) > 65_535
  ) {
    throw new Error("cdpEndpoint must be a root loopback HTTP URL");
  }
  const profileDirectory = AbsolutePathSchema.parse(input.profileDirectory);
  const host = endpoint.hostname.replaceAll(/^\[|\]$/gu, "");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${plistValue(options.label)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    ${plistValue(options.executablePath)}`,
    `    ${plistValue(`--user-data-dir=${profileDirectory}`)}`,
    `    ${plistValue("--no-first-run")}`,
    `    ${plistValue("--no-default-browser-check")}`,
    `    ${plistValue(`--remote-debugging-address=${host}`)}`,
    `    ${plistValue(`--remote-debugging-port=${endpoint.port}`)}`,
    "  </array>",
    "  <key>StandardOutPath</key>",
    `  ${plistValue(options.standardOutPath)}`,
    "  <key>StandardErrorPath</key>",
    `  ${plistValue(options.standardErrorPath)}`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${String(options.throttleIntervalSeconds)}</integer>`,
    "  <key>LimitLoadToSessionType</key>",
    `  ${plistValue("Aqua")}`,
    "  <key>ProcessType</key>",
    `  ${plistValue("Interactive")}`,
    "  <key>AbandonProcessGroup</key>",
    "  <false/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function requireDedicatedProfilePath(
  path: string,
  issues: ChromeCdpLaunchdIssue[],
): Promise<void> {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink())
      throw new Error("symbolic links are refused");
    if (!information.isDirectory()) throw new Error("not a directory");
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      await requireDirectory(dirname(path), "PROFILE_PARENT_INVALID", issues);
      return;
    }
    issues.push(
      issue(
        "PROFILE_DIRECTORY_INVALID",
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

async function requireExecutable(
  path: string,
  issues: ChromeCdpLaunchdIssue[],
): Promise<void> {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink())
      throw new Error("symbolic links are refused");
    if (!information.isFile()) throw new Error("not a regular file");
    await access(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    issues.push(
      issue(
        "CHROME_NOT_EXECUTABLE",
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

async function requireDirectory(
  path: string,
  code: string,
  issues: ChromeCdpLaunchdIssue[],
): Promise<void> {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink())
      throw new Error("symbolic links are refused");
    if (!information.isDirectory()) throw new Error("not a directory");
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    issues.push(
      issue(
        code,
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

async function requireLogDestination(
  path: string,
  issues: ChromeCdpLaunchdIssue[],
): Promise<void> {
  if (path !== "/dev/null") {
    await requireDirectory(dirname(path), "LOG_DIRECTORY_INVALID", issues);
    return;
  }
  try {
    const information = await lstat(path);
    if (!information.isCharacterDevice())
      throw new Error("not a character device");
    await access(path, constants.W_OK);
  } catch (error) {
    issues.push(
      issue(
        "LOG_DIRECTORY_INVALID",
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

function errorCode(error: unknown): null | string {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  return typeof error.code === "string" ? error.code : null;
}

function issue(code: string, message: string): ChromeCdpLaunchdIssue {
  return { code, message };
}

function plistValue(text: string): string {
  return `<string>${text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")}</string>`;
}
