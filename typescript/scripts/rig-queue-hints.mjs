import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

const installation = Symbol.for("saqi.queueScanHints");
function validHint(value) {
  return (
    value != null &&
    // eslint-disable-next-line no-restricted-syntax -- Validate untrusted saved/API hint JSON before it can affect request metadata.
    typeof value.afterPoemId === "string" &&
    value.afterPoemId.length <= 200 &&
    Number.isSafeInteger(value.priority) &&
    value.priority >= 0 &&
    value.priority <= 2
  );
}

// Only concurrent queue claims at this exact endpoint are wrapped. Paid turns,
// source reads, acknowledgement, publication, and other fetches pass through.
export async function installQueueScanHints(endpoint, hintPath) {
  const existing = globalThis[installation];
  if (existing) {
    if (existing.endpoint !== endpoint || existing.hintPath !== hintPath)
      throw new Error("QUEUE_SCAN_HINT_CONFIGURATION_MISMATCH");
    return { installed: false, endpoint, hintPath };
  }
  let hint = null;
  try {
    const saved = JSON.parse(await readFile(hintPath, "utf8"));
    if (validHint(saved))
      hint = { afterPoemId: saved.afterPoemId, priority: saved.priority };
  } catch {
    // A missing or damaged performance hint only repeats bounded reads.
  }
  const originalFetch = globalThis.fetch;
  let sequence = 0;
  let acceptedSequence = 0;
  let saving = Promise.resolve();
  const wrappedFetch = async (input, init) => {
    // eslint-disable-next-line no-restricted-syntax -- Only the runner's serialized JSON claim body is eligible for wrapping.
    if (input !== endpoint || typeof init?.body !== "string")
      return originalFetch(input, init);
    let body;
    try {
      body = JSON.parse(init.body);
    } catch {
      return originalFetch(input, init);
    }
    if (body?.action !== "claim-poem" || !(body.maxConcurrent > 1))
      return originalFetch(input, init);
    const requestSequence = ++sequence;
    const response = await originalFetch(input, {
      ...init,
      body: JSON.stringify(hint ? { ...body, scanHint: hint } : body),
    });
    if (response.ok) {
      try {
        const result = await response.clone().json();
        if (validHint(result.scanHint) && requestSequence > acceptedSequence) {
          acceptedSequence = requestSequence;
          hint = {
            afterPoemId: result.scanHint.afterPoemId,
            priority: result.scanHint.priority,
          };
          const value = JSON.stringify(hint);
          saving = saving
            .then(async () => {
              const temporary = `${hintPath}.${randomUUID()}.tmp`;
              await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
              await rename(temporary, hintPath);
            })
            .catch(() => {
              // Hint persistence must not change a canonical claim's outcome.
            });
          await saving;
        }
      } catch {
        // Return the original response unchanged, even when no hint is usable.
      }
    }
    return response;
  };
  // eslint-disable-next-line unicorn/no-global-object-property-assignment -- Install the tested, endpoint-scoped claim wrapper idempotently.
  globalThis[installation] = {
    endpoint,
    hintPath,
    originalFetch,
    wrappedFetch,
  };
  // eslint-disable-next-line unicorn/no-global-object-property-assignment -- Install the tested, endpoint-scoped claim wrapper idempotently.
  globalThis.fetch = wrappedFetch;
  return { installed: true, endpoint, hintPath };
}
