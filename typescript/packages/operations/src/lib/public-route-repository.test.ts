import { readdirSync, readFileSync } from "node:fs";

import type { D1Database } from "@cloudflare/workers-types";
import { authorCollisionSlug, poemPublicSlug } from "@saqi/precedent-iso";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { PublicRouteRepository } from "./public-route-repository";

const DATABASES: Database.Database[] = [];
afterEach(() => {
  for (const database of DATABASES) database.close();
  DATABASES.length = 0;
});
function fixture() {
  const sqlite = new Database(":memory:");
  DATABASES.push(sqlite);
  sqlite.pragma("foreign_keys=ON");
  const directory = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .toSorted())
    sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
  const hooks: {
    beforeBatch?: () => void;
    beforeQuery?: (query: string) => void;
  } = {};
  const wrap = (query: string, values: unknown[] = []) => {
    const execute = () => {
      hooks.beforeQuery?.(query);
      const statement = sqlite.prepare(query);
      const parameters = Object.fromEntries(
        values.map((value, index) => [String(index + 1), value])
      );
      if (!statement.reader) {
        if (values.length === 0) statement.run();
        else statement.run(parameters);
        return [];
      }
      return values.length === 0 ? statement.all() : statement.all(parameters);
    };
    return {
      bind: (...parameters: unknown[]) => wrap(query, parameters),
      first: async () => execute()[0] ?? null,
      all: async () => ({ results: execute() }),
      execute,
    };
  };
  const database = {
    prepare: wrap,
    batch: async (statements: ReturnType<typeof wrap>[]) => {
      hooks.beforeBatch?.();
      return sqlite.transaction(() =>
        statements.map((statement) => ({ results: statement.execute() }))
      )();
    },
  } as unknown as D1Database;
  const repository = new PublicRouteRepository(database);
  return { sqlite, repository, hooks };
}
function insertAuthor(
  sqlite: Database.Database,
  id = "author",
  slug = "poet-abn-rumi",
  sourceId: null | string = null
) {
  sqlite
    .prepare(
      "INSERT INTO author(id,slug,name_arabic,source_author_id) VALUES(?,?,'شاعر',?)"
    )
    .run(id, slug, sourceId);
}
function insertPoem(sqlite: Database.Database, id = "poem", sourceId = "42") {
  sqlite
    .prepare(
      `INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,rig_status,rig_version,rig_lease_token,rig_lease_expires_at,rig_checkpoint_json)
    VALUES(?,?,?,1,'قصيدة','{"content":["","بيت أول",""]}','unknown',7,'keep-lease',2000000000,'{"invocation":{"attemptId":"keep-me"}}')`
    )
    .run(id, "author", `source-${id}`);
  sqlite
    .prepare(
      "UPDATE poem SET source_hash=?,publication_hash=?,publication_source_hash=?,source_poem_id=? WHERE id=?"
    )
    .run("a".repeat(64), "b".repeat(64), "c".repeat(64), sourceId, id);
}
function paidState(sqlite: Database.Database) {
  return sqlite
    .prepare(
      "SELECT id,author_id,slug,content_arabic,publication_json,source_hash,publication_hash,publication_source_hash,rig_status,rig_version,rig_lease_token,rig_lease_expires_at,rig_checkpoint_json FROM poem ORDER BY id"
    )
    .all();
}
function publish(sqlite: Database.Database, line: string, id = "poem") {
  sqlite.prepare("UPDATE poem SET publication_json=? WHERE id=?").run(
    JSON.stringify({
      schemaVersion: 2,
      active: false,
      fields: { linesEnglish: ["wrong blank-source counterpart", line] },
    }),
    id
  );
}

