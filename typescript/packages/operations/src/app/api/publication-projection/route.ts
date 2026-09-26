import { PublicationProjectionRequestSchema } from "@saqi/precedent-iso";
import { z } from "zod";

import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  hasJsonContentType,
  isTrustedMutationRequest,
  NO_STORE_HEADERS,
  readBoundedJson,
} from "@/lib/operations-boundary";
import { ProductionDeploymentIdentityRepository } from "@/lib/production-deployment-identity-repository";

import {
  CatalogRepository,
  type PoemPage,
} from "../../../../../site/src/lib/catalog";
import { poemTranslationTracks } from "../../../../../site/src/lib/poem-translations";
import {
  publicationSnapshotFromPoem,
  PublicationSnapshotSchema,
} from "../../../../../site/src/lib/publication-snapshot";

const CandidateSchema = z.object({
  id: z.string(),
  authorSlug: z.string(),
  contentArabic: z.string(),
  publicationJson: z.string().nullable(),
});

// This is a temporary, bounded migration tool. Every row is read through the
// production catalog before its inactive projection is written. No poem text
// leaves the Access-protected Worker in the response.
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
  )
    return failure(503, "PRODUCTION_DATABASE_IDENTITY_MISMATCH");
  let input: z.infer<typeof PublicationProjectionRequestSchema>;
  try {
    input = PublicationProjectionRequestSchema.parse(
      await readBoundedJson(request, 1024)
    );
  } catch {
    return failure(400, "INVALID_BACKFILL_REQUEST");
  }
  const catalog = CatalogRepository.fromD1(env.DB);
  const projectedCatalog =
    input.action === "audit" ? CatalogRepository.fromD1(env.DB, true) : null;
  const backfill = new PublicationBackfillRepository(env.DB);
  try {
    const candidates = await backfill.listCandidates(
      input.afterId,
      input.limit,
      input.action === "audit"
    );
    const skipped: string[] = [];
    const mismatched: string[] = [];
    const summary = {
      scanned: 0,
      eligible: 0,
      shadowed: 0,
      skipped,
      mismatched,
    };
    for (const candidate of candidates) {
      summary.scanned += 1;
      // Each result depends on the current catalog row and must be checked
      // before advancing this bounded migration cursor.
      // eslint-disable-next-line no-await-in-loop -- Each migration row must be read before its conditional write.
      const projected = await projectionForCandidate(catalog, candidate);
      if (!projected) {
        summary.skipped.push(candidate.id);
        continue;
      }
      summary.eligible += 1;
      if (input.action === "audit") {
        const stored = PublicationSnapshotSchema.safeParse(
          JSON.parse(candidate.publicationJson ?? "null")
        );
        // This is the actual public reader behind the cutover flag, including
        // Arabic/title/model-label rendering. Every eligible poem is compared.
        // eslint-disable-next-line no-await-in-loop -- Shadow reads must follow the bounded candidate cursor.
        const shadowPage = await projectedCatalog?.getPoemPage(
          candidate.authorSlug,
          candidate.id
        );
        summary.shadowed += 1;
        if (
          !stored.success ||
          JSON.stringify(stored.data) !== projected.publication ||
          JSON.stringify(shadowPage) !== JSON.stringify(projected.oldPage)
        )
          summary.mismatched.push(candidate.id);
        continue;
      }
      if (!input.apply) continue;
      // eslint-disable-next-line no-await-in-loop -- Hash the exact serialized projection for this row.
      const publicationHash = await sha256(projected.publication);
      // eslint-disable-next-line no-await-in-loop -- Preserve bounded, ordered compare-and-swap writes.
      summary.shadowed += await backfill.writeInactiveSnapshot(
        candidate,
        projected.publication,
        publicationHash
      );
    }
    return Response.json(
      {
        ok: true,
        afterId: candidates.at(-1)?.id ?? input.afterId,
        complete: candidates.length < input.limit,
        ...summary,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("[ops] Publication projection backfill failed", {
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    return failure(503, "PUBLICATION_BACKFILL_UNAVAILABLE");
  }
}

class PublicationBackfillRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async listCandidates(afterId: string, limit: number, audit: boolean) {
    const result = await this.#database
      .prepare(
        `SELECT p.id, a.slug AS authorSlug,
              p.content_arabic AS contentArabic,
              p.publication_json AS publicationJson
         FROM poem p JOIN author a ON a.id = p.author_id
        WHERE p.id > ?1
          AND (CASE WHEN ?3 = 1 THEN
                 json_valid(p.publication_json)
                 AND json_extract(p.publication_json, '$.schemaVersion') = 2
                 AND json_extract(p.publication_json, '$.active') = 0
               ELSE p.publication_json IS NULL END)
          AND p.hidden = 0 AND p.publishable = 1
          AND (p.translation IS NOT NULL
            OR p.translation_gemini IS NOT NULL
            OR p.insights IS NOT NULL
            OR EXISTS (SELECT 1 FROM poem_model_publication_pointer pointer
                       WHERE pointer.poem_id = p.id))
        ORDER BY p.id LIMIT ?2`
      )
      .bind(afterId, limit, audit ? 1 : 0)
      .all<unknown>();
    return CandidateSchema.array().parse(result.results);
  }

  async writeInactiveSnapshot(
    candidate: z.infer<typeof CandidateSchema>,
    publication: string,
    publicationHash: string
  ): Promise<number> {
    const written = await this.#database
      .prepare(
        `UPDATE poem SET publication_json = ?1,
                       publication_hash = ?2,
                       publication_source_hash = source_hash
        WHERE id = ?3 AND publication_json IS NULL
          AND content_arabic = ?4`
      )
      .bind(publication, publicationHash, candidate.id, candidate.contentArabic)
      .run();
    return written.meta.changes;
  }
}

async function projectionForCandidate(
  catalog: CatalogRepository,
  candidate: z.infer<typeof CandidateSchema>
): Promise<{ oldPage: PoemPage; publication: string } | undefined> {
  const page = await catalog.getPoemPage(candidate.authorSlug, candidate.id);
  if (!page) return undefined;
  if (poemTranslationTracks(page.poem).length === 0 && !page.poem.insights)
    return undefined;
  return {
    oldPage: page,
    publication: JSON.stringify(publicationSnapshotFromPoem(page.poem)),
  };
}

function failure(status: number, code: string): Response {
  return Response.json(
    { ok: false, code },
    { status, headers: NO_STORE_HEADERS }
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
