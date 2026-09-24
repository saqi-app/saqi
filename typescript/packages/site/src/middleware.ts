import { defineMiddleware } from "astro:middleware";

import { canonicalRedirectUrl, isReadMethod } from "./lib/canonical-request";
import { PURGE_PATH } from "./lib/public-cache-purge";
import {
  allowDocumentInlineScripts,
  withResponseHeaders,
} from "./lib/with-response-headers";

const CANONICAL_HOST = "saqi.app";

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const production = url.hostname === CANONICAL_HOST;
  if (url.pathname === PURGE_PATH && context.request.method === "POST") {
    return next();
  }
  if (!isReadMethod(context.request.method)) {
    return withResponseHeaders(
      new Response("Method Not Allowed", {
        headers: { Allow: "GET, HEAD" },
        status: 405,
      }),
      context.request.method,
      production,
      url.pathname,
    );
  }
  const redirectUrl = canonicalRedirectUrl(url.href, context.request.method);
  if (redirectUrl) {
    const response = withResponseHeaders(
      Response.redirect(redirectUrl, 308),
      context.request.method,
      redirectUrl.hostname === CANONICAL_HOST,
      url.pathname,
    );
    if (url.search) {
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    }
    return response;
  }

  const response = withResponseHeaders(
    await next(),
    context.request.method,
    production,
    url.pathname,
  );
  return url.pathname === "/docs"
    ? allowDocumentInlineScripts(response)
    : response;
});
