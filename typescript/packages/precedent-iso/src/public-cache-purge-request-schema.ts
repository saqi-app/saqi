import { z } from "zod";

const PublicCacheRouteSchema = z.strictObject({
  authorSlug: z.string().min(1).max(500),
  poemId: z.string().min(1).max(500),
});

export const PublicCachePurgeRequestSchema = z.union([
  PublicCacheRouteSchema,
  z.strictObject({ poems: z.array(PublicCacheRouteSchema).min(1).max(50) }),
  z.strictObject({
    authorIndex: z.literal(true),
    poems: z.array(PublicCacheRouteSchema).min(1).max(49),
  }),
  z.strictObject({ all: z.literal(true) }),
  z.strictObject({
    authorIndex: z.literal(true),
    bootstrap: z.literal(true).optional(),
  }),
]);
