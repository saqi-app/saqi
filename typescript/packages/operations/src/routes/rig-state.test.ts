import { expect, test, vi } from "vitest";

import { parseCloudflareEnv } from "../lib/cloudflare";
import { post } from "./rig-state";

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
