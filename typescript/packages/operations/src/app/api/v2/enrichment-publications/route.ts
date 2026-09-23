import {
  ENRICHMENT_PUBLICATION_SCHEMA_ID,
  ENRICHMENT_PUBLICATION_SCHEMA_VERSION,
  EnrichmentPublicationV2RequestSchema,
  EnrichmentPublicationV2ResponseSchema,
  MAX_CORPUS_IMPORT_BYTES,
} from "@saqi/precedent-iso";
import {
  CorpusRevisionConflictError,
  LostPromotionClaimError,
} from "@saqi/precedent-node";

import { getServices } from "@/backend/get-services";
import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  hasJsonContentType,
  isTrustedMutationRequest,
  NO_STORE_HEADERS,
  readBoundedJson,
} from "@/lib/operations-boundary";
import { ProductionDeploymentIdentityRepository } from "@/lib/production-deployment-identity-repository";
import {
  publicCacheConfig,
  type PublicCacheConfiguration,
  PublicCacheInvalidationError,
  purgePublishedPoem,
} from "@/lib/public-cache";

// eslint-disable-next-line @typescript-eslint/naming-convention -- Next.js route handlers use HTTP method exports.
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedMutationRequest(request))
    return failure(403, "UNTRUSTED_MUTATION");
  if (!hasJsonContentType(request)) return failure(415, "INVALID_CONTENT_TYPE");
  const env = getCloudflareEnv();
  if (
    !(await new ProductionDeploymentIdentityRepository(
      env.DB
    ).matchesProduction())
  ) {
    return failure(503, "PRODUCTION_DATABASE_IDENTITY_MISMATCH");
  }

  try {
    const input = await parseRequest(request);
    const cache = publicCacheConfig(env);
    const { corpusImport, poemStore } = getServices();
    const results = [];
    for (const item of input.items) {
      // eslint-disable-next-line no-await-in-loop -- Per-item commits and cache invalidations retain request order and replay identity.
      results.push(await publishItem(item, cache, corpusImport, poemStore));
    }
    const body = EnrichmentPublicationV2ResponseSchema.parse({
      results,
      schemaId: ENRICHMENT_PUBLICATION_SCHEMA_ID,
      schemaVersion: ENRICHMENT_PUBLICATION_SCHEMA_VERSION,
    });
    return Response.json(body, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error(
      "[ops] Bound enrichment publication rejected",
      publicationFailureDiagnostic(error)
    );
    if (error instanceof PublicCacheInvalidationError) {
      return Response.json(
        { error: error.message, ok: false, retryable: true },
        { headers: { ...NO_STORE_HEADERS, "retry-after": "30" }, status: 503 }
      );
    }
    if (error instanceof LostPromotionClaimError) {
      return failure(409, "PUBLICATION_POINTER_CONFLICT", true);
    }
    if (error instanceof CorpusRevisionConflictError) {
      return failure(409, error.message || "PUBLICATION_REJECTED", false);
    }
    if (error instanceof InvalidPublicationRequestError) {
      return failure(400, "INVALID_PUBLICATION_REQUEST", false);
    }
    return failure(503, "PUBLICATION_UNAVAILABLE", true);
  }
}

async function publishItem(
  item: Awaited<ReturnType<typeof parseRequest>>["items"][number],
  cache: PublicCacheConfiguration,
  corpusImport: ReturnType<typeof getServices>["corpusImport"],
  poemStore: ReturnType<typeof getServices>["poemStore"]
) {
  try {
    const receipt = await corpusImport.publishBoundEnrichment(item);
    await invalidatePublicationCache(cache, poemStore, receipt.poemId);
    return { receipt, status: "published" as const };
  } catch (error) {
    if (error instanceof PublicCacheInvalidationError) throw error;
    if (
      !(error instanceof LostPromotionClaimError) &&
      !(error instanceof CorpusRevisionConflictError)
    ) {
      // A partially committed batch is safe to replay because publication intents are idempotent.
      throw error;
    }
    return rejectedResult(item.publicationIntentId, error);
  }
}

