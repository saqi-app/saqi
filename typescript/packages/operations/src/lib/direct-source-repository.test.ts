import { readdirSync, readFileSync } from "node:fs";

import type { D1Database } from "@cloudflare/workers-types";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import {
  DirectSourceConflictError,
  DirectSourceRepository,
} from "./direct-source-repository";
import { RigPublicationRepository } from "./rig-publication-repository";

const DATABASES: Database.Database[] = [];
afterEach(() => {
  for (const database of DATABASES) database.close();
  DATABASES.length = 0;
});

function fixture() {
  const sqlite = new Database(":memory:");
  DATABASES.push(sqlite);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE author (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL,
      name_arabic TEXT NOT NULL,
      source_name TEXT, source_author_id TEXT, source_url TEXT,
      collected_at INTEGER
    );
    CREATE UNIQUE INDEX author_source_identity
      ON author(source_name, source_author_id) WHERE source_name IS NOT NULL;
    CREATE TABLE poem (
      id TEXT PRIMARY KEY, author_id TEXT REFERENCES author(id),
      slug TEXT UNIQUE NOT NULL, verses INTEGER NOT NULL,
      name_arabic TEXT NOT NULL, content_arabic TEXT NOT NULL,
      sitemap_shard INTEGER NOT NULL, source_name TEXT,
      source_poem_id TEXT, source_url TEXT, source_hash TEXT,
      source_version INTEGER NOT NULL DEFAULT 0, collected_at INTEGER,
      publication_json TEXT, publication_source_hash TEXT, publication_hash TEXT,
      publication_cache_dirty INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX poem_source_identity
      ON poem(source_name, source_poem_id) WHERE source_name IS NOT NULL;
  `);
  const wrap = (query: string, values: unknown[] = []) => ({
    bind: (...parameters: unknown[]) => wrap(query, parameters),
    first: async () => sqlite.prepare(query).get(numbered(values)) ?? null,
    run: async () => {
      const result = sqlite.prepare(query).run(numbered(values));
      return { meta: { changes: result.changes } };
    },
  });
  const database = { prepare: wrap } as unknown as D1Database;
  const repository = new DirectSourceRepository(
    database,
    "aldiwan",
    "https://www.aldiwan.net"
  );
  const author = {
    sourceAuthorId: "new-poet",
    sourceUrl: "https://www.aldiwan.net/cat-new-poet",
    nameArabic: "شاعر جديد",
  };
  const poem = {
    sourceAuthorId: "new-poet",
    sourcePoemId: "900001",
    sourceUrl: "https://www.aldiwan.net/poem900001.html",
    titleArabic: "قصيدة جديدة",
    linesArabic: ["سطر عربي أول", "سطر عربي ثان"],
    expectedHash: null as null | string,
  };
  const publisher = new RigPublicationRepository(database);
  return { author, poem, publisher, repository, sqlite };
}

function numbered(values: unknown[]) {
  return Object.fromEntries(
    values.map((value, index) => [String(index + 1), value])
  );
}

test("direct source upsert creates one canonical poem and updates Arabic with hash CAS", async () => {
  const { author, poem, publisher, repository, sqlite } = fixture();
  const createdAuthor = await repository.upsertAuthor(author);
  await expect(repository.nextAuthor()).resolves.toMatchObject({
    sourceAuthorId: author.sourceAuthorId,
    sourceUrl: author.sourceUrl,
    nameArabic: author.nameArabic,
  });
  await expect(repository.upsertAuthor(author)).resolves.toMatchObject({
    id: createdAuthor.id,
    status: "updated",
  });
  const created = await repository.upsertPoem(poem);
  expect(created.status).toBe("created");
  await expect(repository.upsertPoem(poem)).resolves.toMatchObject({
    id: created.id,
    status: "unchanged",
  });
  await expect(
    repository.currentPoem(poem.sourcePoemId)
  ).resolves.toMatchObject({
    id: created.id,
    sourceHash: created.sourceHash,
  });
  const repeated = await repository.upsertPoem({
    ...poem,
    expectedHash: created.sourceHash,
  });
  expect(repeated.status).toBe("unchanged");
  sqlite
    .prepare(
      "UPDATE poem SET publication_json = ?, publication_source_hash = ? WHERE id = ?"
    )
    .run(
      '{"visible":"old English and insights"}',
      created.sourceHash,
      created.id
    );
  const changed = await repository.upsertPoem({
    ...poem,
    linesArabic: ["نص عربي معدل", "سطر عربي ثان"],
    expectedHash: created.sourceHash,
  });
  expect(changed).toMatchObject({ id: created.id, status: "updated" });
  expect(changed.sourceHash).not.toBe(created.sourceHash);
  await expect(
    repository.upsertPoem({
      ...poem,
      linesArabic: ["كاتب قديم", "سطر عربي ثان"],
      expectedHash: created.sourceHash,
    })
  ).rejects.toMatchObject({ message: "SOURCE_CHANGED" });
  const row = sqlite
    .prepare(
      "SELECT content_arabic AS contentArabic, publication_json AS publicationJson, publication_source_hash AS publicationSourceHash, publication_cache_dirty AS publicationCacheDirty, source_version AS sourceVersion FROM poem WHERE id = ?"
    )
    .get(created.id) as Record<string, unknown>;
  expect(row).toMatchObject({
    publicationJson: '{"visible":"old English and insights"}',
    publicationSourceHash: created.sourceHash,
    publicationCacheDirty: 1,
    sourceVersion: 2,
  });
  const pending = await publisher.pendingPurge(created.id);
  expect(pending).toMatchObject({
    poemId: created.id,
    publicationHash: null,
    sourceHash: changed.sourceHash,
  });
  await expect(
    publisher.clearCacheDirty(created.id, null, created.sourceHash)
  ).resolves.toBe(false);
  await expect(
    publisher.clearCacheDirty(created.id, null, changed.sourceHash)
  ).resolves.toBe(true);
  expect(JSON.parse(String(row["contentArabic"]))).toMatchObject({
    content: ["نص عربي معدل", "سطر عربي ثان"],
    titleArabic: poem.titleArabic,
  });
  expect(sqlite.prepare("SELECT count(*) AS total FROM poem").get()).toEqual({
    total: 1,
  });
});

test("an interrupted author collection stays due until its manifest completes", async () => {
  const { author, repository, sqlite } = fixture();
  const created = await repository.upsertAuthor(author);
  sqlite
    .prepare("UPDATE author SET collected_at = ? WHERE id = ?")
    .run(100, created.id);

  await repository.upsertAuthor(author);
  expect(
    sqlite
      .prepare("SELECT collected_at AS collectedAt FROM author WHERE id = ?")
      .get(created.id)
  ).toEqual({ collectedAt: 100 });

  await repository.completeAuthor(author.sourceAuthorId);
  const completed = sqlite
    .prepare("SELECT collected_at AS collectedAt FROM author WHERE id = ?")
    .get(created.id) as { collectedAt: number };
  expect(completed.collectedAt).toBeGreaterThan(100);
  await expect(
    repository.completeAuthor("unknown-author")
  ).rejects.toMatchObject({ message: "AUTHOR_NOT_FOUND" });
});

test("direct upsert accepts the Arabic source author IDs used by the live corpus", async () => {
  const { author, poem, repository } = fixture();
  const sourceAuthorId = "أبو الطيب المتنبي";
  await expect(
    repository.upsertAuthor({
      ...author,
      sourceAuthorId,
      sourceUrl: `https://www.aldiwan.net/cat-${encodeURIComponent(sourceAuthorId)}`,
    })
  ).resolves.toMatchObject({ status: "created" });
  await expect(
    repository.upsertPoem({ ...poem, sourceAuthorId })
  ).resolves.toMatchObject({ status: "created" });
});

