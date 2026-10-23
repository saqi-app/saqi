import { PublicCachePurgeRequestSchema } from "@saqi/precedent-iso";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { AuthorIndexCacheRepository } from "../lib/author-index-cache-repository";
import { parseCloudflareEnv } from "../lib/parse-cloudflare-env";
import { PublicRouteCacheRepository } from "../lib/public-route-cache-repository";
import { PublicRouteRepository } from "../lib/public-route-repository";
import { RigPublicationRepository } from "../lib/rig-publication-repository";
import { PoemIdSchema, RigStateRepository } from "../lib/rig-state-repository";
import { get, post } from "./rig-state";

type PurgeFetch = (url: string, init: { body: string }) => Promise<Response>;

beforeEach(() => {
  vi.spyOn(PublicRouteRepository.prototype, "pending").mockResolvedValue(false);
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

function parsePurgePayload(body: string) {
  return PublicCachePurgeRequestSchema.parse(JSON.parse(body));
}

function cacheMaintenanceRequest(bootstrapAuthorIndex?: unknown) {
  const body: { action: "purge-cache"; bootstrapAuthorIndex?: unknown } = {
    action: "purge-cache",
  };
  if (bootstrapAuthorIndex !== undefined)
    body.bootstrapAuthorIndex = bootstrapAuthorIndex;
  return new Request("https://ops.saqi.app/api/rig/state", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "ops.saqi.app",
      origin: "https://ops.saqi.app",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

test.each([false, "true", 1, null])(
  "deployment bootstrap accepts only the literal true (%j)",
  async (flag) => {
    const prepare = vi.fn();
    const response = await post(
      cacheMaintenanceRequest(flag),
      parseCloudflareEnv({
        DB: { prepare },
        SAQI_RIG_ACTIVE: "1",
        SAQI_SOURCE_NAME: "fixture",
        SAQI_SOURCE_BASE_URL: "https://poetry.example",
      })
    );
    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  }
);

test.each([undefined, true])(
  "only explicit deployment maintenance rearms bootstrap (%s)",
  async (flag) => {
    const request = vi
      .spyOn(AuthorIndexCacheRepository.prototype, "requestBootstrap")
      .mockResolvedValue();
    const poems = vi
      .spyOn(RigPublicationRepository.prototype, "pendingPurges")
      .mockResolvedValue([]);
    const index = vi
      .spyOn(AuthorIndexCacheRepository.prototype, "pending")
      .mockImplementation(async () => {
        expect(request).toHaveBeenCalledTimes(flag === true ? 1 : 0);
        return { generation: 2, bootstrapGeneration: flag === true ? 2 : null };
      });
    const acknowledge = vi
      .spyOn(AuthorIndexCacheRepository.prototype, "acknowledge")
      .mockResolvedValue(false);
    const fetch = vi
      .fn<PurgeFetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const response = await post(
        cacheMaintenanceRequest(flag),
        parseCloudflareEnv({
          DB: { prepare: vi.fn() },
          PUBLIC_SITE: { fetch },
          SAQI_RIG_ACTIVE: "1",
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
      });
      expect(parsePurgePayload(fetch.mock.calls.at(0)?.[1].body ?? "")).toEqual(
        flag === true
          ? { authorIndex: true, bootstrap: true }
          : { authorIndex: true }
      );
    } finally {
      request.mockRestore();
      poems.mockRestore();
      index.mockRestore();
      acknowledge.mockRestore();
    }
  }
);

test.each([false, true])(
  "homepage maintenance runs even with an empty or failed poem backlog (%s)",
  async (poemsFail) => {
    const poems = vi.spyOn(RigPublicationRepository.prototype, "pendingPurges");
    if (poemsFail)
      poems.mockRejectedValue(new Error("POEM_BACKLOG_UNAVAILABLE"));
    else poems.mockResolvedValue([]);
    const index = vi
      .spyOn(AuthorIndexCacheRepository.prototype, "pending")
      .mockResolvedValue({ generation: 1, bootstrapGeneration: 1 });
    const acknowledge = vi
      .spyOn(AuthorIndexCacheRepository.prototype, "acknowledge")
      .mockResolvedValue(true);
    const fetch = vi
      .fn<PurgeFetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const response = await post(
        cacheMaintenanceRequest(),
        parseCloudflareEnv({
          DB: { prepare: vi.fn() },
          PUBLIC_SITE: { fetch },
          SAQI_RIG_ACTIVE: "1",
          SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
          SAQI_PUBLIC_ORIGIN: "https://saqi.app",
          SAQI_SOURCE_NAME: "fixture",
          SAQI_SOURCE_BASE_URL: "https://poetry.example",
        })
      );
      expect(response.status).toBe(poemsFail ? 503 : 200);
      expect(fetch).toHaveBeenCalledOnce();
      expect(parsePurgePayload(fetch.mock.calls.at(0)?.[1].body ?? "")).toEqual(
        {
          authorIndex: true,
          bootstrap: true,
        }
      );
      expect(acknowledge).toHaveBeenCalledWith({
        generation: 1,
        bootstrapGeneration: 1,
      });
    } finally {
      poems.mockRestore();
      index.mockRestore();
      acknowledge.mockRestore();
    }
  }
);

test("publication capability checks require no database or rig mutation", async () => {
  const prepare = vi.fn();
  const response = await get(
    new Request("https://ops.saqi.app/api/rig/state?capabilities=1"),
    parseCloudflareEnv({
      DB: { prepare },
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    })
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  await expect(response.json()).resolves.toEqual({
    ok: true,
    capabilities: { publicationCompareAndSwap: "returning-row-v1" },
  });
  expect(prepare).not.toHaveBeenCalled();
});

test.each([
  "0",
  "1&poemId=poem",
  "1&diagnostics=1",
  "1&attemptId=attempt",
  "1&capabilities=1",
])(
  "publication capability checks reject mixed or invalid queries (%s)",
  async (query) => {
    const prepare = vi.fn();
    const response = await get(
      new Request(`https://ops.saqi.app/api/rig/state?capabilities=${query}`),
      parseCloudflareEnv({
        DB: { prepare },
        SAQI_SOURCE_NAME: "fixture",
        SAQI_SOURCE_BASE_URL: "https://poetry.example",
      })
    );
    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  }
);

test("a failed index read does not prevent captured poem acknowledgement", async () => {
  const poems = vi
    .spyOn(RigPublicationRepository.prototype, "pendingPurges")
    .mockResolvedValue([
      {
        authorName: "شاعر",
        authorSlug: "poet",
        cacheGeneration: 1,
        poemId: "p",
        publicationHash: null,
        sourceHash: null,
      },
    ]);
  const clear = vi
    .spyOn(RigPublicationRepository.prototype, "clearCacheDirtyBatch")
    .mockResolvedValue(1);
  const index = vi
    .spyOn(AuthorIndexCacheRepository.prototype, "pending")
    .mockRejectedValue(new Error("INDEX_READ_UNAVAILABLE"));
  const acknowledge = vi.spyOn(
    AuthorIndexCacheRepository.prototype,
    "acknowledge"
  );
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  try {
    const response = await post(
      cacheMaintenanceRequest(),
      parseCloudflareEnv({
        DB: { prepare: vi.fn() },
        PUBLIC_SITE: { fetch },
        SAQI_RIG_ACTIVE: "1",
        SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
        SAQI_PUBLIC_ORIGIN: "https://saqi.app",
        SAQI_SOURCE_NAME: "fixture",
        SAQI_SOURCE_BASE_URL: "https://poetry.example",
      })
    );
    expect(response.status).toBe(503);
    expect(clear).toHaveBeenCalledOnce();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    poems.mockRestore();
    clear.mockRestore();
    index.mockRestore();
    acknowledge.mockRestore();
  }
});

test("inactive rig refuses mutation before reading D1", async () => {
  const prepare = vi.fn();
  const env = parseCloudflareEnv({
    DB: { prepare },
    SAQI_RIG_ACTIVE: "0",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  const response = await post(
    new Request("https://ops.saqi.app/api/rig/state", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "ops.saqi.app",
        origin: "https://ops.saqi.app",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        action: "claim-poem",
        token: crypto.randomUUID(),
      }),
    }),
    env
  );
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toMatchObject({
    code: "RIG_INACTIVE",
  });
  expect(prepare).not.toHaveBeenCalled();
});

test.each([204, 401, 503])(
  "deployment cache probes reach the real binding without reading or mutating D1 (HTTP %s)",
  async (status) => {
    const prepare = vi.fn();
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    const env = parseCloudflareEnv({
      DB: { prepare },
      PUBLIC_SITE: { fetch },
      SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
      SAQI_PUBLIC_ORIGIN: "https://saqi.app",
      SAQI_RIG_ACTIVE: "1",
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    });
    const response = await post(
      new Request("https://ops.saqi.app/api/rig/state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "ops.saqi.app",
          origin: "https://ops.saqi.app",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ action: "probe-cache" }),
      }),
      env
    );
    expect(response.status).toBe(status === 204 ? 200 : 503);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://saqi.app/internal/purge-publication-cache");
    expect(init.headers.authorization).toBe(`Bearer ${"a".repeat(64)}`);
    expect(init.body).toBe(
      JSON.stringify({
        authorSlug: "__saqi_deployment_probe__",
        poemId: "__saqi_deployment_probe__",
      })
    );
  }
);

