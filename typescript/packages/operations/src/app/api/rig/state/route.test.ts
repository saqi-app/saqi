import { expect, test, vi } from "vitest";

const { getCloudflareEnv } = vi.hoisted(() => ({ getCloudflareEnv: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareEnv }));

import { POST } from "./route";

test("inactive rig refuses mutation before reading D1", async () => {
  const prepare = vi.fn();
  getCloudflareEnv.mockReturnValue({
    DB: { prepare },
    SAQI_RIG_ACTIVE: "0",
  });
  const response = await POST(
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
    })
  );
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toMatchObject({
    code: "RIG_INACTIVE",
  });
  expect(prepare).not.toHaveBeenCalled();
});
