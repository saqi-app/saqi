import { PUBLIC_ROUTE_VERSION } from "@saqi/precedent-iso";
import {
  afterEach,
  beforeEach,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

import { parseCloudflareEnv } from "../lib/parse-cloudflare-env";
import { PublicRouteCacheRepository } from "../lib/public-route-cache-repository";
import { PublicRouteRepository } from "../lib/public-route-repository";
import { get, post } from "./public-routes";

let advance: MockInstance<PublicRouteRepository["advance"]>;
let acknowledge: MockInstance<PublicRouteCacheRepository["acknowledge"]>;
beforeEach(() => {
  advance = vi
    .spyOn(PublicRouteRepository.prototype, "advance")
    .mockResolvedValue({
      authorsActivated: 1,
      authorsChecked: 1,
      poemsActivated: 0,
      poemsChecked: 0,
      pending: true,
    });
  vi.spyOn(PublicRouteRepository.prototype, "pending").mockResolvedValue(false);
  acknowledge = vi
    .spyOn(PublicRouteCacheRepository.prototype, "acknowledge")
    .mockResolvedValue({ acknowledged: 1000, pending: true });
});
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const prepare = vi.fn(() => ({
    first: async () => ({ pending: 1, purgedEpoch: 123 }),
  }));
  const fetch = vi.fn(async () =>
    Response.json({ ok: true, publicRoutes: PUBLIC_ROUTE_VERSION })
  );
  const env = parseCloudflareEnv({
    DB: { prepare },
    PUBLIC_SITE: { fetch },
    SAQI_PUBLIC_CACHE_PURGE_SECRET: "a".repeat(64),
    SAQI_PUBLIC_ORIGIN: "https://saqi.app",
    SAQI_SOURCE_NAME: "fixture",
    SAQI_SOURCE_BASE_URL: "https://poetry.example",
    SAQI_RIG_ACTIVE: "0",
  });
  return { env, prepare, fetch };
}
function request(
  body: unknown,
  path = "",
  headers: Record<string, string> = {}
) {
  return new Request(`https://ops.saqi.app/api/public-routes${path}`, {
    method: "POST",
    headers: {
      host: "ops.saqi.app",
      origin: "https://ops.saqi.app",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
test("read-only status exposes bounded metadata without readiness requests or allocation", async () => {
  const { env, prepare, fetch } = fixture();
  const response = await get(
    new Request("https://ops.saqi.app/api/public-routes"),
    env
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  await expect(response.json()).resolves.toEqual({
    ok: true,
    pending: false,
    cachePending: true,
    purgedEpoch: 123,
  });
  expect(prepare).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});
test("advance proves the deployed site contract before allocating, independently of paid rig activation", async () => {
  const { env, fetch } = fixture();
  const response = await post(request({ action: "advance", limit: 7 }), env);
  expect(response.status).toBe(200);
  expect(fetch).toHaveBeenCalledOnce();
  expect(advance).toHaveBeenCalledWith(7);
  expect(fetch.mock.invocationCallOrder[0]).toBeLessThan(
    advance.mock.invocationCallOrder[0] ?? 0
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
});
test("an incompatible deployed site cannot allocate or acknowledge metadata", async () => {
  const { env, fetch } = fixture();
  fetch.mockResolvedValueOnce(
    Response.json({ ok: true, publicationCompareAndSwap: "returning-row-v1" })
  );
  const response = await post(request({ action: "advance" }), env);
  expect(response.status).toBe(503);
  expect(response.headers.get("x-saqi-public-routes-stage")).toBe(
    "reader-readiness"
  );
  await expect(response.json()).resolves.toEqual({
    ok: false,
    code: "PUBLIC_ROUTES_UNAVAILABLE",
  });
  expect(advance).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
});
test("allocation failures expose only their stage after reader readiness succeeds", async () => {
  const { env, fetch } = fixture();
  advance.mockRejectedValueOnce(new Error("PRIVATE_PAID_SENTINEL"));
  const response = await post(request({ action: "advance" }), env);
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-saqi-public-routes-stage")).toBe("operation");
  await expect(response.json()).resolves.toEqual({
    ok: false,
    code: "PUBLIC_ROUTES_UNAVAILABLE",
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(advance).toHaveBeenCalledOnce();
  expect(acknowledge).not.toHaveBeenCalled();
});
test("status failures expose only the operation stage without readiness or allocation", async () => {
  const { env, fetch, prepare } = fixture();
  vi.spyOn(PublicRouteRepository.prototype, "pending").mockRejectedValueOnce(
    new Error("PRIVATE_PAID_SENTINEL")
  );
  const response = await get(
    new Request("https://ops.saqi.app/api/public-routes"),
    env
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("x-saqi-public-routes-stage")).toBe("operation");
  await expect(response.json()).resolves.toEqual({
    ok: false,
    code: "PUBLIC_ROUTES_UNAVAILABLE",
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});
test("proof drain is bounded and needs no new network purge or activation", async () => {
  const { env, fetch, prepare } = fixture();
  const response = await post(request({ action: "acknowledge" }), env);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    acknowledged: 1000,
    pending: true,
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});
test.each([
  { action: "advance", limit: 0 },
  { action: "advance", limit: 101 },
  { action: "advance", limit: 1.5 },
  { action: "advance", limit: "1" },
  { action: "advance", execute: true },
  { action: "acknowledge", limit: 20 },
  { action: "purge", epoch: 100 },
  { action: "other" },
  {},
])(
  "rejects unknown or mixed action fields %j before metadata work",
  async (body) => {
    const { env, prepare, fetch } = fixture();
    const response = await post(request(body), env);
    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  }
);
test.each([
  { path: "?action=advance", headers: {}, status: 400 },
  { path: "", headers: { origin: "https://foreign.test" }, status: 403 },
  { path: "", headers: { "content-type": "text/plain" }, status: 415 },
  { path: "", headers: { "content-encoding": "gzip" }, status: 400 },
  { path: "", headers: { "content-length": "16385" }, status: 400 },
])(
  "rejects query/origin/type/encoding/oversize boundary $status",
  async ({ path, headers, status }) => {
    const { env, prepare, fetch } = fixture();
    const response = await post(
      request({ action: "advance" }, path, headers),
      env
    );
    expect(response.status).toBe(status);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  }
);
test("actual streamed oversize/malformed bodies fail without allocation and errors remain private", async () => {
  const { env, prepare, fetch } = fixture();
  for (const body of [
    '{"action":',
    JSON.stringify({ action: "advance", padding: "x".repeat(17000) }),
  ]) {
    const base = request({ action: "advance" });
    const response = await post(
      new Request(base.url, {
        method: "POST",
        headers: base.headers,
        body,
      }),
      env
    );
    expect(response.status).toBe(400);
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  acknowledge.mockRejectedValueOnce(
    new Error("private paid content and credentials")
  );
  const response = await post(request({ action: "acknowledge" }), env);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    code: "PUBLIC_ROUTES_UNAVAILABLE",
  });
});
