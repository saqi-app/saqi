import { afterEach, expect, test, vi } from "vitest";

import { parseCloudflareEnv } from "../lib/parse-cloudflare-env";
import { publicSitemap } from "./public-sitemap";

function environment(fetch: (...args: unknown[]) => Promise<Response>) {
  return parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    PUBLIC_SITE: { fetch },
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

test("proxies XML with charset parameters and keeps the response private", async () => {
  const response = await publicSitemap(
    environment(
      async () =>
        new Response("<sitemapindex/>", {
          headers: { "content-type": "Application/XML; charset=utf-8" },
        })
    )
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ xml: "<sitemapindex/>" });
  expect(response.headers.get("cache-control")).toContain("no-store");
});

test.each(["text/html", "application/xml-invalid"])(
  "cancels rejected content rather than accepting a prefix media type: %s",
  async (contentType) => {
    const cancel = vi.fn(
      () =>
        new Promise<void>(() => {
          /* Simulate transport cleanup that never settles. */
        })
    );
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = await publicSitemap(
      environment(
        async () =>
          new Response(body, { headers: { "content-type": contentType } })
      )
    );
    expect(response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  }
);

test("rejects oversized sitemap bodies without waiting for cancellation", async () => {
  const cancel = vi.fn(
    () =>
      new Promise<void>(() => {
        /* Simulate transport cleanup that never settles. */
      })
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_048_577));
    },
    cancel,
  });
  const response = await publicSitemap(
    environment(
      async () =>
        new Response(body, { headers: { "content-type": "application/xml" } })
    )
  );
  expect(response.status).toBe(502);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

test("a stalled XML body reaches a deadline and releases its reader", async () => {
  vi.useFakeTimers();
  const body = new ReadableStream<Uint8Array>();
  const result = publicSitemap(
    environment(
      async () =>
        new Response(body, { headers: { "content-type": "application/xml" } })
    )
  );
  await vi.advanceTimersByTimeAsync(10_000);
  const response = await result;
  expect(response.status).toBe(502);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("a stalled fetch reaches a deadline and cancels a late response body", async () => {
  vi.useFakeTimers();
  const delayed = Promise.withResolvers<Response>();
  const result = publicSitemap(environment(() => delayed.promise));
  await vi.advanceTimersByTimeAsync(10_000);
  const response = await result;
  expect(response.status).toBe(502);
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  delayed.resolve(new Response(body));
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
