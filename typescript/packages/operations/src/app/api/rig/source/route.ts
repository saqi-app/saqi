import { z } from "zod";

import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  DirectAuthorSchema,
  DirectPoemSchema,
  DirectSourceConflictError,
  DirectSourceRepository,
} from "@/lib/direct-source-repository";
import {
  hasJsonContentType,
  isTrustedMutationRequest,
  NO_STORE_HEADERS,
  readBoundedJson,
} from "@/lib/operations-boundary";
import { ProductionDeploymentIdentityRepository } from "@/lib/production-deployment-identity-repository";
import { publicCacheConfig, purgePublishedPoem } from "@/lib/public-cache";
import { RigPublicationRepository } from "@/lib/rig-publication-repository";

const RequestSchema = z.discriminatedUnion("action", [
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

// eslint-disable-next-line @typescript-eslint/naming-convention -- Next.js route handlers use HTTP method exports.
export async function GET(request: Request): Promise<Response> {
  const env = getCloudflareEnv();
  if (env.SAQI_DIRECT_SOURCE_ACTIVE !== "1")
    return failure(503, "DIRECT_SOURCE_INACTIVE");
  if (
    !(await new ProductionDeploymentIdentityRepository(
      env.DB
    ).matchesProduction())
  )
    return failure(503, "PRODUCTION_DATABASE_IDENTITY_MISMATCH");
  const repository = new DirectSourceRepository(
    env.DB,
    env.SAQI_SOURCE_NAME,
    env.SAQI_SOURCE_BASE_URL
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
    const query = new URL(request.url).searchParams;
    if (query.get("action") === "origin")
      return Response.json({ ok: true }, { headers: NO_STORE_HEADERS });
    if (query.get("action") === "next-author")
      return Response.json(
        { ok: true, author: await repository.nextAuthor() },
        { headers: NO_STORE_HEADERS }
      );
    if (query.get("action") === "poem" && query.has("sourcePoemId"))
      return Response.json(
        {
          ok: true,
          poem: await repository.currentPoem(query.get("sourcePoemId") ?? ""),
        },
        { headers: NO_STORE_HEADERS }
      );
    return failure(400, "INVALID_SOURCE_QUERY");
  } catch {
    return failure(503, "SOURCE_QUERY_UNAVAILABLE");
  }
}

// eslint-disable-next-line @typescript-eslint/naming-convention -- Next.js route handlers use HTTP method exports.
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedMutationRequest(request))
    return failure(403, "UNTRUSTED_MUTATION");
  if (!hasJsonContentType(request)) return failure(415, "INVALID_CONTENT_TYPE");
  const env = getCloudflareEnv();
  if (env.SAQI_DIRECT_SOURCE_ACTIVE !== "1")
    return failure(503, "DIRECT_SOURCE_INACTIVE");
  if (
    !(await new ProductionDeploymentIdentityRepository(
      env.DB
    ).matchesProduction())
  )
    return failure(503, "PRODUCTION_DATABASE_IDENTITY_MISMATCH");
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await readBoundedJson(request, 4_500_000));
  } catch {
    return failure(400, "INVALID_SOURCE_REQUEST");
  }
  const repository = new DirectSourceRepository(
    env.DB,
    env.SAQI_SOURCE_NAME,
    env.SAQI_SOURCE_BASE_URL
  );
  try {
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
    let cachePending = false;
    if (input.action === "upsert-poem" && result.status === "updated") {
      try {
        cachePending = !(await purgeChangedPoem(env, result.id));
      } catch (error) {
        console.warn("[ops] Direct source cache purge pending", {
          code: error instanceof Error ? error.message : "UNKNOWN",
        });
        cachePending = true;
      }
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

async function purgeChangedPoem(
  env: ReturnType<typeof getCloudflareEnv>,
  poemId: string
): Promise<boolean> {
  const cache = publicCacheConfig(env);
  if (cache.state === "disabled") return false;
  const repository = new RigPublicationRepository(env.DB);
  const row = await repository.pendingPurge(poemId);
  if (!row) return false;
  await purgePublishedPoem(cache.config, row);
  return repository.clearCacheDirty(
    row.poemId,
    row.publicationHash,
    row.sourceHash
  );
}
