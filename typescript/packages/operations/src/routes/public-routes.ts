import { z } from "zod";

import { bootstrapDirtyPublicCache } from "../lib/author-index-cache";
import {
  hasJsonContentType,
  isTrustedMutationRequest,
  NO_STORE_HEADERS,
  readBoundedJson,
} from "../lib/operations-boundary";
import type { CloudflareEnv } from "../lib/parse-cloudflare-env";
import { PublicRouteCacheRepository } from "../lib/public-route-cache-repository";
import { PublicRouteRepository } from "../lib/public-route-repository";
import { requirePublicRouteReadiness } from "../lib/require-public-route-readiness";

const RequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("advance"),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.strictObject({ action: z.literal("acknowledge") }),
  z.strictObject({ action: z.literal("purge") }),
]);
function failure(status: number, code: string): Response {
  return Response.json(
    { ok: false, code },
    { status, headers: NO_STORE_HEADERS }
  );
}
type FailureStage = "operation" | "reader-readiness";
function unavailable(stage: FailureStage): Response {
  const response = failure(503, "PUBLIC_ROUTES_UNAVAILABLE");
  response.headers.set("x-saqi-public-routes-stage", stage);
  return response;
}
export async function get(
  request: Request,
  env: CloudflareEnv
): Promise<Response> {
  if (new URL(request.url).search)
    return failure(400, "INVALID_PUBLIC_ROUTES_QUERY");
  try {
    const pending = await new PublicRouteRepository(env.DB).pending();
    const cache = await new PublicRouteCacheRepository(env.DB).status();
    return Response.json(
      {
        ok: true,
        pending,
        cachePending: cache.pending === 1,
        purgedEpoch: cache.purgedEpoch,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch {
    return unavailable("operation");
  }
}
export async function post(
  request: Request,
  env: CloudflareEnv
): Promise<Response> {
  if (!isTrustedMutationRequest(request)) return failure(403, "FORBIDDEN");
  if (new URL(request.url).search)
    return failure(400, "INVALID_PUBLIC_ROUTES_QUERY");
  if (!hasJsonContentType(request)) return failure(415, "JSON_REQUIRED");
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await readBoundedJson(request));
  } catch {
    return failure(400, "INVALID_PUBLIC_ROUTES_REQUEST");
  }
  let stage: FailureStage = "operation";
  try {
    switch (input.action) {
      case "advance":
        stage = "reader-readiness";
        await requirePublicRouteReadiness(env);
        stage = "operation";
        return Response.json(
          {
            ok: true,
            ...(await new PublicRouteRepository(env.DB).advance(input.limit)),
          },
          { headers: NO_STORE_HEADERS }
        );
      case "acknowledge":
        return Response.json(
          {
            ok: true,
            ...(await new PublicRouteCacheRepository(env.DB).acknowledge()),
          },
          { headers: NO_STORE_HEADERS }
        );
      case "purge": {
        const outcome = await bootstrapDirtyPublicCache(env);
        if (outcome === "disabled")
          return failure(503, "PUBLIC_CACHE_PURGE_NOT_CONFIGURED");
        return Response.json(
          { ok: true, pending: outcome === "pending" },
          { headers: NO_STORE_HEADERS }
        );
      }
    }
  } catch {
    return unavailable(stage);
  }
}