test("direct upsert rejects text that the public catalog would hide", async () => {
  const { author, poem, repository } = fixture();
  await expect(
    repository.upsertAuthor({ ...author, nameArabic: "س".repeat(501) })
  ).rejects.toThrow();
  await repository.upsertAuthor(author);
  await expect(
    repository.upsertPoem({ ...poem, titleArabic: "س".repeat(501) })
  ).rejects.toThrow();
  await expect(
    repository.upsertPoem({
      ...poem,
      linesArabic: Array.from({ length: 2_001 }, () => "س"),
    })
  ).rejects.toThrow();
});

test("an unmapped poem slug blocks duplicate canonical creation", async () => {
  const { author, poem, repository, sqlite } = fixture();
  const createdAuthor = await repository.upsertAuthor(author);
  sqlite
    .prepare(
      "INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,sitemap_shard) VALUES(?,?,?,?,?,?,?)"
    )
    .run(
      "legacy-id",
      createdAuthor.id,
      "poem900001",
      1,
      poem.titleArabic,
      '{"content":["old"]}',
      1
    );
  await expect(repository.upsertPoem(poem)).rejects.toBeInstanceOf(
    DirectSourceConflictError
  );
  expect(sqlite.prepare("SELECT count(*) AS total FROM poem").get()).toEqual({
    total: 1,
  });
});

