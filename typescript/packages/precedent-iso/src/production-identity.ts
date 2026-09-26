import { z } from "zod";

export const SAQI_PRODUCTION_DATABASE_ID =
  "ffaae610-4dae-4d7e-bf86-8232f46ca2b5";
export const PublicationIdentitySchema = z.strictObject({
  databaseId: z.literal(SAQI_PRODUCTION_DATABASE_ID),
  schemaId: z.literal("saqi.publication-identity"),
  schemaVersion: z.literal(1),
  service: z.literal("saqi-production"),
});
