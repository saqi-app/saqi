import { describe, expect, it } from "vitest";

import {
  credentialGenerationsEqual,
  credentialObservationClassification,
  SolCredentialObservationSchema,
} from "../enrichment/sol-credential-observation";

const GENERATION_A = "a".repeat(64);
const GENERATION_B = "b".repeat(64);

describe("credential observations", () => {
  it("compares opaque generations and nullable snapshots", () => {
    expect(credentialGenerationsEqual(GENERATION_A, GENERATION_A)).toBe(true);
    expect(credentialGenerationsEqual(GENERATION_A, GENERATION_B)).toBe(false);
    expect(credentialGenerationsEqual(null, null)).toBe(true);
    expect(credentialGenerationsEqual(null, GENERATION_A)).toBe(false);
  });

  it("rejects malformed generations without throwing or equating truncated hex", () => {
    expect(credentialGenerationsEqual("zz", "yy")).toBe(false);
    expect(credentialGenerationsEqual(GENERATION_A, "a")).toBe(false);
    expect(
      credentialGenerationsEqual(GENERATION_A, GENERATION_A.toUpperCase()),
    ).toBe(false);
  });

  it("classifies stable, changed, transient, and pending observations", () => {
    const before = {
      accountGeneration: GENERATION_A,
      materialGeneration: GENERATION_B,
      observedAt: 1,
      state: "stable" as const,
    };
    expect(credentialObservationClassification(before, before)).toBe("stable");
    expect(
      credentialObservationClassification(before, {
        ...before,
        materialGeneration: GENERATION_A,
      }),
    ).toBe("changed_during_invocation");
    expect(
      credentialObservationClassification(before, {
        observedAt: 2,
        state: "transient",
      }),
    ).toBe("transient");
    expect(credentialObservationClassification(before, null)).toBe("pending");
  });

  it("rejects a classification inconsistent with its snapshots", () => {
    expect(() =>
      SolCredentialObservationSchema.parse({
        after: {
          accountGeneration: GENERATION_A,
          materialGeneration: GENERATION_B,
          observedAt: 2,
          state: "stable",
        },
        before: {
          accountGeneration: GENERATION_A,
          materialGeneration: GENERATION_B,
          observedAt: 1,
          state: "stable",
        },
        classification: "changed_during_invocation",
        schemaId: "saqi.sol-credential-observation",
        schemaVersion: 1,
      }),
    ).toThrow();
  });
});