test("allocates source-independent canonical routes without changing paid or corpus state", async () => {
  const { sqlite, repository } = fixture();
  insertAuthor(sqlite);
  insertPoem(sqlite);
  publish(sqlite, "The first published line");
  const before = paidState(sqlite);
  const authorsBefore = sqlite
    .prepare("SELECT * FROM author ORDER BY id")
    .all();
  await expect(repository.advance()).resolves.toMatchObject({
    authorsActivated: 1,
    poemsChecked: 0,
    pending: true,
  });
  await expect(repository.advance()).resolves.toMatchObject({
    poemsActivated: 1,
    pending: false,
  });
  expect(
    sqlite
      .prepare(
        "SELECT canonical_slug AS slug FROM public_author_namespace WHERE author_id='author'"
      )
      .get()
  ).toEqual({ slug: "abn-rumi" });
  expect(
    sqlite
      .prepare(
        "SELECT public_slug AS slug,public_slug_language AS language FROM poem"
      )
      .get()
  ).toEqual({
    slug: await poemPublicSlug("The first published line", "poem"),
    language: "en",
  });
  expect(paidState(sqlite)).toEqual(before);
  expect(sqlite.prepare("SELECT * FROM author ORDER BY id").all()).toEqual(
    authorsBefore
  );
  await expect(repository.advance()).resolves.toMatchObject({
    authorsActivated: 0,
    poemsChecked: 0,
    pending: false,
  });
});

test("transitions Arabic to English once and retains every historical alias", async () => {
  const { sqlite, repository } = fixture();
  insertAuthor(sqlite);
  insertPoem(sqlite);
  await repository.advance();
  await repository.advance();
  const arabic = await poemPublicSlug("بيت أول", "poem");
  expect(sqlite.prepare("SELECT public_slug AS slug FROM poem").get()).toEqual({
    slug: arabic,
  });
  publish(sqlite, "An English arrival");
  await repository.advance();
  const english = await poemPublicSlug("An English arrival", "poem");
  publish(sqlite, "A later changed translation");
  await expect(repository.advance()).resolves.toMatchObject({
    poemsChecked: 1,
    poemsActivated: 0,
    pending: false,
  });
  expect(
    sqlite
      .prepare(
        "SELECT public_slug AS slug,public_route_checked_generation=public_route_generation AS checked FROM poem"
      )
      .get()
  ).toEqual({ slug: english, checked: 1 });
  expect(
    sqlite
      .prepare(
        "SELECT segment FROM public_poem_alias WHERE poem_id='poem' ORDER BY segment"
      )
      .pluck()
      .all()
  ).toEqual([arabic, english, "poem"].toSorted());
});

test("respects all pre-reserved legacy author names regardless of allocation order", async () => {
  const { sqlite, repository } = fixture();
  insertAuthor(sqlite, "prefixed", "poet-collision");
  insertAuthor(sqlite, "legacy", "collision");
  await repository.advance();
  expect(
    sqlite
      .prepare(
        "SELECT canonical_slug AS slug FROM public_author_namespace WHERE author_id='legacy'"
      )
      .get()
  ).toEqual({ slug: "collision" });
  expect(
    sqlite
      .prepare(
        "SELECT canonical_slug AS slug FROM public_author_namespace WHERE author_id='prefixed'"
      )
      .get()
  ).toEqual({ slug: await authorCollisionSlug("poet-collision", "prefixed") });
});

test("uses exact source seeds for synthetic slugs and rejects stale author snapshots", async () => {
  const { sqlite, repository, hooks } = fixture();
  insertAuthor(
    sqlite,
    "source-author",
    `source-${"a".repeat(64)}`,
    "poet-old-name"
  );
  hooks.beforeBatch = () => {
    delete hooks.beforeBatch;
    sqlite.exec(
      "UPDATE author SET source_author_id='poet-new-name' WHERE id='source-author'"
    );
  };
  await expect(repository.advance()).resolves.toMatchObject({
    authorsActivated: 0,
    pending: true,
  });
  expect(
    sqlite
      .prepare(
        "SELECT segment FROM public_author_segment WHERE segment='old-name'"
      )
      .get()
  ).toBeUndefined();
  await expect(repository.advance()).resolves.toMatchObject({
    authorsActivated: 1,
    pending: false,
  });
  expect(
    sqlite
      .prepare(
        "SELECT canonical_slug AS slug FROM public_author_namespace WHERE author_id='source-author'"
      )
      .get()
  ).toEqual({ slug: "new-name" });
});

