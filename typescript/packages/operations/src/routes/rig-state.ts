import { z } from "zod";

import { poemTranslationTracks } from "../../../site/src/lib/poem-translations";
import type { CloudflareEnv } from "../lib/cloudflare";
import {
  hasJsonContentType,
  isTrustedMutationRequest,
  NO_STORE_HEADERS,
  readBoundedJson,
} from "../lib/operations-boundary";
import {
  publicCacheConfig,
  PublicCacheInvalidationError,
  purgePublicCorpus,
  purgePublishedPoem,
  purgePublishedPoems,
} from "../lib/public-cache";
import { RigPublicationRepository } from "../lib/rig-publication-repository";
import {
  type RigCandidateCursor,
  RigStateRepository,
} from "../lib/rig-state-repository";

// This optional scan hint survives requests in a Worker isolate. Canonical
// rows and compare-and-swap claims remain authoritative across all isolates.
const CANDIDATE_CURSOR: RigCandidateCursor = { afterPoemId: "", priority: 0 };

const VersionSchema = z.number().int().positive();
const TokenSchema = z.uuid();
const PoemIdSchema = z.string().min(1).max(200);
const RequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("claim-poem"),
    token: TokenSchema,
    poemId: PoemIdSchema.optional(),
    maxConcurrent: z.number().int().min(1).max(80).optional(),
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
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
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
    deferCachePurge: z.boolean().optional(),
    poemId: PoemIdSchema,
    expectedVersion: VersionSchema,
  }),
  z.strictObject({ action: z.literal("purge-cache") }),
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
  const query = new URL(request.url).searchParams;
  const poemId = query.get("poemId");
  const attemptId = query.get("attemptId");
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
        const claimed = await state.claimNextPoem(
          input.token,
          now,
          input.poemId,
          input.maxConcurrent
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
      case "purge-corpus":
        return await handleCorpusPurge(env);
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

async function handleCorpusPurge(env: CloudflareEnv): Promise<Response> {
  const cache = publicCacheConfig(env);
  if (cache.state === "disabled")
    return failure(503, "PUBLIC_CACHE_PURGE_NOT_CONFIGURED");
  await purgePublicCorpus(cache.config);
  // Migration 0093 clears the hash only for rewritten snapshots. A concurrent
  // new publication has a non-null hash; a changed source has a new source hash.
  const cleared = await env.DB.prepare(
    `UPDATE poem SET publication_cache_dirty = 0
     WHERE publication_cache_dirty = 1 AND publication_hash IS NULL
       AND publication_source_hash IS source_hash`
  ).run();
  return Response.json(
    { ok: true, cleared: cleared.meta.changes },
    { headers: NO_STORE_HEADERS }
  );
}

async function handlePublicationAction(
  env: CloudflareEnv,
  state: RigStateRepository,
  input: Extract<
    z.infer<typeof RequestSchema>,
    { action: "publish" | "purge-cache" }
  >
): Promise<Response> {
  if (input.action === "purge-cache") {
    const purged = await purgeDirtyPublications(env);
    return purged !== "disabled"
      ? Response.json(
          { ok: true, purged: purged === "purged" },
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
      cachePurged =
        (await purgeDirtyPublication(env, input.poemId)) !== "disabled";
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

async function purgeDirtyPublications(
  env: CloudflareEnv
): Promise<"disabled" | "empty" | "purged"> {
  const cache = publicCacheConfig(env);
  if (cache.state === "disabled") return "disabled";
  const repository = new RigPublicationRepository(env.DB);
  const rows = await repository.pendingPurges();
  if (!rows.length) return "empty";
  await purgePublishedPoems(
    cache.config,
    rows.map(({ authorSlug, poemId }) => ({ authorSlug, poemId }))
  );
  await repository.clearCacheDirtyBatch(rows);
  return "purged";
}

async function purgeDirtyPublication(
  env: CloudflareEnv,
  poemId?: string
): Promise<"disabled" | "empty" | "purged"> {
  const cache = publicCacheConfig(env);
  if (cache.state === "disabled") return "disabled";
  const repository = new RigPublicationRepository(env.DB);
  const row = await repository.pendingPurge(poemId);
  if (!row) return "empty";
  await purgePublishedPoem(cache.config, row);
  await repository.clearCacheDirty(
    row.poemId,
    row.publicationHash,
    row.sourceHash
  );
  return "purged";
}

async function verifyPublishedPage(
  publication: NonNullable<
    Awaited<ReturnType<RigPublicationRepository["readPublication"]>>
  >,
  poemId: string,
  env: CloudflareEnv
) {
  const url = `https://saqi.app/author/${encodeURIComponent(publication.authorSlug)}/poem/${encodeURIComponent(poemId)}`;
  if (!env.PUBLIC_SITE) return { url, error: "PUBLIC_SITE_UNAVAILABLE" };
  try {
    const response = await env.PUBLIC_SITE.fetch(url);
    const html = await response.text();
    const contains = (text: string) => {
      const escaped = text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return (
        html.includes(escaped) ||
        html.includes(
          escaped.replaceAll('"', "&quot;").replaceAll("'", "&#39;")
        ) ||
        html.includes(
          escaped.replaceAll('"', "&quot;").replaceAll("'", "&#x27;")
        )
      );
    };
    const lines = poemTranslationTracks(publication.snapshot.fields)
      .flatMap((track) => track.lines)
      .filter((line) => line.trim().length > 0);
    const meanings =
      publication.snapshot.fields.wordGlosses?.meanings.lines.flatMap((line) =>
        line.segments.flatMap((segment) =>
          segment.kind === "word" ? [segment.meaning] : []
        )
      ) ?? [];
    return {
      url,
      status: response.status,
      translationMatches:
        response.ok && lines.length > 0 && lines.every(contains),
      wordMeaningsMatch:
        response.ok && meanings.length > 0 && meanings.every(contains),
    };
  } catch {
    return { url, error: "PUBLIC_PAGE_UNAVAILABLE" };
  }
}