test.each([false, true])(
  "explicit corpus purge captures work before the network and reports acknowledgement races (%s)",
  async (raced) => {
    const captured = [
      {
        authorName: "شاعر",
        authorSlug: "poet",
        cacheGeneration: 7,
        poemId: "p",
        publicationHash: null,
        sourceHash: null,
      },
    ];
    const reserve = vi.spyOn(
      AuthorIndexCacheRepository.prototype,
      "reservePurge"
    );
    const bootstrap = vi
      .spyOn(AuthorIndexCacheRepository.prototype, "requestBootstrap")
      .mockResolvedValue();
    vi.spyOn(AuthorIndexCacheRepository.prototype, "pending").mockResolvedValue(
      {
        generation: 2,
        bootstrapGeneration: 2,
      }
    );
    const pending = vi
      .spyOn(RigPublicationRepository.prototype, "pendingPurges")
      .mockResolvedValue(captured);
    const acknowledge = vi
      .spyOn(AuthorIndexCacheRepository.prototype, "acknowledge")
      .mockResolvedValue(!raced);
    const clear = vi
      .spyOn(RigPublicationRepository.prototype, "clearCacheDirtyBatch")
      .mockResolvedValue(raced ? 0 : 1);
    const prepare = vi.fn();
    const fetch = vi.fn().mockImplementation(async () => {
      expect(bootstrap).toHaveBeenCalledOnce();
      expect(pending).toHaveBeenCalledOnce();
      expect(acknowledge).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      return new Response(null, { status: 204 });
    });
    const response = await post(
      new Request("https://ops.saqi.app/api/rig/state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "ops.saqi.app",
          origin: "https://ops.saqi.app",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ action: "purge-corpus" }),
      }),
      parseCloudflareEnv({
        DB: { prepare },
        PUBLIC_SITE: { fetch },
        SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
        SAQI_PUBLIC_ORIGIN: "https://saqi.app",
        SAQI_RIG_ACTIVE: "1",
        SAQI_SOURCE_NAME: "fixture",
        SAQI_SOURCE_BASE_URL: "https://poetry.example",
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      purged: !raced,
      cachePending: raced,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://saqi.app/internal/purge-publication-cache",
      expect.objectContaining({ body: '{"authorIndex":true,"bootstrap":true}' })
    );
    expect(acknowledge).toHaveBeenCalledWith({
      generation: 2,
      bootstrapGeneration: 2,
    });
    expect(clear).toHaveBeenCalledWith(captured);
    expect(prepare).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  }
);

