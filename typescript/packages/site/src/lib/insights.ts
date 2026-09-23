import { z } from "zod";

const CountsSchema = z.object({
  authorCount: z.number().int().nonnegative(),
  poemCount: z.number().int().nonnegative(),
  declaredPoemCount: z.number().int().nonnegative(),
  sourcePoemCount: z.number().int().nonnegative(),
});
const ModelCountSchema = z.object({
  modelKey: z.string().min(1),
  poemCount: z.number().int().nonnegative(),
});
const CollectionDaySchema = z.object({
  day: z.iso.date(),
  poemCount: z.number().int().nonnegative(),
});

export interface CollectionInsights {
  readonly authorCount: number;
  readonly collectionDays: readonly z.infer<typeof CollectionDaySchema>[];
  readonly modelCounts: readonly z.infer<typeof ModelCountSchema>[];
  readonly poemCount: number;
  readonly remainingEstimate: null | number;
  readonly sourcePoemCount: number;
}

export async function loadCollectionInsights(
  database: D1Database,
): Promise<CollectionInsights> {
  const session = database.withSession();
  const [totals, models, days] = await session.batch([
    session
      .prepare(
        `SELECT author_count AS authorCount, poem_count AS poemCount,
                declared_poem_count AS declaredPoemCount,
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
        `SELECT day, poem_count AS poemCount
         FROM insights_collection_day ORDER BY day DESC`,
      ),
  ]);
  const counts = CountsSchema.parse(totals?.results[0]);
  return {
    authorCount: counts.authorCount,
    poemCount: counts.poemCount,
    sourcePoemCount: counts.sourcePoemCount,
    remainingEstimate:
      counts.declaredPoemCount > 0
        ? Math.max(0, counts.declaredPoemCount - counts.poemCount)
        : null,
    modelCounts: ModelCountSchema.array().parse(models?.results),
    collectionDays: CollectionDaySchema.array().parse(days?.results),
  };
}
