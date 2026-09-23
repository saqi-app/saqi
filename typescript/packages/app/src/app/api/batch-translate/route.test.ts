import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("retired batch translation", () => {
  it("returns an explicit retirement response without creating translation work", async () => {
    const response = POST(
      new Request("https://ops.saqi.app/api/batch-translate", {
        method: "POST",
        headers: {
          host: "ops.saqi.app",
          origin: "https://ops.saqi.app",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ authorIds: ["author-1"] }),
      })
    );
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      code: "TRANSLATION_PROVIDER_RETIRED",
    });
  });
});
