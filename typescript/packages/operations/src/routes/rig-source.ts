import { z } from "zod";

import { purgeDirtyPublicCache } from "../lib/author-index-cache";
import {
  DirectAuthorSchema,
  DirectPoemSchema,
  DirectSourceConflictError,
  DirectSourceRepository,
  SourceManifestBatchSchema,
} from "../lib/direct-source-repository";
import {
  hasJsonContentType,
  isTrustedMutationRequest,
  NO_STORE_HEADERS,
  readBoundedJson,
} from "../lib/operations-boundary";
import type { CloudflareEnv } from "../lib/parse-cloudflare-env";

const RequestSchema = z.discriminatedUnion("action", [
  SourceManifestBatchSchema.extend({ action: z.literal("reconcile-manifest") }),
  z.strictObject({
    action: z.literal("upsert-author"),
    author: DirectAuthorSchema,
  }),
  z.strictObject({ action: z.literal("upsert-poem"), poem: DirectPoemSchema }),
  z.strictObject({
    action: z.literal("defer-source"),
    sourceAuthorId: DirectAuthorSchema.shape.sourceAuthorId,
    retryAfter: z.number().int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("complete-author"),
    sourceAuthorId: DirectAuthorSchema.shape.sourceAuthorId,
  }),
]);

function failure(status: number, code: string): Response {
  return Response.json(
    { ok: false, code },
    { status, headers: NO_STORE_HEADERS }
  );
}

export async function get(
  request: Request,
  env: CloudflareEnv
): Promise<Response> {
  if (env.SAQI_DIRECT_SOURCE_ACTIVE !== "1")
    return failure(503, "DIRECT_SOURCE_INACTIVE");
  const repository = new DirectSourceRepository(
    env.DB,
    env.SAQI_SOURCE_BASE_URL,
    env.SAQI_SOURCE_NAME
  );
  // eslint-disable-next-line @sarj/no-fat-try-blocks -- All source reads share one unavailable response; no mutation occurs here.
  try {
    const retryAfter = await repository.sourceRetryAfter();
    const now = Math.floor(Date.now() / 1_000);
    if (retryAfter > now)
      return Response.json(
        { ok: false, code: "SOURCE_COOLDOWN", retryAfter },
        {
          status: 429,
          headers: {
            ...NO_STORE_HEADERS,
            "Retry-After": String(retryAfter - now),
          },
        }
      );
    const searchParams = new URL(request.url).searchParams;
    if (searchParams.get("action") === "origin")
      return Response.json({ ok: true }, { headers: NO_STORE_HEADERS });
    if (searchParams.get("action") === "next-author")
      return Response.json(
        { ok: true, author: await repository.nextAuthor() },
        { headers: NO_STORE_HEADERS }
      );
    if (
      searchParams.get("action") === "poem" &&
      searchParams.has("sourcePoemId")
    )
      return Response.json(
        {
          ok: true,
          poem: await repository.currentPoem(
            searchParams.get("sourcePoemId") ?? ""
          ),
        },
        { headers: NO_STORE_HEADERS }
      );
    return failure(400, "INVALID_SOURCE_QUERY");
  } catch {
    return failure(503, "SOURCE_QUERY_UNAVAILABLE");
  }
}

export async function post(
  request: Request,
  env: CloudflareEnv
): Promise<Response> {
  if (!isTrustedMutationRequest(request))
    return failure(403, "UNTRUSTED_MUTATION");
  if (!hasJsonContentType(request)) return failure(415, "INVALID_CONTENT_TYPE");
  if (env.SAQI_DIRECT_SOURCE_ACTIVE !== "1")
    return failure(503, "DIRECT_SOURCE_INACTIVE");
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await readBoundedJson(request, 4_500_000));
  } catch {
    return failure(400, "INVALID_SOURCE_REQUEST");
  }
  const repository = new DirectSourceRepository(
    env.DB,
    env.SAQI_SOURCE_BASE_URL,
    env.SAQI_SOURCE_NAME
  );
  try {
    if (input.action === "reconcile-manifest") {
      const { sourceAuthorId, poemIds } = input;
      return Response.json(
        {
          ok: true,
          existingPoemIds: await repository.existingPoemIds({
            sourceAuthorId,
            poemIds,
          }),
        },
        { headers: NO_STORE_HEADERS }
      );
    }
    if (input.action === "defer-source") {
      await repository.deferSource(input.sourceAuthorId, input.retryAfter);
      return Response.json({ ok: true }, { headers: NO_STORE_HEADERS });
    }
    if (input.action === "complete-author") {
      await repository.completeAuthor(input.sourceAuthorId);
      return Response.json({ ok: true }, { headers: NO_STORE_HEADERS });
    }
    const result =
      input.action === "upsert-author"
        ? await repository.upsertAuthor(input.author)
        : await repository.upsertPoem(input.poem);
    let cachePending = "cachePending" in result && result.cachePending;
    if (input.action === "upsert-poem" && result.status !== "unchanged") {
      cachePending = await purgeSourceCaches(env, result.id);
    } else if (cachePending) {
      // Renames also leave per-poem invalidations for normal maintenance.
      await purgeSourceCaches(env);
    }
    return Response.json(
      { ok: true, result, cachePending },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof DirectSourceConflictError)
      return failure(409, error.message);
    console.error("[ops] Direct source upsert failed", {
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    return failure(503, "SOURCE_UPSERT_UNAVAILABLE");
  }
}

async function purgeSourceCaches(
  env: CloudflareEnv,
  poemId?: string
): Promise<boolean> {
  try {
    return !["empty", "purged"].includes(
      await purgeDirtyPublicCache(env, poemId)
    );
  } catch (error) {
    console.warn("[ops] Direct source cache purge pending", {
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    return true;
  }
}
