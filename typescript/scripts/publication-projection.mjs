#!/usr/bin/env node

// Run the bounded Operations Worker migration without a local corpus or DB.
// A restart from the beginning is safe: backfill selects only null snapshots.
const endpoint =
  process.env.SAQI_PROJECTION_ENDPOINT ??
  "https://ops.saqi.app/api/publication-projection";
const clientId = process.env.CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const bookmark = process.env.SAQI_D1_RESTORE_BOOKMARK;
const startAfterId = process.env.SAQI_PROJECTION_AFTER_ID ?? "";
const batchLimit = Number(process.env.SAQI_PROJECTION_BATCH_LIMIT ?? 10);
const action = process.argv.includes("--audit") ? "audit" : "backfill";
const apply = process.argv.includes("--apply");
const expectEmpty = process.argv.includes("--expect-empty");
const maxBatchesOption = process.argv.find((arg) =>
  arg.startsWith("--max-batches="),
);
const maxBatches = maxBatchesOption
  ? Number(maxBatchesOption.slice("--max-batches=".length))
  : 20_000;

if (!clientId || !clientSecret)
  throw new Error("Cloudflare Access service credentials are required");
if (action === "audit" && apply)
  throw new Error("Audit is read-only; omit --apply");
if (expectEmpty && (action === "audit" || apply))
  throw new Error("--expect-empty requires a read-only backfill pass");
if (startAfterId && (apply || action === "audit" || expectEmpty))
  throw new Error("A starting cursor is only for read-only backfill inventory");
if (startAfterId.length > 200)
  throw new Error("Starting cursor is too long");
if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 10)
  throw new Error("Batch limit must be between 1 and 10");
if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 20_000)
  throw new Error("--max-batches must be between 1 and 20000");
if (apply && !/^[0-9a-f-]{40,100}$/u.test(bookmark ?? ""))
  throw new Error("A current D1 Time Travel bookmark is required for --apply");

let afterId = startAfterId;
let totalScanned = 0;
let totalEligible = 0;
let totalShadowed = 0;
let totalSkipped = 0;
let complete = false;
for (let batch = 1; batch <= maxBatches; batch += 1) {
  const body = { action, afterId, limit: batchLimit };
  if (apply) body.apply = true;
  // eslint-disable-next-line no-await-in-loop -- Each response advances the durable D1 cursor before the next request.
  const response = await fetchBatch(body, batch);
  // eslint-disable-next-line no-await-in-loop -- Validate this batch before advancing the cursor.
  const result = await response.json();
  if (
    result?.ok !== true ||
    result.afterId !== String(result.afterId) ||
    !Number.isSafeInteger(result.scanned) ||
    !Number.isSafeInteger(result.eligible) ||
    !Number.isSafeInteger(result.shadowed) ||
    !Array.isArray(result.skipped) ||
    !Array.isArray(result.mismatched) ||
    (result.complete !== true && result.complete !== false)
  )
    throw new Error(`Projection API returned an invalid batch ${batch}`);
  totalScanned += result.scanned;
  totalEligible += result.eligible;
  totalShadowed += result.shadowed;
  totalSkipped += result.skipped.length;
  process.stdout.write(
    `${JSON.stringify({
      batch,
      afterId: result.afterId,
      scanned: result.scanned,
      eligible: result.eligible,
      shadowed: result.shadowed,
      skipped: result.skipped,
      mismatched: result.mismatched,
    })}\n`,
  );
  if (result.mismatched.length > 0)
    throw new Error("Projection has mismatched poems; inspect IDs");
  if (result.eligible + result.skipped.length !== result.scanned)
    throw new Error("Projection candidate counts do not reconcile");
  if (apply && result.shadowed !== result.eligible)
    throw new Error(
      "Projection compare-and-swap lost a race; restart the pass",
    );
  if (result.complete) {
    complete = true;
    break;
  }
  if (result.afterId <= afterId)
    throw new Error("Projection cursor did not advance");
  afterId = result.afterId;
}
if (!complete)
  throw new Error(
    `Projection exceeded ${maxBatches} batches; resume from start`,
  );
if (expectEmpty && totalEligible > 0)
  throw new Error(`${totalEligible} visible publications still need backfill`);
if (action === "audit" && totalEligible === 0)
  throw new Error("Audit found no inactive publication snapshots");
process.stdout.write(
  `${JSON.stringify({
    complete,
    action,
    apply,
    startAfterId,
    totalScanned,
    totalEligible,
    totalShadowed,
    totalSkipped,
  })}\n`,
);

async function fetchBatch(body, batch) {
  for (let retry = 0; retry <= 3; retry += 1) {
    // eslint-disable-next-line no-await-in-loop -- Retries are bounded and preserve this batch's cursor.
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
        Origin: new URL(endpoint).origin,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    }).catch((error) => {
      if (retry >= 3) throw error;
      return null;
    });
    if (
      retry < 3 &&
      (!response || [429, 502, 503, 504].includes(response.status))
    ) {
      process.stderr.write(
        `${JSON.stringify({ batch, retry: retry + 1, status: response?.status ?? "network" })}\n`,
      );
      // eslint-disable-next-line no-await-in-loop -- Release a failed response before retrying.
      await response?.body?.cancel();
      // eslint-disable-next-line no-await-in-loop -- Bound backoff reduces bursts against the Worker.
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** retry));
      continue;
    }
    if (!response?.ok)
      throw new Error(
        `Projection API rejected batch ${batch}: ${response?.status ?? "network"}`,
      );
    return response;
  }
  throw new Error(`Projection API exhausted retries for batch ${batch}`);
}