test("cache configuration failures keep their actionable code", async () => {
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    PUBLIC_SITE: { fetch: vi.fn() },
    SAQI_PUBLIC_ORIGIN: "https://saqi.app",
    SAQI_RIG_ACTIVE: "1",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  const response = await post(
    new Request("https://ops.saqi.app/api/rig/state", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "ops.saqi.app",
        origin: "https://ops.saqi.app",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ action: "purge-cache" }),
    }),
    env
  );
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    code: "PUBLIC_CACHE_CONFIG_INVALID",
  });
});

test.each([false, true])(
  "publication verification is an opt-in canonical read (%s)",
  async (includePublication) => {
    const prepare = vi.fn((sql: string) => {
      const first = vi.fn().mockResolvedValue(
        sql.includes("publication_source_hash")
          ? {
              authorSlug: "poet",
              canonicalAuthorSlug: "poet",
              canonicalPoemSlug: "poem-1",
              sourceHash: "a".repeat(64),
              publicationSourceHash: "a".repeat(64),
              publicationHash: "b".repeat(64),
              cacheDirty: 0,
              publicationJson: JSON.stringify({
                schemaVersion: 2,
                active: true,
                fields: {},
              }),
            }
          : {
              poemId: "poem-1",
              status: "complete",
              version: 4,
              leaseToken: null,
              leaseExpiresAt: null,
              checkpointJson: null,
            }
      );
      return { bind: vi.fn().mockReturnValue({ first }) };
    });
    const env = parseCloudflareEnv({
      DB: { prepare },
      SAQI_RIG_ACTIVE: "1",
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    });
    const response = await get(
      new Request(
        `https://ops.saqi.app/api/rig/state?poemId=poem-1${
          includePublication ? "&publication=1" : ""
        }`
      ),
      env
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ state: { status: "complete" } });
    if (includePublication)
      expect(body).toMatchObject({
        publication: {
          authorSlug: "poet",
          cacheDirty: 0,
          snapshot: { active: true },
        },
      });
    else expect(body).not.toHaveProperty("publication");
    expect(prepare).toHaveBeenCalledTimes(includePublication ? 2 : 1);
  }
);

