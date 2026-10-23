import { readdirSync, readFileSync } from "node:fs";

import type { D1Database } from "@cloudflare/workers-types";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { PublicRouteCacheRepository } from "./public-route-cache-repository";

const DATABASES: Database.Database[] = [];
afterEach(() => {
  for (const database of DATABASES) database.close();
  DATABASES.length = 0;
});
function fixture(recursive = false) {
  const sqlite = new Database(":memory:");
  DATABASES.push(sqlite);
  sqlite.pragma("foreign_keys=ON");
  sqlite.pragma(`recursive_triggers=${recursive ? "ON" : "OFF"}`);
  const directory = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .toSorted())
    sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
  sqlite.exec(
    "INSERT INTO author(id,slug,name_arabic) VALUES('a','poet-fixture','شاعر')"
  );
  const wrap = (query: string, values: unknown[] = []) => {
    const parameters = Object.fromEntries(
      values.map((value, index) => [String(index + 1), value])
    );
    const read = () => {
      const statement = sqlite.prepare(query);
      return values.length === 0 ? statement.all() : statement.all(parameters);
    };
    return {
      bind: (...bound: unknown[]) => wrap(query, bound),
      first: async () => read()[0] ?? null,
      all: async () => ({ results: read() }),
      run: async () => {
        const statement = sqlite.prepare(query);
        return values.length === 0
          ? statement.run()
          : statement.run(parameters);
      },
    };
  };
  return {
    sqlite,
    repository: new PublicRouteCacheRepository({
      prepare: wrap,
    } as unknown as D1Database),
  };
}
function activate(sqlite: Database.Database, id = "p") {
  sqlite
    .prepare(
      `INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,
    rig_status,rig_version,rig_lease_token,rig_checkpoint_json)
    VALUES(?,'a',?,1,'قصيدة','{"content":["بيت"]}','unknown',7,'lease','{"keep":"paid"}')`
    )
    .run(id, id);
  sqlite
    .prepare(
      "UPDATE poem SET public_slug=?,public_slug_language='ar' WHERE id=?"
    )
    .run(`line-${id}`, id);
}
function epoch(sqlite: Database.Database): number {
  return sqlite
    .prepare("SELECT generation FROM author_index_cache")
    .pluck()
    .get() as number;
}
function retained(sqlite: Database.Database) {
  return sqlite
    .prepare(
      "SELECT id,author_id,slug,content_arabic,publication_json,source_hash,publication_hash,rig_status,rig_version,rig_lease_token,rig_checkpoint_json FROM poem ORDER BY id"
    )
    .all();
}

test.each([false, true])(
  "canonical activation captures nested dirty ownership with recursive triggers=%s",
  async (recursive) => {
    const { sqlite, repository } = fixture(recursive);
    activate(sqlite);
    const before = retained(sqlite);
    expect(
      sqlite
        .prepare(
          "SELECT publication_cache_dirty AS dirty,publication_cache_generation=public_route_cache_generation AS owned FROM poem"
        )
        .get()
    ).toEqual({ dirty: 1, owned: 1 });
    await repository.recordPurge(epoch(sqlite));
    await expect(repository.acknowledge()).resolves.toEqual({
      acknowledged: 1,
      pending: false,
    });
    expect(
      sqlite
        .prepare(
          "SELECT publication_cache_dirty AS dirty,public_route_cache_epoch AS epoch FROM poem"
        )
        .get()
    ).toEqual({ dirty: 0, epoch: 0 });
    expect(retained(sqlite)).toEqual(before);
    // The old publication wire still sees exactly its own RETURNING row; the
    // 0098 legacy-clear trigger rearms an unfenced clear without losing its write.
    expect(
      sqlite
        .prepare(
          "UPDATE poem SET publication_json='{}',publication_cache_dirty=1 WHERE id='p' RETURNING id"
        )
        .all()
    ).toEqual([{ id: "p" }]);
    sqlite.exec("UPDATE poem SET publication_cache_dirty=0");
    expect(
      sqlite.prepare("SELECT publication_cache_dirty FROM poem").pluck().get()
    ).toBe(1);
  }
);

