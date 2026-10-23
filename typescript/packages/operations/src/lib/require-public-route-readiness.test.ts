import { afterEach, expect, test, vi } from "vitest";

import { parseCloudflareEnv } from "./parse-cloudflare-env";
import { requirePublicRouteReadiness } from "./require-public-route-readiness";

const SECRET = "a".repeat(64);
const CAPABILITY = { ok: true, publicRoutes: "persistent-alias-v1" };
type CapabilityFetch = (url: string, init?: RequestInit) => Promise<Response>;
function environment(fetch: CapabilityFetch) {
  const prepare = vi.fn(() => {
    throw new Error("UNEXPECTED_DATABASE_READ");
  });
  const env = parseCloudflareEnv({
    DB: { prepare },
    PUBLIC_SITE: { fetch },
    SAQI_PUBLIC_ORIGIN: "https://saqi.app",
    SAQI_PUBLIC_CACHE_PURGE_SECRET: SECRET,
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
  });
  return { env, prepare };
}
afterEach(() => vi.useRealTimers());

test("proves the deployed site through the authenticated binding without a database read", async () => {
  const fetch = vi
    .fn<CapabilityFetch>()
    .mockResolvedValue(Response.json(CAPABILITY));
  const { env, prepare } = environment(fetch);
  await requirePublicRouteReadiness(env);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://saqi.app/internal/public-route-capabilities",
    {
      method: "GET",
      redirect: "manual",
      signal: expect.any(AbortSignal),
      headers: { authorization: `Bearer ${SECRET}` },
    }
  );
  expect(prepare).not.toHaveBeenCalled();
});

test.each([301, 302, 307, 308, 404, 500])(
  "rejects HTTP %s without following redirects",
  async (status) => {
    const fetch = vi.fn<CapabilityFetch>().mockResolvedValue(
      new Response("private sentinel", {
        status,
        headers: { location: "https://untrusted.example/private" },
      })
    );
    const { env, prepare } = environment(fetch);
    await expect(requirePublicRouteReadiness(env)).rejects.toThrow(
      /^PUBLIC_ROUTES_SITE_NOT_READY$/u
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  }
);

test.each([
  { ok: true, capabilities: { publicationCompareAndSwap: "returning-row-v1" } },
  { ok: true, publicRoutes: "old" },
  { ...CAPABILITY, privateData: "private sentinel" },
  { ok: false, publicRoutes: "persistent-alias-v1" },
])("rejects unsupported or extra capability fields %j", async (body) => {
  const fetch = vi.fn<CapabilityFetch>().mockResolvedValue(Response.json(body));
  const { env } = environment(fetch);
  await expect(requirePublicRouteReadiness(env)).rejects.toThrow(
    /^PUBLIC_ROUTES_SITE_NOT_READY$/u
  );
});

test.each([
  new Uint8Array([255]),
  new TextEncoder().encode("{"),
  new Uint8Array(1_025),
])("rejects malformed, invalid UTF-8 and oversized responses", async (body) => {
  const fetch = vi.fn<CapabilityFetch>().mockResolvedValue(new Response(body));
  const { env } = environment(fetch);
  await expect(requirePublicRouteReadiness(env)).rejects.toThrow(
    /^PUBLIC_ROUTES_SITE_NOT_READY$/u
  );
});

test("times out the entire request and releases a late response even when cancellation never settles", async () => {
  vi.useFakeTimers();
  const responseDeferred = Promise.withResolvers<Response>();
  const fetch = vi.fn<CapabilityFetch>(() => responseDeferred.promise);
  const pending = requirePublicRouteReadiness(environment(fetch).env);
  const rejection = expect(pending).rejects.toThrow(
    /^PUBLIC_ROUTES_SITE_NOT_READY$/u
  );
  await vi.advanceTimersByTimeAsync(10_000);
  await rejection;
  const cancel = vi.fn(
    () =>
      new Promise<void>(() => {
        /* Simulate transport cleanup that never settles. */
      })
  );
  const body = new ReadableStream<Uint8Array>({ cancel });
  const response = new Response(body);
  responseDeferred.resolve(response);
  await vi.advanceTimersByTimeAsync(1);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("oversize rejection releases its lock without awaiting a stalled transport cancellation", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(
    () =>
      new Promise<void>(() => {
        /* Simulate transport cleanup that never settles. */
      })
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_025));
    },
    cancel,
  });
  const fetch = vi.fn<CapabilityFetch>().mockResolvedValue(new Response(body));
  const pending = requirePublicRouteReadiness(environment(fetch).env);
  const rejection = expect(pending).rejects.toThrow(
    /^PUBLIC_ROUTES_SITE_NOT_READY$/u
  );
  await vi.advanceTimersByTimeAsync(50);
  expect(vi.getTimerCount()).toBe(0);
  expect(body.locked).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  await rejection;
});

test("missing binding or credentials cannot authorize allocation", async () => {
  const fetch = vi
    .fn<CapabilityFetch>()
    .mockResolvedValue(Response.json(CAPABILITY));
  const { env } = environment(fetch);
  env.PUBLIC_SITE = undefined;
  env.SAQI_PUBLIC_CACHE_PURGE_SECRET = undefined;
  await expect(requirePublicRouteReadiness(env)).rejects.toThrow(
    "PUBLIC_ROUTES_SITE_UNAVAILABLE"
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("times out an already-started successful response body read and releases its reader", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(
    () =>
      new Promise<void>(() => {
        /* Simulate transport cleanup that never settles. */
      })
  );
  const body = new ReadableStream<Uint8Array>({ cancel });
  const fetch = vi.fn<CapabilityFetch>().mockResolvedValue(new Response(body));
  const { env, prepare } = environment(fetch);
  const pending = requirePublicRouteReadiness(env);
  let settled = false;
  const observation = (async () => {
    try {
      await pending;
    } catch {
      /* Observe rejection without changing the original promise. */
    }
    settled = true;
  })();
  const rejection = expect(pending).rejects.toThrow(
    /^PUBLIC_ROUTES_SITE_NOT_READY$/u
  );
  await vi.advanceTimersByTimeAsync(9_999);
  expect(settled).toBe(false);
  expect(body.locked).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  await rejection;
  await observation;
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(prepare).not.toHaveBeenCalled();
});

test.each(["fetch", "body"] as const)(
  "sanitizes private errors from %s without database access",
  async (stage) => {
    const fetch = vi.fn<CapabilityFetch>();
    if (stage === "fetch")
      fetch.mockRejectedValue(new Error(`private sentinel ${SECRET}`));
    else
      fetch.mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`private sentinel ${SECRET}`));
            },
          })
        )
      );
    const { env, prepare } = environment(fetch);
    await expect(requirePublicRouteReadiness(env)).rejects.toThrow(
      /^PUBLIC_ROUTES_SITE_NOT_READY$/u
    );
    expect(prepare).not.toHaveBeenCalled();
  }
);

test.each(["binding", "secret"] as const)(
  "rejects partial configuration missing %s before fetching",
  async (missing) => {
    const fetch = vi
      .fn<CapabilityFetch>()
      .mockResolvedValue(Response.json(CAPABILITY));
    const { env, prepare } = environment(fetch);
    if (missing === "binding") env.PUBLIC_SITE = undefined;
    else env.SAQI_PUBLIC_CACHE_PURGE_SECRET = undefined;
    await expect(requirePublicRouteReadiness(env)).rejects.toThrow(
      /^PUBLIC_CACHE_CONFIG_INVALID$/u
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  }
);
