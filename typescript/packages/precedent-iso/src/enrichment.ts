import { z } from "zod";

const MAX_LINE_CHARACTERS = 5_000;
const MAX_LINES = 2_000;
const MAX_GLOSS_CHARACTERS = 2_000;
const UNSAFE_CONTROL =
  /[\u{0000}-\u{0008}\u{000b}\u{000c}\u{000e}-\u{001f}\u{007f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const SafeTextSchema = z
  .string()
  .refine(
    (value) => !UNSAFE_CONTROL.test(value),
    "Text contains unsafe control characters",
  );
const GlossMeaningSchema = SafeTextSchema.trim()
  .min(1)
  .max(MAX_GLOSS_CHARACTERS);
const WordGlossPartSchema = z.strictObject({
  meaning: GlossMeaningSchema,
  surface: SafeTextSchema.min(1).max(MAX_LINE_CHARACTERS),
});
const WordGlossTextSegmentSchema = z.strictObject({
  kind: z.literal("text"),
  surface: SafeTextSchema.max(MAX_LINE_CHARACTERS),
});
const WordGlossWordSegmentSchema = z.strictObject({
  kind: z.literal("word"),
  meaning: GlossMeaningSchema,
  parts: z.array(WordGlossPartSchema).min(1).max(20).optional(),
  surface: SafeTextSchema.min(1).max(MAX_LINE_CHARACTERS),
  tokenIndex: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_LINE_CHARACTERS - 1),
});
const WordGlossSegmentSchema = z.discriminatedUnion("kind", [
  WordGlossTextSegmentSchema,
  WordGlossWordSegmentSchema,
]);
export const PoemWordGlossesSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        lineIndex: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_LINES - 1),
        segments: z.array(WordGlossSegmentSchema).max(MAX_LINE_CHARACTERS),
      }),
    )
    .min(1)
    .max(MAX_LINES),
  tokenizerVersion: z.literal("saqi-orthographic-v1"),
});
