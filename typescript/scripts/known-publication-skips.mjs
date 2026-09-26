import { hash } from "node:crypto";

// Read-only full scan 36186890498, classified against production D1 on
// 26 September 2026. These candidates have no currently renderable English
// or poem insight. Any change in this exact set must receive a new review.
export const KNOWN_SKIPPED_COUNT = 2_739;
export const KNOWN_SKIPPED_DIGEST =
  "e1f472e9a5a3719bc47f2a60f469a772ae6c0651e56e527f0f6184364f3f1a1b";

export function assertKnownSkippedCandidates(
  ids,
  expectedCount = KNOWN_SKIPPED_COUNT,
  expectedDigest = KNOWN_SKIPPED_DIGEST,
) {
  const sorted = ids.toSorted();
  const digest = hash("sha256", `${sorted.join("\n")}\n`, "hex");
  if (sorted.length !== expectedCount || digest !== expectedDigest)
    throw new Error(
      `Skipped publication candidates changed: ${sorted.length} rows, digest ${digest}`,
    );
  return digest;
}
