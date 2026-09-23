import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { acquireLegacyMaintenanceLock } from "../runtime/acquire-legacy-maintenance-lock.js";
import { trackedMkdtempSync } from "./support/tracked-test-root.js";

function path(): string {
  return join(
    trackedMkdtempSync(join(tmpdir(), "legacy-maintenance-")),
    "RUN.lock",
  );
}

test.each(["foreign owner", "", "{invalid"])(
  "historical maintenance never reclaims existing bytes %j",
  async (bytes) => {
    const file = path();
    writeFileSync(file, bytes);
    await expect(
      acquireLegacyMaintenanceLock(file, "a".repeat(64)),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(file, "utf8")).toBe(bytes);
  },
);

test("historical maintenance releases only its original owner and refuses changed evidence", async () => {
  const file = path();
  const owner = await acquireLegacyMaintenanceLock(file, "a".repeat(64));
  const original = readFileSync(file, "utf8");
  const changed = original.replace(
    `"pid":${String(process.pid)}`,
    () => `"pid":${String(process.pid + 1)}`,
  );
  expect(changed).not.toBe(original);
  writeFileSync(file, changed);
  await expect(owner.release()).rejects.toThrow(
    "LEGACY_MAINTENANCE_LOCK_OWNER_CHANGED",
  );
  expect(readFileSync(file, "utf8")).toBe(changed);
  writeFileSync(file, original);
  await owner.release();
  await owner.release();
  expect(() => readFileSync(file)).toThrow();
});
