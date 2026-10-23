import { hash, timingSafeEqual } from "node:crypto";

import {
  PublicCachePurgeRequestSchema,
  readBoundedJsonBody,
} from "@saqi/precedent-iso";

import {
  AUTHOR_INDEX_CACHE_TAG,
  publicationCacheTags,
  SITEMAP_CACHE_TAG,
} from "./cache-tags";

export const PURGE_PATH = "/internal/purge-publication-cache";
export const PUBLIC_CACHE_NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
} as const;

export async function handlePublicCachePurge(
  request: Request,
  secret: string | undefined,
  purge: (
    tags: string[]
  ) => Promise<
    | { success: false; errors?: { code: number; message: string }[] }
    | { success: true }
  >
): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== PURGE_PATH) return undefined;
  if (
    request.method !== "POST" ||
    !publicCacheAuthorized(request.headers.get("authorization"), secret)
  ) {
    return new Response(null, {
      status: 404,
      headers: PUBLIC_CACHE_NO_STORE_HEADERS,
    });
  }
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return new Response(null, {
      status: 415,
      headers: PUBLIC_CACHE_NO_STORE_HEADERS,
    });
  }
  let route: ReturnType<typeof PublicCachePurgeRequestSchema.parse>;
  try {
    route = await readRoute(request);
  } catch {
    return new Response(null, {
      status: 400,
      headers: PUBLIC_CACHE_NO_STORE_HEADERS,
    });
  }
  try {
    const tags = purgeTags(route);
    // Workers Cache uses the Free-tier limit of 100 purge operations/request.
    // Keep the existing 50-poem publisher wire; acknowledge only all chunks.
    for (let offset = 0; offset < tags.length; offset += 100) {
      // eslint-disable-next-line no-await-in-loop -- Ordered chunks preserve complete-batch acknowledgement after a partial purge failure.
      const result = await purge(tags.slice(offset, offset + 100));
      if (!result.success) {
        const errors = (result.errors ?? [])
          .slice(0, 10)
          .map(({ code, message }) => ({
            code,
            message: message.slice(0, 300),
          }));
        console.error("[public] Cache purge rejected", { errors });
        return Response.json(
          { code: "PUBLIC_CACHE_PURGE_FAILED", errors },
          { status: 503, headers: PUBLIC_CACHE_NO_STORE_HEADERS }
        );
      }
    }
  } catch (error) {
    console.error("[public] Cache purge unavailable", {
      message: error instanceof Error ? error.message : "UNKNOWN",
    });
    return Response.json(
      { code: "PUBLIC_CACHE_PURGE_FAILED", errors: [] },
      { status: 503, headers: PUBLIC_CACHE_NO_STORE_HEADERS }
    );
  }
  return new Response(null, {
    status: 204,
    headers: PUBLIC_CACHE_NO_STORE_HEADERS,
  });
}

function purgeTags(
  route: ReturnType<typeof PublicCachePurgeRequestSchema.parse>
): string[] {
  if ("all" in route || ("bootstrap" in route && route.bootstrap))
    return ["saqi-corpus"];
  const poems =
    "poems" in route ? route.poems : "authorIndex" in route ? [] : [route];
  const tags = poems.flatMap((poem) =>
    publicationCacheTags(poem.authorSlug, poem.poemId)
  );
  if ("authorIndex" in route) tags.push(AUTHOR_INDEX_CACHE_TAG);
  const probe =
    !("poems" in route) &&
    !("authorIndex" in route) &&
    poems.length === 1 &&
    poems[0]?.authorSlug === "__saqi_deployment_probe__" &&
    poems[0].poemId === "__saqi_deployment_probe__";
  if (!probe) tags.push(SITEMAP_CACHE_TAG);
  return [...new Set(tags)];
}

export function publicCacheAuthorized(
  header: null | string,
  secret: string | undefined
): boolean {
  if (!secret) return false;
  const supplied = hash("sha256", header ?? "", "buffer");
  const expected = hash("sha256", `Bearer ${secret}`, "buffer");
  return timingSafeEqual(supplied, expected);
}

async function readRoute(
  request: Request
): Promise<ReturnType<typeof PublicCachePurgeRequestSchema.parse>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > 320_000)
      throw new Error("Invalid purge content length");
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity")
    throw new Error("Unsupported purge content encoding");
  return PublicCachePurgeRequestSchema.parse(
    await readBoundedJsonBody(
      request.body,
      320_000,
      "Purge request is too large"
    )
  );
}
