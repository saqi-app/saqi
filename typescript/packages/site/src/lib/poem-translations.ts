import {
  approvedEnrichmentProfileByModelKey,
  READABLE_ENRICHMENT_PROFILES,
} from "@saqi/precedent-iso";

import type { Poem } from "./snapshot-contract";

export interface TranslationTrack {
  attributionCertainty?: string;
  attributionNote?: string;
  key: string;
  lines: string[];
  model?: string;
  provider?: TranslationModelProvider;
}

export interface WordGlossTrack {
  key: string;
  model: string;
  provider: TranslationModelProvider;
  wordGlosses: NonNullable<
    NonNullable<Poem["modelEnrichments"]>[number]["wordGlosses"]
  >;
}

// Display estimates do not change the immutable legacy attribution records.
// The earliest translator (7758078) used claude-2; later configurations varied.
export const LEGACY_TRANSLATION_MODEL_ESTIMATE = "Claude 2";
export const LEGACY_GEMINI_MODEL_ESTIMATE = "Gemini 3.5 Flash";
export const LEGACY_TRANSLATION_ATTRIBUTION_NOTE =
  "Claude 2 is inferred from the historical translator configuration. The original record does not identify its model.";
export const LEGACY_GEMINI_ATTRIBUTION_NOTE =
  "Gemini 3.5 Flash is a user-supplied attribution. The original record does not identify its model.";

export type TranslationModelProvider =
  "anthropic" | "google" | "openai" | "other";

// Historical display metadata is intentionally separate from executable
// enrichment profiles. These entries can label preserved translations but
// cannot schedule, validate, or publish model work.
const HISTORICAL_MODEL_PRESENTATIONS = [
  {
    displayName: "Claude Opus 5",
    model: "claude-opus-5",
    modelVendorKey: "anthropic",
  },
  {
    displayName: "Claude Opus 4.6",
    model: "claude-opus-4-6-thinking",
    modelVendorKey: "anthropic",
  },
  {
    displayName: "Gemini 3.1 Pro High",
    model: "gemini-3.1-pro-high",
    modelVendorKey: "google",
  },
] as const;

function isHistoricalClaudeEstimate(model: string): boolean {
  return (
    model === "Claude 1 or 2" || model === LEGACY_TRANSLATION_MODEL_ESTIMATE
  );
}

function isHistoricalGeminiEstimate(model: string): boolean {
  return (
    model === LEGACY_GEMINI_MODEL_ESTIMATE ||
    model === "Gemini (legacy model unknown)"
  );
}

function profileForModelLabel(model: string) {
  const normalized = model.split(" · ", 1)[0]?.trim() ?? model;
  return (
    READABLE_ENRICHMENT_PROFILES.find(
      ({ displayName, model: profileModel }) =>
        normalized === displayName ||
        normalized === profileModel ||
        normalized === `${displayName} (${profileModel})`,
    ) ??
    HISTORICAL_MODEL_PRESENTATIONS.find(
      ({ displayName, model: profileModel }) =>
        normalized === displayName ||
        normalized === profileModel ||
        normalized === `${displayName} (${profileModel})`,
    )
  );
}

export function translationModelProvider(
  model: string,
): TranslationModelProvider {
  const normalized = model.split(" · ", 1)[0]?.trim() ?? model;
  const profile = profileForModelLabel(model);
  if (profile) return profile.modelVendorKey;
  if (
    normalized === "claude-2" ||
    normalized === "claude-sonnet-4-5-20250929"
  ) {
    return "anthropic";
  }
  if (normalized === "gemini-3-pro-preview") return "google";
  if (normalized === "gemini-3.7-flash") return "google";
  if (isHistoricalGeminiEstimate(normalized)) return "google";
  if (isHistoricalClaudeEstimate(normalized)) return "anthropic";
  return "other";
}

export function translationModelName(model: string): string {
  const normalized = model.split(" · ", 1)[0]?.trim() ?? model;
  if (isHistoricalClaudeEstimate(normalized)) {
    return LEGACY_TRANSLATION_MODEL_ESTIMATE;
  }
  if (isHistoricalGeminiEstimate(normalized)) {
    return LEGACY_GEMINI_MODEL_ESTIMATE;
  }
  return profileForModelLabel(model)?.displayName ?? normalized;
}

