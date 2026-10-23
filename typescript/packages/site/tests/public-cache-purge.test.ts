import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handlePublicCachePurge } from "../src/lib/public-cache-purge";

const URL = "https://saqi.app/internal/purge-publication-cache";
const SECRET = "a".repeat(64);

await it("accepts JSON media types with charset parameters", async () => {
  const purge = async () => ({ success: true as const });
  const response = await handlePublicCachePurge(
    new Request(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "Application/JSON; charset=utf-8",
      },
      body: JSON.stringify({ authorIndex: true }),
    }),
    SECRET,
    purge
  );
  assert.equal(response?.status, 204);
});

for (const headers of [
  { "content-length": "-1" },
  { "content-length": "NaN" },
  { "content-length": "1.5" },
  { "content-length": "Infinity" },
  { "content-length": "320001" },
  { "content-encoding": "gzip" },
]) {
  await it(`rejects invalid purge metadata before reading: ${JSON.stringify(headers)}`, async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ authorIndex: true }),
    });
    let purged = false;
    const response = await handlePublicCachePurge(request, SECRET, async () => {
      purged = true;
      return { success: true };
    });
    assert.equal(response?.status, 400);
    assert.equal(request.bodyUsed, false);
    assert.equal(purged, false);
  });
}

await it("rejects malformed UTF-8 identities before purging", async () => {
  const prefix = new TextEncoder().encode('{"authorSlug":"');
  const suffix = new TextEncoder().encode('","poemId":"p"}');
  const body = new Uint8Array([...prefix, 0xff, ...suffix]);
  let purged = false;
  const response = await handlePublicCachePurge(
    new Request(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body,
    }),
    SECRET,
    async () => {
      purged = true;
      return { success: true };
    }
  );
  assert.equal(response?.status, 400);
  assert.equal(purged, false);
});

for (const [body, expected] of [
  [{ authorIndex: true }, ["saqi-author-index", "saqi-sitemaps"]],
  [{ authorIndex: true, bootstrap: true }, ["saqi-corpus"]],
  [
    {
      authorSlug: "__saqi_deployment_probe__",
      poemId: "__saqi_deployment_probe__",
    },
    [
      "saqi-poem-__saqi_deployment_probe__",
      "saqi-author-__saqi_deployment_probe__",
    ],
  ],
] as const) {
  await it(`isolates index/bootstrap/probe purge scope: ${JSON.stringify(body)}`, async () => {
    let tags: string[] = [];
    const response = await handlePublicCachePurge(
      new Request(URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      SECRET,
      async (requestedTags) => {
        tags = requestedTags;
        return { success: true };
      }
    );
    assert.equal(response?.status, 204);
    assert.deepEqual(tags, expected);
  });
}

await describe("public Worker cache purge", async () => {
  await it("rejects unauthenticated calls without purging", async () => {
    let calls = 0;
    const response = await handlePublicCachePurge(
      new Request(URL, { method: "POST", body: "{}" }),
      SECRET,
      async () => {
        calls += 1;
        return { success: true };
      }
    );
    assert.equal(response?.status, 404);
    assert.equal(calls, 0);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });

  await it("purges exactly the published poem and affected indexes", async () => {
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
      }
    );
    assert.equal(response?.status, 204);
    assert.deepEqual(tags, [
      "saqi-poem-id-1",
      "saqi-author-poet",
      "saqi-sitemaps",
    ]);
  });

  await it("reports purge rejection so operations can retry", async () => {
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
      async () => ({
        success: false,
        errors: [{ code: 1001, message: "Cache purge denied" }],
      })
    );
    assert.equal(response?.status, 503);
    assert.deepEqual(await response.json(), {
      code: "PUBLIC_CACHE_PURGE_FAILED",
      errors: [{ code: 1001, message: "Cache purge denied" }],
    });
  });

  await it("purges the corpus with one authenticated tag", async () => {
    let tags: string[] = [];
    const response = await handlePublicCachePurge(
      new Request(URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ all: true }),
      }),
      SECRET,
      async (requestedTags) => {
        tags = requestedTags;
        return { success: true };
      }
    );
    assert.equal(response?.status, 204);
    assert.deepEqual(tags, ["saqi-corpus"]);
  });
});

await it("purges fifty poems and shared author indexes in one bounded deduplicated request", async () => {
  const poems = Array.from({ length: 50 }, (_, index) => ({
    authorSlug: "poet",
    poemId: `${String(index)}-${"a".repeat(90)}`,
  }));
  let tags: string[] = [];
  const response = await handlePublicCachePurge(
    new Request(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ poems }),
    }),
    SECRET,
    async (requestedTags) => {
      tags = requestedTags;
      return { success: true };
    }
  );
  assert.equal(response?.status, 204);
  assert.deepEqual(tags, [
    ...poems.flatMap((poem, index) =>
      index === 0
        ? [`saqi-poem-${poem.poemId}`, "saqi-author-poet"]
        : `saqi-poem-${poem.poemId}`
    ),
    "saqi-sitemaps",
  ]);
});

for (const count of [0, 51]) {
  await it(`refuses a batch of ${String(count)} poems before purging`, async () => {
    let calls = 0;
    const response = await handlePublicCachePurge(
      new Request(URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          poems: Array.from({ length: count }, () => ({
            authorSlug: "poet",
            poemId: "one",
          })),
        }),
      }),
      SECRET,
      async () => {
        calls += 1;
        return { success: true };
      }
    );
    assert.equal(response?.status, 400);
    assert.equal(calls, 0);
  });
}

