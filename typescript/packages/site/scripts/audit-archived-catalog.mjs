#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";

import { CatalogRepository } from "../src/lib/catalog.ts";

const path = process.argv[2];
if (!path || process.argv.length !== 3)
  throw new Error(
    "Usage: node --import tsx scripts/audit-archived-catalog.mjs VERIFIED_ARCHIVE_SQLITE",
  );
const manifest = JSON.parse(
  await readFile(join(dirname(path), "manifest.json"), "utf8"),
);
if (
  manifest.format !== "saqi.d1-sql-gzip-parts.v1" ||
  manifest["database_id"] !== "ffaae610-4dae-4d7e-bf86-8232f46ca2b5"
)
  throw new Error(
    "Expected a verified production archive replay and its manifest",
  );
const sqlite = new Database(path, { readonly: true, fileMustExist: true });
sqlite.pragma("query_only = ON");
const prepared = new Map();
const wrap = (query, values = []) => ({
  bind: (...parameters) => wrap(query, parameters),
  all: async () => {
    let statement = prepared.get(query);
    if (!statement) {
      statement = sqlite.prepare(query);
      prepared.set(query, statement);
    }
    const parameters = Object.fromEntries(
      values.map((value, index) => [String(index + 1), value]),
    );
    return {
      results: values.length ? statement.all(parameters) : statement.all(),
    };
  },
});
const adapter = {
  prepare: wrap,
  batch: async (statements) =>
    Promise.all(statements.map((statement) => statement.all())),
};
const legacy = new CatalogRepository(adapter);
const projected = new CatalogRepository(adapter, true);
const digest = createHash("sha256");
let checked = 0;
let publicPages = 0;
let snapshots = 0;
const mismatches = [];
const started = Date.now();
try {
  for (const row of sqlite
    .prepare(
      `
    SELECT p.id, a.slug AS authorSlug, p.publication_json IS NOT NULL AS hasSnapshot
    FROM poem p JOIN author a ON a.id=p.author_id ORDER BY p.id
  `,
    )
    .iterate()) {
    // eslint-disable-next-line no-await-in-loop -- Bound memory and retain deterministic cursor/hash ordering on one SQLite connection.
    const before = await legacy.getPoemPage(row.authorSlug, row.id);
    // eslint-disable-next-line no-await-in-loop -- Bound memory and retain deterministic cursor/hash ordering on one SQLite connection.
    const after = await projected.getPoemPage(row.authorSlug, row.id);
    if (!isDeepStrictEqual(before, after)) mismatches.push(row.id);
    if (before) publicPages += 1;
    if (row.hasSnapshot) snapshots += 1;
    digest.update(`${JSON.stringify([row.id, before])}\n`);
    checked += 1;
    if (checked % 10000 === 0)
      process.stdout.write(
        `${JSON.stringify({
          checked,
          publicPages,
          snapshots,
          mismatchCount: mismatches.length,
          elapsedSeconds: Math.round((Date.now() - started) / 1000),
        })}\n`,
      );
    if (mismatches.length >= 20)
      throw new Error(`Catalog parity mismatch: ${mismatches.join(",")}`);
  }
  const orphanCount = sqlite
    .prepare("SELECT count(*) AS count FROM poem WHERE author_id IS NULL")
    .get().count;
  if (
    checked + orphanCount !== manifest.counts.poems ||
    snapshots !== manifest.counts.snapshots
  )
    throw new Error("Archive coverage does not match the verified manifest");
  const authors = await legacy.listAuthors();
  if (!isDeepStrictEqual(authors, await projected.listAuthors()))
    mismatches.push("author-index");
  let authorPages = 0;
  for (const { author } of authors) {
    let pageCount = 1;
    for (let page = 1; page <= pageCount; page += 1) {
      // eslint-disable-next-line no-await-in-loop -- Bound memory and retain deterministic cursor/hash ordering on one SQLite connection.
      const before = await legacy.getAuthorPage(author.slug, page);
      // eslint-disable-next-line no-await-in-loop -- Bound memory and retain deterministic cursor/hash ordering on one SQLite connection.
      const after = await projected.getAuthorPage(author.slug, page);
      pageCount = before?.pageCount ?? 1;
      if (!isDeepStrictEqual(before, after))
        mismatches.push(`${author.slug}/page/${page}`);
      authorPages += 1;
    }
  }
  for (let shard = 1; shard <= 16; shard += 1) {
    if (
      !isDeepStrictEqual(
        // eslint-disable-next-line no-await-in-loop -- Bound memory and retain deterministic cursor/hash ordering on one SQLite connection.
        await legacy.listSitemapPoems(shard),
        // eslint-disable-next-line no-await-in-loop -- Bound memory and retain deterministic cursor/hash ordering on one SQLite connection.
        await projected.listSitemapPoems(shard),
      )
    )
      mismatches.push(`sitemap/${shard}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      checked,
      publicPages,
      snapshots,
      orphanCount,
      authors: authors.length,
      authorPages,
      sitemapShards: 16,
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 20),
      archiveSqlSha256: manifest["sql_sha256"],
      publicOutputSha256: digest.digest("hex"),
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
    })}\n`,
  );
  if (mismatches.length) process.exitCode = 1;
} finally {
  sqlite.close();
}
