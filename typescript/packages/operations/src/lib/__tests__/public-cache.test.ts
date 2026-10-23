import { PublicCachePurgeRequestSchema } from "@saqi/precedent-iso";
import { describe, expect, it, vi } from "vitest";

import {
  bootstrapAuthorIndex,
  publicCacheConfig,
  PublicCacheInvalidationError,
  publishedPoemUrl,
  purgePublishedPoem,
  purgePublishedPoems,
} from "../public-cache";

const SECRET = "b".repeat(64);
const PUBLIC_SITE = { fetch: vi.fn() };

describe("public cache invalidation", () => {
  it("disables purge only when both service binding and secret are absent", () => {
    expect(
      publicCacheConfig({
        PUBLIC_SITE: undefined,
        SAQI_PUBLIC_CACHE_PURGE_SECRET: undefined,
        SAQI_PUBLIC_ORIGIN: "https://saqi.app",
      })
    ).toEqual({ state: "disabled" });
  });

  it("rejects partial or malformed configuration", () => {
    expect(() =>
      publicCacheConfig({
        PUBLIC_SITE,
        SAQI_PUBLIC_CACHE_PURGE_SECRET: undefined,
        SAQI_PUBLIC_ORIGIN: "https://saqi.app",
      })
    ).toThrow("PUBLIC_CACHE_CONFIG_INVALID");
    expect(() =>
      publicCacheConfig({
        PUBLIC_SITE: undefined,
        SAQI_PUBLIC_CACHE_PURGE_SECRET: SECRET,
        SAQI_PUBLIC_ORIGIN: "https://saqi.app",
      })
    ).toThrow("PUBLIC_CACHE_CONFIG_INVALID");
    expect(() =>
      publicCacheConfig({
        PUBLIC_SITE,
        SAQI_PUBLIC_CACHE_PURGE_SECRET: SECRET,
        SAQI_PUBLIC_ORIGIN: "https://saqi.app/path",
      })
    ).toThrow("PUBLIC_CACHE_CONFIG_INVALID");
  });

  it("constructs one canonical, percent-encoded poem URL", () => {
    expect(
      publishedPoemUrl("https://saqi.app", {
        authorSlug: "شاعر / poet",
        poemId: "id/with space",
      })
    ).toBe(
      "https://saqi.app/poet/%D8%B4%D8%A7%D8%B9%D8%B1%20%2F%20poet/poem/id%2Fwith%20space"
    );
  });

  it("calls the public Worker and rejects failures without exposing the secret", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const config = {
      publicSite: PUBLIC_SITE,
      publicOrigin: "https://saqi.app",
      purgeSecret: SECRET,
    };
    await expect(
      purgePublishedPoem(
        config,
        { authorSlug: "author-1", poemId: "poem-1" },
        transport
      )
    ).resolves.toBe("https://saqi.app/poet/author-1/poem/poem-1");
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "https://saqi.app/internal/purge-publication-cache",
      expect.objectContaining({
        body: JSON.stringify({ authorSlug: "author-1", poemId: "poem-1" }),
        method: "POST",
      })
    );
    transport.mockResolvedValue(new Response(SECRET, { status: 503 }));
    await expect(
      purgePublishedPoem(
        config,
        { authorSlug: "author-1", poemId: "poem-1" },
        transport
      )
    ).rejects.toThrow(
      new PublicCacheInvalidationError("PUBLIC_CACHE_PURGE_REJECTED", {
        details: { status: 503 },
      })
    );
    await expect(
      purgePublishedPoem(
        config,
        { authorSlug: "author-1", poemId: "poem-1" },
        transport
      )
    ).rejects.not.toThrow(SECRET);
  });

  it("purges a repository row using only the public route contract", async () => {
    const row = {
      authorSlug: "author-1",
      poemId: "poem-1",
      publicationHash: "a".repeat(64),
      sourceHash: "b".repeat(64),
    };
    const transport = vi
      .fn()
      .mockImplementation(async (_url: string, init: { body: string }) => {
        const valid = PublicCachePurgeRequestSchema.safeParse(
          JSON.parse(init.body)
        ).success;
        return new Response(null, { status: valid ? 204 : 400 });
      });
    await expect(
      purgePublishedPoem(
        {
          publicSite: PUBLIC_SITE,
          publicOrigin: "https://saqi.app",
          purgeSecret: SECRET,
        },
        row,
        transport
      )
    ).resolves.toBe("https://saqi.app/poet/author-1/poem/poem-1");
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "https://saqi.app/internal/purge-publication-cache",
      expect.objectContaining({
        body: JSON.stringify({
          authorSlug: row.authorSlug,
          poemId: row.poemId,
        }),
      })
    );
  });

  it("reports bounded public Worker errors and discards arbitrary response bodies", async () => {
    const transport = vi.fn().mockResolvedValue(
      Response.json(
        {
          code: "PUBLIC_CACHE_PURGE_FAILED",
          errors: [{ code: 1001, message: "Cache purge denied" }],
          secret: SECRET,
        },
        { status: 503 }
      )
    );
    const config = {
      publicSite: PUBLIC_SITE,
      publicOrigin: "https://saqi.app",
      purgeSecret: SECRET,
    };
    await expect(
      purgePublishedPoem(
        config,
        { authorSlug: "author-1", poemId: "poem-1" },
        transport
      )
    ).rejects.toMatchObject({
      message: "PUBLIC_CACHE_PURGE_REJECTED",
      details: {
        status: 503,
        errors: [{ code: 1001, message: "Cache purge denied" }],
      },
    });
    transport.mockResolvedValue(
      Response.json({ secret: SECRET }, { status: 404 })
    );
    await expect(
      purgePublishedPoem(
        config,
        { authorSlug: "author-1", poemId: "poem-1" },
        transport
      )
    ).rejects.toMatchObject({ details: { status: 404 } });
  });

  it("requests one retained full-corpus invalidation", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await bootstrapAuthorIndex(
      {
        publicSite: PUBLIC_SITE,
        publicOrigin: "https://saqi.app",
        purgeSecret: SECRET,
      },
      transport
    );
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "https://saqi.app/internal/purge-publication-cache",
      expect.objectContaining({ body: '{"authorIndex":true,"bootstrap":true}' })
    );
  });

  it("bounds a rejected response body and retains only its status", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(new Response("x".repeat(16_385), { status: 503 }));
    await expect(
      purgePublishedPoem(
        {
          publicSite: PUBLIC_SITE,
          publicOrigin: "https://saqi.app",
          purgeSecret: SECRET,
        },
        { authorSlug: "poet", poemId: "one" },
        transport
      )
    ).rejects.toMatchObject({
      message: "PUBLIC_CACHE_PURGE_REJECTED",
      details: { status: 503 },
    });
  });

  it("includes stalled failure diagnostics in the request deadline", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      let signal: { readonly aborted: boolean } | undefined;
      const transport = vi.fn(
        async (
          _url: string,
          init: { signal?: { readonly aborted: boolean } }
        ) => {
          signal = init.signal;
          return new Response(body, { status: 503 });
        }
      );
      const rejected = expect(
        purgePublishedPoem(
          {
            publicSite: PUBLIC_SITE,
            publicOrigin: "https://saqi.app",
            purgeSecret: SECRET,
          },
          { authorSlug: "poet", poemId: "one" },
          transport
        )
      ).rejects.toMatchObject({
        message: "PUBLIC_CACHE_PURGE_REJECTED",
        details: { status: 503 },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a failure body that arrives after the request deadline", async () => {
    vi.useFakeTimers();
    const delayed = Promise.withResolvers<Response>();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    try {
      const rejected = expect(
        purgePublishedPoem(
          {
            publicSite: PUBLIC_SITE,
            publicOrigin: "https://saqi.app",
            purgeSecret: SECRET,
          },
          { authorSlug: "poet", poemId: "one" },
          () => delayed.promise
        )
      ).rejects.toMatchObject({ message: "PUBLIC_CACHE_PURGE_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      delayed.resolve(new Response(body, { status: 503 }));
      await vi.runAllTimersAsync();
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("batches multiple publication routes in one authenticated purge without forwarding hashes", async () => {
  const transport = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 204 }));
  const poems = [
    {
      authorSlug: "poet",
      poemId: "one",
      sourceHash: "private source",
      publicationHash: "private publication",
    },
    {
      authorSlug: "poet",
      poemId: "two",
      sourceHash: "private source",
      publicationHash: "private publication",
    },
  ];
  await purgePublishedPoems(
    {
      publicSite: PUBLIC_SITE,
      publicOrigin: "https://saqi.app",
      purgeSecret: SECRET,
    },
    poems,
    transport
  );
  expect(transport).toHaveBeenCalledExactlyOnceWith(
    "https://saqi.app/internal/purge-publication-cache",
    expect.objectContaining({
      body: JSON.stringify({
        poems: [
          { authorSlug: "poet", poemId: "one" },
          { authorSlug: "poet", poemId: "two" },
        ],
      }),
    })
  );
  expect(
    PublicCachePurgeRequestSchema.safeParse({
      poems: Array.from({ length: 51 }, () => poems[0]),
    }).success
  ).toBe(false);
});
