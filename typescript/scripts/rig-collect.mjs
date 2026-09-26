#!/usr/bin/env node
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SourceChromeCollector } from "../packages/source-collector/dist/collection/collection-source-browser.js";
import {
  canonicalAuthorUrl,
  configureSource,
  parseAuthorPoemManifest,
  parsePoemDetail,
} from "../packages/source-collector/dist/source-adapter/index.js";

const endpoint =
  process.env.SAQI_SOURCE_ENDPOINT ?? "https://ops.saqi.app/api/rig/source";
const sourceOrigin = process.env.SAQI_SOURCE_ORIGIN;
const sourceName = process.env.SAQI_SOURCE_NAME ?? "aldiwan";
const clientId = process.env.CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
if (!sourceOrigin) throw new Error("SAQI_SOURCE_ORIGIN is required");
if (!clientId || !clientSecret)
  throw new Error(
    "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
  );
configureSource({ name: sourceName, origin: sourceOrigin });

async function main() {
  if (process.env.SAQI_RIG_ACTIVE !== "1")
    throw new Error(
      "Collector inactive: set SAQI_RIG_ACTIVE=1 after cutover gates",
    );
  const args = process.argv.slice(2);
  let author;
  if (args.length === 1 && args[0] === "next-author") {
    const next = await get("?action=next-author");
    author = next.author;
    if (!author) {
      process.stdout.write("No source author available in D1.\n");
      return;
    }
    author = {
      href: author.sourceUrl,
      name: author.nameArabic,
    };
  } else if (args.length === 3 && args[0] === "author") {
    author = { href: args[1], name: args[2] };
  } else {
    throw new Error(
      'Usage: rig-collect.mjs next-author | author AUTHOR_URL "ARABIC_NAME"',
    );
  }
  const canonical = canonicalAuthorUrl(author.href);
  await get("?action=origin");
  // Admit the stable author key before any source request, so a rate-limit
  // deadline can be preserved even if its first manifest request fails.
  await post({
    action: "upsert-author",
    author: {
      sourceAuthorId: canonical.slug,
      sourceUrl: canonical.href,
      nameArabic: author.name,
    },
  });
  const collector = await SourceChromeCollector.create({
    profileDirectory:
      process.env.SAQI_BROWSER_PROFILE ?? join(tmpdir(), "saqi-source-profile"),
    challengeResolutionTimeoutMs: 15 * 60_000,
  });
  process.stdout.write(
    `Collecting ${canonical.href}. Complete any source verification in the Chrome window; it can wait up to 15 minutes.\n`,
  );
  try {
    const signal = new AbortController().signal;
    const manifest = parseAuthorPoemManifest(
      await collector.collectAuthorManifest(canonical.href, signal),
    );
    if (manifest.author.canonicalId !== canonical.canonicalId)
      throw new Error("SOURCE_MANIFEST_AUTHOR_MISMATCH");
    for (const poem of manifest.poems) {
      // A crash repeats this author; canonical source keys and source hashes
      // make admissions idempotent. A later sweep catches source additions.
      // eslint-disable-next-line no-await-in-loop -- Each poem must read its current source hash before a guarded upsert.
      const current = await get(
        `?action=poem&sourcePoemId=${encodeURIComponent(poem.numericId)}`,
      );
      // eslint-disable-next-line no-await-in-loop -- Browser source requests are serial and origin-throttled.
      const projection = await collector.collectPoemDetail(
        poem.href,
        canonical.href,
        signal,
      );
      const detail = parsePoemDetail(projection);
      if (detail.canonicalId !== poem.canonicalId)
        throw new Error("SOURCE_POEM_ID_MISMATCH");
      // eslint-disable-next-line no-await-in-loop -- Visit each source poem serially; only an explicit identity-review conflict may be skipped.
      const response = await postPoem({
        action: "upsert-poem",
        poem: {
          sourceAuthorId: canonical.slug,
          sourcePoemId: poem.numericId,
          sourceUrl: detail.href,
          titleArabic: detail.title,
          linesArabic: detail.lines,
          expectedHash: current.poem?.sourceHash ?? null,
        },
      });
      process.stdout.write(
        `${poem.numericId}: ${response.result.status}${response.cachePending ? " (cache purge pending)" : ""}\n`,
      );
    }
    // Advance only after visiting the whole manifest, including explicitly
    // reported identity-review conflicts. A crash leaves this author due again.
    await post({ action: "complete-author", sourceAuthorId: canonical.slug });
  } catch (error) {
    if (error?.code === "SOURCE_RATE_LIMITED") {
      const delay = Math.max(60_000, error.retryAfterMs ?? 900_000);
      await post({
        action: "defer-source",
        sourceAuthorId: canonical.slug,
        retryAfter: Math.ceil((Date.now() + delay) / 1_000),
      });
    }
    throw error;
  } finally {
    await collector.close();
  }
  process.stdout.write(`Author ${canonical.slug}: collection complete\n`);
}

async function postPoem(body) {
  try {
    return await post(body);
  } catch (error) {
    if (error?.code !== "UNMAPPED_POEM_COLLISION") throw error;
    return { result: { status: "identity review required; not imported" } };
  }
}

async function get(query) {
  const response = await fetch(`${endpoint}${query}`, {
    headers: accessHeaders(),
  });
  return readResponse(response);
}

async function post(body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...accessHeaders(),
      "content-type": "application/json",
      Origin: new URL(endpoint).origin,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

function accessHeaders() {
  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
}

async function readResponse(response) {
  if (!response.ok) {
    const body = await response.text();
    let code;
    try {
      code = JSON.parse(body)?.code;
    } catch {
      code = undefined;
    }
    const error = new Error(
      `Source API ${response.status}: ${body.slice(0, 300)}`,
    );
    if (response.status === 409 && code === "UNMAPPED_POEM_COLLISION")
      error.code = code;
    throw error;
  }
  const result = await response.json();
  if (!result?.ok) throw new Error("Source API returned an invalid response");
  return result;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
