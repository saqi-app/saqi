import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  preflightChromeCdpLaunchdService,
  renderChromeCdpLaunchdService,
} from "../runtime/chrome-cdp-launchd-service.js";
import { trackedMkdtempSync as mkdtempSync } from "./support/tracked-test-root";

const CLI = resolve(import.meta.dirname, "../cli.ts");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "saqi-chrome-launchd-"));
  const stateDirectory = join(root, "state");
  const logs = join(root, "logs & audit");
  mkdirSync(stateDirectory);
  mkdirSync(logs);
  const executablePath = join(root, "Google Chrome");
  writeFileSync(executablePath, "fixture");
  chmodSync(executablePath, 0o700);
  const configPath = join(root, "rig.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      collector: {
        cdpEndpoint: "http://127.0.0.1:9223/",
        enabled: true,
        headless: false,
      },
      retention: { minimumFreeBytes: 0 },
      schemaVersion: 1,
      stateDirectory,
    }),
  );
  return {
    configPath,
    executablePath,
    logs,
    root,
    standardErrorPath: join(logs, "stderr.log"),
    standardOutPath: join(logs, "stdout.log"),
    stateDirectory,
    options: {
      configPath,
      executablePath,
      standardErrorPath: join(logs, "stderr.log"),
      standardOutPath: join(logs, "stdout.log"),
    },
  };
}

describe("Chrome CDP launchd dry-run", () => {
  it.runIf(process.platform === "darwin")(
    "exposes only a dry-run CLI that prints the preflight report",
    () => {
      const target = fixture();
      const output = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI,
            "install-cdp-browser-service",
            "--dry-run",
            "--config",
            target.configPath,
            "--executable",
            target.executablePath,
            "--stdout",
            target.standardOutPath,
            "--stderr",
            target.standardErrorPath,
          ],
          { encoding: "utf8", stdio: "pipe" },
        ),
      ) as { readonly command: string; readonly dryRun: boolean };
      expect(output).toMatchObject({
        command: "install-cdp-browser-service",
        dryRun: true,
      });

      const rejected = spawnSync(
        process.execPath,
        ["--import", "tsx", CLI, "install-cdp-browser-service"],
        { encoding: "utf8", stdio: "pipe" },
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "install-cdp-browser-service supports only --dry-run",
      );
    },
  );

  it("derives verify-source's profile and renders a credential-free loopback service", async () => {
    const target = fixture();
    const report = await preflightChromeCdpLaunchdService(target.options, {
      platform: "darwin",
    });

    expect(report).toMatchObject({
      cdpEndpoint: "http://127.0.0.1:9223/",
      issues: [],
      ok: true,
      profileDirectory: join(target.stateDirectory, "chrome-profile"),
    });
    expect(report.plist).toContain(
      `<string>--user-data-dir=${join(target.stateDirectory, "chrome-profile")}</string>`,
    );
    expect(report.plist).toContain(
      "<string>--remote-debugging-address=127.0.0.1</string>",
    );
    expect(report.plist).toContain(
      "<string>--remote-debugging-port=9223</string>",
    );
    expect(report.plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(report.plist).toContain("<string>Aqua</string>");
    expect(report.plist).toContain("logs &amp; audit");
    expect(report.plist).not.toMatch(
      /cookie|credential|environmentvariables/iu,
    );
    expect(existsSync(join(target.stateDirectory, "chrome-profile"))).toBe(
      false,
    );
    if (process.platform === "darwin" && report.plist !== null) {
      const plistPath = join(target.root, "rendered.plist");
      writeFileSync(plistPath, report.plist);
      expect(() => execFileSync("plutil", ["-lint", plistPath])).not.toThrow();
    }
  });

  it("fails closed without configured CDP or a visible enabled collector", async () => {
    const target = fixture();
    writeFileSync(
      target.configPath,
      JSON.stringify({
        collector: { cdpEndpoint: null, enabled: false, headless: true },
        retention: { minimumFreeBytes: 0 },
        schemaVersion: 1,
        stateDirectory: target.stateDirectory,
      }),
    );
    const report = await preflightChromeCdpLaunchdService(target.options, {
      platform: "darwin",
    });

    expect(report).toMatchObject({ ok: false, plist: null });

    expect(report.issues.map(({ code }) => code)).toEqual([
      "CDP_ENDPOINT_REQUIRED",
      "COLLECTOR_DISABLED",
      "VISIBLE_BROWSER_REQUIRED",
    ]);
  });

  it("refuses symlinked Chrome and profile paths", async () => {
    const target = fixture();
    const realProfile = join(target.root, "real-profile");
    mkdirSync(realProfile);
    symlinkSync(realProfile, join(target.stateDirectory, "chrome-profile"));
    const realExecutable = join(target.root, "real-chrome");
    writeFileSync(realExecutable, "fixture");
    chmodSync(realExecutable, 0o700);
    const linkedExecutable = join(target.root, "linked-chrome");
    symlinkSync(realExecutable, linkedExecutable);

    const report = await preflightChromeCdpLaunchdService(
      { ...target.options, executablePath: linkedExecutable },
      { platform: "darwin" },
    );
    expect(report.issues.map(({ code }) => code)).toEqual([
      "PROFILE_DIRECTORY_INVALID",
      "CHROME_NOT_EXECUTABLE",
    ]);
  });

  it("rejects non-loopback renderer inputs independently of config parsing", () => {
    const target = fixture();
    expect(() =>
      renderChromeCdpLaunchdService({
        cdpEndpoint: "https://example.com:9223/",
        options: {
          configPath: target.configPath,
          executablePath: target.executablePath,
          label: "net.saqi.chrome",
          standardErrorPath: target.standardErrorPath,
          standardOutPath: target.standardOutPath,
          throttleIntervalSeconds: 60,
        },
        profileDirectory: join(target.stateDirectory, "chrome-profile"),
      }),
    ).toThrow("root loopback HTTP URL");
  });

  it("allows /dev/null to bound long-running Chrome logs", async () => {
    const target = fixture();
    const report = await preflightChromeCdpLaunchdService(
      {
        ...target.options,
        standardErrorPath: "/dev/null",
        standardOutPath: "/dev/null",
      },
      { platform: "darwin" },
    );
    expect(report).toMatchObject({ issues: [], ok: true });
  });
});
