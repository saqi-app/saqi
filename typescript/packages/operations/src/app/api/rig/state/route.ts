import { z } from "zod";

import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  hasJsonContentType,
  isTrustedMutationRequest,
  NO_STORE_HEADERS,
  readBoundedJson,
} from "@/lib/operations-boundary";
import { ProductionDeploymentIdentityRepository } from "@/lib/production-deployment-identity-repository";
import { publicCacheConfig, purgePublishedPoem } from "@/lib/public-cache";
import { RigPublicationRepository } from "@/lib/rig-publication-repository";
import { RigStateRepository } from "@/lib/rig-state-repository";

const VersionSchema = z.number().int().positive();
const TokenSchema = z.uuid();
const PoemIdSchema = z.string().min(1).max(200);
const RequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("claim-poem"),
    token: TokenSchema,
    poemId: PoemIdSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("source"),
    poemId: PoemIdSchema,
    token: TokenSchema,
  }),
  z.strictObject({
    action: z.literal("dispatch"),
    poemId: PoemIdSchema,
    token: TokenSchema,
    expectedVersion: VersionSchema,
    attemptId: TokenSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.string().trim().min(1).max(100),
  }),
  z.strictObject({
    action: z.literal("acknowledge"),
    poemId: PoemIdSchema,
    attemptId: TokenSchema,
    expectedVersion: VersionSchema,
    output: z.unknown(),
  }),
  z.strictObject({ action: z.literal("mark-unknown"), poemId: PoemIdSchema }),
  z.strictObject({
    action: z.literal("retry-unknown"),
    poemId: PoemIdSchema,
    attemptId: TokenSchema,
    expectedVersion: VersionSchema,
  }),
  z.strictObject({
    action: z.literal("publish"),
    poemId: PoemIdSchema,
    expectedVersion: VersionSchema,
  }),
  z.strictObject({ action: z.literal("purge-cache") }),
]);

function failure(status: number, code: string): Response {
  return Response.json(
    { ok: false, code },
    { status, headers: NO_STORE_HEADERS }
  );
}

// Access protects the operations origin; this route also requires the same
// request-origin contract as the existing corpus mutation endpoints.
// eslint-disable-next-line @typescript-eslint/naming-convention -- Next.js route handlers use HTTP method exports.
export async function GET(request: Request): Promise<Response> {
  const env = getCloudflareEnv();
  if (
    !(await new ProductionDeploymentIdentityRepository(
      env.DB
    ).matchesProduction())
  )
    return failure(503, "PRODUCTION_DATABASE_IDENTITY_MISMATCH");
  const poemId = new URL(request.url).searchParams.get("poemId");
  if (poemId === null) {
    try {
      const state = await new RigStateRepository(env.DB).currentEnrichment();
      return Response.json({ ok: true, state }, { headers: NO_STORE_HEADERS });
    } catch {
      return failure(503, "RIG_STATE_UNAVAILABLE");
    }
  }
  const parsed = PoemIdSchema.safeParse(poemId);
  if (!parsed.success) return failure(400, "INVALID_POEM_ID");
  try {
    const state = await new RigStateRepository(env.DB).read(parsed.data);
    return Response.json({ ok: true, state }, { headers: NO_STORE_HEADERS });
  } catch {
    return failure(503, "RIG_STATE_UNAVAILABLE");
  }
}