await it("coalesces forty-nine distinct poem/author pairs and the homepage and sitemaps into one hundred tags", async () => {
  const poems = Array.from({ length: 49 }, (_, index) => ({
    authorSlug: `poet-${String(index)}`,
    poemId: `p-${String(index)}`,
  }));
  let tags: string[] = [];
  const response = await handlePublicCachePurge(
    new Request(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ authorIndex: true, poems }),
    }),
    SECRET,
    async (requested) => {
      tags = requested;
      return { success: true };
    }
  );
  assert.equal(response?.status, 204);
  assert.equal(tags.length, 100);
  assert.deepEqual(tags, [
    ...poems.flatMap(({ authorSlug, poemId }) => [
      `saqi-poem-${poemId}`,
      `saqi-author-${authorSlug}`,
    ]),
    "saqi-author-index",
    "saqi-sitemaps",
  ]);
});

await it("rejects a combined fifty-poem/index request before any Cloudflare purge", async () => {
  let calls = 0;
  const response = await handlePublicCachePurge(
    new Request(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        authorIndex: true,
        poems: Array.from({ length: 50 }, (_, index) => ({
          authorSlug: `poet-${String(index)}`,
          poemId: `p-${String(index)}`,
        })),
      }),
    }),
    SECRET,
    async () => {
      calls += 1;
      return { success: true };
    }
  );
  assert.equal(response?.status, 400);
  assert.equal(calls, 0);
});

for (const failSecond of [false, true]) {
  await it(`chunks fifty distinct owners and sitemaps, second-chunk failure=${String(failSecond)}`, async () => {
    const chunks: string[][] = [];
    const response = await handlePublicCachePurge(
      new Request(URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          poems: Array.from({ length: 50 }, (_, index) => ({
            authorSlug: `author-${String(index)}`,
            poemId: `poem-${String(index)}`,
          })),
        }),
      }),
      SECRET,
      async (tags) => {
        chunks.push(tags);
        return failSecond && chunks.length === 2
          ? { success: false }
          : { success: true };
      }
    );
    assert.equal(response?.status, failSecond ? 503 : 204);
    assert.deepEqual(
      chunks.map((tags) => tags.length),
      [100, 1]
    );
    assert.deepEqual(chunks[1], ["saqi-sitemaps"]);
  });
}

await it("accepts a bounded full Unicode batch with escaped 500-unit identities", async () => {
  const body = JSON.stringify({
    poems: Array.from({ length: 50 }, (_, index) => ({
      authorSlug: "漢".repeat(497) + String(index).padStart(3, "0"),
      poemId: "字".repeat(497) + String(index).padStart(3, "0"),
    })),
  })
    .replaceAll("漢", String.raw`\u6f22`)
    .replaceAll("字", String.raw`\u5b57`);
  assert.ok(body.length > 290000 && body.length < 320000);
  const chunks: string[][] = [];
  const response = await handlePublicCachePurge(
    new Request(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body,
    }),
    SECRET,
    async (tags) => {
      chunks.push(tags);
      return { success: true };
    }
  );
  assert.equal(response?.status, 204);
  assert.ok(chunks.flat().every((tag) => tag.length <= 1024));
  assert.equal(new Set(chunks.flat()).size, 101);
});

await it("includes sitemaps when an index invalidation contains the reserved probe pair", async () => {
  const tags: string[] = [];
  const response = await handlePublicCachePurge(
    new Request(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        authorIndex: true,
        poems: [
          {
            authorSlug: "__saqi_deployment_probe__",
            poemId: "__saqi_deployment_probe__",
          },
        ],
      }),
    }),
    SECRET,
    async (chunk) => {
      tags.push(...chunk);
      return { success: true };
    }
  );
  assert.equal(response?.status, 204);
  assert.ok(tags.includes("saqi-author-index"));
  assert.ok(tags.includes("saqi-sitemaps"));
});

await it("authenticates the separate route capability without reads or public cacheability", async () => {
  const { handlePublicRouteCapabilities } =
    await import("../src/lib/handle-public-route-capabilities");
  const route = "https://saqi.app/internal/public-route-capabilities";
  const authorized = handlePublicRouteCapabilities(
    new Request(route, { headers: { authorization: `Bearer ${SECRET}` } }),
    SECRET
  );
  assert.equal(authorized.status, 200);
  assert.equal(
    authorized.headers.get("Cloudflare-CDN-Cache-Control"),
    "no-store"
  );
  assert.deepEqual(await authorized.json(), {
    ok: true,
    publicRoutes: "persistent-alias-v1",
  });
});

for (const [path, method, authorization, configuredSecret] of [
  ["/internal/public-route-capabilities", "GET", undefined, SECRET],
  ["/internal/public-route-capabilities", "GET", "Bearer wrong", SECRET],
  ["/internal/public-route-capabilities", "GET", `Bearer ${SECRET}`, undefined],
  ["/internal/public-route-capabilities", "POST", `Bearer ${SECRET}`, SECRET],
  [
    "/internal/public-route-capabilities?extra=1",
    "GET",
    `Bearer ${SECRET}`,
    SECRET,
  ],
  ["/internal/public-route-capabilities/", "GET", `Bearer ${SECRET}`, SECRET],
] as const) {
  await it(`rejects route capability ${method} ${path} authorization=${String(authorization !== undefined)} configured=${String(configuredSecret !== undefined)}`, async () => {
    const { handlePublicRouteCapabilities } =
      await import("../src/lib/handle-public-route-capabilities");
    const headers = new Headers();
    if (authorization) headers.set("authorization", authorization);
    const response = handlePublicRouteCapabilities(
      new Request(`https://saqi.app${path}`, { method, headers }),
      configuredSecret
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(
      response.headers.get("Cloudflare-CDN-Cache-Control"),
      "no-store"
    );
    assert.equal(await response.text(), "");
  });
}
