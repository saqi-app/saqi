import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

const EXPAND = readFileSync(
  new URL(
    "../../migrations/0062_expand_canonical_rig_state.sql",
    import.meta.url
  ),
  "utf8"
);
const BACKFILL = readFileSync(
  new URL(
    "../../migrations/0063_backfill_known_source_identity.sql",
    import.meta.url
  ),
  "utf8"
);

test("backfills authoritative mappings and leaves colliding legacy slugs alone", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE author(id TEXT PRIMARY KEY, slug TEXT NOT NULL);
      CREATE TABLE poem(id TEXT PRIMARY KEY, slug TEXT NOT NULL,
        hidden INTEGER NOT NULL, publishable INTEGER NOT NULL,
        active_source_revision_id TEXT);
      CREATE TABLE source_author_identity(source_name TEXT, external_id TEXT,
        canonical_url TEXT, canonical_author_id TEXT, last_observed_at INTEGER);
      CREATE TABLE source_poem_identity(source_name TEXT, external_id TEXT,
        canonical_url TEXT, canonical_poem_id TEXT, current_revision_id TEXT,
        current_revision_version INTEGER, last_observed_at INTEGER);
      CREATE TABLE poem_source_revision(id TEXT PRIMARY KEY, content_hash TEXT);
      INSERT INTO author VALUES ('author', 'poet');
      INSERT INTO poem VALUES ('legacy', 'poem123', 0, 1, NULL);
      INSERT INTO poem VALUES ('mapped', 'source-mapped', 0, 1, 'revision');
      INSERT INTO source_author_identity VALUES
        ('aldiwan', 'poet', 'https://source.test/poet', 'author', 10);
      INSERT INTO source_poem_identity VALUES
        ('aldiwan', '123', 'https://source.test/poem123', 'mapped', 'revision', 3, 20);
    `);
    database
      .prepare("INSERT INTO poem_source_revision VALUES (?, ?)")
      .run("revision", "a".repeat(64));
    database.exec(EXPAND);
    database.exec(BACKFILL);
    expect(
      database
        .prepare(
          "SELECT source_name AS sourceName, source_author_id AS sourceAuthorId FROM author WHERE id='author'"
        )
        .get()
    ).toEqual({ sourceName: "aldiwan", sourceAuthorId: "poet" });
    expect(
      database
        .prepare(
          "SELECT source_poem_id AS sourcePoemId, source_hash AS sourceHash, source_version AS sourceVersion FROM poem WHERE id='mapped'"
        )
        .get()
    ).toEqual({
      sourcePoemId: "123",
      sourceHash: "a".repeat(64),
      sourceVersion: 3,
    });
    expect(
      database
        .prepare(
          "SELECT source_poem_id AS sourcePoemId, source_hash AS sourceHash FROM poem WHERE id='legacy'"
        )
        .get()
    ).toEqual({ sourcePoemId: null, sourceHash: null });
    database.exec(BACKFILL);
    expect(database.prepare("SELECT COUNT(*) AS n FROM poem").get()).toEqual({
      n: 2,
    });
    expect(database.pragma("foreign_key_check")).toEqual([]);
  } finally {
    database.close();
  }
});

test("backfill advances in bounded batches and resumes without revisiting rows", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE author(id TEXT PRIMARY KEY, slug TEXT NOT NULL);
      CREATE TABLE poem(id TEXT PRIMARY KEY, slug TEXT NOT NULL,
        hidden INTEGER NOT NULL, publishable INTEGER NOT NULL,
        active_source_revision_id TEXT);
      CREATE TABLE source_author_identity(source_name TEXT, external_id TEXT,
        canonical_url TEXT, canonical_author_id TEXT, last_observed_at INTEGER);
      CREATE TABLE source_poem_identity(source_name TEXT, external_id TEXT,
        canonical_url TEXT, canonical_poem_id TEXT, current_revision_id TEXT,
        current_revision_version INTEGER, last_observed_at INTEGER);
      CREATE TABLE poem_source_revision(id TEXT PRIMARY KEY, content_hash TEXT);
    `);
    const insertAuthor = database.prepare("INSERT INTO author VALUES (?, ?)");
    const insertPoem = database.prepare(
      "INSERT INTO poem VALUES (?, ?, 0, 1, ?)"
    );
    const insertSourceAuthor = database.prepare(
      "INSERT INTO source_author_identity VALUES ('aldiwan', ?, NULL, ?, 1)"
    );
    const insertSourcePoem = database.prepare(
      "INSERT INTO source_poem_identity VALUES ('aldiwan', ?, NULL, ?, ?, 1, 1)"
    );
    const insertRevision = database.prepare(
      "INSERT INTO poem_source_revision VALUES (?, ?)"
    );
    database.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        const id = `id-${String(index).padStart(3, "0")}`;
        const revision = `revision-${id}`;
        insertAuthor.run(id, id);
        insertPoem.run(id, id, revision);
        insertSourceAuthor.run(id, id);
        insertSourcePoem.run(id, id, revision);
        insertRevision.run(revision, "a".repeat(64));
      }
    })();
    database.exec(EXPAND);
    database.exec(BACKFILL);
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM author WHERE source_name IS NOT NULL"
        )
        .get()
    ).toEqual({ count: 500 });
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM poem WHERE source_hash IS NOT NULL"
        )
        .get()
    ).toEqual({ count: 500 });
    database.exec(BACKFILL);
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM author WHERE source_name IS NOT NULL"
        )
        .get()
    ).toEqual({ count: 501 });
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM poem WHERE source_hash IS NOT NULL"
        )
        .get()
    ).toEqual({ count: 501 });
    database.exec(BACKFILL);
    expect(database.pragma("integrity_check")).toEqual([
      { integrity_check: "ok" },
    ]);
  } finally {
    database.close();
  }
});
