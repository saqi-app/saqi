import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

const SQL = readFileSync(
  new URL("../../../migrations/0001_schema.sql", import.meta.url),
  "utf8"
);
const DATABASES: Database.Database[] = [];

afterEach(() => {
  for (const database of DATABASES) database.close();
  DATABASES.length = 0;
});

function fixture() {
  const sqlite = new Database(":memory:");
  DATABASES.push(sqlite);
  sqlite.pragma("foreign_keys=ON");
  sqlite.exec(SQL);
  return sqlite;
}

function rows(sqlite: Database.Database) {
  return {
    authors: sqlite.prepare("SELECT * FROM author ORDER BY id").all(),
    poems: sqlite.prepare("SELECT * FROM poem ORDER BY id").all(),
    cache: sqlite.prepare("SELECT * FROM author_index_cache").all(),
    namespaces: sqlite
      .prepare("SELECT * FROM public_author_namespace ORDER BY id")
      .all(),
    segments: sqlite
      .prepare("SELECT * FROM public_author_segment ORDER BY segment")
      .all(),
    aliases: sqlite
      .prepare("SELECT * FROM public_poem_alias ORDER BY segment")
      .all(),
  };
}

test("baseline creates the current schema and replays without touching paid state or routes", () => {
  const sqlite = fixture();
  sqlite.exec(`
    INSERT INTO author(id,slug,name_arabic,source_author_id) VALUES('a','poet','شاعر','source-author');
    INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,source_poem_id,
      source_hash,publication_json,publication_hash,rig_status,rig_version,rig_lease_token,rig_checkpoint_json)
    VALUES('p','a','poem',1,'قصيدة','{"content":["بيت"]}','42','source',
      '{"schemaVersion":2,"active":false,"fields":{"linesEnglish":["A line"]}}','publication',
      'unknown',7,'retained-lease','{"invocation":{"attemptId":"retained-attempt"}}');
    UPDATE public_author_namespace SET canonical_slug='poet' WHERE author_id='a';
    UPDATE poem SET public_slug='a-line',public_slug_language='en' WHERE id='p';
  `);
  const before = rows(sqlite);
  sqlite.exec(SQL);
  expect(rows(sqlite)).toEqual(before);
  expect(sqlite.pragma("foreign_key_check")).toEqual([]);
});

test("schema rejects duplicate source identities and empty Arabic content", () => {
  const sqlite = fixture();
  const author = sqlite.prepare(
    "INSERT INTO author(id,slug,name_arabic,source_author_id) VALUES(?,?,'شاعر','same-source')"
  );
  author.run("a", "poet");
  expect(() => author.run("b", "another-poet")).toThrow();
  const poem = sqlite.prepare(
    "INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,source_poem_id) VALUES(?,'a',?,1,'قصيدة',?,'42')"
  );
  expect(() => poem.run("empty", "empty", '{"content":[" "]}')).toThrow();
  poem.run("p", "poem", '{"content":["بيت"]}');
  expect(() =>
    poem.run("q", "other-poem", '{"content":["بيت آخر"]}')
  ).toThrow();
});

test("deleting an owner retains route tombstones", () => {
  const sqlite = fixture();
  sqlite.exec(
    "INSERT INTO author(id,slug,name_arabic) VALUES('a','reserved-poet','شاعر')"
  );
  const before = sqlite
    .prepare(
      "SELECT * FROM public_author_segment WHERE segment='reserved-poet'"
    )
    .get();
  sqlite.exec("DELETE FROM author WHERE id='a'");
  expect(
    sqlite
      .prepare(
        "SELECT * FROM public_author_segment WHERE segment='reserved-poet'"
      )
      .get()
  ).toEqual(before);
  expect(() =>
    sqlite.exec(
      "INSERT INTO author(id,slug,name_arabic) VALUES('b','reserved-poet','شاعر آخر')"
    )
  ).toThrow();
});
