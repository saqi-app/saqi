import { z } from "zod";

const CountsSchema = z.object({
  authorCount: z.number().int().nonnegative(),
  poemCount: z.number().int().nonnegative(),
  sourcePoemCount: z.number().int().nonnegative(),
});
const ModelCountSchema = z.object({
  modelKey: z.string().min(1),
  poemCount: z.number().int().nonnegative(),
});
const CollectionMonthSchema = z.object({
  month: z.iso.date(),
  poemCount: z.number().int().nonnegative(),
});

export interface CollectionInsights {
  readonly authorCount: number;
  readonly collectionMonths: readonly z.infer<typeof CollectionMonthSchema>[];
  readonly modelCounts: readonly z.infer<typeof ModelCountSchema>[];
  readonly poemCount: number;
  readonly sourcePoemCount: number;
}

export async function loadCollectionInsights(
  database: D1Database,
): Promise<CollectionInsights> {
  const session = database.withSession();
  const [totals, models, months] = await session.batch([
    session
      .prepare(
        `SELECT author_count AS authorCount, poem_count AS poemCount,
                source_poem_count AS sourcePoemCount
         FROM insights_rollup WHERE singleton = 1`,
      ),
    session
      .prepare(
        `SELECT model_key AS modelKey, poem_count AS poemCount
         FROM insights_model_count ORDER BY poem_count DESC, model_key`,
      ),
    session
      .prepare(
        `SELECT month, poem_count AS poemCount
         FROM insights_collection_month ORDER BY month DESC`,
      ),
  ]);
  const counts = CountsSchema.parse(totals?.results[0]);
  return {
    authorCount: counts.authorCount,
    poemCount: counts.poemCount,
    sourcePoemCount: counts.sourcePoemCount,
    modelCounts: ModelCountSchema.array().parse(models?.results),
    collectionMonths: CollectionMonthSchema.array().parse(months?.results),
  };
}
