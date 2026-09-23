import { describe, expect, it, vi } from "vitest";

import {
  publicCacheConfig,
  PublicCacheInvalidationError,
  publishedPoemUrl,
  purgePublishedPoem,
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
      "https://saqi.app/author/%D8%B4%D8%A7%D8%B9%D8%B1%20%2F%20poet/poem/id%2Fwith%20space"
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
    ).resolves.toBe("https://saqi.app/author/author-1/poem/poem-1");
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
      new PublicCacheInvalidationError("PUBLIC_CACHE_PURGE_REJECTED")
    );
    await expect(
      purgePublishedPoem(
        config,
        { authorSlug: "author-1", poemId: "poem-1" },
        transport
      )
    ).rejects.not.toThrow(SECRET);
  });
});
