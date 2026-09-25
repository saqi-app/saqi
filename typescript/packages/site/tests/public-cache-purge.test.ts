import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handlePublicCachePurge } from "../src/lib/public-cache-purge";

const URL = "https://saqi.app/internal/purge-publication-cache";
const SECRET = "a".repeat(64);

void describe("public Worker cache purge", () => {
  void it("rejects unauthenticated calls without purging", async () => {
    let calls = 0;
    const response = await handlePublicCachePurge(
      new Request(URL, { method: "POST", body: "{}" }),
      SECRET,
      async () => {
        calls += 1;
        return { success: true };
      },
    );
    assert.equal(response?.status, 404);
    assert.equal(calls, 0);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });

  void it("purges exactly the published poem and affected indexes", async () => {
    let tags: string[] = [];
    const response = await handlePublicCachePurge(
      new Request(URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ authorSlug: "poet", poemId: "id-1" }),
      }),
      SECRET,
      async (requestedTags) => {
        tags = requestedTags;
        return { success: true };
      },
    );
    assert.equal(response?.status, 204);
    assert.deepEqual(tags, [
      "saqi-poem-id-1",
      "saqi-author-poet",
    ]);
  });

  void it("reports purge rejection so operations can retry", async () => {
    const response = await handlePublicCachePurge(
      new Request(URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ authorSlug: "poet", poemId: "id-1" }),
      }),
      SECRET,
      async () => ({ success: false }),
    );
    assert.equal(response?.status, 503);
  });
});