// eslint-disable-next-line @typescript-eslint/naming-convention -- Next.js route handlers use HTTP method exports.
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedMutationRequest(request))
    return failure(403, "UNTRUSTED_MUTATION");
  if (!hasJsonContentType(request)) return failure(415, "INVALID_CONTENT_TYPE");
  const env = getCloudflareEnv();
  if (env.SAQI_RIG_ACTIVE !== "1") return failure(503, "RIG_INACTIVE");
  if (
    !(await new ProductionDeploymentIdentityRepository(
      env.DB
    ).matchesProduction())
  )
    return failure(503, "PRODUCTION_DATABASE_IDENTITY_MISMATCH");
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await readBoundedJson(request, 1_048_576));
  } catch {
    return failure(400, "INVALID_RIG_REQUEST");
  }
  const state = new RigStateRepository(env.DB);
  const now = Math.floor(Date.now() / 1_000);
  try {
    switch (input.action) {
      case "claim-poem": {
        const claimed = await state.claimNextPoem(
          input.token,
          now,
          input.poemId
        );
        return Response.json(
          { ok: true, state: claimed },
          { headers: NO_STORE_HEADERS }
        );
      }
      case "source": {
        const poem = await new RigPublicationRepository(
          env.DB
        ).readClaimedSource(input.poemId, input.token, now);
        return poem
          ? Response.json({ ok: true, poem }, { headers: NO_STORE_HEADERS })
          : failure(409, "RIG_CLAIM_CHANGED");
      }
      case "dispatch": {
        const changed = await state.beginInvocation(
          input.poemId,
          input.token,
          input.expectedVersion,
          {
            attemptId: input.attemptId,
            inputHash: input.inputHash,
            model: input.model,
            startedAt: now,
            deadlineAt: now + 1_800,
          }
        );
        return changed
          ? Response.json(
              { ok: true, state: await state.read(input.poemId) },
              { headers: NO_STORE_HEADERS }
            )
          : failure(409, "RIG_CLAIM_CHANGED");
      }
      case "acknowledge": {
        const changed = await state.acknowledgeInvocation(
          input.poemId,
          input.attemptId,
          input.expectedVersion,
          input.output
        );
        return changed
          ? Response.json(
              { ok: true, state: await state.read(input.poemId) },
              { headers: NO_STORE_HEADERS }
            )
          : failure(409, "RIG_ATTEMPT_CHANGED");
      }
      case "mark-unknown": {
        const changed = await state.markExpiredUnknown(input.poemId, now);
        return changed
          ? Response.json(
              { ok: true, state: await state.read(input.poemId) },
              { headers: NO_STORE_HEADERS }
            )
          : failure(409, "RIG_ATTEMPT_NOT_EXPIRED");
      }
      case "retry-unknown": {
        const changed = await state.retryUnknown(
          input.poemId,
          input.attemptId,
          input.expectedVersion
        );
        return changed
          ? Response.json(
              { ok: true, state: await state.read(input.poemId) },
              { headers: NO_STORE_HEADERS }
            )
          : failure(409, "RIG_UNKNOWN_ATTEMPT_CHANGED");
      }
      case "publish":
      case "purge-cache":
        return await handlePublicationAction(env, state, input);
    }
  } catch (error) {
    console.error("[ops] Rig state rejected", {
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    return failure(503, "RIG_STATE_UNAVAILABLE");
  }
}

async function handlePublicationAction(
  env: ReturnType<typeof getCloudflareEnv>,
  state: RigStateRepository,
  input: Extract<
    z.infer<typeof RequestSchema>,
    { action: "publish" | "purge-cache" }
  >
): Promise<Response> {
  if (input.action === "purge-cache") {
    const purged = await purgeDirtyPublication(env);
    return purged
      ? Response.json({ ok: true }, { headers: NO_STORE_HEADERS })
      : failure(503, "PUBLIC_CACHE_PURGE_NOT_CONFIGURED");
  }
  const changed = await new RigPublicationRepository(env.DB).publish(
    input.poemId,
    input.expectedVersion
  );
  if (!changed) return failure(409, "RIG_PUBLICATION_CHANGED");
  let cachePurged = false;
  try {
    cachePurged = await purgeDirtyPublication(env, input.poemId);
  } catch {
    // The dirty bit persists so the next runner start retries the purge.
  }
  return Response.json(
    {
      ok: true,
      state: await state.read(input.poemId),
      cachePending: !cachePurged,
    },
    { headers: NO_STORE_HEADERS }
  );
}

async function purgeDirtyPublication(
  env: ReturnType<typeof getCloudflareEnv>,
  poemId?: string
): Promise<boolean> {
  const cache = publicCacheConfig(env);
  if (cache.state === "disabled") return false;
  const repository = new RigPublicationRepository(env.DB);
  const row = await repository.pendingPurge(poemId);
  if (!row) return true;
  await purgePublishedPoem(cache.config, row);
  await repository.clearCacheDirty(
    row.poemId,
    row.publicationHash,
    row.sourceHash
  );
  return true;
}
