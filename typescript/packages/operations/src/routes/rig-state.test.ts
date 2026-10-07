import { expect, test, vi } from "vitest";

import { parseCloudflareEnv } from "../lib/cloudflare";
import { RigPublicationRepository } from "../lib/rig-publication-repository";
import { get, post } from "./rig-state";

test("inactive rig refuses mutation before reading D1", async () => {
  const prepare = vi.fn();
  const env = parseCloudflareEnv({
    DB: { prepare },
    SAQI_RIG_ACTIVE: "0",
    SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
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

test("corpus purge clears only migration-marked cache flags after purge", async () => {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 2 } });
  const prepare = vi.fn().mockReturnValue({ run });
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const env = parseCloudflareEnv({
    DB: { prepare },
    PUBLIC_SITE: { fetch },
    SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
    SAQI_PUBLIC_ORIGIN: "https://saqi.app",
    SAQI_RIG_ACTIVE: "1",
    SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
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
    env
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, cleared: 2 });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://saqi.app/internal/purge-publication-cache",
    expect.objectContaining({ body: '{"all":true}' })
  );
  expect(prepare).toHaveBeenCalledWith(
    expect.stringContaining("publication_hash IS NULL")
  );
});

test("cache configuration failures keep their actionable code", async () => {
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    PUBLIC_SITE: { fetch: vi.fn() },
    SAQI_PUBLIC_ORIGIN: "https://saqi.app",
    SAQI_RIG_ACTIVE: "1",
    SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
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
      SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
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
      SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
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
          freshPage
            ? '<p>Bread &amp; wine</p><button data-word-meaning="bread &quot;loaf&quot;">خبز</button>'
            : "<p>Old translation</p>",
          { status: 200 }
        )
      );
    const env = parseCloudflareEnv({
      DB: { prepare },
      PUBLIC_SITE: { fetch },
      SAQI_RIG_ACTIVE: "1",
      SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
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
      "https://saqi.app/author/poet/poem/poem-1"
    );
  }
);

test("pooled publication can defer cache invalidation without dropping its dirty flag", async () => {
  const publication = vi
    .spyOn(RigPublicationRepository.prototype, "publish")
    .mockResolvedValue(true);
  const fetch = vi.fn();
  const first = vi.fn().mockResolvedValue({
    poemId: "poem-1",
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
    SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
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
      SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
    });
    const response = await get(
      new Request(`https://ops.saqi.app/api/rig/state?attemptId=${value}`),
      env
    );
    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
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
    SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
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
