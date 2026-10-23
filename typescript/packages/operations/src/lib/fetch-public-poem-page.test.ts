import { afterEach, expect, test, vi } from "vitest";

import { fetchPublicPoemPage } from "./fetch-public-poem-page";
import { parseCloudflareEnv } from "./parse-cloudflare-env";

const INITIAL = "https://saqi.app/author/poet-old/poem/uuid";
const EXPECTED = "https://saqi.app/poet/old/poem/first-line-0123456789abcdef";
type PageFetch = (url: string, init?: unknown) => Promise<Response>;
function fixture(responses: Response[]) {
  const fetch = vi.fn<PageFetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch");
    return response;
  });
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    PUBLIC_SITE: { fetch },
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  if (!env.PUBLIC_SITE) throw new Error("Expected binding");
  return { fetch, site: env.PUBLIC_SITE };
}
afterEach(() => vi.useRealTimers());
test("only validated bounded 308s reach the independently expected canonical page", async () => {
  const { fetch, site } = fixture([
    new Response("redirect", { status: 308, headers: { location: EXPECTED } }),
    new Response("<html>fresh</html>"),
  ]);
  await expect(fetchPublicPoemPage(site, INITIAL, EXPECTED)).resolves.toEqual({
    url: EXPECTED,
    status: 200,
    html: "<html>fresh</html>",
  });
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([INITIAL, EXPECTED]);
  expect(fetch).toHaveBeenNthCalledWith(1, INITIAL, {
    redirect: "manual",
    signal: expect.any(AbortSignal),
  });
  expect(fetch).toHaveBeenNthCalledWith(2, EXPECTED, {
    redirect: "manual",
    signal: expect.any(AbortSignal),
  });
});
test.each([
  "https://foreign.test/author/a/poem/p",
  // eslint-disable-next-line unicorn/prefer-https -- An insecure redirect must be rejected.
  "http://saqi.app/author/a/poem/p",
  "https://user@saqi.app/author/a/poem/p",
  "/api/rig/state",
  "/author/a/poem/p?",
  "/author/a/poem/p#",
  "/author/a/poem/%2F",
  "/author/a/poem/%ff",
  "/author/a/poem/%2e%2e/p",
  String.raw`/author/a/poem/p\q`,
  "/author/a/poem/p, /author/a/poem/q",
  "",
])(
  "rejects unsafe Location %s before another binding request",
  async (location) => {
    const response = new Response("redirect", {
      status: 308,
      headers: { location },
    });
    const { fetch, site } = fixture([response]);
    await expect(
      fetchPublicPoemPage(site, INITIAL, EXPECTED)
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  }
);
test("same-origin loops and overlong chains stop within four requests", async () => {
  const loop = fixture([
    new Response(null, { status: 308, headers: { location: INITIAL } }),
  ]);
  await expect(
    fetchPublicPoemPage(loop.site, INITIAL, EXPECTED)
  ).rejects.toThrow("PUBLIC_PAGE_REDIRECT_LOOP");
  expect(loop.fetch).toHaveBeenCalledOnce();
  const chain = fixture(
    Array.from(
      { length: 4 },
      (_, index) =>
        new Response(null, {
          status: 308,
          headers: { location: `/author/old/poem/step-${String(index)}` },
        })
    )
  );
  await expect(
    fetchPublicPoemPage(chain.site, INITIAL, EXPECTED)
  ).rejects.toThrow("PUBLIC_PAGE_REDIRECT_INVALID");
  expect(chain.fetch).toHaveBeenCalledTimes(4);
});
test("a self-consistent successful wrong page cannot satisfy the independent expectation", async () => {
  const { fetch, site } = fixture([
    new Response("<link rel=canonical href=wrong>"),
  ]);
  await expect(fetchPublicPoemPage(site, INITIAL, EXPECTED)).rejects.toThrow(
    "PUBLIC_PAGE_CANONICAL_MISMATCH"
  );
  expect(fetch).toHaveBeenCalledOnce();
});
test.each([302, 404, 500])(
  "unexpected HTTP %s is not followed or treated as content",
  async (status) => {
    const { fetch, site } = fixture([
      new Response("private error", {
        status,
        headers: { location: EXPECTED },
      }),
    ]);
    await expect(fetchPublicPoemPage(site, INITIAL, EXPECTED)).resolves.toEqual(
      { url: INITIAL, status, html: "" }
    );
    expect(fetch).toHaveBeenCalledOnce();
  }
);
test("whole-chain deadline cancels a stalled terminal body and releases its reader", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const { site } = fixture([new Response(body)]);
  const pending = fetchPublicPoemPage(site, EXPECTED, EXPECTED);
  const rejected = expect(pending).rejects.toThrow("PUBLIC_PAGE_TIMEOUT");
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("relative aliases preserve exactly-once encoded and Unicode identities through three redirects", async () => {
  vi.useFakeTimers();
  const final =
    "https://saqi.app/author/%D8%B4%D8%A7%D8%B9%D8%B1/poem/%252F-e%CC%81";
  const { fetch, site } = fixture([
    new Response(null, {
      status: 308,
      headers: { location: "/author/old/poem/step-one" },
    }),
    new Response(null, { status: 308, headers: { location: "step-two" } }),
    new Response(null, {
      status: 308,
      headers: {
        location: "/author/%D8%B4%D8%A7%D8%B9%D8%B1/poem/%252F-e%CC%81",
      },
    }),
    new Response("fresh"),
  ]);
  await expect(fetchPublicPoemPage(site, INITIAL, final)).resolves.toEqual({
    url: final,
    status: 200,
    html: "fresh",
  });
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    INITIAL,
    "https://saqi.app/author/old/poem/step-one",
    "https://saqi.app/author/old/poem/step-two",
    final,
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
test("the HTML byte limit is inclusive and rejects invalid UTF-8", async () => {
  const maximum = 16 * 1024 * 1024;
  const bytes = new Uint8Array(maximum).fill(97);
  const accepted = fixture([new Response(bytes)]);
  const result = await fetchPublicPoemPage(accepted.site, EXPECTED, EXPECTED);
  expect(result.html.length).toBe(maximum);
  const rejected = fixture([new Response(new Uint8Array([255]))]);
  await expect(
    fetchPublicPoemPage(rejected.site, EXPECTED, EXPECTED)
  ).rejects.toThrow();
});
test("oversize and redirect cancellation cannot hold the deadline open", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => Promise.withResolvers<never>().promise);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
    },
    cancel,
  });
  const oversized = fixture([new Response(body)]);
  await expect(
    fetchPublicPoemPage(oversized.site, EXPECTED, EXPECTED)
  ).rejects.toThrow("PUBLIC_PAGE_TOO_LARGE");
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  const redirectCancel = vi.fn(() => Promise.withResolvers<never>().promise);
  const redirectBody = new ReadableStream<Uint8Array>({
    cancel: redirectCancel,
  });
  const redirected = fixture([
    new Response(redirectBody, {
      status: 308,
      headers: { location: EXPECTED },
    }),
    new Response("fresh"),
  ]);
  await expect(
    fetchPublicPoemPage(redirected.site, INITIAL, EXPECTED)
  ).resolves.toEqual({ url: EXPECTED, status: 200, html: "fresh" });
  expect(redirectCancel).toHaveBeenCalledOnce();
  expect(redirectBody.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
test("a fetch resolving after the chain deadline is canceled without following its redirect", async () => {
  vi.useFakeTimers();
  const late = Promise.withResolvers<Response>();
  const fetch = vi.fn<PageFetch>(() => late.promise);
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    PUBLIC_SITE: { fetch },
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  if (!env.PUBLIC_SITE) throw new Error("Expected binding");
  const pending = fetchPublicPoemPage(env.PUBLIC_SITE, INITIAL, EXPECTED);
  const rejected = expect(pending).rejects.toThrow("PUBLIC_PAGE_TIMEOUT");
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  const signal = fetch.mock.calls[0]?.[1];
  expect(signal).toEqual({
    redirect: "manual",
    signal: expect.objectContaining({ aborted: true }),
  });
  const cancel = vi.fn(() => Promise.withResolvers<never>().promise);
  const body = new ReadableStream<Uint8Array>({ cancel });
  late.resolve(
    new Response(body, { status: 308, headers: { location: EXPECTED } })
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
