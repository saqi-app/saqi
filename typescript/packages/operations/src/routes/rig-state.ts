import { z } from "zod";

import {
  bootstrapDirtyPublicCache,
  purgeDirtyPublicCache,
} from "../lib/author-index-cache";
import { maintainPublicRoutes } from "../lib/maintain-public-routes";
import {
  hasJsonContentType,
  isTrustedMutationRequest,
  NO_STORE_HEADERS,
  readBoundedJson,
} from "../lib/operations-boundary";
import type { CloudflareEnv } from "../lib/parse-cloudflare-env";
import {
  publicCacheConfig,
  PublicCacheInvalidationError,
  purgePublishedPoem,
} from "../lib/public-cache";
import { RigPublicationRepository } from "../lib/rig-publication-repository";
import {
  AttemptIdSchema,
  PoemIdSchema,
  type RigCandidateCursor,
  RigStateRepository,
} from "../lib/rig-state-repository";
import { verifyPublishedPage } from "../lib/verify-published-page";

// This optional scan hint survives requests in a Worker isolate. Canonical
// rows and compare-and-swap claims remain authoritative across all isolates.
const CANDIDATE_CURSOR: RigCandidateCursor = { afterPoemId: "", priority: 0 };

const VersionSchema = z.number().int().positive();
const TokenSchema = z.uuid();
const ScanHintSchema = z.strictObject({
  afterPoemId: z.string().max(200),
  priority: z.number().int().min(0).max(2),
});
const RequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("claim-poem"),
    token: TokenSchema,
    poemId: PoemIdSchema.optional(),
    maxConcurrent: z.number().int().min(1).max(80).optional(),
    scanHint: ScanHintSchema.optional(),
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
    attemptId: AttemptIdSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.string().trim().min(1).max(100),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  }),
  z.strictObject({
    action: z.literal("acknowledge"),
    poemId: PoemIdSchema,
    attemptId: AttemptIdSchema,
    expectedVersion: VersionSchema,
    output: z.unknown(),
  }),
  z.strictObject({ action: z.literal("mark-unknown"), poemId: PoemIdSchema }),
  z.strictObject({
    action: z.literal("retry-unknown"),
    poemId: PoemIdSchema,
    attemptId: AttemptIdSchema,
    expectedVersion: VersionSchema,
  }),
  z.strictObject({
    action: z.literal("publish"),
    deferCachePurge: z.boolean().optional(),
    poemId: PoemIdSchema,
    expectedVersion: VersionSchema,
  }),
  z.strictObject({
    action: z.literal("purge-cache"),
    bootstrapAuthorIndex: z.literal(true).optional(),
  }),
  z.strictObject({ action: z.literal("probe-cache") }),
  z.strictObject({ action: z.literal("purge-corpus") }),
]);

function failure(status: number, code: string): Response {
  return Response.json(
    { ok: false, code },
    { status, headers: NO_STORE_HEADERS }
  );
}

// Access protects the operations origin; this route also requires the same
// request-origin contract as the existing corpus mutation endpoints.
export async function get(
  request: Request,
  env: CloudflareEnv
): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  if (searchParams.has("capabilities")) return capabilityResponse(searchParams);
  const poemId = searchParams.get("poemId");
  const attemptId = searchParams.get("attemptId");
  const diagnostics = searchParams.get("diagnostics");
  if (diagnostics !== null) {
    if (diagnostics !== "1" || poemId !== null || attemptId !== null)
      return failure(400, "INVALID_DIAGNOSTICS_QUERY");
    try {
      const result = await new RigStateRepository(env.DB).queueDiagnostics(
        Math.floor(Date.now() / 1_000)
      );
      return Response.json(
        {
          ok: true,
          diagnostics: { ...result, scanHint: { ...CANDIDATE_CURSOR } },
        },
        { headers: NO_STORE_HEADERS }
      );
    } catch {
      return failure(503, "RIG_DIAGNOSTICS_UNAVAILABLE");
    }
  }
  if (attemptId !== null) {
    if (poemId !== null || !TokenSchema.safeParse(attemptId).success)
      return failure(400, "INVALID_ATTEMPT_ID");
    try {
      const state = await new RigStateRepository(env.DB).readUnknownAttempt(
        attemptId
      );
      return Response.json({ ok: true, state }, { headers: NO_STORE_HEADERS });
    } catch {
      return failure(503, "RIG_STATE_UNAVAILABLE");
    }
  }
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
    const publication =
      new URL(request.url).searchParams.get("publication") === "1"
        ? await new RigPublicationRepository(env.DB).readPublication(
            parsed.data
          )
        : undefined;
    const publicPage = publication
      ? await verifyPublishedPage(publication, parsed.data, env)
      : undefined;
    return Response.json(
      { ok: true, state, publication, publicPage },
      { headers: NO_STORE_HEADERS }
    );
  } catch {
    return failure(503, "RIG_STATE_UNAVAILABLE");
  }
}

