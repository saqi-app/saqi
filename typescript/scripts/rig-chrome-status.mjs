/* global structuredClone -- Node provides snapshot cloning globally. */
import { Buffer } from "node:buffer";
// eslint-disable-next-line @sarj/prefer-node-fs-promises -- Single bounded atomic status replacement must complete before a native reply or process exit.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

export const collectorStates = new Set([
  "idle",
  "collecting",
  "paused",
  "human_required",
  "cooldown",
  "error",
]);
export function initialStatus() {
  return {
    version: 1,
    state: "paused",
    seenAt: null,
    progressAt: null,
    retryAt: null,
    current: null,
    error: null,
    lastCompleted: null,
    reviewWarning: null,
  };
}
export function statusStore(directory, clock = () => new Date().toISOString()) {
  const file = join(directory, "collector-status.json");
  let status = initialStatus();
  try {
    const bytes = readFileSync(file);
    if (bytes.length <= 65536) {
      const saved = JSON.parse(bytes);
      if (saved.version === 1 && collectorStates.has(saved.state))
        status = saved;
    }
  } catch {
    /* Missing or invalid status is not evidence of a healthy collector. */
  }
  return {
    get: () => structuredClone(status),
    update(patch = {}) {
      const { progress, ...fields } = patch;
      const next = { ...status, ...fields, version: 1, seenAt: clock() };
      if (!collectorStates.has(next.state))
        throw new Error("INVALID_COLLECTOR_STATE");
      if (progress) {
        next.progressAt = next.seenAt;
        next.error = null;
        next.retryAt = null;
      }
      const body = JSON.stringify(next);
      if (Buffer.byteLength(body) > 65536)
        throw new Error("COLLECTOR_STATUS_TOO_LARGE");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, body, { mode: 0o600 });
      renameSync(temporary, file);
      status = next;
      return structuredClone(status);
    },
  };
}
