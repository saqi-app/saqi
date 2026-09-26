import { z } from "zod";

export const PublicCachePurgeRequestSchema = z.strictObject({
  authorSlug: z.string().min(1).max(128),
  poemId: z.string().min(1).max(128),
});
