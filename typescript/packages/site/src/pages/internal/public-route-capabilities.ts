import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { handlePublicRouteCapabilities } from "../../lib/handle-public-route-capabilities";

const SecretSchema = z.object({
  SAQI_PUBLIC_CACHE_PURGE_SECRET: z.string().optional(),
});
export const GET: APIRoute = ({ request }) =>
  handlePublicRouteCapabilities(
    request,
    SecretSchema.parse(env).SAQI_PUBLIC_CACHE_PURGE_SECRET
  );