test("publication races cannot activate a slug derived from an old generation", async () => {
  const { sqlite, repository, hooks } = fixture();
  insertAuthor(sqlite);
  insertPoem(sqlite);
  await repository.advance();
  publish(sqlite, "Old English");
  hooks.beforeQuery = (query) => {
    if (query.startsWith("UPDATE poem SET public_slug=")) {
      delete hooks.beforeQuery;
      publish(sqlite, "Fresh English");
    }
  };
  await expect(repository.advance()).resolves.toMatchObject({
    poemsActivated: 0,
    pending: true,
  });
  expect(sqlite.prepare("SELECT public_slug AS slug FROM poem").get()).toEqual({
    slug: null,
  });
  await repository.advance();
  expect(sqlite.prepare("SELECT public_slug AS slug FROM poem").get()).toEqual({
    slug: await poemPublicSlug("Fresh English", "poem"),
  });
});

test("batches guarded poem updates while leaving a raced publication pending", async () => {
  const { sqlite, repository, hooks } = fixture();
  insertAuthor(sqlite);
  for (let index = 0; index < 4; index += 1) {
    const id = `poem-${String(index)}`;
    insertPoem(sqlite, id, String(100 + index));
    publish(sqlite, `Published line ${String(index)}`, id);
  }
  await repository.advance();
  let expectedPaid = paidState(sqlite);
  let batches = 0;
  hooks.beforeBatch = () => {
    batches += 1;
    publish(sqlite, "A freshly published line", "poem-1");
    expectedPaid = paidState(sqlite);
  };
  await expect(repository.advance()).resolves.toMatchObject({
    poemsChecked: 4,
    poemsActivated: 3,
    pending: true,
  });
  expect(batches).toBe(1);
  expect(paidState(sqlite)).toEqual(expectedPaid);
  expect(
    sqlite
      .prepare("SELECT id FROM poem WHERE public_slug IS NOT NULL ORDER BY id")
      .pluck()
      .all()
  ).toEqual(["poem-0", "poem-2", "poem-3"]);
  expect(
    sqlite
      .prepare("SELECT public_slug FROM poem WHERE id='poem-1'")
      .pluck()
      .get()
  ).toBeNull();
  delete hooks.beforeBatch;
  await expect(repository.advance()).resolves.toMatchObject({
    poemsChecked: 1,
    poemsActivated: 1,
    pending: false,
  });
  expect(
    sqlite
      .prepare("SELECT public_slug FROM poem WHERE id='poem-1'")
      .pluck()
      .get()
  ).toBe(await poemPublicSlug("A freshly published line", "poem-1"));
});

test("rolls back the whole poem write batch when an alias is reserved", async () => {
  const { sqlite, repository } = fixture();
  insertAuthor(sqlite);
  for (let index = 0; index < 4; index += 1) {
    const id = `poem-${String(index)}`;
    insertPoem(sqlite, id, String(100 + index));
    publish(sqlite, `Published line ${String(index)}`, id);
  }
  await repository.advance();
  sqlite
    .prepare(
      `INSERT INTO public_poem_alias(author_namespace_id,segment,poem_id)
      SELECT id,?,NULL FROM public_author_namespace WHERE author_id='author'`
    )
    .run(await poemPublicSlug("Published line 3", "poem-3"));
  const paidBefore = paidState(sqlite);
  const aliasesBefore = sqlite
    .prepare("SELECT * FROM public_poem_alias ORDER BY segment")
    .all();
  const cacheBefore = sqlite.prepare("SELECT * FROM author_index_cache").all();
  await expect(repository.advance()).rejects.toThrow("PUBLIC_POEM_ALIAS_OWNED");
  expect(
    sqlite
      .prepare(
        "SELECT count(*) FROM poem WHERE public_slug IS NULL AND public_route_checked_generation<public_route_generation"
      )
      .pluck()
      .get()
  ).toBe(4);
  expect(paidState(sqlite)).toEqual(paidBefore);
  expect(
    sqlite.prepare("SELECT * FROM public_poem_alias ORDER BY segment").all()
  ).toEqual(aliasesBefore);
  expect(sqlite.prepare("SELECT * FROM author_index_cache").all()).toEqual(
    cacheBefore
  );
});

