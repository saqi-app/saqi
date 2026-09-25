import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  allowDocumentInlineScripts,
  withResponseHeaders,
} from "../src/lib/with-response-headers";

void describe("withResponseHeaders", () => {
  void it("allows only the generated docs page's exact inline scripts", async () => {
    const script = "console.log('schema')";
    const html = `<main><script>${script}</script></main>`;
    const response = await allowDocumentInlineScripts(
      withResponseHeaders(
        new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
        "GET",
        true,
        "/docs",
      ),
    );
    const hash = createHash("sha256").update(script).digest("base64");
    assert.ok(
      response.headers
        .get("Content-Security-Policy")
        ?.includes(`script-src 'self' 'sha256-${hash}'`),
    );
    assert.doesNotMatch(
      response.headers.get("Content-Security-Policy") ?? "",
      /unsafe-inline/u,
    );
    assert.equal(await response.text(), html);
  });
  void it("hashes scripts with whitespace in the closing tag", async () => {
    const script = "console.log('schema')";
    const html = `<script>${script}</script\t\n data-end>`;
    const response = await allowDocumentInlineScripts(
      withResponseHeaders(
        new Response(html, {
          headers: { "Content-Type": "text/html" },
        }),
        "GET",
        true,
        "/docs",
      ),
    );
    const hash = createHash("sha256").update(script).digest("base64");
    assert.ok(
      response.headers
        .get("Content-Security-Policy")
        ?.includes(`'sha256-${hash}'`),
    );
  });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    void it(`prevents caching successful ${method} responses`, () => {
      const response = withResponseHeaders(
        new Response(null, { status: 204 }),
        method,
        true,
      );

      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(
        response.headers.get("Cloudflare-CDN-Cache-Control"),
        "no-store",
      );
    });
  }

  void it("allows public caching for successful reads", () => {
    const response = withResponseHeaders(new Response("ok"), "GET", true);

    assert.equal(
      response.headers.get("Cache-Control"),
      "public, max-age=60, stale-while-revalidate=300, stale-if-error=86400",
    );
    assert.equal(
      response.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      "public, max-age=300, stale-while-revalidate=60, stale-if-error=86400",
    );
    assert.equal(response.headers.get("Cache-Tag"), "saqi-corpus");
  });

  void it("caches poem HTML for a day and tags affected views", () => {
    const poem = withResponseHeaders(
      new Response("poem"),
      "GET",
      true,
      "/author/poet/poem/id-1",
    );
    const author = withResponseHeaders(
      new Response("author"),
      "GET",
      true,
      "/author/poet/page/2",
    );
    assert.match(
      poem.headers.get("Cloudflare-CDN-Cache-Control") ?? "",
      /max-age=86400/u,
    );
    assert.equal(poem.headers.get("Cache-Tag"), "saqi-corpus,saqi-poem-id-1");
    assert.equal(
      author.headers.get("Cache-Tag"),
      "saqi-corpus,saqi-author-poet",
    );
  });
});
