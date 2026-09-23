import { z } from "zod";

const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Offline planning only: never grants provider budget or changes runtime policy. */
export const CompletionPlanInputSchema = z.strictObject({
  /** Caller-verified unique poems, not jobs or summed inventory declarations. */
  totalUniquePoems: CountSchema,
  acceptedCurrentPoems: CountSchema,
  /** Disjoint, verified checkpoints for the exact source/model/prompt/schema. */
  reusableAcceptedPoems: CountSchema,
  generatedWithOnePassingReview: CountSchema,
  generatedWithoutReviews: CountSchema,
  authorizedRemainingOperations: CountSchema,
  scenarios: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(100),
        invocationConcurrency: z.number().int().min(1).max(256),
        meanOperationSeconds: z.number().positive(),
        /** Independently measured or authorized cap, not inferred from concurrency. */
        operationRateCapPerHour: z.number().positive(),
      }),
    )
    .max(32),
});

export type CompletionPlanInput = z.infer<typeof CompletionPlanInputSchema>;

const CollectionCompletionInputSchema = z.strictObject({
  totalUnique: CountSchema,
  completedUnique: CountSchema,
  sampleCompletedUnique: CountSchema,
  sampleHours: z.number().positive(),
  inventoryComplete: z.boolean(),
});

export type CollectionCompletionInput = z.infer<
  typeof CollectionCompletionInputSchema
>;

export function planEnrichmentCompletion(input: CompletionPlanInput) {
  CompletionPlanInputSchema.parse(input);
  const resolved =
    input.acceptedCurrentPoems +
    input.reusableAcceptedPoems +
    input.generatedWithOnePassingReview +
    input.generatedWithoutReviews;
  assertCount("checkpoint sum", resolved);
  if (resolved > input.totalUniquePoems)
    throw new Error("Checkpoint partitions exceed supplied unique poems");
  const freshPoems = input.totalUniquePoems - resolved;
  const minimumOperations =
    3 * freshPoems +
    2 * input.generatedWithoutReviews +
    input.generatedWithOnePassingReview;
  assertCount("minimumOperations", minimumOperations);
  const fullRecomputeOperations =
    3 * (input.totalUniquePoems - input.acceptedCurrentPoems);
  assertCount("fullRecomputeOperations", fullRecomputeOperations);
  return {
    qualityPolicy: {
      passingReviewsRequired: 2,
      modelSwitchRequiresApprovalAndEvaluation: true,
      artifactReuseRequiresExactIdentityAndPassingReviews: true,
    } as const,
    freshPoems,
    minimumOperations,
    operationsSavedByVerifiedReuse: fullRecomputeOperations - minimumOperations,
    additionalAuthorizationRequired: Math.max(
      0,
      minimumOperations - input.authorizedRemainingOperations,
    ),
    /** All attempts pass; excludes retries, rate-limit waits and publication time. */
    estimateKind: "optimistic-operation-lower-bound" as const,
    monetaryCost: null,
    scenarios: input.scenarios.map((scenario) => {
      assertCount("invocationConcurrency", scenario.invocationConcurrency);
      if (scenario.invocationConcurrency === 0)
        throw new Error("invocationConcurrency must be positive");
      for (const value of [
        scenario.meanOperationSeconds,
        scenario.operationRateCapPerHour,
      ]) {
        if (!Number.isFinite(value) || value <= 0)
          throw new Error("Scenario latency and rate cap must be positive");
      }
      const operationsPerHour = Math.min(
        (3600 * scenario.invocationConcurrency) / scenario.meanOperationSeconds,
        scenario.operationRateCapPerHour,
      );
      const hours = minimumOperations / operationsPerHour;
      if (!Number.isFinite(hours)) throw new Error("Scenario ETA overflow");
      return {
        name: scenario.name,
        operationsPerHour,
        optimisticHoursAfterAuthorization: hours,
        executableCompletionHours:
          minimumOperations <= input.authorizedRemainingOperations
            ? hours
            : null,
      };
    }),
  };
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative safe integer`);
}

/** Observed unique completions only; no multiplication by hypothetical lanes. */
export function estimateCollectionCompletion(input: CollectionCompletionInput) {
  CollectionCompletionInputSchema.parse(input);
  assertCount("totalUnique", input.totalUnique);
  assertCount("completedUnique", input.completedUnique);
  assertCount("sampleCompletedUnique", input.sampleCompletedUnique);
  if (input.completedUnique > input.totalUnique)
    throw new Error("Completed unique count exceeds inventory");
  if (!Number.isFinite(input.sampleHours) || input.sampleHours <= 0)
    throw new Error("sampleHours must be positive");
  const remaining = input.totalUnique - input.completedUnique;
  const rate = input.sampleCompletedUnique / input.sampleHours;
  if (!Number.isFinite(rate)) throw new Error("Observed rate overflow");
  const hours = remaining === 0 ? 0 : rate > 0 ? remaining / rate : null;
  if (hours !== null && !Number.isFinite(hours))
    throw new Error("Collection ETA overflow");
  return {
    remainingUnique: remaining,
    observedUniquePerHour: rate,
    hoursAtObservedRate: hours,
    scope: input.inventoryComplete
      ? "complete-inventory"
      : "known-inventory-only",
    guarantee: false as const,
  };
}