function modelPresentation(
  enrichment: NonNullable<Poem["modelEnrichments"]>[number],
) {
  const profile =
    approvedEnrichmentProfileByModelKey(enrichment.modelKey) ??
    READABLE_ENRICHMENT_PROFILES.find(
      ({ modelKey }) => modelKey === enrichment.modelKey,
    ) ??
    profileForModelLabel(enrichment.model);
  return {
    model: enrichment.displayName ?? profile?.displayName ?? enrichment.model,
    provider:
      enrichment.vendorKey ??
      profile?.modelVendorKey ??
      translationModelProvider(enrichment.model),
  };
}

export function poemWordGlossTracks(
  poem: Pick<Poem, "modelEnrichments">,
): WordGlossTrack[] {
  return (poem.modelEnrichments ?? []).flatMap((enrichment) => {
    if (!enrichment.wordGlosses) return [];
    const presentation = modelPresentation(enrichment);
    return [
      {
        key: enrichment.modelKey,
        model: presentation.model,
        provider: presentation.provider,
        wordGlosses: enrichment.wordGlosses,
      },
    ];
  });
}

export function poemTranslationTracks(
  poem: Pick<
    Poem,
    | "linesEnglish"
    | "linesEnglishAttributionCertainty"
    | "linesEnglishGemini"
    | "linesEnglishGeminiModel"
    | "linesEnglishModel"
    | "linesEnglishModelVendor"
    | "linesEnglishSol"
    | "linesEnglishSolModel"
    | "linesEnglishSolReasoningEffort"
    | "modelEnrichments"
  >,
): TranslationTrack[] {
  const tracks: TranslationTrack[] = [];
  for (const enrichment of poem.modelEnrichments ?? []) {
    if (!hasTranslation(enrichment.lines)) continue;
    const presentation = modelPresentation(enrichment);
    tracks.push({
      key: enrichment.modelKey,
      lines: enrichment.lines,
      ...presentation,
    });
  }
  if (
    hasTranslation(poem.linesEnglishSol) &&
    !tracks.some(({ key }) => key === "sol-5.6")
  ) {
    const solProfile = approvedEnrichmentProfileByModelKey("sol-5.6");
    tracks.push({
      key: "sol",
      lines: poem.linesEnglishSol,
      model: "Sol · provenance unavailable",
      provider: solProfile?.modelVendorKey ?? "openai",
      ...(poem.linesEnglishSolModel
        ? {
            model:
              solProfile?.displayName ??
              translationModelName(poem.linesEnglishSolModel),
            provider:
              solProfile?.modelVendorKey ??
              translationModelProvider(poem.linesEnglishSolModel),
          }
        : {}),
    });
  }
  if (hasTranslation(poem.linesEnglish)) {
    const inferred =
      !poem.linesEnglishModel ||
      isHistoricalClaudeEstimate(poem.linesEnglishModel);
    tracks.push({
      ...(inferred
        ? { attributionNote: LEGACY_TRANSLATION_ATTRIBUTION_NOTE }
        : {}),
      attributionCertainty:
        poem.linesEnglishAttributionCertainty ??
        (inferred ? "inferred_range" : undefined),
      key: "legacy",
      lines: poem.linesEnglish,
      model: poem.linesEnglishModel ?? LEGACY_TRANSLATION_MODEL_ESTIMATE,
      provider:
        poem.linesEnglishModelVendor ??
        (poem.linesEnglishModel
          ? translationModelProvider(poem.linesEnglishModel)
          : "anthropic"),
    });
  }
  if (hasTranslation(poem.linesEnglishGemini)) {
    tracks.push({
      ...(!poem.linesEnglishGeminiModel ||
      isHistoricalGeminiEstimate(poem.linesEnglishGeminiModel)
        ? { attributionNote: LEGACY_GEMINI_ATTRIBUTION_NOTE }
        : {}),
      key: "gemini",
      lines: poem.linesEnglishGemini,
      model: poem.linesEnglishGeminiModel ?? LEGACY_GEMINI_MODEL_ESTIMATE,
      provider: poem.linesEnglishGeminiModel
        ? translationModelProvider(poem.linesEnglishGeminiModel)
        : "google",
    });
  }
  return tracks;
}

function hasTranslation(lines: string[] | undefined): lines is string[] {
  return lines?.some((line) => line.trim().length > 0) ?? false;
}

export function translatedLineCount(
  lines: string[],
  arabicLines: string[],
): number {
  return arabicLines.reduce(
    (count, line, index) =>
      count + (line.trim() && lines[index]?.trim() ? 1 : 0),
    0,
  );
}