test.each([
  [20, 200],
  [40, 200],
  [41, 200],
  [80, 200],
  [81, 400],
])(
  "concurrent claim limit %i returns HTTP %i",
  async (maxConcurrent, expectedStatus) => {
    const first = vi.fn().mockResolvedValue(null);
    const prepare = vi
      .fn()
      .mockReturnValue({ bind: vi.fn().mockReturnValue({ first }), first });
    const env = parseCloudflareEnv({
      DB: { prepare },
      SAQI_RIG_ACTIVE: "1",
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    });
    const response = await post(
      new Request("https://ops.saqi.app/api/rig/state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "ops.saqi.app",
          origin: "https://ops.saqi.app",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          action: "claim-poem",
          token: crypto.randomUUID(),
          maxConcurrent,
        }),
      }),
      env
    );
    expect(response.status).toBe(expectedStatus);
    if (expectedStatus === 400) expect(prepare).not.toHaveBeenCalled();
  }
);

test.each([
  [true, false],
  [false, false],
  [true, true],
  [false, true],
])(
  "publication check tests deployed escaped content (fresh=%s, legacy=%s)",
  async (freshPage, legacyTranslation) => {
    const snapshot = {
      schemaVersion: 2,
      active: true,
      fields: {
        ...(legacyTranslation
          ? { linesEnglish: ["Bread & wine"], linesEnglishModel: "claude-2" }
          : {
              modelEnrichments: [
                {
                  lines: ["Bread & wine"],
                  model: "gpt-6.1-sol",
                  modelKey: "saqi-current",
                  reasoningEffort: "xhigh",
                  vendorKey: "openai",
                },
              ],
            }),
        wordGlosses: {
          sourceHash: "a".repeat(64),
          model: "gpt-6.1-sol",
          meanings: {
            tokenizerVersion: "saqi-orthographic-v1",
            lines: [
              {
                lineIndex: 0,
                segments: [
                  {
                    kind: "word",
                    surface: "خبز",
                    tokenIndex: 0,
                    meaning: 'bread "loaf"',
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(
          sql.includes("publication_source_hash")
            ? {
                authorSlug: "poet",
                canonicalAuthorSlug: "poet",
                canonicalPoemSlug: "poem-1",
                sourceHash: "a".repeat(64),
                publicationSourceHash: "a".repeat(64),
                publicationHash: "b".repeat(64),
                cacheDirty: 0,
                publicationJson: JSON.stringify(snapshot),
              }
            : {
                poemId: "poem-1",
                status: "complete",
                version: 4,
                leaseToken: null,
                leaseExpiresAt: null,
                checkpointJson: null,
              }
        ),
      }),
    }));
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `<head><link rel="canonical" href="https://saqi.app/poet/poet/poem/poem-1"></head>${
            freshPage
              ? '<p>Bread &amp; wine</p><button data-word-meaning="bread &quot;loaf&quot;">خبز</button>'
              : "<p>Old translation</p>"
          }`,
          { status: 200 }
        )
      );
    const env = parseCloudflareEnv({
      DB: { prepare },
      PUBLIC_SITE: { fetch },
      SAQI_RIG_ACTIVE: "1",
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    });
    const response = await get(
      new Request(
        "https://ops.saqi.app/api/rig/state?poemId=poem-1&publication=1"
      ),
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      publicPage: {
        status: 200,
        translationMatches: freshPage,
        wordMeaningsMatch: freshPage,
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://saqi.app/poet/poet/poem/poem-1",
      expect.objectContaining({
        redirect: "manual",
        signal: expect.any(AbortSignal),
      })
    );
  }
);

test("pooled publication can defer cache invalidation without dropping its dirty flag", async () => {
  const publication = vi
    .spyOn(RigPublicationRepository.prototype, "publish")
    .mockResolvedValue(true);
  const fetch = vi.fn();
  const first = vi.fn().mockResolvedValue({
    poemId: PoemIdSchema.parse("poem-1"),
    status: "complete",
    version: 4,
    leaseToken: null,
    leaseExpiresAt: null,
    checkpointJson: null,
  });
  const prepare = vi
    .fn()
    .mockReturnValue({ bind: vi.fn().mockReturnValue({ first }) });
  const env = parseCloudflareEnv({
    DB: { prepare },
    PUBLIC_SITE: { fetch },
    SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
    SAQI_PUBLIC_ORIGIN: "https://saqi.app",
    SAQI_RIG_ACTIVE: "1",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  try {
    const response = await post(
      new Request("https://ops.saqi.app/api/rig/state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "ops.saqi.app",
          origin: "https://ops.saqi.app",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          action: "publish",
          poemId: "poem-1",
          expectedVersion: 3,
          deferCachePurge: true,
        }),
      }),
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cachePending: true,
      state: { status: "complete" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    publication.mockRestore();
  }
});

test.each([
  "",
  "not-a-uuid",
  "11111111-1111-4111-8111-111111111111&poemId=poem-1",
])(
  "invalid or ambiguous saved-attempt lookup does not touch D1 (%s)",
  async (value) => {
    const prepare = vi.fn();
    const env = parseCloudflareEnv({
      DB: { prepare },
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    });
    const response = await get(
      new Request(`https://ops.saqi.app/api/rig/state?attemptId=${value}`),
      env
    );
    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  }
);

test("acknowledgement does not echo a large durable checkpoint", async () => {
  const acknowledge = vi
    .spyOn(RigStateRepository.prototype, "acknowledgeInvocation")
    .mockResolvedValue(true);
  const read = vi
    .spyOn(RigStateRepository.prototype, "read")
    .mockResolvedValue({
      poemId: PoemIdSchema.parse("poem-1"),
      status: "claimed",
      version: 4,
      leaseToken: null,
      leaseExpiresAt: null,
      checkpointJson: JSON.stringify({
        outputs: { generation: "x".repeat(100_000) },
      }),
    });
  try {
    const response = await post(
      new Request("https://ops.saqi.app/api/rig/state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "ops.saqi.app",
          origin: "https://ops.saqi.app",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          action: "acknowledge",
          poemId: "poem-1",
          attemptId: crypto.randomUUID(),
          expectedVersion: 3,
          output: {},
        }),
      }),
      parseCloudflareEnv({
        DB: { prepare: vi.fn() },
        SAQI_RIG_ACTIVE: "1",
        SAQI_SOURCE_NAME: "fixture",
        SAQI_SOURCE_BASE_URL: "https://poetry.example",
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      state: { poemId: "poem-1", status: "claimed", version: 4 },
    });
  } finally {
    acknowledge.mockRestore();
    read.mockRestore();
  }
});

test.each([false, true])(
  "publication reports cache pending when dirty acknowledgement is %s",
  async (cleared) => {
    const publish = vi
      .spyOn(RigPublicationRepository.prototype, "publish")
      .mockResolvedValue(true);
    const pending = vi
      .spyOn(RigPublicationRepository.prototype, "pendingPurge")
      .mockResolvedValue({
        poemId: PoemIdSchema.parse("poem-1"),
        authorName: "شاعر",
        authorSlug: "poet",
        cacheGeneration: 1,
        publicationHash: "b".repeat(64),
        sourceHash: "a".repeat(64),
      });
    const clear = vi
      .spyOn(RigPublicationRepository.prototype, "clearCacheDirty")
      .mockResolvedValue(cleared);
    const read = vi
      .spyOn(RigStateRepository.prototype, "read")
      .mockResolvedValue({
        poemId: PoemIdSchema.parse("poem-1"),
        status: "complete",
        version: 4,
        leaseToken: null,
        leaseExpiresAt: null,
        checkpointJson: null,
      });
    try {
      const response = await post(
        new Request("https://ops.saqi.app/api/rig/state", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "ops.saqi.app",
            origin: "https://ops.saqi.app",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
          },
          body: JSON.stringify({
            action: "publish",
            poemId: "poem-1",
            expectedVersion: 3,
          }),
        }),
        parseCloudflareEnv({
          DB: { prepare: vi.fn() },
          SAQI_RIG_ACTIVE: "1",
          SAQI_SOURCE_NAME: "fixture",
          SAQI_SOURCE_BASE_URL: "https://poetry.example",
          PUBLIC_SITE: {
            fetch: vi
              .fn()
              .mockResolvedValue(new Response(null, { status: 204 })),
          },
          SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
          SAQI_PUBLIC_ORIGIN: "https://saqi.app",
        })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        cachePending: !cleared,
      });
    } finally {
      publish.mockRestore();
      pending.mockRestore();
      clear.mockRestore();
      read.mockRestore();
    }
  }
);

