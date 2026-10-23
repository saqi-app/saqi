import { readFileSync } from "node:fs";

import type { D1Database } from "@cloudflare/workers-types";
import { PublicCachePurgeRequestSchema } from "@saqi/precedent-iso";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";

import {
  bootstrapDirtyPublicCache,
  purgeDirtyPublicCache,
} from "./author-index-cache";
import { AuthorIndexCacheRepository } from "./author-index-cache-repository";
import { parseCloudflareEnv } from "./parse-cloudflare-env";
import { PublicRouteCacheRepository } from "./public-route-cache-repository";
import { RigPublicationRepository } from "./rig-publication-repository";

type PurgeFetch = (url: string, init: { body: string }) => Promise<Response>;

const DATABASES: Database.Database[] = [];
afterEach(() => {
  for (const database of DATABASES) database.close();
  DATABASES.length = 0;
  vi.restoreAllMocks();
});

async function pendingCache(repository: AuthorIndexCacheRepository) {
  const pending = await repository.pending();
  if (!pending) throw new Error("Expected a durable author-index invalidation");
  return pending;
}

function parsePurgePayload(body: string) {
  return PublicCachePurgeRequestSchema.parse(JSON.parse(body));
}

function fixture(bootstrap = false) {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const sqlite = new Database(":memory:");
  DATABASES.push(sqlite);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(
    readFileSync(
      new URL("../../migrations/0001_schema.sql", import.meta.url),
      "utf8"
    )
  );
  sqlite.exec(
    "INSERT INTO author(id,slug,name_arabic) VALUES('a','poet','شاعر')"
  );
  if (!bootstrap)
    sqlite
      .prepare(
        "UPDATE author_index_cache SET dirty=0, bootstrap_generation=NULL"
      )
      .run();
  const wrap = (sql: string, values: unknown[] = []) => {
    const parameters = Object.fromEntries(
      values.map((value, index) => [String(index + 1), value])
    );
    const execute = () => {
      const statement = sqlite.prepare(sql);
      const before = sqlite
        .prepare("SELECT total_changes()")
        .pluck()
        .get() as number;
      if (values.length === 0) statement.run();
      else statement.run(parameters);
      const after = sqlite
        .prepare("SELECT total_changes()")
        .pluck()
        .get() as number;
      return { success: true, results: [], meta: { changes: after - before } };
    };
    return {
      bind: (...bound: unknown[]) => wrap(sql, bound),
      first: async () => {
        const statement = sqlite.prepare(sql);
        return (
          (values.length === 0 ? statement.get() : statement.get(parameters)) ??
          null
        );
      },
      all: async () => {
        const statement = sqlite.prepare(sql);
        return {
          success: true,
          results:
            values.length === 0 ? statement.all() : statement.all(parameters),
        };
      },
      run: async () => execute(),
      execute,
    };
  };
  const database = {
    prepare: wrap,
    batch: async (statements: ReturnType<typeof wrap>[]) =>
      sqlite.transaction(() =>
        statements.map((statement) => statement.execute())
      )(),
  } as unknown as D1Database;
  const fetch = vi
    .fn<PurgeFetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  const env = parseCloudflareEnv({
    DB: database,
    PUBLIC_SITE: { fetch },
    SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
    SAQI_PUBLIC_ORIGIN: "https://saqi.app",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  return {
    sqlite,
    fetch,
    env,
    repository: new AuthorIndexCacheRepository(database),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test("poem inserts dirty their author pages and homepage before translation", async () => {
  const { sqlite, repository } = fixture();
  await expect(repository.pending()).resolves.toBeNull();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  expect(
    sqlite.prepare("SELECT publication_cache_dirty AS dirty FROM poem").get()
  ).toEqual({ dirty: 1 });
  const pending = await pendingCache(repository);
  expect(pending.bootstrapGeneration).toBeNull();
  await repository.acknowledge(pending);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  sqlite
    .prepare("UPDATE poem SET publication_json='{}', rig_checkpoint_json='{}'")
    .run();
  await expect(repository.pending()).resolves.toBeNull();
});

test("an empty author does not change the homepage, while first and additional poems do", async () => {
  const { sqlite, repository } = fixture();
  sqlite
    .prepare(
      "INSERT INTO author(id,slug,name_arabic,name,sort_name_arabic) VALUES ('b','other','آخر',NULL,'آخر')"
    )
    .run();
  sqlite.prepare("UPDATE author SET name_arabic='مصحح' WHERE id='b'").run();
  await expect(repository.pending()).resolves.toBeNull();
  for (const id of ["p", "q"]) {
    sqlite
      .prepare(
        "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES (?,lower(hex(randomblob(16))),1,'قصيدة',json_object('content',json_array('بيت')),'b')"
      )
      .run(id);
    const pending = await pendingCache(repository);
    await repository.acknowledge(pending);
  }
});

test("a stale acknowledgement cannot clear a name changing A to B to A", async () => {
  const { sqlite, repository } = fixture();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  const old = await pendingCache(repository);
  sqlite.prepare("UPDATE author SET name_arabic='مصحح' WHERE id='a'").run();
  sqlite.prepare("UPDATE author SET name_arabic='شاعر' WHERE id='a'").run();
  await expect(repository.acknowledge(old)).resolves.toBe(false);
  const current = await pendingCache(repository);
  expect(current.generation).toBeGreaterThan(old.generation);
});

test("failed source transactions roll back their outbox writes", async () => {
  const { sqlite, repository } = fixture();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  await repository.acknowledge(await pendingCache(repository));
  sqlite.exec("BEGIN; UPDATE author SET name_arabic='مصحح'; ROLLBACK;");
  await expect(repository.pending()).resolves.toBeNull();
});

test.each(["English name", "slug", "sort key"])(
  "public author presentation changes retain durable invalidation: %s",
  async (field) => {
    const { sqlite, repository } = fixture();
    sqlite
      .prepare(
        "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
      )
      .run();
    await repository.acknowledge(await pendingCache(repository));
    if (field === "English name")
      sqlite
        .prepare("UPDATE author SET name='Corrected English' WHERE id='a'")
        .run();
    else if (field === "slug")
      sqlite.prepare("UPDATE author SET slug='moved-poet' WHERE id='a'").run();
    else
      sqlite
        .prepare(
          "UPDATE author SET sort_name_arabic='corrected-sort' WHERE id='a'"
        )
        .run();
    const pending = await pendingCache(repository);
    expect(pending.bootstrapGeneration).toBe(
      field === "slug" ? pending.generation : null
    );
  }
);

test.each([
  {
    change: "delete",
    mutate: (database: Database.Database) =>
      database.prepare("DELETE FROM poem WHERE id='p'").run(),
    removed: true,
  },
  {
    change: "move",
    mutate: (database: Database.Database) =>
      database.prepare("UPDATE poem SET author_id='b' WHERE id='p'").run(),
    removed: false,
  },
  {
    change: "poem identity",
    mutate: (database: Database.Database) =>
      database.prepare("UPDATE poem SET id='repaired-poem' WHERE id='p'").run(),
    removed: false,
  },
  {
    change: "author delete",
    mutate: (database: Database.Database) =>
      database.prepare("DELETE FROM author WHERE id='a'").run(),
    removed: false,
  },
  {
    change: "author slug",
    mutate: (database: Database.Database) =>
      database
        .prepare("UPDATE author SET slug='repaired-slug' WHERE id='a'")
        .run(),
    removed: false,
  },
  {
    change: "author identity",
    mutate: (database: Database.Database) =>
      database.exec(
        "BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE author SET id='repaired-author' WHERE id='a'; UPDATE poem SET author_id='repaired-author' WHERE id='p'; COMMIT;"
      ),
    removed: false,
  },
])(
  "destructive $change changes retain a budgeted full-corpus purge after their old routes disappear",
  async ({ mutate, removed }) => {
    const { sqlite, repository, env, fetch, advance } = fixture();
    sqlite
      .prepare(
        "INSERT INTO author(id,slug,name_arabic,name,sort_name_arabic) VALUES ('b','other','آخر',NULL,'آخر')"
      )
      .run();
    const publication = '{"paid":"published output"}';
    const checkpoint = '{"paid":"saved invocation"}';
    sqlite
      .prepare(
        "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id,publication_json,rig_checkpoint_json,source_hash,publication_hash) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a',?,?,?,?)"
      )
      .run(publication, checkpoint, "source", "publication");
    await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
    const saved = sqlite
      .prepare(
        "SELECT publication_json AS publicationJson, rig_checkpoint_json AS checkpointJson, source_hash AS sourceHash, publication_hash AS publicationHash FROM poem"
      )
      .get();
    mutate(sqlite);
    const pending = await pendingCache(repository);
    expect(pending.bootstrapGeneration).toBe(pending.generation);
    await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
    expect(fetch).toHaveBeenCalledOnce();
    await expect(repository.pending()).resolves.toEqual(pending);
    advance(15_000);
    await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
    expect(parsePurgePayload(fetch.mock.calls.at(1)?.[1].body ?? "")).toEqual({
      authorIndex: true,
      bootstrap: true,
    });
    await expect(repository.pending()).resolves.toBeNull();
    expect(
      sqlite
        .prepare(
          "SELECT publication_json AS publicationJson, rig_checkpoint_json AS checkpointJson, source_hash AS sourceHash, publication_hash AS publicationHash FROM poem"
        )
        .get()
    ).toEqual(removed ? undefined : saved);
  }
);

test("unchanged poem and author identities do not request another purge", async () => {
  const { sqlite, repository, env, fetch } = fixture();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  await purgeDirtyPublicCache(env);
  sqlite
    .prepare("UPDATE poem SET id=id, author_id=author_id WHERE id='p'")
    .run();
  sqlite.prepare("UPDATE author SET id=id, slug=slug WHERE id='a'").run();
  await expect(repository.pending()).resolves.toBeNull();
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("empty");
  expect(fetch).toHaveBeenCalledOnce();
});

test("an older targeted purge cannot consume a later deletion's full-corpus epoch", async () => {
  const { sqlite, repository, env, fetch, advance } = fixture();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  fetch.mockImplementationOnce(async () => {
    sqlite.prepare("DELETE FROM poem WHERE id='p'").run();
    return new Response(null, { status: 204 });
  });
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
  const pending = await pendingCache(repository);
  expect(pending.bootstrapGeneration).toBe(pending.generation);
  advance(15_000);
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
  expect(parsePurgePayload(fetch.mock.calls.at(1)?.[1].body ?? "")).toEqual({
    authorIndex: true,
    bootstrap: true,
  });
});

test("a newer destructive epoch survives an in-flight full-corpus acknowledgement", async () => {
  const { sqlite, repository, env, fetch, advance } = fixture();
  sqlite
    .prepare(
      "INSERT INTO author(id,slug,name_arabic,name,sort_name_arabic) VALUES ('b','other','آخر',NULL,'آخر')"
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  await purgeDirtyPublicCache(env);
  sqlite.prepare("UPDATE poem SET author_id='b' WHERE id='p'").run();
  const captured = await pendingCache(repository);
  advance(15_000);
  fetch.mockImplementationOnce(async () => {
    sqlite.prepare("UPDATE poem SET author_id='a' WHERE id='p'").run();
    return new Response(null, { status: 204 });
  });
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
  const pending = await pendingCache(repository);
  expect(pending.generation).toBeGreaterThan(captured.generation);
  expect(pending.bootstrapGeneration).toBe(pending.generation);
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
  expect(fetch).toHaveBeenCalledTimes(2);
  advance(15_000);
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
  expect(
    fetch.mock.calls.slice(1).map((call) => parsePurgePayload(call[1].body))
  ).toEqual([
    { authorIndex: true, bootstrap: true },
    { authorIndex: true, bootstrap: true },
  ]);
});

test("a failed destructive purge retains its full epoch and consumes the shared slot", async () => {
  const { sqlite, repository, env, fetch, advance } = fixture();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  await purgeDirtyPublicCache(env);
  sqlite.prepare("DELETE FROM poem WHERE id='p'").run();
  const pending = await pendingCache(repository);
  advance(15_000);
  fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(purgeDirtyPublicCache(env)).rejects.toThrow(
    "PUBLIC_CACHE_PURGE_REJECTED"
  );
  await expect(repository.pending()).resolves.toEqual(pending);
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
  expect(fetch).toHaveBeenCalledTimes(2);
  advance(15_000);
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
  await expect(repository.pending()).resolves.toBeNull();
});

test("deferred identity repair invalidates the homepage before child ownership is repaired", async () => {
  const { sqlite, repository } = fixture();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  await repository.acknowledge(await pendingCache(repository));
  sqlite.exec(
    "BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE author SET id='repaired-author' WHERE id='a';"
  );
  await expect(repository.pending()).resolves.not.toBeNull();
  sqlite.exec(
    "UPDATE poem SET author_id='repaired-author' WHERE id='p'; COMMIT;"
  );
});

test("bootstrap remains durable when an older public Worker rejects its new contract", async () => {
  const { repository, env, fetch, advance } = fixture(true);
  fetch.mockResolvedValue(new Response(null, { status: 400 }));
  await expect(purgeDirtyPublicCache(env)).rejects.toThrow(
    "PUBLIC_CACHE_PURGE_REJECTED"
  );
  const rejected = await pendingCache(repository);
  expect(rejected.bootstrapGeneration).toBe(1);
  fetch.mockResolvedValue(new Response(null, { status: 204 }));
  advance(15_000);
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
  await expect(repository.pending()).resolves.toBeNull();
  expect(parsePurgePayload(fetch.mock.calls.at(1)?.[1].body ?? "")).toEqual({
    authorIndex: true,
    bootstrap: true,
  });
});

test("a concurrent mutation stays dirty after bootstrap and retries only targeted content tags", async () => {
  const { sqlite, repository, env, fetch, advance } = fixture(true);
  fetch.mockImplementationOnce(async () => {
    sqlite
      .prepare(
        "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
      )
      .run();
    return new Response(null, { status: 204 });
  });
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
  const concurrent = await pendingCache(repository);
  expect(concurrent.bootstrapGeneration).toBeNull();
  expect(
    sqlite.prepare("SELECT publication_cache_dirty AS dirty FROM poem").get()
  ).toEqual({ dirty: 1 });
  advance(15_000);
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
  expect(
    fetch.mock.calls.map((call) => parsePurgePayload(call[1].body))
  ).toEqual([
    { authorIndex: true, bootstrap: true },
    { authorIndex: true, poems: [{ authorSlug: "poet", poemId: "p" }] },
  ]);
});

test.each([false, true])(
  "an older acknowledgement cannot consume a newer deployment epoch (old bootstrap %s)",
  async (bootstrap) => {
    const { sqlite, repository } = fixture(bootstrap);
    if (!bootstrap)
      sqlite
        .prepare(
          "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
        )
        .run();
    const old = await pendingCache(repository);
    await repository.requestBootstrap();
    const requested = await pendingCache(repository);
    expect(requested.generation).toBeGreaterThan(old.generation);
    expect(requested.bootstrapGeneration).toBe(requested.generation);
    await expect(repository.acknowledge(old)).resolves.toBe(false);
    await expect(repository.pending()).resolves.toEqual(requested);
  }
);

test("a public rollback followed by deployment explicitly bootstraps previously untagged homepage objects", async () => {
  const { sqlite, repository, env, fetch, advance } = fixture(true);
  await purgeDirtyPublicCache(env);
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  fetch.mockResolvedValue(new Response(null, { status: 400 }));
  advance(15_000);
  await expect(purgeDirtyPublicCache(env)).rejects.toThrow(
    "PUBLIC_CACHE_PURGE_REJECTED"
  );
  const rejected = await pendingCache(repository);
  expect(rejected.bootstrapGeneration).toBeNull();
  fetch.mockResolvedValue(new Response(null, { status: 204 }));
  await expect(bootstrapDirtyPublicCache(env)).resolves.toBe("purged");
  expect(
    fetch.mock.calls.map((call) => parsePurgePayload(call[1].body))
  ).toEqual([
    { authorIndex: true, bootstrap: true },
    { authorIndex: true, poems: [{ authorSlug: "poet", poemId: "p" }] },
    { authorIndex: true, bootstrap: true },
  ]);
});

test("clean state skips the network and disabled purging preserves durable work", async () => {
  const { sqlite, repository, env, fetch } = fixture();
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("empty");
  expect(fetch).not.toHaveBeenCalled();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  await expect(
    purgeDirtyPublicCache({
      ...env,
      PUBLIC_SITE: undefined,
      SAQI_PUBLIC_CACHE_PURGE_SECRET: undefined,
    })
  ).resolves.toBe("disabled");
  await expect(repository.pending()).resolves.not.toBeNull();
});

test("a successful purge with a failed durable acknowledgement retains its bootstrap checkpoint", async () => {
  const { repository, env, fetch } = fixture(true);
  const acknowledge = vi
    .spyOn(AuthorIndexCacheRepository.prototype, "acknowledge")
    .mockRejectedValue(new Error("D1_UNAVAILABLE"));
  try {
    await expect(purgeDirtyPublicCache(env)).rejects.toThrow("D1_UNAVAILABLE");
    expect(fetch).toHaveBeenCalledOnce();
    const retained = await pendingCache(repository);
    expect(retained.bootstrapGeneration).toBe(1);
  } finally {
    acknowledge.mockRestore();
  }
});

test("isolates reserve one durable purge slot and retry only at the shared deadline", async () => {
  const { repository, advance } = fixture();
  const reservations = await Promise.all(
    Array.from({ length: 8 }, () => repository.reservePurge())
  );
  expect(reservations.filter(Boolean)).toHaveLength(1);
  advance(14_999);
  await expect(repository.reservePurge()).resolves.toBe(false);
  advance(1);
  await expect(repository.reservePurge()).resolves.toBe(true);
});

test.each(["http", "network"])(
  "failed or unknown %s purges consume their slot and preserve both queues",
  async (failure) => {
    const { sqlite, repository, env, fetch, advance } = fixture();
    sqlite
      .prepare(
        "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
      )
      .run();
    if (failure === "http")
      fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    else fetch.mockRejectedValueOnce(new Error("FETCH_UNAVAILABLE"));
    await expect(purgeDirtyPublicCache(env)).rejects.toThrow();
    await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
    expect(fetch).toHaveBeenCalledOnce();
    await expect(repository.pending()).resolves.not.toBeNull();
    expect(
      sqlite.prepare("SELECT publication_cache_dirty AS dirty FROM poem").get()
    ).toEqual({ dirty: 1 });
    advance(14_999);
    await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
    advance(1);
    await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);

test("coalesces forty-nine poems and the index while retaining the fiftieth poem for the next slot", async () => {
  const { sqlite, repository, env, fetch, advance } = fixture();
  const insertAuthor = sqlite.prepare(
    "INSERT INTO author(id,slug,name_arabic,name,sort_name_arabic) VALUES (?,?,?,NULL,?)"
  );
  const insertPoem = sqlite.prepare(
    "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES (?,lower(hex(randomblob(16))),1,'قصيدة',json_object('content',json_array('بيت')),?)"
  );
  for (let index = 0; index < 50; index += 1) {
    const suffix = String(index).padStart(2, "0");
    insertAuthor.run(`a-${suffix}`, `poet-${suffix}`, "شاعر", "شاعر");
    insertPoem.run(`p-${suffix}`, `a-${suffix}`);
  }
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
  expect(fetch).toHaveBeenCalledOnce();
  const body = parsePurgePayload(fetch.mock.calls.at(0)?.[1].body ?? "");
  expect(body).toEqual({
    authorIndex: true,
    poems: Array.from({ length: 49 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return { authorSlug: `poet-${suffix}`, poemId: `p-${suffix}` };
    }),
  });
  await expect(repository.pending()).resolves.toBeNull();
  expect(
    sqlite.prepare("SELECT id FROM poem WHERE publication_cache_dirty=1").all()
  ).toEqual([{ id: "p-49" }]);
  advance(15_000);
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
  expect(parsePurgePayload(fetch.mock.calls.at(1)?.[1].body ?? "")).toEqual({
    poems: [{ authorSlug: "poet-49", poemId: "p-49" }],
  });
});

test("one purge retains raced author-generation and source-hash acknowledgements independently", async () => {
  const { sqlite, repository, env, fetch, advance } = fixture();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  fetch.mockImplementationOnce(async () => {
    sqlite.prepare("UPDATE author SET name_arabic='مصحح' WHERE id='a'").run();
    sqlite.prepare("UPDATE poem SET source_hash='changed' WHERE id='p'").run();
    return new Response(null, { status: 204 });
  });
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
  await expect(repository.pending()).resolves.not.toBeNull();
  expect(
    sqlite.prepare("SELECT publication_cache_dirty AS dirty FROM poem").get()
  ).toEqual({ dirty: 1 });
  advance(15_000);
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
});

test.each(["index", "poems"])(
  "a failed %s acknowledgement does not lose the other queue's successful acknowledgement",
  async (queue) => {
    const { sqlite, repository, env, fetch, advance } = fixture();
    sqlite
      .prepare(
        "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
      )
      .run();
    const failure =
      queue === "index"
        ? vi
            .spyOn(AuthorIndexCacheRepository.prototype, "acknowledge")
            .mockRejectedValue(new Error("D1_UNAVAILABLE"))
        : vi
            .spyOn(RigPublicationRepository.prototype, "clearCacheDirtyBatch")
            .mockRejectedValue(new Error("D1_UNAVAILABLE"));
    await expect(purgeDirtyPublicCache(env)).rejects.toThrow("D1_UNAVAILABLE");
    failure.mockRestore();
    expect(fetch).toHaveBeenCalledOnce();
    const pending = await repository.pending();
    expect(pending !== null).toBe(queue === "index");
    expect(
      sqlite.prepare("SELECT publication_cache_dirty AS dirty FROM poem").get()
    ).toEqual({ dirty: queue === "poems" ? 1 : 0 });
    advance(15_000);
    await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
  }
);

test("deployment bootstrap bypasses a normal slot without resetting its deadline", async () => {
  const { sqlite, repository, env, fetch } = fixture();
  sqlite
    .prepare(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    )
    .run();
  await expect(repository.reservePurge(0)).resolves.toBe(true);
  await expect(bootstrapDirtyPublicCache(env)).resolves.toBe("purged");
  expect(parsePurgePayload(fetch.mock.calls.at(0)?.[1].body ?? "")).toEqual({
    authorIndex: true,
    bootstrap: true,
  });
  await expect(repository.reservePurge(14_999)).resolves.toBe(false);
  await expect(repository.reservePurge(15_000)).resolves.toBe(true);
});

test("only a successful full-corpus purge records route coverage", async () => {
  const { sqlite, env, fetch, advance } = fixture();
  sqlite.exec(
    "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a'); UPDATE poem SET public_slug='first-line' WHERE id='p'"
  );
  const proof = () =>
    sqlite
      .prepare("SELECT public_routes_purged_epoch FROM author_index_cache")
      .pluck()
      .get();
  await expect(
    purgeDirtyPublicCache({
      ...env,
      PUBLIC_SITE: undefined,
      SAQI_PUBLIC_CACHE_PURGE_SECRET: undefined,
    })
  ).resolves.toBe("disabled");
  expect(proof()).toBe(0);
  await purgeDirtyPublicCache(env);
  expect(proof()).toBe(0);
  advance(15000);
  fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(bootstrapDirtyPublicCache(env)).rejects.toThrow(
    "PUBLIC_CACHE_PURGE_REJECTED"
  );
  expect(proof()).toBe(0);
  const captured = await pendingCache(new AuthorIndexCacheRepository(env.DB));
  await bootstrapDirtyPublicCache(env);
  expect(proof()).toBeGreaterThan(captured.generation);
});

test("a successful full purge proves its captured generation rather than a concurrent activation", async () => {
  const { sqlite, env, fetch, repository } = fixture(true);
  sqlite.exec(
    "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a'); UPDATE poem SET public_slug='first-line' WHERE id='p'"
  );
  const captured = await pendingCache(repository);
  fetch.mockImplementationOnce(async () => {
    sqlite.exec(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('q','q',1,'قصيدة',json_object('content',json_array('بيت')),'a'); UPDATE poem SET public_slug='later-line' WHERE id='q'"
    );
    return new Response(null, { status: 204 });
  });
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("pending");
  expect(
    sqlite
      .prepare("SELECT public_routes_purged_epoch FROM author_index_cache")
      .pluck()
      .get()
  ).toBe(captured.generation);
  expect(
    sqlite
      .prepare(
        "SELECT id,publication_cache_dirty AS dirty,public_route_cache_epoch>0 AS receipt FROM poem ORDER BY id"
      )
      .all()
  ).toEqual([
    { id: "p", dirty: 0, receipt: 0 },
    { id: "q", dirty: 1, receipt: 1 },
  ]);
});

test("normal maintenance drains retained full-purge proof after the index is clean", async () => {
  const { sqlite, env, fetch, repository } = fixture();
  const insert = sqlite.prepare(
    "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES (?,lower(hex(randomblob(16))),1,'قصيدة',json_object('content',json_array('بيت')),'a')"
  );
  const activate = sqlite.prepare("UPDATE poem SET public_slug=? WHERE id=?");
  sqlite.transaction(() => {
    for (let i = 0; i < 1101; i += 1) {
      const id = String(i);
      insert.run(id);
      activate.run(`line-${id}`, id);
    }
  })();
  await expect(bootstrapDirtyPublicCache(env)).resolves.toBe("pending");
  await expect(repository.pending()).resolves.toBeNull();
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("purged");
  await expect(purgeDirtyPublicCache(env)).resolves.toBe("empty");
  expect(fetch).toHaveBeenCalledOnce();
  expect(
    sqlite
      .prepare(
        "SELECT count(*) FROM poem WHERE publication_cache_dirty=1 OR public_route_cache_epoch>0"
      )
      .pluck()
      .get()
  ).toBe(0);
});

test.each(["acknowledge", "recordPurge"] as const)(
  "route %s failure cannot skip successful existing queue maintenance",
  async (method) => {
    const { sqlite, env, fetch, repository } = fixture(true);
    sqlite.exec(
      "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,author_id) VALUES ('p','p',1,'قصيدة',json_object('content',json_array('بيت')),'a')"
    );
    vi.spyOn(PublicRouteCacheRepository.prototype, method).mockRejectedValue(
      new Error("ROUTE_METADATA_UNAVAILABLE")
    );
    await expect(purgeDirtyPublicCache(env)).rejects.toThrow(
      "ROUTE_METADATA_UNAVAILABLE"
    );
    expect(fetch).toHaveBeenCalledOnce();
    await expect(repository.pending()).resolves.toBeNull();
    expect(
      sqlite.prepare("SELECT publication_cache_dirty FROM poem").pluck().get()
    ).toBe(0);
  }
);
