import { describe, expect, it } from "vitest";

import {
  type CompletionPlanInput,
  CompletionPlanInputSchema,
  estimateCollectionCompletion,
  planEnrichmentCompletion,
} from "../enrichment/completion-plan.js";

function input(change: Partial<CompletionPlanInput> = {}): CompletionPlanInput {
  return {
    totalUniquePoems: 100,
    acceptedCurrentPoems: 10,
    reusableAcceptedPoems: 5,
    generatedWithOnePassingReview: 4,
    generatedWithoutReviews: 3,
    authorizedRemainingOperations: 0,
    scenarios: [
      {
        name: "measured",
        invocationConcurrency: 2,
        meanOperationSeconds: 60,
        operationRateCapPerHour: 100,
      },
    ],
    ...change,
  };
}

describe("offline completion planning", () => {
  it("rejects unrecognized policy overrides and unbounded scenarios", () => {
    expect(
      CompletionPlanInputSchema.safeParse({ ...input(), reviews: 0 }).success,
    ).toBe(false);
    const scenario = input().scenarios[0];
    expect(() =>
      planEnrichmentCompletion(
        input({ scenarios: Array.from({ length: 33 }, () => scenario!) }),
      ),
    ).toThrow();
    expect(() =>
      planEnrichmentCompletion(
        input({ scenarios: [{ ...scenario!, invocationConcurrency: 257 }] }),
      ),
    ).toThrow();
  });

  it("rejects operation overflow rather than rounding budget counts", () => {
    expect(() =>
      planEnrichmentCompletion(
        input({ totalUniquePoems: Number.MAX_SAFE_INTEGER }),
      ),
    ).toThrow();
  });

  it("reports zero remaining work without needing additional budget", () => {
    const result = planEnrichmentCompletion(
      input({
        totalUniquePoems: 10,
        acceptedCurrentPoems: 10,
        reusableAcceptedPoems: 0,
        generatedWithOnePassingReview: 0,
        generatedWithoutReviews: 0,
      }),
    );
    expect(result.minimumOperations).toBe(0);
    expect(result.scenarios[0]?.executableCompletionHours).toBe(0);
  });
  it("keeps the two-review quality gate and counts retained phases once", () => {
    const result = planEnrichmentCompletion(input());
    expect(result).toMatchObject({
      freshPoems: 78,
      minimumOperations: 244,
      operationsSavedByVerifiedReuse: 26,
      additionalAuthorizationRequired: 244,
      qualityPolicy: {
        passingReviewsRequired: 2,
        modelSwitchRequiresApprovalAndEvaluation: true,
      },
      monetaryCost: null,
    });
  });

  it("does not report executable ETA while budget is blocked", () => {
    const scenario = planEnrichmentCompletion(input()).scenarios[0];
    expect(scenario?.optimisticHoursAfterAuthorization).toBe(2.44);
    expect(scenario?.executableCompletionHours).toBeNull();
  });

  it("caps concurrency scenarios at independently supplied throughput", () => {
    const result = planEnrichmentCompletion(
      input({ authorizedRemainingOperations: 244 }),
    );
    expect(result.scenarios[0]?.operationsPerHour).toBe(100);
    expect(result.scenarios[0]?.executableCompletionHours).toBe(2.44);
  });

  it("uses latency as a separate limiting factor", () => {
    const result = planEnrichmentCompletion(
      input({
        scenarios: [
          {
            name: "slow",
            invocationConcurrency: 1,
            meanOperationSeconds: 120,
            operationRateCapPerHour: 100,
          },
        ],
      }),
    );
    expect(result.scenarios[0]?.operationsPerHour).toBe(30);
  });

  it("computes an explicitly supplied corpus scenario without pricing guesses", () => {
    const result = planEnrichmentCompletion(
      input({
        totalUniquePoems: 124579,
        acceptedCurrentPoems: 1,
        reusableAcceptedPoems: 0,
        generatedWithOnePassingReview: 0,
        generatedWithoutReviews: 0,
      }),
    );
    expect(result.minimumOperations).toBe(373734);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid count %s",
    (value) => {
      expect(() =>
        planEnrichmentCompletion(input({ totalUniquePoems: value })),
      ).toThrow();
    },
  );

  it("rejects overlapping or over-counted checkpoint partitions", () => {
    expect(() =>
      planEnrichmentCompletion(input({ totalUniquePoems: 20 })),
    ).toThrow();
  });

  it("does not confuse zero progress with a completion date", () => {
    const result = estimateCollectionCompletion({
      totalUnique: 100,
      completedUnique: 20,
      sampleCompletedUnique: 0,
      sampleHours: 1,
      inventoryComplete: false,
    });
    expect(result).toMatchObject({
      hoursAtObservedRate: null,
      scope: "known-inventory-only",
    });
  });

  it("estimates from unique completions rather than duplicate author jobs", () => {
    const result = estimateCollectionCompletion({
      totalUnique: 100,
      completedUnique: 20,
      sampleCompletedUnique: 10,
      sampleHours: 2,
      inventoryComplete: true,
    });
    expect(result).toMatchObject({
      hoursAtObservedRate: 16,
      observedUniquePerHour: 5,
    });
  });
});