test("a purge covers only its captured epoch and cannot consume a newer publication", async () => {
  const { sqlite, repository } = fixture();
  activate(sqlite, "old");
  const captured = epoch(sqlite);
  activate(sqlite, "late");
  sqlite.exec("UPDATE poem SET publication_cache_dirty=1 WHERE id='old'");
  const before = retained(sqlite);
  await repository.recordPurge(captured);
  await expect(repository.acknowledge()).resolves.toEqual({
    acknowledged: 0,
    pending: false,
  });
  expect(
    sqlite
      .prepare(
        "SELECT id,publication_cache_dirty AS dirty,public_route_cache_epoch>0 AS captured FROM poem ORDER BY id"
      )
      .all()
  ).toEqual([
    { id: "late", dirty: 1, captured: 1 },
    { id: "old", dirty: 1, captured: 0 },
  ]);
  expect(retained(sqlite)).toEqual(before);
  await repository.recordPurge(epoch(sqlite));
  await expect(repository.acknowledge()).resolves.toEqual({
    acknowledged: 1,
    pending: false,
  });
});

test("durable full-purge proof drains more than 1000 rows after bootstrap/index acknowledgement", async () => {
  const { sqlite, repository } = fixture();
  sqlite.transaction(() => {
    for (let i = 0; i < 2001; i += 1) activate(sqlite, String(i));
  })();
  const before = retained(sqlite);
  const captured = epoch(sqlite);
  await repository.recordPurge(captured);
  sqlite.exec(
    "UPDATE author_index_cache SET dirty=0,bootstrap_generation=NULL"
  );
  await expect(repository.acknowledge()).resolves.toEqual({
    acknowledged: 1000,
    pending: true,
  });
  await expect(repository.acknowledge()).resolves.toEqual({
    acknowledged: 1000,
    pending: true,
  });
  await expect(repository.acknowledge()).resolves.toEqual({
    acknowledged: 1,
    pending: false,
  });
  await repository.recordPurge(1);
  expect(
    sqlite
      .prepare("SELECT public_routes_purged_epoch FROM author_index_cache")
      .pluck()
      .get()
  ).toBe(captured);
  expect(
    sqlite
      .prepare(
        "SELECT count(*) FROM poem WHERE publication_cache_dirty<>0 OR public_route_cache_epoch<>0"
      )
      .pluck()
      .get()
  ).toBe(0);
  expect(retained(sqlite)).toEqual(before);
});

test("stale receipt prefixes are bounded and cannot starve later covered routes", async () => {
  const { sqlite, repository } = fixture();
  sqlite.transaction(() => {
    for (let i = 0; i < 1001; i += 1) activate(sqlite, String(i));
  })();
  sqlite.exec("UPDATE poem SET publication_cache_dirty=1 WHERE id<>'1000'");
  await repository.recordPurge(epoch(sqlite));
  await expect(repository.acknowledge()).resolves.toEqual({
    acknowledged: 0,
    pending: true,
  });
  await expect(repository.acknowledge()).resolves.toEqual({
    acknowledged: 1,
    pending: false,
  });
  expect(
    sqlite
      .prepare("SELECT count(*) FROM poem WHERE publication_cache_dirty=1")
      .pluck()
      .get()
  ).toBe(1000);
  const plan = sqlite
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM poem INDEXED BY poem_public_route_cache_pending WHERE public_route_cache_epoch>0 AND public_route_cache_epoch<=? ORDER BY public_route_cache_epoch,id LIMIT 1000"
    )
    .all(epoch(sqlite));
  expect(JSON.stringify(plan)).toContain(
    "COVERING INDEX poem_public_route_cache_pending"
  );
  expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
});

test("status retains author-route bootstrap work independently of poem receipts", async () => {
  const { sqlite, repository } = fixture();
  sqlite.exec(
    "UPDATE author_index_cache SET bootstrap_generation=NULL,dirty=0"
  );
  await expect(repository.status()).resolves.toEqual({
    pending: 0,
    purgedEpoch: 0,
  });
  sqlite.exec(`INSERT INTO public_author_segment(segment,namespace_id) SELECT 'fixture',id FROM public_author_namespace WHERE author_id='a';
    UPDATE public_author_namespace SET canonical_slug='fixture' WHERE author_id='a'`);
  await expect(repository.status()).resolves.toEqual({
    pending: 1,
    purgedEpoch: 0,
  });
  await repository.recordPurge(epoch(sqlite));
  await expect(repository.acknowledge()).resolves.toEqual({
    acknowledged: 0,
    pending: false,
  });
  const retainedStatus = await repository.status();
  expect(retainedStatus.pending).toBe(1);
  sqlite.exec("UPDATE author_index_cache SET bootstrap_generation=NULL");
  const completeStatus = await repository.status();
  expect(completeStatus.pending).toBe(0);
});
