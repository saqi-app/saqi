import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withResponseHeaders } from "../src/lib/with-response-headers";

await describe("withResponseHeaders", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await it(`prevents caching successful ${method} responses`, () => {
      const response = withResponseHeaders(
        new Response(null, { status: 204 }),
        method,
        true
      );

      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(
        response.headers.get("Cloudflare-CDN-Cache-Control"),
        "no-store"
      );
    });
  }

  await it("allows public caching for successful reads", () => {
    const response = withResponseHeaders(new Response("ok"), "GET", true);

    assert.equal(
      response.headers.get("Cache-Control"),
      "public, max-age=60, stale-while-revalidate=300, stale-if-error=86400"
    );
    assert.equal(
      response.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      "public, max-age=300, stale-while-revalidate=60, stale-if-error=86400"
    );
    assert.equal(
      response.headers.get("Cache-Tag"),
      "saqi-corpus,saqi-author-index"
    );
  });

  await it("caches poem HTML for a day and tags affected views", () => {
    const poem = withResponseHeaders(
      new Response("poem"),
      "GET",
      true,
      "/author/poet/poem/id-1"
    );
    const author = withResponseHeaders(
      new Response("author"),
      "GET",
      true,
      "/author/poet/page/2"
    );
    assert.match(
      poem.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      /max-age=86400/u
    );
    assert.equal(poem.headers.get("Cache-Tag"), "saqi-corpus,saqi-poem-id-1");
    assert.equal(
      author.headers.get("Cache-Tag"),
      "saqi-corpus,saqi-author-poet"
    );
    assert.equal(
      withResponseHeaders(
        new Response("sitemap"),
        "GET",
        true,
        "/sitemap-index.xml"
      ).headers.get("Cache-Tag"),
      "saqi-corpus,saqi-sitemaps"
    );
  });
});

for (const prefix of ["author", "poet"]) {
  await it(`preserves stable cache identities and poem lifetime for ${prefix} redirects`, () => {
    const response = withResponseHeaders(
      new Response(null, { status: 308 }),
      "GET",
      true,
      `/${prefix}/source/poem/id`
    );
    assert.match(
      response.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      /max-age=86400/u
    );
    assert.equal(response.headers.get("Cache-Tag"), "saqi-corpus,saqi-poem-id");
    assert.equal(
      withResponseHeaders(
        new Response(null, { status: 308 }),
        "GET",
        true,
        `/${prefix}/source/page/2`
      ).headers.get("Cache-Tag"),
      "saqi-corpus,saqi-author-source"
    );
  });
}

for (const status of [200, 308]) {
  await it(`uses stable resolved identities for readable HTTP ${String(status)}`, () => {
    const response = withResponseHeaders(
      new Response(null, { status }),
      "GET",
      true,
      "/author/clean-name/poem/readable-first-line",
      { authorSlug: "poet-source-name", poemId: "stable-id" }
    );
    assert.equal(
      response.headers.get("Cache-Tag"),
      "saqi-corpus,saqi-author-poet-source-name,saqi-poem-stable-id"
    );
  });
}

await it("preserves explicit private responses when adding resolved cache ownership", () => {
  const response = withResponseHeaders(
    new Response("private", {
      headers: { "Cache-Control": "private, max-age=0" },
    }),
    "GET",
    true,
    "/author/clean",
    { authorSlug: "poet-source" }
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(
    response.headers.get("Cloudflare-CDN-Cache-Control"),
    "no-store"
  );
  assert.equal(response.headers.get("Cache-Tag"), null);
});

for (const method of ["GET", "HEAD"]) {
  for (const status of [200, 404, 410]) {
    for (const cacheControl of [
      "no-store",
      "private",
      'private="Set-Cookie"',
    ]) {
      await it(`preserves ${cacheControl} for production ${method} ${String(status)}`, () => {
        const response = withResponseHeaders(
          new Response(null, {
            status,
            headers: { "Cache-Control": cacheControl, "Cache-Tag": "supplied" },
          }),
          method,
          true
        );
        assert.equal(
          response.headers.get("Cloudflare-CDN-Cache-Control"),
          "no-store"
        );
        assert.equal(response.headers.get("Cache-Tag"), null);
      });
    }
  }
}

await it("uses resolved poem caching for encoded static route markers", () => {
  const response = withResponseHeaders(
    new Response(null, { status: 308 }),
    "GET",
    true,
    "/%61uthor/source/%70oem/id",
    { authorSlug: "source", poemId: "id" }
  );
  assert.match(
    response.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
    /max-age=86400/u
  );
});
