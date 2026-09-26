import { beforeEach, expect, test, vi } from "vitest";
const { verifyAccessIdentity } = vi.hoisted(() => ({
  verifyAccessIdentity: vi.fn(),
}));
// eslint-disable-next-line @sarj/no-first-party-module-mock -- Test the Worker entrypoint authentication gate; the real JWT verifier has separate tests.
vi.mock("./lib/access", () => ({ verifyAccessIdentity }));
import worker from "../worker";
import { parseCloudflareEnv } from "./lib/cloudflare";

const prepare = vi.fn(() => ({ first: async () => null }));
const publicFetch = vi.fn(
  async () =>
    new Response("<sitemapindex/>", {
      headers: { "content-type": "application/xml" },
    })
);
const ENV = parseCloudflareEnv({
  DB: { prepare },
  PUBLIC_SITE: { fetch: publicFetch },
  SAQI_SOURCE_NAME: "aldiwan",
  SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
  SAQI_RIG_ACTIVE: "0",
  SAQI_DIRECT_SOURCE_ACTIVE: "0",
});
function request(path: string, method = "GET", headers = {}) {
  return new Request(`https://ops.saqi.app${path}`, {
    method,
    headers: {
      host: "ops.saqi.app",
      origin: "https://ops.saqi.app",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "content-type": "application/json",
      ...headers,
    },
    body: method === "POST" ? "{}" : null,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  verifyAccessIdentity.mockResolvedValue({ subject: "service" });
});
test("unauthenticated requests cannot reach any endpoint or D1", async () => {
  verifyAccessIdentity.mockResolvedValue(null);
  for (const path of [
    "/",
    "/api/rig/state",
    "/api/rig/source",
    "/api/public-sitemap",
    "/missing",
  ]) {
    const response = await worker.fetch(request(path), ENV);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(publicFetch).not.toHaveBeenCalled();
});
test("rejects spoofed hosts, cross-origin mutations and unsupported methods", async () => {
  for (const req of [
    request("/", "GET", { host: "evil.test" }),
    request("/api/rig/state", "POST", { origin: "https://evil.test" }),
  ]) {
    await expect(worker.fetch(req, ENV)).resolves.toMatchObject({
      status: 403,
    });
  }
  await expect(
    worker.fetch(request("/api/rig/state", "DELETE"), ENV)
  ).resolves.toMatchObject({ status: 405 });
  expect(verifyAccessIdentity).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
test("routes existing API URLs and preserves inactive mutation gates", async () => {
  const state = await worker.fetch(request("/api/rig/state"), ENV);
  expect(state.status).toBe(200);
  await expect(state.json()).resolves.toEqual({ ok: true, state: null });
  for (const path of ["/api/rig/state", "/api/rig/source"])
    await expect(
      worker.fetch(request(path, "POST"), ENV)
    ).resolves.toMatchObject({ status: 503 });
  await expect(
    worker.fetch(request("/api/rig/source"), ENV)
  ).resolves.toMatchObject({ status: 503 });
  const sitemap = await worker.fetch(request("/api/public-sitemap"), ENV);
  await expect(sitemap.json()).resolves.toEqual({ xml: "<sitemapindex/>" });
  await expect(
    worker.fetch(request("/api/public-sitemap", "POST"), ENV)
  ).resolves.toMatchObject({ status: 405 });
  await expect(
    worker.fetch(request("/_next/static/old.js"), ENV)
  ).resolves.toMatchObject({ status: 404 });
});
test("HEAD has no body and unexpected errors stay private and uncached", async () => {
  const head = await worker.fetch(request("/", "HEAD"), ENV);
  expect(head.status).toBe(200);
  await expect(head.text()).resolves.toBe("");
  verifyAccessIdentity.mockRejectedValueOnce(new Error("private details"));
  const failed = await worker.fetch(request("/api/rig/state"), ENV);
  expect(failed.status).toBe(503);
  await expect(failed.text()).resolves.toBe("Service Unavailable");
  expect(failed.headers.get("cache-control")).toContain("no-store");
});
