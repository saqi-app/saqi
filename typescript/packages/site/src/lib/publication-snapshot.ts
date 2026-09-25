import { z } from "zod";

import { type Poem, SnapshotPoemSchema } from "./snapshot-contract";

// These are the publication fields that the existing poem page actually uses.
// Arabic, route identity, and visibility remain authoritative on poem.
const PublicationFieldsSchema = z.object({
  linesEnglish: SnapshotPoemSchema.shape.linesEnglish,
  linesEnglishAttributionCertainty:
    SnapshotPoemSchema.shape.linesEnglishAttributionCertainty,
  linesEnglishModel: SnapshotPoemSchema.shape.linesEnglishModel,
  linesEnglishModelVendor: SnapshotPoemSchema.shape.linesEnglishModelVendor,
  linesEnglishGemini: SnapshotPoemSchema.shape.linesEnglishGemini,
  linesEnglishGeminiModel: SnapshotPoemSchema.shape.linesEnglishGeminiModel,
  linesEnglishSol: SnapshotPoemSchema.shape.linesEnglishSol,
  linesEnglishSolModel: SnapshotPoemSchema.shape.linesEnglishSolModel,
  linesEnglishSolReasoningEffort:
    SnapshotPoemSchema.shape.linesEnglishSolReasoningEffort,
  modelEnrichments: SnapshotPoemSchema.shape.modelEnrichments,
  insights: SnapshotPoemSchema.shape.insights,
  insightsModel: SnapshotPoemSchema.shape.insightsModel,
  insightsReasoningEffort: SnapshotPoemSchema.shape.insightsReasoningEffort,
  insightsTrack: SnapshotPoemSchema.shape.insightsTrack,
});

export const PublicationSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(2),
  active: z.boolean(),
  fields: PublicationFieldsSchema,
});

export function publicationSnapshotFromPoem(poem: Poem, active = false) {
  return PublicationSnapshotSchema.parse({
    schemaVersion: 2,
    active,
    fields: poem,
  });
}
