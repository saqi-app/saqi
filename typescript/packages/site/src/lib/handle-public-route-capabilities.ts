import {
  PUBLIC_ROUTE_CAPABILITIES_PATH,
  PUBLIC_ROUTE_VERSION,
} from "@saqi/precedent-iso";

import {
  PUBLIC_CACHE_NO_STORE_HEADERS,
  publicCacheAuthorized,
} from "./public-cache-purge";

export function handlePublicRouteCapabilities(
  request: Request,
  secret: string | undefined
): Response {
  const url = new URL(request.url);
  if (
    !["GET", "HEAD"].includes(request.method) ||
    url.pathname !== PUBLIC_ROUTE_CAPABILITIES_PATH ||
    url.search ||
    !publicCacheAuthorized(request.headers.get("authorization"), secret)
  )
    return new Response(null, {
      status: 404,
      headers: PUBLIC_CACHE_NO_STORE_HEADERS,
    });
  return Response.json(
    { ok: true, publicRoutes: PUBLIC_ROUTE_VERSION },
    { headers: PUBLIC_CACHE_NO_STORE_HEADERS }
  );
}
