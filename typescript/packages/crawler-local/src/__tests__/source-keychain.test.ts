import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureSource, currentSource } from "@saqi/source-adapter";
import { describe, expect, it, vi } from "vitest";

import {
  installLaunchdPublicationAccessCredentials,
  loadLaunchdDesiredConfigDigest,
  loadLaunchdSourceConfiguration,
} from "../runtime/source-keychain.js";
import { trackedMkdtempSync as mkdtempSync } from "./support/tracked-test-root.js";

describe("launchd source Keychain loading", () => {
  it("installs Access credentials without exposing them through launchd configuration", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const readSecret = vi.fn(async (_account: string, service: string) =>
      service === "saqi-cf-access-client-id"
        ? "client-id\n"
        : "client-secret\n",
    );

    await expect(
      installLaunchdPublicationAccessCredentials(readSecret, environment),
    ).resolves.toBe(true);
    expect(environment).toEqual({
      CF_ACCESS_CLIENT_ID: "client-id",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });
    expect(readSecret.mock.calls).toEqual([
      ["saqi-publication-access-v2", "saqi-cf-access-client-id"],
      ["saqi-publication-access-v2", "saqi-cf-access-client-secret"],
    ]);
  });

  it("leaves publication fail-closed when the Access pair is unavailable", async () => {
    const environment: NodeJS.ProcessEnv = {};
    await expect(
      installLaunchdPublicationAccessCredentials(async () => {
        throw new Error("private failure");
      }, environment),
    ).resolves.toBe(false);
    expect(environment).toEqual({});
  });

  it("loads and validates the two conventional Keychain entries", async () => {
    const readSecret = vi.fn(async (_account: string, service: string) =>
      service === "saqi-source-name" ? "archive\n" : "https://poetry.example\n",
    );

    await expect(loadLaunchdSourceConfiguration(readSecret)).resolves.toEqual({
      name: "archive",
      origin: "https://poetry.example",
    });
    expect(readSecret.mock.calls).toEqual([
      ["saqi-publication", "saqi-source-name"],
      ["saqi-publication", "saqi-source-base-url"],
    ]);
  });

  it.each(["missing-secret-value", "not-a-valid-origin-secret"])(
    "fails closed without returning a missing or invalid value: %s",
    async (privateValue) => {
      const readSecret = vi.fn(async (_account: string, service: string) => {
        if (service === "saqi-source-name") return "archive";
        if (privateValue === "missing-secret-value")
          throw new Error(privateValue);
        return privateValue;
      });

      const result = loadLaunchdSourceConfiguration(readSecret);

      await expect(result).rejects.toThrow("SOURCE_KEYCHAIN_UNAVAILABLE");
      await expect(result).rejects.not.toThrow(privateValue);
    },
  );

  it("detects a Keychain source switch without mutating the active source", async () => {
    const root = mkdtempSync(join(tmpdir(), "saqi-source-digest-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, stateDirectory: root }),
    );
    configureSource({ name: "active", origin: "https://active.example" });
    let desired = { name: "first", origin: "https://first.example" };
    const readSecret = async (_account: string, service: string) =>
      service === "saqi-source-name" ? desired.name : desired.origin;

    const first = await loadLaunchdDesiredConfigDigest(configPath, readSecret);
    desired = { name: "second", origin: "https://second.example" };
    const second = await loadLaunchdDesiredConfigDigest(configPath, readSecret);

    expect(second).not.toBe(first);
    expect(currentSource()).toEqual({
      name: "active",
      origin: "https://active.example",
    });
    configureSource({ name: "source", origin: "https://source.invalid" });
  });
});
