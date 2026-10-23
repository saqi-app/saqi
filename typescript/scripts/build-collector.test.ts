import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("collector build limits host access and emits every Chrome asset outside Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saqi-extension-"));
  const script = fileURLToPath(new URL("build-collector.ts", import.meta.url));
  try {
    execFileSync(process.execPath, [script, directory], {
      env: { ...process.env, SAQI_SOURCE_BASE_URL: "https://poetry.example" },
      stdio: "pipe",
    });
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8")
    );
    assert.deepEqual(manifest["host_permissions"], [
      "https://poetry.example/*",
    ]);
    assert.equal(manifest.background["service_worker"], "background.js");
    for (const name of [
      "background.js",
      "controller.js",
      "popup.js",
      "project.js",
      "popup.html",
      "popup.css",
    ]) {
      const asset = await readFile(join(directory, name));
      assert.ok(asset.length > 0);
    }
    for (const origin of [
      "http://poetry.example",
      "https://poetry.example/path",
      "https://user@poetry.example",
    ])
      assert.throws(() =>
        execFileSync(process.execPath, [script, directory], {
          env: { ...process.env, SAQI_SOURCE_BASE_URL: origin },
          stdio: "pipe",
        })
      );
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [script, fileURLToPath(new URL("../", import.meta.url))],
        {
          env: {
            ...process.env,
            SAQI_SOURCE_BASE_URL: "https://poetry.example",
          },
          stdio: "pipe",
        }
      )
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
