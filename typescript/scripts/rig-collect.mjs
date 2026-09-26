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
  const collector = await SourceChromeCollector.create({
    profileDirectory:
      process.env.SAQI_BROWSER_PROFILE ?? join(tmpdir(), "saqi-source-profile"),
  });
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  try {
    const signal = new AbortController().signal;
    const manifest = parseAuthorPoemManifest(
      await collector.collectAuthorManifest(canonical.href, signal),
    );
    if (manifest.author.canonicalId !== canonical.canonicalId)
      throw new Error("SOURCE_MANIFEST_AUTHOR_MISMATCH");
    await post({
      action: "upsert-author",
      author: {
        sourceAuthorId: canonical.slug,
        sourceUrl: canonical.href,
        nameArabic: author.name,
      },
    });
    for (const poem of manifest.poems) {
      // The manifest is certified by two independent browser passes. A crash
      // simply repeats the current author; D1's source key and hash make it safe.
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
      // eslint-disable-next-line no-await-in-loop -- A failed upsert must stop before advancing to another poem.
      const response = await post({
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
      if (response.result.status === "created") created += 1;
      else if (response.result.status === "updated") updated += 1;
      else unchanged += 1;
      process.stdout.write(
        `${poem.numericId}: ${response.result.status}${response.cachePending ? " (cache purge pending)" : ""}\n`,
      );
    }
  } finally {
    await collector.close();
  }
  process.stdout.write(
    `Author ${canonical.slug}: ${created} created, ${updated} updated, ${unchanged} unchanged\n`,
  );
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
    throw new Error(`Source API ${response.status}: ${body.slice(0, 300)}`);
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
