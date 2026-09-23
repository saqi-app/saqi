import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import type { D1Database } from "@cloudflare/workers-types";
import Database from "better-sqlite3";

import { loadCollectionInsights } from "../src/lib/insights";

const MIGRATIONS = new URL("../../operations/migrations/", import.meta.url);

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  for (const fileName of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    database.exec(readFileSync(new URL(fileName, MIGRATIONS), "utf8"));
  }
  return database;
}

function asD1(database: Database.Database): D1Database {
  return {
    withSession: () => ({
      prepare: (query: string) => ({ query }),
      batch: async (statements: { query: string }[]) =>
        statements.map(({ query }) => ({ results: database.prepare(query).all() })),
    }),
  } as unknown as D1Database;
}

void test("insight rollups track writes and replay without double counting", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author (id, slug, name_arabic, poem_count)
      VALUES ('author-1', 'author-1', 'شاعر', 3);
      INSERT INTO poem (id, author_id, slug, verses, name_arabic, content_arabic)
      VALUES ('poem-1', 'author-1', 'poem-1', 1, 'قصيدة', '{"content":["بيت"]}');
      INSERT INTO author (id, slug, name_arabic)
      VALUES ('author-unknown', 'author-unknown', 'شاعر آخر');
      INSERT INTO poem (id, author_id, slug, verses, name_arabic, content_arabic)
      SELECT 'unknown-' || value, 'author-unknown', 'unknown-' || value,
             1, 'قصيدة', '{"content":["بيت"]}'
      FROM json_each('[1,2,3,4,5,6,7,8,9,10]');
      INSERT INTO source_author_identity (
        id, source_name, external_id, canonical_url, name_arabic,
        canonical_author_id, first_observed_at, last_observed_at
      ) VALUES (
        'source-author-1', 'test', 'author-1', 'https://example.com/author-1',
        'شاعر', 'author-1', 1780000000, 1780000000
      );
      INSERT INTO source_poem_identity (
        id, source_name, external_id, source_author_id, canonical_url,
        canonical_poem_id, first_observed_at, last_observed_at
      ) VALUES (
        'source-poem-1', 'test', 'poem-1', 'source-author-1',
        'https://example.com/poem-1', 'poem-1', 1780000000, 1780000000
      );
    `);
    const expected = await loadCollectionInsights(asD1(sqlite));
    assert.deepEqual(expected, {
      authorCount: 2,
      poemCount: 11,
      sourcePoemCount: 1,
      remainingEstimate: 2,
      modelCounts: [],
      collectionDays: [{ day: "2026-05-28", poemCount: 1 }],
    });

    sqlite.exec(readFileSync(new URL("0040_insights_rollups.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await loadCollectionInsights(asD1(sqlite)), expected);

    sqlite.exec("UPDATE author SET poem_count = 4 WHERE id = 'author-1'");
    const updated = await loadCollectionInsights(asD1(sqlite));
    assert.equal(updated.remainingEstimate, 3);

    sqlite.exec("UPDATE poem SET author_id = 'author-1' WHERE id = 'unknown-1'");
    const reparented = await loadCollectionInsights(asD1(sqlite));
    assert.equal(reparented.remainingEstimate, 2);
    sqlite.exec("DELETE FROM poem WHERE id = 'unknown-1'");
    const restored = await loadCollectionInsights(asD1(sqlite));
    assert.equal(restored.remainingEstimate, 3);
  } finally {
    sqlite.close();
  }
});

void test("remaining count is unavailable without declared author totals", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author (id, slug, name_arabic)
      VALUES ('undeclared', 'undeclared', 'شاعر');
    `);
    const insights = await loadCollectionInsights(asD1(sqlite));
    assert.equal(insights.remainingEstimate, null);
  } finally {
    sqlite.close();
  }
});
