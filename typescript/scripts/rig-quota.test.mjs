import assert from "node:assert/strict";
import { test } from "node:test";

import { quotaDecision } from "./rig-quota.mjs";

const response = (primary, secondary = null) => ({
  ordinaryUsageAllowed: true,
  rateLimitsByLimitId: { codex: { primary, secondary } },
});
test("quota leaves a 20 percent reserve across every reported window", () => {
  assert.equal(quotaDecision(response({ usedPercent: 79 })).allowed, true);
  assert.equal(quotaDecision(response({ usedPercent: 80 })).allowed, false);
  assert.equal(
    quotaDecision(response({ usedPercent: 1 }, { usedPercent: 82 })).allowed,
    false,
  );
  assert.equal(
    quotaDecision(
      response(
        { usedPercent: 82, resetsAt: 100 },
        { usedPercent: 90, resetsAt: 200 },
      ),
    ).resetsAt,
    200,
  );
});
test("missing or invalid quota and unavailable account permission cannot admit", () => {
  for (const payload of [
    null,
    {},
    response(null),
    response({ usedPercent: -1 }),
    response({ usedPercent: "10" }),
    { ...response({ usedPercent: 1 }), ordinaryUsageAllowed: null },
  ])
    assert.equal(quotaDecision(payload).allowed, false);
  const payload = response({ usedPercent: 1 });
  payload.rateLimitsByLimitId.codex.spendControlReached = true;
  assert.equal(quotaDecision(payload).allowed, false);
});

test("app-server timeout or malformed reply pauses without exposing output", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, delimiter } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const directory = await mkdtemp(join(tmpdir(), "saqi-quota-protocol-"));
  try {
    for (const program of [
      "process.stdin.resume(); setInterval(() => {}, 1000);",
      String.raw`process.stdout.write("invalid reply with private data\n"); process.stdin.resume();`,
    ]) {
      await writeFile(
        join(directory, "codex"),
        `#!/usr/bin/env node\n${program}`,
        { mode: 0o700 },
      );
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { readQuota } from ${JSON.stringify(new URL("rig-quota.mjs", import.meta.url).href)}; console.log(JSON.stringify(await readQuota({timeoutMs: 250})));`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
          },
          timeout: 5_000,
        },
      );
      assert.deepEqual(JSON.parse(stdout), {
        allowed: false,
        reason: "Quota unavailable",
      });
      assert.equal(stderr, "");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