function capabilityResponse(searchParams: URLSearchParams): Response {
  if (searchParams.get("capabilities") !== "1" || searchParams.size !== 1)
    return failure(400, "INVALID_CAPABILITIES_QUERY");
  return Response.json(
    {
      ok: true,
      capabilities: { publicationCompareAndSwap: "returning-row-v1" },
    },
    { headers: NO_STORE_HEADERS }
  );
}

export async function post(
  request: Request,
  env: CloudflareEnv
): Promise<Response> {
  if (!isTrustedMutationRequest(request))
    return failure(403, "UNTRUSTED_MUTATION");
  if (!hasJsonContentType(request)) return failure(415, "INVALID_CONTENT_TYPE");
  if (env.SAQI_RIG_ACTIVE !== "1") return failure(503, "RIG_INACTIVE");
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await readBoundedJson(request, 1_048_576));
  } catch {
    return failure(400, "INVALID_RIG_REQUEST");
  }
  const state = new RigStateRepository(env.DB, CANDIDATE_CURSOR);
  const now = Math.floor(Date.now() / 1_000);
  try {
    switch (input.action) {
      case "claim-poem": {
        const cursor = input.scanHint ?? CANDIDATE_CURSOR;
        const claimed = await new RigStateRepository(
          env.DB,
          cursor
        ).claimNextPoem(input.token, now, input.poemId, input.maxConcurrent);
        return Response.json(
          { ok: true, state: claimed, scanHint: { ...cursor } },
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
            reasoningEffort: input.reasoningEffort ?? "unknown",
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
        if (!changed) return failure(409, "RIG_ATTEMPT_CHANGED");
        const acknowledged = await state.read(input.poemId);
        return Response.json(
          {
            ok: true,
            state: acknowledged
              ? {
                  poemId: acknowledged.poemId,
                  status: acknowledged.status,
                  version: acknowledged.version,
                }
              : null,
          },
          { headers: NO_STORE_HEADERS }
        );
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
      case "purge-corpus":
        return await handlePublicationAction(env, state, input);
      case "probe-cache": {
        const cache = publicCacheConfig(env);
        if (cache.state === "disabled")
          return failure(503, "PUBLIC_CACHE_PURGE_NOT_CONFIGURED");
        // Reserved identities exercise the real binding, authentication and
        // tag-purge API without touching corpus rows or evicting reader pages.
        await purgePublishedPoem(cache.config, {
          authorSlug: "__saqi_deployment_probe__",
          poemId: "__saqi_deployment_probe__",
        });
        return Response.json({ ok: true }, { headers: NO_STORE_HEADERS });
      }
    }
  } catch (error) {
    return rigStateFailure(error);
  }
}

function rigStateFailure(error: unknown): Response {
  console.error("[ops] Rig state rejected", {
    code: error instanceof Error ? error.message : "UNKNOWN",
  });
  if (!(error instanceof PublicCacheInvalidationError))
    return failure(503, "RIG_STATE_UNAVAILABLE");
  const body: {
    ok: false;
    code: string;
    details?: PublicCacheInvalidationError["details"];
  } = { ok: false, code: error.message };
  if (error.details) body.details = error.details;
  return Response.json(body, { status: 503, headers: NO_STORE_HEADERS });
}

async function handlePublicationAction(
  env: CloudflareEnv,
  state: RigStateRepository,
  input: Extract<
    z.infer<typeof RequestSchema>,
    { action: "publish" | "purge-cache" | "purge-corpus" }
  >
): Promise<Response> {
  if (input.action !== "publish") {
    if (input.action === "purge-cache") await maintainPublicRoutes(env);
    const outcome =
      input.action === "purge-corpus" || input.bootstrapAuthorIndex
        ? await bootstrapDirtyPublicCache(env)
        : await purgeDirtyPublicCache(env);
    return outcome !== "disabled"
      ? Response.json(
          {
            ok: true,
            purged: outcome === "purged",
            cachePending: outcome === "pending",
          },
          { headers: NO_STORE_HEADERS }
        )
      : failure(503, "PUBLIC_CACHE_PURGE_NOT_CONFIGURED");
  }
  const changed = await new RigPublicationRepository(env.DB).publish(
    input.poemId,
    input.expectedVersion
  );
  if (changed === "blocked") return failure(422, "RIG_PUBLICATION_BLOCKED");
  if (!changed) return failure(409, "RIG_PUBLICATION_CHANGED");
  let cachePurged = false;
  try {
    if (!input.deferCachePurge)
      cachePurged = ["empty", "purged"].includes(
        await purgeDirtyPublicCache(env, input.poemId)
      );
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
