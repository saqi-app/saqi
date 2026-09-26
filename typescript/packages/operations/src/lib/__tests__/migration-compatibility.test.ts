import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SAQI_PRODUCTION_DATABASE_ID } from "@saqi/precedent-iso";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const DIRECTORY = fileURLToPath(
  new URL("../../../migrations/", import.meta.url)
);
const DATABASES: Database.Database[] = [];
const AUTHOR_ID = "00000000-0000-4000-8000-000000000001";
const POEM_ID = "00000000-0000-4000-8000-000000000002";
const PUBLICATION = JSON.stringify({
  schemaVersion: 2,
  active: false,
  poem: { linesEnglish: ["First", "Second"] },
});
const SOURCE_HASH = "a".repeat(64);

afterEach(() => {
  for (const database of DATABASES) database.close();
  DATABASES.length = 0;
});

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY) STRICT");
  DATABASES.push(database);
  return database;
}

function migrationFiles() {
  return readdirSync(DIRECTORY)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .toSorted();
}

function applyPending(database: Database.Database, names = migrationFiles()) {
  const applied: string[] = [];
  const run = database.transaction((name: string) => {
    if (
      database.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(name)
    )
      return;
    database.exec(readFileSync(join(DIRECTORY, name), "utf8"));
    database.prepare("INSERT INTO d1_migrations VALUES (?)").run(name);
    applied.push(name);
  });
  for (const name of names) run(name);
  return applied;
}

function tables(database: Database.Database) {
  return database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='d1_migrations' ORDER BY name"
    )
    .pluck()
    .all();
}

function insertPoem(database: Database.Database) {
  database
    .prepare(
      "INSERT INTO author(id,slug,name_arabic,source_name,source_author_id) VALUES (?, 'author', 'شاعر', 'aldiwan', 'poet-1')"
    )
    .run(AUTHOR_ID);
  database
    .prepare(
      `INSERT INTO poem (
    id, author_id, slug, verses, name_arabic, content_arabic,
    source_name, source_poem_id, source_hash, publication_json,
    publication_hash, publication_source_hash, rig_status, rig_version,
    rig_checkpoint_json
  ) VALUES (?, ?, 'poem42', 1, 'قصيدة', '{"content":["صدر","عجز"]}',
    'aldiwan','42',?,?,?,?,'unknown',7,'{"invocation":{"attemptId":"keep-me"}}')`
    )
    .run(
      POEM_ID,
      AUTHOR_ID,
      SOURCE_HASH,
      PUBLICATION,
      "b".repeat(64),
      SOURCE_HASH
    );
}

function canonicalPoem(database: Database.Database) {
  return database
    .prepare(
      `SELECT id,author_id,slug,verses,name_arabic,content_arabic,
    source_name,source_poem_id,source_hash,publication_json,publication_hash,
    publication_source_hash,rig_status,rig_version,rig_checkpoint_json,
    hidden,publishable,sitemap_shard FROM poem WHERE id=?`
    )
    .get(POEM_ID);
}

describe("canonical migration compatibility", () => {
  it.each([
    "../../../wrangler.jsonc",
    "../../../../site/wrangler.jsonc",
    "../../../../site/wrangler.production.jsonc",
  ])(
    "keeps deployment binding %s on the approved production database",
    (path) => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const ids = Array.from(
        source.matchAll(/"database_id"\s*:\s*"([^"]+)"/gu),
        (match) => match[1]
      );
      expect(ids).toEqual([SAQI_PRODUCTION_DATABASE_ID]);
    }
  );

  it("bootstraps exactly two application tables and replays as a no-op", () => {
    const database = open();
    expect(applyPending(database).at(-1)).toBe(
      "0072_drop_duplicate_poem_payloads.sql"
    );
    expect(tables(database)).toEqual(["author", "poem"]);
    const before = database
      .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
      .all();
    expect(applyPending(database)).toEqual([]);
    expect(
      database
        .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
        .all()
    ).toEqual(before);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it.each(["0065_", "0071_"])(
    "upgrades the installed schema before %s without losing canonical or unknown work",
    (cutoff) => {
      const database = open();
      applyPending(
        database,
        migrationFiles().filter((name) => name < cutoff)
      );
      insertPoem(database);
      const before = canonicalPoem(database);
      applyPending(database);
      expect(tables(database)).toEqual(["author", "poem"]);
      expect(canonicalPoem(database)).toEqual(before);
      expect(
        database.prepare("SELECT count(*) FROM author").pluck().get()
      ).toBe(1);
      expect(database.prepare("SELECT count(*) FROM poem").pluck().get()).toBe(
        1
      );
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
      const columns = database
        .prepare("SELECT name FROM pragma_table_info('poem')")
        .pluck()
        .all();
      expect(columns).toHaveLength(28);
      expect(columns).not.toContain("translation");
      expect(columns).not.toContain("active_source_revision_id");
    }
  );

  it("rolls back contraction if an unexpected view still depends on a removed field", () => {
    const database = open();
    applyPending(
      database,
      migrationFiles().filter((name) => name < "0071_")
    );
    insertPoem(database);
    database.exec(
      "CREATE VIEW external_legacy_reader AS SELECT active_source_revision_id FROM poem"
    );
    const before = tables(database);
    expect(() => applyPending(database)).toThrow();
    expect(tables(database)).toEqual(before);
    expect(
      database
        .prepare(
          "SELECT 1 FROM d1_migrations WHERE name='0071_drop_noncore_corpus_tables.sql'"
        )
        .get()
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT rig_status FROM poem WHERE id=?")
        .pluck()
        .get(POEM_ID)
    ).toBe("unknown");
    database.exec("DROP VIEW external_legacy_reader");
    expect(applyPending(database)).toEqual([
      "0071_drop_noncore_corpus_tables.sql",
      "0072_drop_duplicate_poem_payloads.sql",
    ]);
  });

  it("keeps source/URL uniqueness and unsafe-text visibility guards after contraction", () => {
    const database = open();
    applyPending(database);
    insertPoem(database);
    const visible = () =>
      database
        .prepare("SELECT publishable FROM poem WHERE id=?")
        .pluck()
        .get(POEM_ID);
    expect(visible()).toBe(1);
    expect(() =>
      database
        .prepare(
          "INSERT INTO author(id,slug,name_arabic) VALUES ('duplicate','author','شاعر')"
        )
        .run()
    ).toThrow(/UNIQUE/u);
    expect(() =>
      database
        .prepare(
          "INSERT INTO author(id,slug,name_arabic,source_name,source_author_id) VALUES ('duplicate','different','شاعر','aldiwan','poet-1')"
        )
        .run()
    ).toThrow(/UNIQUE/u);
    database
      .prepare("UPDATE poem SET slug=? WHERE id=?")
      .run("poem\u{202a}", POEM_ID);
    expect(visible()).toBe(0);
    database.prepare("UPDATE poem SET slug='poem42' WHERE id=?").run(POEM_ID);
    expect(visible()).toBe(1);
    database
      .prepare("UPDATE poem SET content_arabic=? WHERE id=?")
      .run(JSON.stringify({ content: ["صدر\u{0000}عجز"] }), POEM_ID);
    expect(visible()).toBe(0);
  });
});
