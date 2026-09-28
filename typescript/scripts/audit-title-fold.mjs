import { SAQI_PRODUCTION_DATABASE_ID } from "@saqi/precedent-iso";

import { usableTitle } from "../packages/site/src/lib/catalog.ts";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) throw new Error("D1_READ_CREDENTIALS_MISSING");

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${SAQI_PRODUCTION_DATABASE_ID}/query`;

async function query(sql, params = []) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`D1_HTTP_${response.status}`);
  const body = await response.json();
  if (!body.success || body.result?.[0]?.success !== true)
    throw new Error(`D1_QUERY_FAILED: ${JSON.stringify(body.errors ?? body.result?.[0]?.error)}`);
  return body.result[0].results;
}

const stats = {
  legacyRows: 0,
  legacyOnlyVisible: 0,
  invalidModernVisibleLegacy: 0,
  invalidLegacy: 0,
  fallbackParityFailures: 0,
  longestVisibleTitle: 0,
  longestLegacyRaw: 0,
};
const invalidModernFallbackIds = [];
async function scan(cursor = "") {
  const rows = await query(
    `SELECT id, name_english AS modern, poem_title_first_line AS legacy
       FROM poem WHERE poem_title_first_line IS NOT NULL AND id > ?
       ORDER BY id LIMIT 500`,
    [cursor],
  );
  if (rows.length === 0) return;
  for (const row of rows) {
    const modern = row.modern?.trim() || null;
    const legacy = row.legacy?.trim() || null;
    const visible = usableTitle(modern, legacy);
    const modernVisible = usableTitle(modern);
    const legacyVisible = usableTitle(legacy);
    stats.legacyRows++;
    if (!modernVisible && legacyVisible) {
      if (modern) {
        stats.invalidModernVisibleLegacy++;
        invalidModernFallbackIds.push(row.id);
      }
      else stats.legacyOnlyVisible++;
    }
    if (legacy && !legacyVisible) stats.invalidLegacy++;
    const folded = modernVisible ?? legacyVisible;
    if (visible !== folded) stats.fallbackParityFailures++;
    stats.longestVisibleTitle = Math.max(stats.longestVisibleTitle, visible?.length ?? 0);
    stats.longestLegacyRaw = Math.max(stats.longestLegacyRaw, row.legacy?.length ?? 0);
  }
  if (rows.length === 500) await scan(rows.at(-1).id);
}
await scan();
const visibility = await query(`SELECT
  count(*) AS total,
  sum(publication_json IS NOT NULL) AS publications,
  sum(rig_status IN ('claimed','dispatching','unknown')) AS active,
  sum(source_poem_id IS NOT NULL) AS sourced,
  sum(author_id IS NULL) AS orphan
  FROM poem WHERE publishable <> 1`);
process.stdout.write(`${JSON.stringify({ titles: stats, invalidModernFallbackIds, unpublishable: visibility[0] })}\n`);
