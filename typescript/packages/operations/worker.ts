import { type AccessEnv, verifyAccessIdentity } from "./src/lib/access";
import { type CloudflareEnv, parseCloudflareEnv } from "./src/lib/cloudflare";
import {
  isTrustedMutationRequest,
  OPS_ORIGIN,
  secureOperationsResponse,
} from "./src/lib/operations-boundary";
import { get as publicSitemap } from "./src/routes/public-sitemap";
import * as source from "./src/routes/rig-source";
import * as state from "./src/routes/rig-state";

async function route(request: Request, bindings: AccessEnv): Promise<Response> {
  if (!isAllowedHost(request))
    return new Response("Forbidden", { status: 403 });
  if (!["GET", "HEAD", "POST"].includes(request.method))
    return new Response("Method Not Allowed", { status: 405 });
  if (request.method === "POST" && !isTrustedMutationRequest(request))
    return new Response("Forbidden", { status: 403 });
  if (!(await verifyAccessIdentity(request, bindings)))
    return new Response("Forbidden", { status: 403 });

  const path = new URL(request.url).pathname;
  const read = request.method !== "POST";
  if (path === "/" && read)
    return new Response("Saqi Operations\nCollection and publication API.\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  if (
    !["/api/rig/state", "/api/rig/source", "/api/public-sitemap"].includes(path)
  )
    return new Response("Not Found", { status: 404 });
  if (path === "/api/public-sitemap" && !read)
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });

  const env = parseCloudflareEnv(bindings);
  switch (path) {
    case "/api/rig/state":
      return read ? state.get(request, env) : state.post(request, env);
    case "/api/rig/source":
      return read ? source.get(request, env) : source.post(request, env);
    default:
      return publicSitemap(env);
  }
}

export default {
  async fetch(
    request: Request,
    env: AccessEnv & CloudflareEnv
  ): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch {
      response = new Response("Service Unavailable", { status: 503 });
    }
    if (request.method === "HEAD") response = new Response(null, response);
    return secureOperationsResponse(response);
  },
};

function isAllowedHost(request: Request): boolean {
  const url = new URL(request.url);
  if (request.headers.get("host") !== url.host) return false;
  return (
    url.origin === OPS_ORIGIN ||
    (!("cf" in request) &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
  );
}
