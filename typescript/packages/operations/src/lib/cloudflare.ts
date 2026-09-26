import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { SourceNameSchema, SourceOriginSchema } from "@saqi/precedent-iso";
import { z } from "zod";

export interface CloudflareEnv {
  DB: D1Database;
  PUBLIC_SITE: Fetcher | undefined;
  SAQI_DIRECT_SOURCE_ACTIVE: string | undefined;
  SAQI_PUBLIC_CACHE_PURGE_SECRET: string | undefined;
  SAQI_PUBLIC_ORIGIN: string | undefined;
  SAQI_RIG_ACTIVE: string | undefined;
  SAQI_SOURCE_BASE_URL: string;
  SAQI_SOURCE_NAME: string;
}

const D1DatabaseSchema = z.custom<D1Database>(
  (value) => z.object({ prepare: z.function() }).safeParse(value).success,
  { message: "DB must be a D1 database binding" }
);
const CloudflareEnvSchema = z.object({
  PUBLIC_SITE: z.custom<Fetcher>().optional(),
  SAQI_PUBLIC_CACHE_PURGE_SECRET: z.string().optional(),
  DB: D1DatabaseSchema,
  SAQI_PUBLIC_ORIGIN: z.string().optional(),
  SAQI_SOURCE_BASE_URL: SourceOriginSchema,
  SAQI_SOURCE_NAME: SourceNameSchema,
  SAQI_DIRECT_SOURCE_ACTIVE: z.enum(["0", "1"]).optional(),
  SAQI_RIG_ACTIVE: z.enum(["0", "1"]).optional(),
});

export function getCloudflareEnv(): CloudflareEnv {
  const { env } = getCloudflareContext();
  const typedEnv = CloudflareEnvSchema.parse(env);

  return {
    PUBLIC_SITE: typedEnv.PUBLIC_SITE,
    SAQI_PUBLIC_CACHE_PURGE_SECRET: typedEnv.SAQI_PUBLIC_CACHE_PURGE_SECRET,
    DB: typedEnv.DB,
    SAQI_PUBLIC_ORIGIN: typedEnv.SAQI_PUBLIC_ORIGIN,
    SAQI_SOURCE_BASE_URL: typedEnv.SAQI_SOURCE_BASE_URL,
    SAQI_SOURCE_NAME: typedEnv.SAQI_SOURCE_NAME,
    SAQI_DIRECT_SOURCE_ACTIVE: typedEnv.SAQI_DIRECT_SOURCE_ACTIVE,
    SAQI_RIG_ACTIVE: typedEnv.SAQI_RIG_ACTIVE,
  };
}
