export const APPROVED_ENRICHMENT_MODEL = "gpt-5.6-sol";
export const APPROVED_ENRICHMENT_REASONING_EFFORT = "medium";
export const APPROVED_ENRICHMENT_PROMPT_VERSION = "sol-word-gloss-v3";
export const APPROVED_ENRICHMENT_PROFILES = [
  {
    backendKey: "openai-codex-cli",
    displayName: "Sol 5.6",
    displayOrder: 100,
    iconKey: "openai",
    model: APPROVED_ENRICHMENT_MODEL,
    modelKey: "sol-5.6",
    modelVendorKey: "openai",
    provider: "sol",
    promptVersion: APPROVED_ENRICHMENT_PROMPT_VERSION,
    reasoningEffort: APPROVED_ENRICHMENT_REASONING_EFFORT,
    validatorPrefix: "sol",
  },
] as const;
const PREVIOUS_SOL_ENRICHMENT_PROFILE = {
  ...APPROVED_ENRICHMENT_PROFILES[0],
  promptVersion: "sol-word-gloss-v2",
  reasoningEffort: "high",
} as const;
export const ACCEPTED_PUBLICATION_ENRICHMENT_PROFILES = [
  ...APPROVED_ENRICHMENT_PROFILES,
  PREVIOUS_SOL_ENRICHMENT_PROFILE,
] as const;
export type AcceptedPublicationEnrichmentProfile =
  (typeof ACCEPTED_PUBLICATION_ENRICHMENT_PROFILES)[number];
export const LEGACY_ENRICHMENT_PROFILES = [
  {
    ...APPROVED_ENRICHMENT_PROFILES[0],
    promptVersion: "sol-enrichment-v1",
    reasoningEffort: "high",
  },
  {
    backendKey: "anthropic-claude-code-cli",
    displayName: "Claude Opus 5",
    displayOrder: 200,
    iconKey: "anthropic",
    model: "claude-opus-5",
    modelKey: "claude-opus-5",
    modelVendorKey: "anthropic",
    provider: "claude",
    promptVersion: "claude-opus-5-word-gloss-v2",
    reasoningEffort: "max",
    validatorPrefix: "claude-opus-5",
  },
  {
    backendKey: "anthropic-claude-code-cli",
    displayName: "Claude Opus 5",
    displayOrder: 201,
    iconKey: "anthropic",
    model: "claude-opus-5",
    modelKey: "claude-opus-5",
    modelVendorKey: "anthropic",
    provider: "claude",
    promptVersion: "claude-opus-5-enrichment-v1",
    reasoningEffort: "max",
    validatorPrefix: "claude-opus-5",
  },
  {
    backendKey: "agy-cli",
    displayName: "Gemini 3.1 Pro High",
    displayOrder: 300,
    iconKey: "google",
    model: "gemini-3.1-pro-high",
    modelKey: "agy-gemini-3.1-pro-high",
    modelVendorKey: "google",
    provider: "agy",
    promptVersion: "agy-gemini-3-1-pro-high-word-gloss-v2",
    reasoningEffort: "high",
    validatorPrefix: "agy-gemini-3-1-pro-high",
  },
  {
    backendKey: "agy-cli",
    displayName: "Claude Opus 4.6",
    displayOrder: 310,
    iconKey: "anthropic",
    model: "claude-opus-4-6-thinking",
    modelKey: "agy-claude-opus-4.6-thinking", // gitleaks:allow -- Public legacy model identifier, not a credential.
    modelVendorKey: "anthropic",
    provider: "agy",
    promptVersion: "agy-claude-opus-4-6-word-gloss-v2",
    reasoningEffort: "high",
    validatorPrefix: "agy-claude-opus-4-6-thinking",
  },
  {
    backendKey: "agy-cli",
    displayName: "Claude Opus 4.6",
    displayOrder: 311,
    iconKey: "anthropic",
    model: "claude-opus-4-6-thinking",
    modelKey: "agy-claude-opus-4.6-thinking", // gitleaks:allow -- Public legacy model identifier, not a credential.
    modelVendorKey: "anthropic",
    provider: "agy",
    promptVersion: "agy-claude-opus-4-6-enrichment-v1",
    reasoningEffort: "high",
    validatorPrefix: "agy-claude-opus-4-6-thinking",
  },
  PREVIOUS_SOL_ENRICHMENT_PROFILE,
] as const;
export const READABLE_ENRICHMENT_PROFILES = [
  ...APPROVED_ENRICHMENT_PROFILES,
  ...LEGACY_ENRICHMENT_PROFILES,
] as const;
export type ApprovedEnrichmentProfile =
  (typeof APPROVED_ENRICHMENT_PROFILES)[number];
