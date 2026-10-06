import { z } from "zod";

const PublicCacheRouteSchema = z.strictObject({
  authorSlug: z.string().min(1).max(128),
  poemId: z.string().min(1).max(128),
});

export const PublicCachePurgeRequestSchema = z.union([
  PublicCacheRouteSchema,
  z.strictObject({ poems: z.array(PublicCacheRouteSchema).min(1).max(50) }),
  z.strictObject({ all: z.literal(true) }),
]);
