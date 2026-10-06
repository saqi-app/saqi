import type { APIRoute } from "astro";
import { cache, env } from "cloudflare:workers";
import { z } from "zod";

import { handlePublicCachePurge } from "../../lib/public-cache-purge";

const PurgeSecretSchema = z.object({
  SAQI_PUBLIC_CACHE_PURGE_SECRET: z.string().optional(),
});

export const POST: APIRoute = async ({ request }) =>
  (await handlePublicCachePurge(
    request,
    PurgeSecretSchema.parse(env).SAQI_PUBLIC_CACHE_PURGE_SECRET,
    async (tags) => {
      const result = await cache.purge({ tags });
      if (result.success) return { success: true };
      return { success: false, errors: result.errors };
    },
  )) ?? new Response(null, { status: 404 });
