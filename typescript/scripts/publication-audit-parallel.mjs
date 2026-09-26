#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Live poem IDs are lowercase hex-prefixed and none equals these boundaries.
// A crossing batch may be checked by two lanes; overlap is at most nine per edge.
const ranges = [
  { start: "", stop: "4" },
  { start: "4", stop: "8" },
  { start: "8", stop: "c" },
  { start: "c", stop: "" },
];
if (process.argv.length !== 2)
  throw new Error("Usage: publication-audit-parallel.mjs");
const expectedPublications = Number(
  process.env.SAQI_PROJECTION_EXPECTED_PUBLICATIONS ?? 77_739,
);
if (!Number.isSafeInteger(expectedPublications) || expectedPublications < 1)
  throw new Error("Expected publication count must be a positive integer");
const script = fileURLToPath(
  new URL("publication-projection.mjs", import.meta.url),
);
const children = [];
try {
  // Four simultaneous catalog comparisons exceeded the live Worker's stable
  // read capacity. Keep bounded ranges for resumability, but read one at a time.
  const summaries = [];
  for (let index = 0; index < ranges.length; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- Limit audit demand on the live Worker.
    summaries.push(await auditLane(ranges[index], index));
  }
  const totals = summaries.reduce(
    (sum, item) => ({
      scanned: sum.scanned + item.totalScanned,
      eligible: sum.eligible + item.totalEligible,
      shadowed: sum.shadowed + item.totalShadowed,
      skipped: sum.skipped + item.totalSkipped,
    }),
    { scanned: 0, eligible: 0, shadowed: 0, skipped: 0 },
  );
  if (totals.skipped !== 0)
    throw new Error(
      `${totals.skipped} stored publications no longer have a visible page`,
    );
  if (
    totals.eligible < expectedPublications ||
    totals.eligible > expectedPublications + 27
  )
    throw new Error(
      `Audited ${totals.eligible} publications; expected ${expectedPublications} plus at most 27 crossing duplicates`,
    );
  if (totals.shadowed !== 0 && totals.shadowed !== totals.eligible)
    throw new Error("Shadow reads covered only part of the audited corpus");
  process.stdout.write(
    `${JSON.stringify({ complete: true, lanes: ranges.length, ...totals })}\n`,
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

function auditLane(range, index) {
  return new Promise((resolve, reject) => {
    const label = `audit-${index + 1}`;
    const child = spawn(process.execPath, [script, "--audit"], {
      env: {
        ...process.env,
        SAQI_PROJECTION_AFTER_ID: range.start,
        SAQI_PROJECTION_STOP_AFTER_ID: range.stop,
        SAQI_PROJECTION_PACE_MS: "250",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let summary;
    createInterface({ input: child.stdout }).on("line", (line) => {
      process.stdout.write(`[${label}] ${line}\n`);
      try {
        const parsed = JSON.parse(line);
        if (parsed.complete === true && parsed.action === "audit")
          summary = parsed;
      } catch {
        // The child owns validation; retain non-JSON diagnostics in the log.
      }
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      process.stderr.write(`[${label}] ${line}\n`);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${label} exited with ${code}`));
      } else if (
        summary?.startAfterId !== range.start ||
        summary?.stopAfterId !== range.stop ||
        summary.totalEligible < 1
      ) {
        reject(new Error(`${label} returned an invalid range summary`));
      } else {
        resolve(summary);
      }
    });
  });
}
