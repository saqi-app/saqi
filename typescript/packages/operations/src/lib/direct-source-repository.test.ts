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
  sqlite.exec(
    readFileSync(
      new URL("../../migrations/0001_schema.sql", import.meta.url),
      "utf8"
    )
  );
  const wrap = (query: string, values: unknown[] = []) => ({
    bind: (...parameters: unknown[]) => wrap(query, parameters),
    first: async () => sqlite.prepare(query).get(numbered(values)) ?? null,
    all: async () => {
      const before = sqlite
        .prepare("SELECT total_changes()")
        .pluck()
        .get() as number;
      const statement = sqlite.prepare(query);
      let results: unknown[] = [];
      if (statement.reader) results = statement.all(numbered(values));
      else statement.run(numbered(values));
      return {
        results,
        meta: {
          changes:
            (sqlite.prepare("SELECT total_changes()").pluck().get() as number) -
            before,
        },
      };
    },
    run: async () => {
      const before = sqlite
        .prepare("SELECT total_changes()")
        .pluck()
        .get() as number;
      sqlite.prepare(query).run(numbered(values));
      const after = sqlite
        .prepare("SELECT total_changes()")
        .pluck()
        .get() as number;
      return { meta: { changes: after - before } };
    },
  });
  const database = {
    prepare: wrap,
    batch: async (statements: { all: () => Promise<unknown> }[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = await Promise.all(
          statements.map((statement) => statement.all())
        );
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const repository = new DirectSourceRepository(
    database,
    "https://poetry.example",
    "fixture"
  );
  const author = {
    sourceAuthorId: "new-poet",
    sourceUrl: "https://poetry.example/cat-new-poet",
    nameArabic: "شاعر جديد",
  };
  const poem = {
    sourceAuthorId: "new-poet",
    sourcePoemId: "900001",
    sourceUrl: "https://poetry.example/poem900001.html",
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

test("author renames atomically retain dirty routes without changing poem identities or source hashes", async () => {
  const { author, poem, publisher, repository, sqlite } = fixture();
  const createdAuthor = await repository.upsertAuthor(author);
  const createdPoem = await repository.upsertPoem(poem);
  await publisher.clearCacheDirtyBatch(await publisher.pendingPurges());
  await expect(repository.upsertAuthor(author)).resolves.toMatchObject({
    cachePending: false,
  });
  await expect(
    repository.upsertAuthor({ ...author, nameArabic: "شاعر مصحح" })
  ).resolves.toMatchObject({
    id: createdAuthor.id,
    status: "updated",
    cachePending: true,
  });
  expect(
    sqlite
      .prepare(
        "SELECT id, source_hash AS sourceHash, publication_cache_dirty AS cacheDirty FROM poem"
      )
      .get()
  ).toEqual({
    id: createdPoem.id,
    sourceHash: createdPoem.sourceHash,
    cacheDirty: 1,
  });
  expect(sqlite.prepare("SELECT name_arabic FROM author").pluck().get()).toBe(
    "شاعر مصحح"
  );
});

test("failed author rename rolls back its pending cache invalidations", async () => {
  const { author, poem, publisher, repository, sqlite } = fixture();
  await repository.upsertAuthor(author);
  await repository.upsertPoem(poem);
  await publisher.clearCacheDirtyBatch(await publisher.pendingPurges());
  sqlite.exec(
    "CREATE TRIGGER reject_rename BEFORE UPDATE ON author BEGIN SELECT RAISE(ABORT, 'test rename failure'); END;"
  );
  await expect(
    repository.upsertAuthor({ ...author, nameArabic: "شاعر مصحح" })
  ).rejects.toThrow("test rename failure");
  expect(
    sqlite.prepare("SELECT publication_cache_dirty FROM poem").pluck().get()
  ).toBe(0);
  expect(sqlite.prepare("SELECT name_arabic FROM author").pluck().get()).toBe(
    author.nameArabic
  );
});

test("an in-flight purge cannot acknowledge a later author rename, including legacy null hashes", async () => {
  const { author, poem, publisher, repository, sqlite } = fixture();
  await repository.upsertAuthor(author);
  const created = await repository.upsertPoem(poem);
  sqlite
    .prepare("UPDATE poem SET source_hash = NULL, publication_cache_dirty = 1")
    .run();
  const old = await publisher.pendingPurge(created.id);
  expect(old).toMatchObject({
    sourceHash: null,
    authorName: author.nameArabic,
  });
  const renamed = "شاعر مصحح";
  await repository.upsertAuthor({ ...author, nameArabic: renamed });
  await expect(publisher.clearCacheDirty(old!)).resolves.toBe(false);
  const current = await publisher.pendingPurge(created.id);
  sqlite.prepare("UPDATE author SET slug='moved-poet'").run();
  await expect(publisher.clearCacheDirty(current!)).resolves.toBe(false);
  await expect(
    publisher.clearCacheDirty((await publisher.pendingPurge(created.id))!)
  ).resolves.toBe(true);
  await expect(publisher.pendingPurge(created.id)).resolves.toBeNull();
});

test.each(["scalar", "batch"])(
  "a stale %s acknowledgement cannot consume an author rename from A to B to A",
  async (method) => {
    const { author, poem, publisher, repository } = fixture();
    await repository.upsertAuthor(author);
    const created = await repository.upsertPoem(poem);
    const captured = await publisher.pendingPurge(created.id);
    if (!captured)
      throw new Error("Expected the created poem to have a pending purge");
    await repository.upsertAuthor({ ...author, nameArabic: "شاعر مصحح" });
    await repository.upsertAuthor(author);
    const current = await publisher.pendingPurge(created.id);
    if (!current)
      throw new Error("Expected both author renames to retain pending work");
    expect(current).toEqual({
      ...captured,
      cacheGeneration: captured.cacheGeneration + 2,
    });
    if (method === "scalar") {
      await expect(publisher.clearCacheDirty(captured)).resolves.toBe(false);
      await expect(publisher.pendingPurge(created.id)).resolves.toEqual(
        current
      );
      await expect(publisher.clearCacheDirty(current)).resolves.toBe(true);
    } else {
      await expect(publisher.clearCacheDirtyBatch([captured])).resolves.toBe(0);
      await expect(publisher.pendingPurge(created.id)).resolves.toEqual(
        current
      );
      await expect(publisher.clearCacheDirtyBatch([current])).resolves.toBe(1);
    }
    await expect(publisher.pendingPurge(created.id)).resolves.toBeNull();
  }
);

test("renamed legacy authors drain beyond one cache batch and stale names cannot clear it", async () => {
  const { author, poem, publisher, repository, sqlite } = fixture();
  await repository.upsertAuthor(author);
  const created = await repository.upsertPoem(poem);
  const insert =
    sqlite.prepare(`INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,sitemap_shard,source_hash,publication_cache_dirty)
    SELECT ?,author_id,?,verses,name_arabic,content_arabic,sitemap_shard,NULL,1 FROM poem WHERE id = ?`);
  for (let index = 0; index < 60; index += 1)
    insert.run(
      `legacy-${String(index)}`,
      `legacy-${String(index)}`,
      created.id
    );
  sqlite
    .prepare("UPDATE poem SET source_hash = NULL, publication_cache_dirty = 1")
    .run();
  const before = await publisher.pendingPurges();
  expect(before).toHaveLength(50);
  await repository.upsertAuthor({ ...author, nameArabic: "شاعر مصحح" });
  await publisher.clearCacheDirtyBatch(before);
  expect(
    sqlite
      .prepare("SELECT count(*) FROM poem WHERE publication_cache_dirty = 1")
      .pluck()
      .get()
  ).toBe(61);
  await publisher.clearCacheDirtyBatch(await publisher.pendingPurges());
  const remaining = await publisher.pendingPurges();
  expect(remaining).toHaveLength(11);
  await publisher.clearCacheDirtyBatch(remaining);
  await expect(publisher.pendingPurges()).resolves.toEqual([]);
});

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
  sqlite.exec(`CREATE TRIGGER extra_source_write AFTER UPDATE OF content_arabic ON poem
    BEGIN UPDATE poem SET publication_cache_dirty = 1 WHERE id = NEW.id; END`);
  const changesBefore = sqlite
    .prepare("SELECT total_changes() AS total")
    .get() as {
    total: number;
  };
  const changed = await repository.upsertPoem({
    ...poem,
    linesArabic: ["نص عربي معدل", "سطر عربي ثان"],
    expectedHash: created.sourceHash,
  });
  expect(changed).toMatchObject({ id: created.id, status: "updated" });
  const changesAfter = sqlite
    .prepare("SELECT total_changes() AS total")
    .get() as {
    total: number;
  };
  expect(changesAfter.total - changesBefore.total).toBeGreaterThan(1);
  expect(changed.sourceHash).not.toBe(created.sourceHash);
  await expect(
    repository.upsertPoem({
      ...poem,
      linesArabic: ["نص عربي معدل", "سطر عربي ثان"],
      expectedHash: created.sourceHash,
    })
  ).resolves.toMatchObject({ id: created.id, status: "unchanged" });
  await expect(
    repository.upsertPoem({
      ...poem,
      linesArabic: ["كاتب قديم", "سطر عربي ثان"],
      expectedHash: created.sourceHash,
    })
  ).rejects.toMatchObject({ message: "SOURCE_CHANGED" });
  const row = sqlite
    .prepare(
      "SELECT content_arabic AS contentArabic, publication_json AS publicationJson, publication_source_hash AS publicationSourceHash, publication_cache_dirty AS publicationCacheDirty FROM poem WHERE id = ?"
    )
    .get(created.id) as Record<string, unknown>;
  expect(row).toMatchObject({
    publicationJson: '{"visible":"old English and insights"}',
    publicationSourceHash: created.sourceHash,
    publicationCacheDirty: 1,
  });
  const pending = await publisher.pendingPurge(created.id);
  expect(pending).toMatchObject({
    poemId: created.id,
    publicationHash: null,
    sourceHash: changed.sourceHash,
  });
  await expect(
    publisher.clearCacheDirty({ ...pending!, sourceHash: created.sourceHash })
  ).resolves.toBe(false);
  await expect(publisher.clearCacheDirty(pending!)).resolves.toBe(true);
  expect(JSON.parse(String(row["contentArabic"]))).toMatchObject({
    content: ["نص عربي معدل", "سطر عربي ثان"],
    titleArabic: poem.titleArabic,
  });
  expect(sqlite.prepare("SELECT count(*) AS total FROM poem").get()).toEqual({
    total: 1,
  });
});

test("canonical IDs and author URLs use the configured namespace", async () => {
  const { author, poem, repository, sqlite } = fixture();
  const createdAuthor = await repository.upsertAuthor(author);
  const createdPoem = await repository.upsertPoem(poem);
  expect(createdAuthor.id).toBe(
    "8b0838c71947c5ed07bca87bad0a7e74084aa8c031da39e2fa9b9826e8e9547f"
  );
  expect(createdPoem.id).toBe(
    "e47b23af3b1a4d01947728055d9d24039e54362898e320278b53660501710215"
  );
  expect(
    sqlite.prepare("SELECT slug FROM author WHERE id = ?").get(createdAuthor.id)
  ).toEqual({
    slug: "source-3d87ab8ae7c9552f0a19063c310b60bcfb1d912a4b4defe5b1bea513310a48c1",
  });
});

test("an interrupted author collection stays due until its manifest completes", async () => {
  const { author, repository, sqlite } = fixture();
  const created = await repository.upsertAuthor(author);
  await repository.upsertAuthor(author);
  expect(
    sqlite
      .prepare("SELECT source_url AS sourceUrl FROM author WHERE id = ?")
      .get(created.id)
  ).toEqual({ sourceUrl: author.sourceUrl });
  await expect(repository.nextAuthor()).resolves.toMatchObject({
    id: created.id,
  });

  await repository.completeAuthor(author.sourceAuthorId);
  const completed = sqlite
    .prepare("SELECT source_url AS sourceUrl FROM author WHERE id = ?")
    .get(created.id) as { sourceUrl: null };
  expect(completed.sourceUrl).toBeNull();
  await repository.upsertAuthor(author);
  expect(
    sqlite
      .prepare("SELECT source_url AS sourceUrl FROM author WHERE id = ?")
      .get(created.id)
  ).toEqual({ sourceUrl: null });
  await expect(repository.nextAuthor()).resolves.toBeNull();
  await expect(
    repository.completeAuthor("unknown-author")
  ).rejects.toMatchObject({ message: "AUTHOR_NOT_FOUND" });
});

test("manifest reconciliation skips only this author's mapped canonical poems", async () => {
  const { author, poem, repository, sqlite } = fixture();
  await repository.upsertAuthor(author);
  await repository.upsertPoem(poem);
  const otherAuthor = { ...author, sourceAuthorId: "other-poet" };
  await repository.upsertAuthor(otherAuthor);
  await repository.upsertPoem({
    ...poem,
    sourceAuthorId: "other-poet",
    sourcePoemId: "900002",
  });
  await repository.upsertPoem({ ...poem, sourcePoemId: "900003" });
  sqlite
    .prepare("UPDATE poem SET source_hash = NULL WHERE source_poem_id = ?")
    .run("900003");
  await expect(
    repository.existingPoemIds({
      sourceAuthorId: author.sourceAuthorId,
      poemIds: ["900001", "900002", "900003", "900004"],
    })
  ).resolves.toEqual(["900001"]);
  await expect(
    repository.existingPoemIds({
      sourceAuthorId: author.sourceAuthorId,
      poemIds: Array.from({ length: 201 }, (_, index) => String(index + 1)),
    })
  ).rejects.toThrow();
});

test("author writes succeed with triggers and leave missing authors detectable", async () => {
  const { author, repository, sqlite } = fixture();
  const created = await repository.upsertAuthor(author);
  sqlite.exec(`CREATE TABLE author_updates(id TEXT);
    CREATE TRIGGER record_author_update AFTER UPDATE ON author
    BEGIN INSERT INTO author_updates VALUES (NEW.id); END;`);
  await expect(repository.upsertAuthor(author)).resolves.toMatchObject({
    id: created.id,
  });
  await repository.deferSource(author.sourceAuthorId, 2_000_000_000);
  await repository.completeAuthor(author.sourceAuthorId);
  expect(
    sqlite.prepare("SELECT count(*) AS total FROM author_updates").get()
  ).toEqual({ total: 3 });
  await expect(repository.completeAuthor("absent")).rejects.toThrow(
    "AUTHOR_NOT_FOUND"
  );
});

test("direct upsert accepts the Arabic source author IDs used by the live corpus", async () => {
  const { author, poem, repository } = fixture();
  const sourceAuthorId = "أبو الطيب المتنبي";
  await expect(
    repository.upsertAuthor({
      ...author,
      sourceAuthorId,
      sourceUrl: `https://poetry.example/cat-${encodeURIComponent(sourceAuthorId)}`,
    })
  ).resolves.toMatchObject({ status: "created" });
  await expect(
    repository.upsertPoem({ ...poem, sourceAuthorId })
  ).resolves.toMatchObject({ status: "created" });
});

test("Unicode dash author identities replay exactly and remain distinct from ASCII spelling", async () => {
  const { author, poem, repository, sqlite } = fixture();
  const sourceAuthorId = "poet-Malik-Al‑Asamm";
  const sourceUrl = `https://poetry.example/cat-${encodeURIComponent(sourceAuthorId)}`;
  const input = { ...author, sourceAuthorId, sourceUrl };
  const created = await repository.upsertAuthor(input);
  await expect(repository.upsertAuthor(input)).resolves.toMatchObject({
    id: created.id,
    status: "updated",
  });
  const createdPoem = await repository.upsertPoem({ ...poem, sourceAuthorId });
  await expect(
    repository.existingPoemIds({ sourceAuthorId, poemIds: [poem.sourcePoemId] })
  ).resolves.toEqual([poem.sourcePoemId]);
  await repository.deferSource(sourceAuthorId, 2_000_000_000);
  expect(
    sqlite
      .prepare(
        "SELECT source_author_id AS sourceAuthorId, source_url AS sourceUrl, source_retry_after AS sourceRetryAfter FROM author WHERE id=?"
      )
      .get(created.id)
  ).toEqual({
    sourceAuthorId,
    sourceUrl,
    sourceRetryAfter: 2_000_000_000,
  });
  await repository.completeAuthor(sourceAuthorId);
  expect(
    sqlite
      .prepare("SELECT source_url FROM author WHERE id=?")
      .pluck()
      .get(created.id)
  ).toBeNull();
  const asciiId = "poet-Malik-Al-Asamm";
  const separate = await repository.upsertAuthor({
    ...author,
    sourceAuthorId: asciiId,
    sourceUrl: `https://poetry.example/cat-${asciiId}`,
  });
  expect(separate.id).not.toBe(created.id);
  await expect(
    repository.existingPoemIds({
      sourceAuthorId: asciiId,
      poemIds: [poem.sourcePoemId],
    })
  ).resolves.toEqual([]);
  await expect(
    repository.upsertPoem({ ...poem, sourceAuthorId: asciiId })
  ).rejects.toThrow("POEM_AUTHOR_CONFLICT");
  expect(
    sqlite
      .prepare("SELECT author_id FROM poem WHERE id=?")
      .pluck()
      .get(createdPoem.id)
  ).toBe(created.id);
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

test("unmapped poems block ambiguous admission after both title and text change", async () => {
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
  sqlite
    .prepare("UPDATE poem SET name_arabic = ?, content_arabic = ?")
    .run("عنوان مختلف", '{"content":["نص مختلف"]}');
  await expect(repository.upsertPoem(poem)).rejects.toMatchObject({
    message: "UNMAPPED_POEM_COLLISION",
  });
  expect(sqlite.prepare("SELECT count(*) AS total FROM poem").get()).toEqual({
    total: 1,
  });
});

test("mapped Arabic updates remain available beside unresolved legacy poems", async () => {
  const { author, poem, repository, sqlite } = fixture();
  await repository.upsertAuthor(author);
  const created = await repository.upsertPoem(poem);
  sqlite
    .prepare(
      `INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,sitemap_shard)
    SELECT 'legacy',author_id,'legacy',1,'قديم','{"content":["قديم"]}',1
    FROM poem WHERE id = ?`
    )
    .run(created.id);
  await expect(
    repository.upsertPoem({
      ...poem,
      titleArabic: "عنوان معدل",
      linesArabic: ["نص معدل"],
      expectedHash: created.sourceHash,
    })
  ).resolves.toMatchObject({ id: created.id, status: "updated" });
  expect(sqlite.prepare("SELECT count(*) AS total FROM poem").get()).toEqual({
    total: 2,
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

test("direct source insert passes the current schema and poem validity guards", async () => {
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
    "https://poetry.example",
    "fixture"
  );
  const author = await repository.upsertAuthor({
    sourceAuthorId: "new-poet",
    sourceUrl: "https://poetry.example/cat-new-poet",
    nameArabic: "شاعر جديد",
  });
  const poem = await repository.upsertPoem({
    sourceAuthorId: "new-poet",
    sourcePoemId: "900001",
    sourceUrl: "https://poetry.example/poem900001.html",
    titleArabic: "قصيدة جديدة",
    linesArabic: ["سطر عربي أول", "سطر عربي ثان"],
    expectedHash: null,
  });
  expect(
    sqlite
      .prepare("SELECT source_poem_id AS sourcePoemId FROM poem WHERE id = ?")
      .get(poem.id)
  ).toEqual({ sourcePoemId: "900001" });
  expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    sqlite.prepare("SELECT id FROM author WHERE id = ?").get(author.id)
  ).toEqual({ id: author.id });
});

test("source cooldown persists through completion and a shorter retry cannot erase it", async () => {
  const { author, repository, sqlite } = fixture();
  await repository.upsertAuthor(author);
  await repository.deferSource(author.sourceAuthorId, 2_000_000_000);
  await repository.deferSource(author.sourceAuthorId, 1_900_000_000);
  await repository.completeAuthor(author.sourceAuthorId);
  await expect(repository.sourceRetryAfter()).resolves.toBe(2_000_000_000);
  expect(
    sqlite
      .prepare("SELECT source_retry_after AS sourceRetryAfter FROM author")
      .get()
  ).toEqual({
    sourceRetryAfter: 2_000_000_000,
  });
  await expect(
    repository.deferSource("missing-author", 2_000_000_001)
  ).rejects.toThrow("SOURCE_AUTHOR_MISSING");
});
