import { describe, expect, it } from "vitest";

import {
  acceptedPublicationEnrichmentProfile,
  approvedEnrichmentProfile,
  approvedEnrichmentProfileByModelKey,
  LEGACY_ENRICHMENT_PROFILES,
  publicationEnrichmentProfile,
  readableEnrichmentProfile,
} from "../enrichment-profiles.js";

describe("enrichment profiles", () => {
  it.each([
    ["sol-word-gloss-v3", "medium", true],
    ["sol-word-gloss-v2", "high", false],
  ] as const)(
    "accepts publication of %s without confusing the current recipe",
    (promptVersion, reasoningEffort, current) => {
      const input = { model: "gpt-5.6-sol", promptVersion, reasoningEffort };
      expect(acceptedPublicationEnrichmentProfile(input)).toMatchObject(input);
      expect(publicationEnrichmentProfile(input)).toMatchObject(input);
      expect(readableEnrichmentProfile(input)).toMatchObject(input);
      expect(Boolean(approvedEnrichmentProfile(input))).toBe(current);
    },
  );

  it.each([
    ["sol-word-gloss-v3", "high"],
    ["sol-word-gloss-v2", "medium"],
    ["sol-enrichment-v1", "medium"],
  ])("rejects a mixed %s/%s recipe", (promptVersion, reasoningEffort) => {
    const input = { model: "gpt-5.6-sol", promptVersion, reasoningEffort };
    expect(acceptedPublicationEnrichmentProfile(input)).toBeUndefined();
    expect(publicationEnrichmentProfile(input)).toBeUndefined();
    expect(readableEnrichmentProfile(input)).toBeUndefined();
  });

  it("looks up approved model profiles by stable key instead of array order", () => {
    expect(approvedEnrichmentProfileByModelKey("sol-5.6")).toMatchObject({
      model: "gpt-5.6-sol",
      provider: "sol",
    });
    expect(
      approvedEnrichmentProfileByModelKey("retired-model"),
    ).toBeUndefined();
    expect(approvedEnrichmentProfileByModelKey("unknown")).toBeUndefined();
  });

  it("publishes only approved profiles plus the exact legacy Sol fallback", () => {
    expect(
      publicationEnrichmentProfile({
        model: "gpt-5.6-sol",
        promptVersion: "sol-enrichment-v1",
        reasoningEffort: "high",
      }),
    ).toMatchObject({
      modelKey: "sol-5.6",
      promptVersion: "sol-enrichment-v1",
    });
    expect(
      publicationEnrichmentProfile({
        model: "claude-opus-5",
        promptVersion: "claude-opus-5-enrichment-v1",
        reasoningEffort: "max",
      }),
    ).toBeUndefined();
  });

  it("keeps retired non-Sol profiles readable but never writable", () => {
    for (const profile of LEGACY_ENRICHMENT_PROFILES) {
      if (profile.provider === "sol") continue;
      expect(readableEnrichmentProfile(profile)).toEqual(profile);
      expect(acceptedPublicationEnrichmentProfile(profile)).toBeUndefined();
      expect(publicationEnrichmentProfile(profile)).toBeUndefined();
    }
  });
});