test("saved-attempt lookup is a read-only authenticated-state response", async () => {
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const state = {
    poemId: "poem-1",
    status: "unknown",
    version: 3,
    leaseToken: null,
    leaseExpiresAt: null,
    checkpointJson: JSON.stringify({ invocation: { attemptId } }),
  };
  const first = vi.fn().mockResolvedValue(state);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  const env = parseCloudflareEnv({
    DB: { prepare },
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  const response = await get(
    new Request(`https://ops.saqi.app/api/rig/state?attemptId=${attemptId}`),
    env
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, state });
  expect(bind).toHaveBeenCalledExactlyOnceWith(attemptId);
  expect(prepare).toHaveBeenCalledOnce();
  expect(response.headers.get("cache-control")).toContain("no-store");
});

test("queue diagnostic reads are opt-in and never cached", async () => {
  const diagnostics = {
    checkedAt: 100,
    activeSlots: 0,
    states: [],
    expiredDispatches: [],
  };
  const read = vi
    .spyOn(RigStateRepository.prototype, "queueDiagnostics")
    .mockResolvedValue(diagnostics);
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    SAQI_RIG_ACTIVE: "1",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  try {
    const response = await get(
      new Request("https://ops.saqi.app/api/rig/state?diagnostics=1"),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      diagnostics: {
        ...diagnostics,
        scanHint: {
          afterPoemId: expect.any(String),
          priority: expect.any(Number),
        },
      },
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
  } finally {
    read.mockRestore();
  }
});

test.each([
  "diagnostics=0",
  "diagnostics=",
  "diagnostics=1&poemId=poem-1",
  "diagnostics=1&attemptId=11111111-1111-4111-8111-111111111111",
])("invalid diagnostic query %s never reads D1", async (query) => {
  const prepare = vi.fn();
  const env = parseCloudflareEnv({
    DB: { prepare },
    SAQI_RIG_ACTIVE: "1",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  const response = await get(
    new Request(`https://ops.saqi.app/api/rig/state?${query}`),
    env
  );
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    code: "INVALID_DIAGNOSTICS_QUERY",
  });
  expect(prepare).not.toHaveBeenCalled();
});

test("queue diagnostics fail closed without exposing database errors", async () => {
  const read = vi
    .spyOn(RigStateRepository.prototype, "queueDiagnostics")
    .mockRejectedValue(new Error("private database detail"));
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    SAQI_RIG_ACTIVE: "1",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  try {
    const response = await get(
      new Request("https://ops.saqi.app/api/rig/state?diagnostics=1"),
      env
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "RIG_DIAGNOSTICS_UNAVAILABLE",
    });
  } finally {
    read.mockRestore();
  }
});

test("claim requests resume a supplied hint in a fresh repository and return its next position", async () => {
  let scanBind = vi.fn();
  const prepare = vi.fn((sql: string) => {
    const first = vi
      .fn()
      .mockResolvedValue(
        sql.includes("WITH candidates")
          ? { poemId: null, scannedThrough: null }
          : null
      );
    const bind = vi.fn().mockReturnValue({ first });
    if (sql.includes("WITH candidates")) scanBind = bind;
    return { first, bind };
  });
  const env = parseCloudflareEnv({
    DB: { prepare },
    SAQI_RIG_ACTIVE: "1",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  const response = await post(
    new Request("https://ops.saqi.app/api/rig/state", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "ops.saqi.app",
        origin: "https://ops.saqi.app",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        action: "claim-poem",
        token: "11111111-1111-4111-8111-111111111111",
        maxConcurrent: 80,
        scanHint: { afterPoemId: "resume", priority: 2 },
      }),
    }),
    env
  );
  expect(response.status).toBe(200);
  expect(scanBind).toHaveBeenCalledExactlyOnceWith(
    "resume",
    expect.any(Number),
    80,
    2
  );
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    state: null,
    scanHint: { afterPoemId: "", priority: 0 },
  });
});

