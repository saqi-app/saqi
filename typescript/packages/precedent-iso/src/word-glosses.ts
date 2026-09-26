import { PoemWordGlossesSchema } from "./enrichment.js";

// Preserve source spelling; punctuation and spaces remain unannotated text.
export function arabicWords(line: string): string[] {
  return Array.from(
    line.matchAll(/\p{L}[\p{L}\p{M}\p{N}]*/gu),
    ([word]) => word,
  );
}

export function wordGlossesFromMeanings(
  lines: readonly string[],
  meanings: readonly string[][],
) {
  if (meanings.length !== lines.length)
    throw new Error("GLOSS_LINE_COUNT_MISMATCH");
  return PoemWordGlossesSchema.parse({
    tokenizerVersion: "saqi-orthographic-v1",
    lines: lines.map((line, lineIndex) => {
      const words = meanings[lineIndex];
      const matches = Array.from(
        line.matchAll(/\p{L}[\p{L}\p{M}\p{N}]*/gu),
        (match) => ({ surface: match[0], index: match.index }),
      );
      if (words?.length !== matches.length)
        throw new Error("GLOSS_WORD_COUNT_MISMATCH");
      const segments: unknown[] = [];
      let offset = 0;
      for (const [tokenIndex, match] of matches.entries()) {
        if (match.index > offset)
          segments.push({
            kind: "text",
            surface: line.slice(offset, match.index),
          });
        segments.push({
          kind: "word",
          surface: match.surface,
          tokenIndex,
          meaning: words[tokenIndex],
        });
        offset = match.index + match.surface.length;
      }
      if (offset < line.length)
        segments.push({ kind: "text", surface: line.slice(offset) });
      return { lineIndex, segments };
    }),
  });
}
