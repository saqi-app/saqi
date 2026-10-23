import { TRANSLATION_MODELS } from "@saqi/precedent-iso";

import type { Poem } from "./snapshot-contract";

export interface TranslationTrack {
  attributionCertainty?: string | undefined;
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
const LEGACY_GEMINI_MODEL_ESTIMATE = "Gemini 3.5 Flash";
export const LEGACY_TRANSLATION_ATTRIBUTION_NOTE =
  "Claude 2 is inferred from the historical translator configuration. The original record does not identify its model.";
export const LEGACY_GEMINI_ATTRIBUTION_NOTE =
  "Gemini 3.5 Flash is a user-supplied attribution. The original record does not identify its model.";
const HISTORICAL_CLAUDE_LABEL = "Claude 1 or 2";
const HISTORICAL_GEMINI_LABEL = "Gemini (legacy model unknown)";

export type TranslationModelProvider =
  "anthropic" | "google" | "openai" | "other";

type ModelProfile = (typeof TRANSLATION_MODELS)[number];

const MODEL_PROFILES_BY_LABEL: ReadonlyMap<string, ModelProfile> = new Map(
  TRANSLATION_MODELS.flatMap((profile) =>
    [
      profile.displayName,
      profile.model,
      `${profile.displayName} (${profile.model})`,
    ].map((label) => [label, profile] as const)
  )
);
const MODEL_PROFILES_BY_KEY: ReadonlyMap<string, ModelProfile> = new Map(
  TRANSLATION_MODELS.map((profile) => [profile.modelKey, profile])
);

function normalizedModelLabel(model: string): string {
  return model.split(" · ", 1)[0]?.trim() ?? model;
}

export function translationModelProvider(
  model: string
): TranslationModelProvider {
  const normalized = normalizedModelLabel(model);
  const profile = MODEL_PROFILES_BY_LABEL.get(normalized);
  if (profile) return profile.modelVendorKey;
  if (
    normalized === "claude-2" ||
    normalized === "claude-sonnet-4-5-20250929"
  ) {
    return "anthropic";
  }
  if (
    normalized === "gemini-3-pro-preview" ||
    normalized === "gemini-3.7-flash" ||
    normalized === HISTORICAL_GEMINI_LABEL
  )
    return "google";
  if (normalized === HISTORICAL_CLAUDE_LABEL) return "anthropic";
  if (normalized === LEGACY_GEMINI_MODEL_ESTIMATE) return "google";
  if (normalized === LEGACY_TRANSLATION_MODEL_ESTIMATE) return "anthropic";
  return "other";
}

export function translationModelName(model: string): string {
  const normalized = normalizedModelLabel(model);
  if (normalized === HISTORICAL_CLAUDE_LABEL) {
    return LEGACY_TRANSLATION_MODEL_ESTIMATE;
  }
  if (normalized === HISTORICAL_GEMINI_LABEL)
    return LEGACY_GEMINI_MODEL_ESTIMATE;
  return MODEL_PROFILES_BY_LABEL.get(normalized)?.displayName ?? normalized;
}

function modelPresentation(
  enrichment: NonNullable<Poem["modelEnrichments"]>[number]
) {
  const profile = MODEL_PROFILES_BY_KEY.get(enrichment.modelKey);
  return {
    model: enrichment.displayName ?? profile?.displayName ?? enrichment.model,
    provider:
      enrichment.vendorKey ??
      profile?.modelVendorKey ??
      translationModelProvider(enrichment.model),
  };
}

export function poemWordGlossTracks(
  poem: Pick<Poem, "modelEnrichments" | "wordGlosses">
): WordGlossTrack[] {
  if (poem.wordGlosses)
    return [
      {
        key: "current-glosses",
        model: translationModelName(poem.wordGlosses.model),
        provider: translationModelProvider(poem.wordGlosses.model),
        wordGlosses: poem.wordGlosses.meanings,
      },
    ];
  return (poem.modelEnrichments ?? []).flatMap((enrichment) => {
    if (!enrichment.wordGlosses) return [];
    const presentation = modelPresentation(enrichment);
    return {
      key: enrichment.modelKey,
      model: presentation.model,
      provider: presentation.provider,
      wordGlosses: enrichment.wordGlosses,
    };
  });
}

type TranslationPoem = Pick<
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
>;

export function poemTranslationTracks(
  poem: TranslationPoem
): TranslationTrack[] {
  const tracks: TranslationTrack[] = [];
  if (poem.modelEnrichments != null) {
    for (const enrichment of poem.modelEnrichments) {
      if (!hasTranslation(enrichment.lines)) continue;
      const presentation = modelPresentation(enrichment);
      tracks.push({
        key: enrichment.modelKey,
        lines: enrichment.lines,
        ...presentation,
      });
    }
  }
  if (
    hasTranslation(poem.linesEnglishSol) &&
    !tracks.some(({ key }) => key === "sol-5.6")
  ) {
    const solProfile = TRANSLATION_MODELS[0];
    tracks.push({
      key: "sol",
      lines: poem.linesEnglishSol,
      model: poem.linesEnglishSolModel
        ? solProfile.displayName
        : "Sol · provenance unavailable",
      provider: solProfile.modelVendorKey,
    });
  }

  if (
    hasTranslation(poem.linesEnglish) &&
    !isLegacyProviderRefusal(poem.linesEnglish)
  ) {
    tracks.push(legacyTranslationTrack(poem, poem.linesEnglish));
  }

  if (hasTranslation(poem.linesEnglishGemini)) {
    const gemini: TranslationTrack = {
      key: "gemini",
      lines: poem.linesEnglishGemini,
      model: poem.linesEnglishGeminiModel ?? LEGACY_GEMINI_MODEL_ESTIMATE,
      provider: poem.linesEnglishGeminiModel
        ? translationModelProvider(poem.linesEnglishGeminiModel)
        : "google",
    };
    if (
      !poem.linesEnglishGeminiModel ||
      poem.linesEnglishGeminiModel === HISTORICAL_GEMINI_LABEL
    )
      gemini.attributionNote = LEGACY_GEMINI_ATTRIBUTION_NOTE;
    tracks.push(gemini);
  }
  return tracks;
}

function legacyTranslationTrack(
  poem: TranslationPoem,
  lines: string[]
): TranslationTrack {
  const inferred =
    !poem.linesEnglishModel ||
    poem.linesEnglishModel === HISTORICAL_CLAUDE_LABEL;
  const track: TranslationTrack = {
    attributionCertainty:
      poem.linesEnglishAttributionCertainty ??
      (inferred ? "inferred_range" : undefined),
    key: "legacy",
    lines,
    model: poem.linesEnglishModel ?? LEGACY_TRANSLATION_MODEL_ESTIMATE,
    provider:
      poem.linesEnglishModelVendor ??
      (poem.linesEnglishModel
        ? translationModelProvider(poem.linesEnglishModel)
        : "anthropic"),
  };
  if (inferred) track.attributionNote = LEGACY_TRANSLATION_ATTRIBUTION_NOTE;
  return track;
}

function hasTranslation(lines: string[] | undefined): lines is string[] {
  return lines?.some((line) => line.trim().length > 0) ?? false;
}

function isLegacyProviderRefusal(lines: string[]): boolean {
  // Exclude only the observed legacy boilerplate, leaving mixed tracks,
  // multiline text and the immutable publication itself intact.
  const response = lines.find((line) => line.trim().length > 0);
  return (
    response !== undefined &&
    !/[\r\n]/u.test(response) &&
    /^i apologize, but i do not feel comfortable providing translations for content i deem inappropriate or offensive\.$/iu.test(
      response.trim()
    ) &&
    lines.filter((line) => line.trim().length > 0).length === 1
  );
}

export function translatedLineCount(
  lines: string[],
  arabicLines: string[]
): number {
  return arabicLines.reduce(
    (count, line, index) =>
      count + (line.trim() && lines[index]?.trim() ? 1 : 0),
    0
  );
}

export function wordGlossMatchesTranslation(
  glossKey: string | undefined,
  translationKey: string | undefined
): boolean {
  return (
    glossKey === "current-glosses" ||
    (glossKey !== undefined && glossKey === translationKey)
  );
}
