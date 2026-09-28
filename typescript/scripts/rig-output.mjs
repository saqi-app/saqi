import { arabicWords } from "../packages/precedent-iso/dist/word-glosses.js";

export function generationSchema(
  template,
  lines,
  required = template.required,
) {
  if (
    !Array.isArray(required) ||
    !required.length ||
    new Set(required).size !== required.length ||
    required.some((field) => !template.required.includes(field))
  )
    throw new Error("Invalid required generation fields");
  const schema = structuredClone(template);
  schema.properties.translation.properties.lines.minItems = lines.length;
  schema.properties.translation.properties.lines.maxItems = lines.length;
  schema.properties.wordMeanings = {
    type: "object",
    additionalProperties: false,
    required: lines.map((_, i) => `line_${i + 1}`),
    properties: Object.fromEntries(
      lines.map((line, i) => [
        `line_${i + 1}`,
        {
          type: "array",
          items: { ...template.properties.wordMeanings.items.items },
          minItems: arabicWords(line).length,
          maxItems: arabicWords(line).length,
        },
      ]),
    ),
  };
  schema.required = [...required];
  schema.properties = Object.fromEntries(
    Object.entries(schema.properties).filter(([field]) =>
      required.includes(field),
    ),
  );
  return schema;
}

export function normalizeWordMeanings(output) {
  // eslint-disable-next-line no-restricted-syntax -- Untrusted Codex JSON must be an object before field normalization.
  if (!output || typeof output !== "object" || Array.isArray(output))
    throw new Error("Invalid generation output");
  if (!("wordMeanings" in output) || Array.isArray(output.wordMeanings))
    return output;
  // eslint-disable-next-line no-restricted-syntax -- Raw Codex JSON is an untrusted boundary; reject non-object word maps before recovery.
  if (!output.wordMeanings || typeof output.wordMeanings !== "object")
    throw new Error("Missing word meanings");
  const keys = Object.keys(output.wordMeanings);
  if (keys.some((key) => !/^line_[1-9]\d*$/u.test(key)))
    throw new Error("Invalid word meaning line key");
  const meanings = keys.map((_, i) => output.wordMeanings[`line_${i + 1}`]);
  if (meanings.some((value) => !Array.isArray(value)))
    throw new Error("Missing word meaning line");
  return { ...output, wordMeanings: meanings };
}