test.each([
  { afterPoemId: "x", priority: 3 },
  { afterPoemId: "x", priority: -1 },
  { afterPoemId: "x".repeat(201), priority: 0 },
  { afterPoemId: "x", priority: 0, extra: true },
])(
  "invalid scan hint is refused before canonical reads: %j",
  async (scanHint) => {
    const prepare = vi.fn();
    const env = parseCloudflareEnv({
      DB: { prepare },
      SAQI_RIG_ACTIVE: "1",
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    });
    const response = await post(
      new Request("https://ops.saqi.app/api/rig/state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "ops.saqi.app",
          origin: "https://ops.saqi.app",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          action: "claim-poem",
          token: "11111111-1111-4111-8111-111111111111",
          maxConcurrent: 80,
          scanHint,
        }),
      }),
      env
    );
    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  }
);

test("incompatible route metadata maintenance cannot block the existing publication purge", async () => {
  vi.spyOn(PublicRouteRepository.prototype, "pending").mockResolvedValue(true);
  const allocate = vi.spyOn(PublicRouteRepository.prototype, "advance");
  vi.spyOn(console, "warn").mockImplementation(() => {
    /* Silence the expected generic deferred-maintenance notice. */
  });
  vi.spyOn(
    RigPublicationRepository.prototype,
    "pendingPurges"
  ).mockResolvedValue([]);
  vi.spyOn(AuthorIndexCacheRepository.prototype, "pending").mockResolvedValue({
    generation: 1,
    bootstrapGeneration: null,
  });
  vi.spyOn(
    AuthorIndexCacheRepository.prototype,
    "acknowledge"
  ).mockResolvedValue(true);
  const fetch = vi.fn(
    async (url: string) =>
      new Response(null, {
        status: url.endsWith("/internal/public-route-capabilities") ? 503 : 204,
      })
  );
  const response = await post(
    cacheMaintenanceRequest(),
    parseCloudflareEnv({
      DB: { prepare: vi.fn() },
      PUBLIC_SITE: { fetch },
      SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
      SAQI_PUBLIC_ORIGIN: "https://saqi.app",
      SAQI_RIG_ACTIVE: "1",
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    })
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    purged: true,
  });
  expect(fetch.mock.calls.map((call) => new URL(call[0]).pathname)).toEqual([
    "/internal/public-route-capabilities",
    "/internal/purge-publication-cache",
  ]);
  expect(allocate).not.toHaveBeenCalled();
});