test("unmapped Arabic matches block duplicate poems even with unrelated slugs", async () => {
  const { author, poem, repository, sqlite } = fixture();
  const createdAuthor = await repository.upsertAuthor(author);
  sqlite
    .prepare(
      "INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,sitemap_shard) VALUES(?,?,?,?,?,?,?)"
    )
    .run(
      "legacy-id",
      createdAuthor.id,
      "unrelated-slug",
      1,
      poem.titleArabic,
      '{"content":["old"]}',
      1
    );
  await expect(repository.upsertPoem(poem)).rejects.toMatchObject({
    message: "UNMAPPED_POEM_COLLISION",
  });
  sqlite
    .prepare("UPDATE poem SET name_arabic = ?, content_arabic = ?")
    .run("عنوان آخر", JSON.stringify({ content: poem.linesArabic }));
  await expect(repository.upsertPoem(poem)).rejects.toMatchObject({
    message: "UNMAPPED_POEM_COLLISION",
  });
  expect(sqlite.prepare("SELECT count(*) AS total FROM poem").get()).toEqual({
    total: 1,
  });
});

test("an unmapped author slug blocks duplicate canonical creation", async () => {
  const { author, repository, sqlite } = fixture();
  sqlite
    .prepare("INSERT INTO author(id,slug,name_arabic) VALUES(?,?,?)")
    .run("legacy-author", author.sourceAuthorId, author.nameArabic);
  await expect(repository.upsertAuthor(author)).rejects.toMatchObject({
    message: "UNMAPPED_AUTHOR_COLLISION",
  });
  expect(sqlite.prepare("SELECT count(*) AS total FROM author").get()).toEqual({
    total: 1,
  });
});

test("an unmapped Arabic author name blocks duplicate canonical creation", async () => {
  const { author, repository, sqlite } = fixture();
  sqlite
    .prepare("INSERT INTO author(id,slug,name_arabic) VALUES(?,?,?)")
    .run("legacy-author", "old-slug", author.nameArabic);
  await expect(repository.upsertAuthor(author)).rejects.toMatchObject({
    message: "UNMAPPED_AUTHOR_COLLISION",
  });
  expect(sqlite.prepare("SELECT count(*) AS total FROM author").get()).toEqual({
    total: 1,
  });
});

test("direct source rejects unsafe text and foreign origin", async () => {
  const { author, poem, repository } = fixture();
  await expect(
    repository.upsertAuthor({
      ...author,
      sourceUrl: "https://other.example/cat-new-poet",
    })
  ).rejects.toMatchObject({ message: "SOURCE_ORIGIN_MISMATCH" });
  await repository.upsertAuthor(author);
  await expect(
    repository.upsertPoem({
      ...poem,
      linesArabic: ["control\u{202e}inside"],
    })
  ).rejects.toThrow();
});

test("direct source insert passes the installed D1 schema and publishability triggers", async () => {
  const sqlite = new Database(":memory:");
  DATABASES.push(sqlite);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;`);
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(directory)
    .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
    .toSorted()) {
    sqlite.transaction(() => {
      sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
      sqlite.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
    })();
  }
  const wrap = (query: string, values: unknown[] = []) => ({
    bind: (...parameters: unknown[]) => wrap(query, parameters),
    first: async () => sqlite.prepare(query).get(numbered(values)) ?? null,
    run: async () => {
      const result = sqlite.prepare(query).run(numbered(values));
      return { meta: { changes: result.changes } };
    },
  });
  const repository = new DirectSourceRepository(
    { prepare: wrap } as unknown as D1Database,
    "aldiwan",
    "https://www.aldiwan.net"
  );
  const author = await repository.upsertAuthor({
    sourceAuthorId: "new-poet",
    sourceUrl: "https://www.aldiwan.net/cat-new-poet",
    nameArabic: "شاعر جديد",
  });
  const poem = await repository.upsertPoem({
    sourceAuthorId: "new-poet",
    sourcePoemId: "900001",
    sourceUrl: "https://www.aldiwan.net/poem900001.html",
    titleArabic: "قصيدة جديدة",
    linesArabic: ["سطر عربي أول", "سطر عربي ثان"],
    expectedHash: null,
  });
  expect(
    sqlite.prepare("SELECT publishable FROM poem WHERE id = ?").get(poem.id)
  ).toEqual({ publishable: 1 });
  expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    sqlite.prepare("SELECT id FROM author WHERE id = ?").get(author.id)
  ).toEqual({ id: author.id });
});
