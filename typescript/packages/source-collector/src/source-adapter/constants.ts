import { SourceNameSchema, SourceOriginSchema } from "@saqi/precedent-iso";

export interface SourceConfiguration {
  readonly name: string;
  readonly origin: string;
}

const DEFAULT_SOURCE_CONFIGURATION: SourceConfiguration = Object.freeze({
  name: "source",
  origin: "https://source.invalid",
});

let sourceConfiguration = DEFAULT_SOURCE_CONFIGURATION;

export function configureSource(raw: SourceConfiguration): void {
  const name = SourceNameSchema.safeParse(raw.name);
  if (!name.success) {
    throw new Error("SOURCE_NAME_INVALID");
  }
  const origin = SourceOriginSchema.safeParse(raw.origin);
  if (!origin.success) {
    throw new Error("SOURCE_ORIGIN_INVALID");
  }
  sourceConfiguration = Object.freeze({
    name: name.data,
    origin: origin.data,
  });
}

export function currentSource(): SourceConfiguration {
  return sourceConfiguration;
}

export const PROJECTION_SCHEMA_VERSION = 1 as const;

export const LIMITS = {
  authorName: 512,
  authorSlug: 256,
  poemTitle: 512,
  poemsPerAuthor: 20_000,
  poemLines: 4_096,
  poemLine: 4_096,
  poemTextBytes: 4 * 1024 * 1024,
  url: 2_048,
  // Source cards can report the length of book-scale didactic poems; this is
  // metadata only. Actual downloaded poem bodies remain bounded separately by
  // poemLines and poemTextBytes.
  verses: 10_000,
} as const;