export type ReadableEnrichmentProfile =
  (typeof READABLE_ENRICHMENT_PROFILES)[number];

export type EnrichmentModelIconKey =
  (typeof READABLE_ENRICHMENT_PROFILES)[number]["iconKey"];

export function approvedEnrichmentProfileByModelKey(
  modelKey: string,
): ApprovedEnrichmentProfile | undefined {
  return APPROVED_ENRICHMENT_PROFILES.find(
    (profile) => profile.modelKey === modelKey,
  );
}

function requiredApprovedEnrichmentProfile(
  modelKey: string,
): ApprovedEnrichmentProfile {
  const profile = approvedEnrichmentProfileByModelKey(modelKey);
  if (!profile)
    throw new Error(`Enrichment profile is not registered: ${modelKey}`);
  return profile;
}
const DEFAULT_APPROVED_ENRICHMENT_PROFILE =
  requiredApprovedEnrichmentProfile("sol-5.6");

export function approvedEnrichmentProfile(input: {
  readonly model: string;
  readonly promptVersion: string;
  readonly reasoningEffort: string;
}): ApprovedEnrichmentProfile | undefined {
  return APPROVED_ENRICHMENT_PROFILES.find(
    (profile) =>
      profile.model === input.model &&
      profile.promptVersion === input.promptVersion &&
      profile.reasoningEffort === input.reasoningEffort,
  );
}

export function readableEnrichmentProfile(input: {
  readonly model: string;
  readonly promptVersion: string;
  readonly reasoningEffort: string;
}): ReadableEnrichmentProfile | undefined {
  return READABLE_ENRICHMENT_PROFILES.find(
    (profile) =>
      profile.model === input.model &&
      profile.promptVersion === input.promptVersion &&
      profile.reasoningEffort === input.reasoningEffort,
  );
}

export function acceptedPublicationEnrichmentProfile(input: {
  readonly model: string;
  readonly promptVersion: string;
  readonly reasoningEffort: string;
}): AcceptedPublicationEnrichmentProfile | undefined {
  return ACCEPTED_PUBLICATION_ENRICHMENT_PROFILES.find(
    (profile) =>
      profile.model === input.model &&
      profile.promptVersion === input.promptVersion &&
      profile.reasoningEffort === input.reasoningEffort,
  );
}

export function publicationEnrichmentProfile(input: {
  readonly model: string;
  readonly promptVersion: string;
  readonly reasoningEffort: string;
}): ReadableEnrichmentProfile | undefined {
  return (
    acceptedPublicationEnrichmentProfile(input) ??
    (input.model === LEGACY_ENRICHMENT_PROFILES[0].model &&
    input.promptVersion === LEGACY_ENRICHMENT_PROFILES[0].promptVersion &&
    input.reasoningEffort === LEGACY_ENRICHMENT_PROFILES[0].reasoningEffort
      ? LEGACY_ENRICHMENT_PROFILES[0]
      : undefined)
  );
}

export function approvedEnrichmentValidations(
  profile: ReadableEnrichmentProfile,
) {
  const fidelity = {
    attempt: 1,
    validatorKey: `${profile.validatorPrefix}-fidelity-review`,
    validatorVersion: profile.promptVersion,
  } as const;
  const grounding = {
    attempt: 2,
    validatorKey: `${profile.validatorPrefix}-grounding-review`,
    validatorVersion: profile.promptVersion,
  } as const;
  return { all: [fidelity, grounding] as const, fidelity, grounding };
}
export const APPROVED_ENRICHMENT_VALIDATIONS = [
  {
    attempt: 1,
    validatorKey: "sol-fidelity-review",
    validatorVersion: APPROVED_ENRICHMENT_PROMPT_VERSION,
  },
  {
    attempt: 2,
    validatorKey: "sol-grounding-review",
    validatorVersion: APPROVED_ENRICHMENT_PROMPT_VERSION,
  },
] as const;

export interface EnrichmentValidationIdentity {
  readonly attempt: number;
  readonly validatorKey: string;
  readonly validatorVersion: string;
}

export function isApprovedEnrichmentValidationSet(
  validations: readonly EnrichmentValidationIdentity[],
  profile: ReadableEnrichmentProfile = DEFAULT_APPROVED_ENRICHMENT_PROFILE,
): boolean {
  const approved = approvedEnrichmentValidations(profile).all;
  if (validations.length !== approved.length) return false;
  const identities = new Set(
    validations.map(({ attempt, validatorKey, validatorVersion }) =>
      JSON.stringify([validatorKey, validatorVersion, attempt]),
    ),
  );
  return approved.every(({ attempt, validatorKey, validatorVersion }) =>
    identities.has(JSON.stringify([validatorKey, validatorVersion, attempt])),
  );
}
