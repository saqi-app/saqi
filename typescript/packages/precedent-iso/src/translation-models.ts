// Display metadata for translations already published in the corpus.
// Generation configuration and retired artifact validators do not belong here.
export const TRANSLATION_MODELS = [
  {
    modelKey: "sol-5.6",
    model: "gpt-5.6-sol",
    displayName: "Sol 5.6",
    modelVendorKey: "openai",
  },
  {
    modelKey: "claude-opus-5",
    model: "claude-opus-5",
    displayName: "Claude Opus 5",
    modelVendorKey: "anthropic",
  },
  {
    modelKey: "agy-gemini-3.1-pro-high",
    model: "gemini-3.1-pro-high",
    displayName: "Gemini 3.1 Pro High",
    modelVendorKey: "google",
  },
  {
    modelKey: "agy-claude-opus-4.6-thinking",
    model: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6",
    modelVendorKey: "anthropic",
  }, // gitleaks:allow -- Public legacy model identifier, not a credential.
] as const;
