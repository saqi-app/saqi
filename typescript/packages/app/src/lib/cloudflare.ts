import type { D1Database } from "@cloudflare/workers-types";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { SourceNameSchema, SourceOriginSchema } from "@saqi/precedent-iso";
import { z } from "zod";

export interface CloudflareEnv {
  CF_CACHE_PURGE_TOKEN: string | undefined;
  CF_ZONE_ID: string | undefined;
  DB: D1Database;
  SAQI_PUBLIC_ORIGIN: string | undefined;
  SAQI_SOURCE_BASE_URL: string;
  SAQI_SOURCE_NAME: string;
}

const D1DatabaseSchema = z.custom<D1Database>(
  (value) => typeof value === "object" && value !== null && "prepare" in value,
  { message: "DB must be a D1 database binding" }
);
const CloudflareEnvSchema = z.object({
  CF_CACHE_PURGE_TOKEN: z.string().optional(),
  CF_ZONE_ID: z.string().optional(),
  DB: D1DatabaseSchema,
  SAQI_PUBLIC_ORIGIN: z.string().optional(),
  SAQI_SOURCE_BASE_URL: SourceOriginSchema,
  SAQI_SOURCE_NAME: SourceNameSchema,
});

export function getCloudflareEnv(): CloudflareEnv {
  const { env } = getCloudflareContext();
  const typedEnv = CloudflareEnvSchema.parse(env);

  return {
    CF_CACHE_PURGE_TOKEN: typedEnv.CF_CACHE_PURGE_TOKEN,
    CF_ZONE_ID: typedEnv.CF_ZONE_ID,
    DB: typedEnv.DB,
    SAQI_PUBLIC_ORIGIN: typedEnv.SAQI_PUBLIC_ORIGIN,
    SAQI_SOURCE_BASE_URL: typedEnv.SAQI_SOURCE_BASE_URL,
    SAQI_SOURCE_NAME: typedEnv.SAQI_SOURCE_NAME,
  };
}
