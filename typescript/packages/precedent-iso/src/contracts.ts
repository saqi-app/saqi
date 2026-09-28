import { z } from "zod";

export const PublicCachePurgeRequestSchema = z.union([
  z.strictObject({
    authorSlug: z.string().min(1).max(128),
    poemId: z.string().min(1).max(128),
  }),
  z.strictObject({ all: z.literal(true) }),
]);
