import { hash, timingSafeEqual } from "node:crypto";

import { PublicCachePurgeRequestSchema } from "@saqi/precedent-iso";

import { publicationCacheTags } from "./cache-tags";

export const PURGE_PATH = "/internal/purge-publication-cache";
const NO_STORE = {
  "Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
} as const;

export async function handlePublicCachePurge(
  request: Request,
  secret: string | undefined,
  purge: (tags: string[]) => Promise<{ success: boolean }>,
): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== PURGE_PATH) return undefined;
  if (
    request.method !== "POST" ||
    !authorized(request.headers.get("authorization"), secret)
  ) {
    return new Response(null, { status: 404, headers: NO_STORE });
  }
  if (request.headers.get("content-type") !== "application/json") {
    return new Response(null, { status: 415, headers: NO_STORE });
  }
  let route: ReturnType<typeof PublicCachePurgeRequestSchema.parse>;
  try {
    route = await readRoute(request);
  } catch {
    return new Response(null, { status: 400, headers: NO_STORE });
  }
  try {
    const result = await purge(
      publicationCacheTags(route.authorSlug, route.poemId),
    );
    if (!result.success)
      return new Response(null, { status: 503, headers: NO_STORE });
  } catch {
    return new Response(null, { status: 503, headers: NO_STORE });
  }
  return new Response(null, { status: 204, headers: NO_STORE });
}

function authorized(
  header: null | string,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const supplied = hash("sha256", header ?? "", "buffer");
  const expected = hash("sha256", `Bearer ${secret}`, "buffer");
  return timingSafeEqual(supplied, expected);
}

async function readRoute(
  request: Request,
): Promise<ReturnType<typeof PublicCachePurgeRequestSchema.parse>> {
  if (Number(request.headers.get("content-length")) > 1024) {
    throw new Error("Purge request is too large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing purge request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let next = await reader.read();
  while (!next.done) {
    size += next.value.byteLength;
    if (size > 1024) {
      // eslint-disable-next-line no-await-in-loop -- Cancel the current reader before rejecting oversized bodies.
      await reader.cancel();
      throw new Error("Purge request is too large");
    }
    chunks.push(next.value);
    // eslint-disable-next-line no-await-in-loop -- The body must be consumed sequentially to enforce its size limit.
    next = await reader.read();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return PublicCachePurgeRequestSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
}
