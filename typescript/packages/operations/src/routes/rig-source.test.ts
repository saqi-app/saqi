import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { AuthorIndexCacheRepository } from "../lib/author-index-cache-repository";
import { DirectSourceRepository } from "../lib/direct-source-repository";
import { parseCloudflareEnv } from "../lib/parse-cloudflare-env";
import { PublicRouteCacheRepository } from "../lib/public-route-cache-repository";
import { RigPublicationRepository } from "../lib/rig-publication-repository";
import { PoemIdSchema, RigStateRepository } from "../lib/rig-state-repository";
import { get, post } from "./rig-source";
import { post as postRigState } from "./rig-state";

beforeEach(() => {
  vi.spyOn(
    PublicRouteCacheRepository.prototype,
    "acknowledge"
  ).mockResolvedValue({ acknowledged: 0, pending: false });
  vi.spyOn(
    PublicRouteCacheRepository.prototype,
    "recordPurge"
  ).mockResolvedValue();
  vi.spyOn(AuthorIndexCacheRepository.prototype, "pending").mockResolvedValue(
    null
  );
  vi.spyOn(
    AuthorIndexCacheRepository.prototype,
    "reservePurge"
  ).mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function sourceRequest(body: unknown) {
  return new Request("https://ops.saqi.app/api/rig/source", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "ops.saqi.app",
      origin: "https://ops.saqi.app",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    },
    body: JSON.stringify(body),
  });
}

test.each([204, 503])(
  "created Arabic poems coalesce both cache queues without failing their source mutation (HTTP %s)",
  async (status) => {
    const upsert = vi
      .spyOn(DirectSourceRepository.prototype, "upsertPoem")
      .mockResolvedValue({
        id: "p",
        sourceHash: "a".repeat(64),
        status: "created",
      });
    const poem = vi
      .spyOn(RigPublicationRepository.prototype, "pendingPurge")
      .mockResolvedValue({
        poemId: PoemIdSchema.parse("p"),
        authorSlug: "poet",
        authorName: "شاعر",
        cacheGeneration: 1,
        sourceHash: "a".repeat(64),
        publicationHash: null,
      });
    const clear = vi
      .spyOn(RigPublicationRepository.prototype, "clearCacheDirty")
      .mockResolvedValue(true);
    const index = vi
      .spyOn(AuthorIndexCacheRepository.prototype, "pending")
      .mockResolvedValue({ generation: 4, bootstrapGeneration: null });
    const acknowledge = vi
      .spyOn(AuthorIndexCacheRepository.prototype, "acknowledge")
      .mockResolvedValue(true);
    const fetch = vi.fn().mockImplementation(
      async (_url: string, init: { body: string }) =>
        new Response(null, {
          status: "authorIndex" in JSON.parse(init.body) ? status : 204,
        })
    );
    try {
      const response = await post(
        sourceRequest({
          action: "upsert-poem",
          poem: {
            sourceAuthorId: "poet",
            sourcePoemId: "123",
            sourceUrl: "https://poetry.example/poem123.html",
            titleArabic: "قصيدة",
            linesArabic: ["بيت"],
            expectedHash: null,
          },
        }),
        parseCloudflareEnv({
          DB: { prepare: vi.fn() },
          PUBLIC_SITE: { fetch },
          SAQI_DIRECT_SOURCE_ACTIVE: "1",
          SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
          SAQI_PUBLIC_ORIGIN: "https://saqi.app",
          SAQI_SOURCE_NAME: "fixture",
          SAQI_SOURCE_BASE_URL: "https://poetry.example",
        })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        result: { status: "created" },
        cachePending: status !== 204,
      });
      expect({
        cleared: clear.mock.calls.length,
        indexAcknowledged: acknowledge.mock.calls.length,
        requests: fetch.mock.calls.length,
      }).toEqual({
        cleared: status === 204 ? 1 : 0,
        indexAcknowledged: status === 204 ? 1 : 0,
        requests: 1,
      });
    } finally {
      upsert.mockRestore();
      poem.mockRestore();
      clear.mockRestore();
      index.mockRestore();
      acknowledge.mockRestore();
    }
  }
);