async function invalidatePublicationCache(
  cache: PublicCacheConfiguration,
  poemStore: ReturnType<typeof getServices>["poemStore"],
  poemId: string
): Promise<void> {
  if (cache.state === "disabled") {
    console.warn("[ops] Public cache purge skipped", {
      code: "PUBLIC_CACHE_PURGE_NOT_CONFIGURED",
      poemId,
    });
    return;
  }
  const authorSlug = await poemStore.getAuthorSlugForPoem(poemId);
  if (!authorSlug)
    throw new PublicCacheInvalidationError("PUBLIC_CACHE_ROUTE_INVALID");
  await purgePublishedPoem(cache.config, { authorSlug, poemId });
}

type PublicationFailureDiagnostic = Readonly<{
  causeCode:
    | "D1_BUSY"
    | "D1_CONSTRAINT"
    | "D1_QUERY_LIMIT"
    | "DATABASE_FAILURE"
    | "PUBLICATION_FAILURE";
  causeMessage: string;
  code: "PUBLICATION_UNAVAILABLE";
}>;

/*
 * Classify database failures without logging the underlying error. Drizzle's
 * error message can contain SQL and bound parameters, while a nested D1 cause
 * can contain request metadata. Keep both fields fixed and low-cardinality so
 * production logs are useful without becoming a data-exfiltration surface.
 */
function publicationFailureDiagnostic(
  error: unknown
): PublicationFailureDiagnostic {
  const signal = errorCauseSignal(error);
  if (
    /7429|expression tree is too large|query (?:is )?too large|sqlite_toobig|statement too long|too many sql variables/u.test(
      signal
    )
  ) {
    return diagnostic("D1_QUERY_LIMIT", "Database query limit exceeded");
  }
  if (
    /database (?:is )?(?:busy|locked)|d1[^\n]*timed? ?out|sqlite_busy/u.test(
      signal
    )
  ) {
    return diagnostic("D1_BUSY", "Database temporarily busy");
  }
  if (
    /constraint failed|foreign key constraint|not null constraint|sqlite_constraint|unique constraint/u.test(
      signal
    )
  ) {
    return diagnostic("D1_CONSTRAINT", "Database constraint violation");
  }
  if (/d1_error|drizzle|failed query|sqlite/u.test(signal)) {
    return diagnostic("DATABASE_FAILURE", "Database operation failed");
  }
  return diagnostic("PUBLICATION_FAILURE", "Publication operation failed");
}

function diagnostic(
  causeCode: PublicationFailureDiagnostic["causeCode"],
  causeMessage: string
): PublicationFailureDiagnostic {
  return { causeCode, causeMessage, code: "PUBLICATION_UNAVAILABLE" };
}

function errorCauseSignal(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    parts.push(current.name.toLowerCase(), current.message.toLowerCase());
    current = current.cause;
  }
  return parts.join("\n");
}

class InvalidPublicationRequestError extends Error {
  override readonly name = "InvalidPublicationRequestError";
}

async function parseRequest(request: Request) {
  try {
    return EnrichmentPublicationV2RequestSchema.parse(
      await readBoundedJson(request, MAX_CORPUS_IMPORT_BYTES)
    );
  } catch (error) {
    throw new InvalidPublicationRequestError("INVALID_PUBLICATION_REQUEST", {
      cause: error,
    });
  }
}

function rejectedResult(publicationIntentId: string, error: unknown) {
  const message =
    error instanceof Error ? error.message : "PUBLICATION_REJECTED";
  if (error instanceof LostPromotionClaimError) {
    return {
      code: "POINTER_CONFLICT" as const,
      message,
      publicationIntentId,
      retryable: true,
      status: "rejected" as const,
    };
  }
  const code =
    message.includes("ACTION_HASH") || message.includes("INTENT")
      ? "ACTION_HASH_CONFLICT"
      : message.includes("VALIDATION")
        ? "VALIDATION_INVALID"
        : message.includes("ARTIFACT")
          ? "ARTIFACT_INVALID"
          : message.includes("TOMBSTON")
            ? "SOURCE_TOMBSTONED"
            : message.includes("CURRENT") || message.includes("SOURCE_CHANGED")
              ? "SOURCE_CHANGED"
              : "BINDING_INVALID";
  return {
    code,
    message,
    publicationIntentId,
    retryable: code === "SOURCE_CHANGED",
    status: "rejected" as const,
  };
}

function failure(status: number, error: string, retryable = false): Response {
  return Response.json(
    { error, ok: false, retryable },
    { headers: NO_STORE_HEADERS, status }
  );
}
