import { arabicWords } from "../packages/precedent-iso/dist/word-glosses.js";

export function generationSchema(template, lines) {
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
          items: { type: "string" },
          minItems: arabicWords(line).length,
          maxItems: arabicWords(line).length,
        },
      ]),
    ),
  };
  return schema;
}

export function normalizeWordMeanings(output) {
  if (Array.isArray(output.wordMeanings)) return output;
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