test("makes deterministic fallback conflicts explicit without stealing reservations", async () => {
  const { sqlite, repository } = fixture();
  insertAuthor(sqlite, "legacy", "collision");
  insertAuthor(sqlite, "candidate", "poet-collision");
  const fallback = await authorCollisionSlug("poet-collision", "candidate");
  sqlite
    .prepare(
      "INSERT INTO public_author_segment(segment,namespace_id) SELECT ?,id FROM public_author_namespace WHERE author_id='legacy'"
    )
    .run(fallback);
  await expect(repository.advance()).rejects.toThrow(
    "PUBLIC_AUTHOR_ROUTE_CONFLICT"
  );
  expect(
    sqlite
      .prepare(
        "SELECT n.author_id AS authorId FROM public_author_segment s JOIN public_author_namespace n ON n.id=s.namespace_id WHERE s.segment=?"
      )
      .get(fallback)
  ).toEqual({ authorId: "legacy" });
});

test("does not count orphaned poems or reconnect a deleted namespace", async () => {
  const { sqlite, repository, hooks } = fixture();
  insertAuthor(sqlite);
  insertPoem(sqlite);
  hooks.beforeBatch = () => {
    delete hooks.beforeBatch;
    sqlite.exec("DELETE FROM author WHERE id='author'");
  };
  await expect(repository.advance()).resolves.toMatchObject({
    authorsActivated: 0,
    pending: false,
  });
  await expect(repository.advance()).resolves.toMatchObject({
    poemsChecked: 0,
    pending: false,
  });
  expect(
    sqlite
      .prepare("SELECT author_id AS authorId FROM public_author_namespace")
      .get()
  ).toEqual({ authorId: null });
  expect(sqlite.prepare("SELECT public_slug AS slug FROM poem").get()).toEqual({
    slug: null,
  });
});

test("concurrent allocator requests activate a poem only once", async () => {
  const { sqlite, repository } = fixture();
  insertAuthor(sqlite);
  insertPoem(sqlite);
  await repository.advance();
  const results = await Promise.all([
    repository.advance(),
    repository.advance(),
  ]);
  expect(
    results.reduce((total, result) => total + result.poemsActivated, 0)
  ).toBe(1);
  expect(
    sqlite
      .prepare("SELECT count(*) FROM public_poem_alias WHERE poem_id='poem'")
      .pluck()
      .get()
  ).toBe(2);
  await expect(repository.pending()).resolves.toBe(false);
});

test("a reused poem and author ID cannot receive the retired incarnation's slug", async () => {
  const { sqlite, repository, hooks } = fixture();
  insertAuthor(sqlite);
  insertPoem(sqlite);
  await repository.advance();
  hooks.beforeQuery = (query) => {
    if (!query.startsWith("UPDATE poem SET public_slug=")) return;
    delete hooks.beforeQuery;
    sqlite.exec("DELETE FROM poem; DELETE FROM author");
    insertAuthor(sqlite, "author", "poet-replacement");
    sqlite
      .prepare(
        `INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic)
      VALUES('poem','author','new-source',1,'قصيدة',?)`
      )
      .run(JSON.stringify({ content: ["بيت جديد"] }));
  };
  await expect(repository.advance()).resolves.toMatchObject({
    poemsActivated: 0,
    pending: true,
  });
  expect(
    sqlite.prepare("SELECT public_slug FROM poem").pluck().get()
  ).toBeNull();
  expect(
    sqlite
      .prepare("SELECT count(*) FROM public_poem_alias WHERE poem_id IS NULL")
      .pluck()
      .get()
  ).toBe(1);
  await repository.advance();
  await repository.advance();
  expect(sqlite.prepare("SELECT public_slug FROM poem").pluck().get()).toBe(
    await poemPublicSlug("بيت جديد", "poem")
  );
});
