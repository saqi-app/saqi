import {
  ENRICHMENT_INPUT_SCHEMA_ID,
  ENRICHMENT_INPUT_SCHEMA_VERSION,
} from "@saqi/precedent-iso";
import { z } from "zod";

import { EnrichmentProviderSchema } from "../ports/provider-contract.js";
import { SOL_ENRICHMENT_WORK_KIND } from "./sol-coordinator.js";
import {
  ENRICHMENT_PROVIDER_SPECS,
  type EnrichmentProvider,
  SOL_PIPELINE_VERSION,
} from "./sol-runner.js";

const SOURCE_SCHEMA_VERSION = `${ENRICHMENT_INPUT_SCHEMA_ID}@${String(ENRICHMENT_INPUT_SCHEMA_VERSION)}`;
const LEGACY_SOL_PIPELINE_VERSION = "sol-enrichment-v1";

const ReconciliationProvidersSchema = z.array(EnrichmentProviderSchema).max(1);

const ProfileSchema = z.strictObject({
  implementationVersion: z.string().trim().min(1).max(100),
  kind: z.string().trim().min(1).max(100),
  provider: EnrichmentProviderSchema,
});

const EnrichmentStartupReconciliationReportSchema = z.strictObject({
  duplicates: z.int().nonnegative(),
  profiles: z.array(
    ProfileSchema.extend({
      duplicates: z.int().nonnegative(),
      inserted: z.int().nonnegative(),
    }).strict(),
  ),
  scannedInputs: z.int().nonnegative(),
  schemaId: z.literal("saqi.enrichment-startup-reconciliation"),
  schemaVersion: z.literal(2),
  seeded: z.int().nonnegative(),
  sourceImplementationVersion: z.literal(SOL_PIPELINE_VERSION),
  sourceImplementationVersions: z.tuple([
    z.literal(LEGACY_SOL_PIPELINE_VERSION),
    z.literal(SOL_PIPELINE_VERSION),
  ]),
  sourceKind: z.literal(SOL_ENRICHMENT_WORK_KIND),
  sourceSchemaVersion: z.literal(SOURCE_SCHEMA_VERSION),
});

export type EnrichmentStartupReconciliationReport = z.infer<
  typeof EnrichmentStartupReconciliationReportSchema
>;

export function reconcileExistingEnrichmentInputs(options: {
  readonly providers: readonly EnrichmentProvider[];
}): EnrichmentStartupReconciliationReport {
  const providers = ReconciliationProvidersSchema.parse(options.providers);
  // A profile release is not authorization to translate the historical corpus
  // again. Existing definitions retain their immutable version and checkpoints;
  // only newly admitted inputs use the current profile.
  const profiles = providers.map((provider) => {
    const spec = ENRICHMENT_PROVIDER_SPECS[provider];
    return {
      duplicates: 0,
      implementationVersion: spec.pipelineVersion,
      inserted: 0,
      kind: SOL_ENRICHMENT_WORK_KIND,
      provider,
    };
  });
  return EnrichmentStartupReconciliationReportSchema.parse({
    duplicates: 0,
    profiles,
    scannedInputs: 0,
    schemaId: "saqi.enrichment-startup-reconciliation",
    schemaVersion: 2,
    seeded: 0,
    sourceImplementationVersion: SOL_PIPELINE_VERSION,
    sourceImplementationVersions: [
      LEGACY_SOL_PIPELINE_VERSION,
      SOL_PIPELINE_VERSION,
    ],
    sourceKind: SOL_ENRICHMENT_WORK_KIND,
    sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
  });
}
