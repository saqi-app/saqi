import { expect, test, vi } from "vitest";

import { parseCloudflareEnv } from "../lib/cloudflare";
import { post } from "./rig-state";

test("inactive rig refuses mutation before reading D1", async () => {
  const prepare = vi.fn();
  const env = parseCloudflareEnv({
    DB: { prepare },
    SAQI_RIG_ACTIVE: "0",
    SAQI_SOURCE_NAME: "aldiwan",
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