test("a failed cache acknowledgement preserves the successful source update and reports pending work", async () => {
  const upsert = vi
    .spyOn(DirectSourceRepository.prototype, "upsertPoem")
    .mockResolvedValue({
      id: "p",
      sourceHash: "a".repeat(64),
      status: "updated",
    });
  const pending = vi
    .spyOn(RigPublicationRepository.prototype, "pendingPurge")
    .mockResolvedValue({
      poemId: PoemIdSchema.parse("p"),
      authorSlug: "poet",
      authorName: "شاعر",
      cacheGeneration: 1,
      sourceHash: "a".repeat(64),
      publicationHash: null,
    });
  const clear = vi
    .spyOn(RigPublicationRepository.prototype, "clearCacheDirty")
    .mockRejectedValue(new Error("D1_UNAVAILABLE"));
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  try {
    const response = await post(
      sourceRequest({
        action: "upsert-poem",
        poem: {
          sourceAuthorId: "poet",
          sourcePoemId: "123",
          sourceUrl: "https://poetry.example/poem123.html",
          titleArabic: "قصيدة",
          linesArabic: ["بيت"],
          expectedHash: null,
        },
      }),
      parseCloudflareEnv({
        DB: { prepare: vi.fn() },
        PUBLIC_SITE: { fetch },
        SAQI_DIRECT_SOURCE_ACTIVE: "1",
        SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
        SAQI_PUBLIC_ORIGIN: "https://saqi.app",
        SAQI_SOURCE_NAME: "fixture",
        SAQI_SOURCE_BASE_URL: "https://poetry.example",
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cachePending: true,
      result: { id: "p", status: "updated" },
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  } finally {
    upsert.mockRestore();
    pending.mockRestore();
    clear.mockRestore();
  }
});

test.each([false, true])(
  "author update propagates its atomic cache state (%s)",
  async (cachePending) => {
    const upsert = vi
      .spyOn(DirectSourceRepository.prototype, "upsertAuthor")
      .mockResolvedValue({ id: "a", status: "updated", cachePending });
    try {
      const response = await post(
        sourceRequest({
          action: "upsert-author",
          author: {
            sourceAuthorId: "poet",
            sourceUrl: "https://poetry.example/cat-poet",
            nameArabic: "شاعر",
          },
        }),
        parseCloudflareEnv({
          DB: { prepare: vi.fn() },
          SAQI_DIRECT_SOURCE_ACTIVE: "1",
          SAQI_SOURCE_NAME: "fixture",
          SAQI_SOURCE_BASE_URL: "https://poetry.example",
        })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        cachePending,
      });
    } finally {
      upsert.mockRestore();
    }
  }
);

test("fresh requests honor a durable source deadline across authors until it expires", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE author(id TEXT PRIMARY KEY, source_author_id TEXT,
      source_url TEXT, name_arabic TEXT, source_retry_after INTEGER);
    INSERT INTO author VALUES ('a', 'a', NULL, 'شاعر', 2000000000);
    INSERT INTO author VALUES ('b', 'b', 'https://poetry.example/cat-b', 'شاعر', NULL);
  `);
  const wrap = (sql: string, values: unknown[] = []) => ({
    bind: (...parameters: unknown[]) => wrap(sql, parameters),
    first: async () =>
      sqlite
        .prepare(sql)
        .get(
          Object.fromEntries(
            values.map((value, index) => [String(index + 1), value])
          )
        ) ?? null,
  });
  const env = parseCloudflareEnv({
    DB: { prepare: wrap },
    SAQI_DIRECT_SOURCE_ACTIVE: "1",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(1999999900000);
  try {
    const blocked = await get(
      new Request("https://ops.saqi.app/api/rig/source?action=next-author"),
      env
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("100");
    await expect(blocked.json()).resolves.toMatchObject({
      code: "SOURCE_COOLDOWN",
    });
    const manual = await get(
      new Request("https://ops.saqi.app/api/rig/source?action=origin"),
      env
    );
    expect(manual.status).toBe(429);
    now.mockReturnValue(2000000000000);
    const resumed = await get(
      new Request("https://ops.saqi.app/api/rig/source?action=next-author"),
      env
    );
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({
      author: { id: "b" },
    });
  } finally {
    now.mockRestore();
    sqlite.close();
  }
});

test("manifest reconciliation has an authenticated bounded batch contract", async () => {
  const read = vi
    .spyOn(DirectSourceRepository.prototype, "existingPoemIds")
    .mockResolvedValue(["1"]);
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    SAQI_DIRECT_SOURCE_ACTIVE: "1",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  const request = (poemIds: string[], trusted = true) =>
    new Request("https://ops.saqi.app/api/rig/source", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "ops.saqi.app",
        origin: trusted ? "https://ops.saqi.app" : "https://other.example",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      },
      body: JSON.stringify({
        action: "reconcile-manifest",
        sourceAuthorId: "poet-Test",
        poemIds,
      }),
    });
  try {
    const response = await post(request(["1", "2"]), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      existingPoemIds: ["1"],
    });
    expect(read).toHaveBeenCalledWith({
      sourceAuthorId: "poet-Test",
      poemIds: ["1", "2"],
    });
    const oversized = await post(
      request(Array.from({ length: 201 }, (_, index) => String(index + 1))),
      env
    );
    expect(oversized.status).toBe(400);
    const untrusted = await post(request(["1"], false), env);
    expect(untrusted.status).toBe(403);
    expect(read).toHaveBeenCalledOnce();
  } finally {
    read.mockRestore();
  }
});

test("source and publication share one slot while both durable mutations remain successful", async () => {
  const upsert = vi
    .spyOn(DirectSourceRepository.prototype, "upsertPoem")
    .mockResolvedValue({
      id: "p",
      sourceHash: "a".repeat(64),
      status: "updated",
    });
  const publish = vi
    .spyOn(RigPublicationRepository.prototype, "publish")
    .mockResolvedValue(true);
  vi.spyOn(
    RigPublicationRepository.prototype,
    "pendingPurge"
  ).mockResolvedValue({
    poemId: PoemIdSchema.parse("p"),
    authorSlug: "poet",
    authorName: "شاعر",
    cacheGeneration: 1,
    sourceHash: "a".repeat(64),
    publicationHash: null,
  });
  vi.spyOn(
    RigPublicationRepository.prototype,
    "clearCacheDirty"
  ).mockResolvedValue(true);
  vi.spyOn(RigStateRepository.prototype, "read").mockResolvedValue({
    poemId: PoemIdSchema.parse("p"),
    status: "complete",
    version: 2,
    leaseToken: null,
    leaseExpiresAt: null,
    checkpointJson: null,
  });
  const reserve = vi
    .spyOn(AuthorIndexCacheRepository.prototype, "reservePurge")
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  const started = Promise.withResolvers<undefined>();
  const finished = Promise.withResolvers<Response>();
  const fetch = vi.fn().mockImplementation(() => {
    started.resolve(undefined);
    return finished.promise;
  });
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    PUBLIC_SITE: { fetch },
    SAQI_DIRECT_SOURCE_ACTIVE: "1",
    SAQI_RIG_ACTIVE: "1",
    SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
    SAQI_PUBLIC_ORIGIN: "https://saqi.app",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  const source = post(
    sourceRequest({
      action: "upsert-poem",
      poem: {
        sourceAuthorId: "poet",
        sourcePoemId: "123",
        sourceUrl: "https://poetry.example/poem123.html",
        titleArabic: "قصيدة",
        linesArabic: ["بيت"],
        expectedHash: null,
      },
    }),
    env
  );
  await started.promise;
  try {
    const published = await postRigState(
      new Request("https://ops.saqi.app/api/rig/state", {
        method: "POST",
        headers: sourceRequest({}).headers,
        body: JSON.stringify({
          action: "publish",
          poemId: "p",
          expectedVersion: 1,
        }),
      }),
      env
    );
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({
      ok: true,
      cachePending: true,
      state: { status: "complete" },
    });
    expect({
      publishes: publish.mock.calls.length,
      requests: fetch.mock.calls.length,
      reservations: reserve.mock.calls.length,
    }).toEqual({ publishes: 1, requests: 1, reservations: 2 });
  } finally {
    finished.resolve(new Response(null, { status: 204 }));
    await source;
  }
  const saved = await source;
  expect(saved.status).toBe(200);
  await expect(saved.json()).resolves.toMatchObject({
    ok: true,
    cachePending: false,
    result: { status: "updated" },
  });
  expect(upsert).toHaveBeenCalledOnce();
});

test.each(["poet-Malik-Al‑Asamm", "شاعر اسم‑آخر"])(
  "all source actions preserve Unicode dash identity %s",
  async (sourceAuthorId) => {
    const upsertAuthor = vi
      .spyOn(DirectSourceRepository.prototype, "upsertAuthor")
      .mockResolvedValue({ id: "author", status: "created" });
    const upsertPoem = vi
      .spyOn(DirectSourceRepository.prototype, "upsertPoem")
      .mockResolvedValue({
        id: "poem",
        sourceHash: "a".repeat(64),
        status: "unchanged",
      });
    const reconcile = vi
      .spyOn(DirectSourceRepository.prototype, "existingPoemIds")
      .mockResolvedValue(["123"]);
    const defer = vi
      .spyOn(DirectSourceRepository.prototype, "deferSource")
      .mockResolvedValue(undefined);
    const complete = vi
      .spyOn(DirectSourceRepository.prototype, "completeAuthor")
      .mockResolvedValue(undefined);
    const env = parseCloudflareEnv({
      DB: { prepare: vi.fn() },
      SAQI_DIRECT_SOURCE_ACTIVE: "1",
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    });
    const author = {
      sourceAuthorId,
      sourceUrl: `https://poetry.example/cat-${encodeURIComponent(sourceAuthorId)}`,
      nameArabic: "شاعر",
    };
    const poem = {
      sourceAuthorId,
      sourcePoemId: "123",
      sourceUrl: "https://poetry.example/poem123.html",
      titleArabic: "قصيدة",
      linesArabic: ["بيت"],
      expectedHash: null,
    };
    for (const body of [
      { action: "upsert-author", author },
      { action: "upsert-poem", poem },
      { action: "reconcile-manifest", sourceAuthorId, poemIds: ["123"] },
      { action: "defer-source", sourceAuthorId, retryAfter: 123 },
      { action: "complete-author", sourceAuthorId },
    ]) {
      const response = await post(sourceRequest(body), env);
      expect(response.status).toBe(200);
    }
    expect(upsertAuthor).toHaveBeenCalledWith(author);
    expect(upsertPoem).toHaveBeenCalledWith(poem);
    expect(reconcile).toHaveBeenCalledWith({
      sourceAuthorId,
      poemIds: ["123"],
    });
    expect(defer).toHaveBeenCalledWith(sourceAuthorId, 123);
    expect(complete).toHaveBeenCalledWith(sourceAuthorId);
  }
);

test.each([
  "a/b",
  "a%2Fb",
  "a\u{202e}b",
  " a",
  "a ",
  "a  b",
  "a\u{00a0}b",
  "a\u{0000}b",
])("source IDs still reject unsafe spelling %j", async (sourceAuthorId) => {
  const complete = vi
    .spyOn(DirectSourceRepository.prototype, "completeAuthor")
    .mockResolvedValue(undefined);
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    SAQI_DIRECT_SOURCE_ACTIVE: "1",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  const response = await post(
    sourceRequest({ action: "complete-author", sourceAuthorId }),
    env
  );
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    code: "INVALID_SOURCE_REQUEST",
  });
  expect(complete).not.toHaveBeenCalled();
});
