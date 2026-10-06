import type { Fetcher } from "@cloudflare/workers-types";
import { z } from "zod";

import type { CloudflareEnv } from "./cloudflare";

const PURGE_TIMEOUT_MS = 10_000;
type PurgeTransport = (
  url: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: "POST";
  }
) => Promise<{ status: number; json?: () => Promise<unknown> }>;

export interface PublicCacheConfig {
  readonly publicOrigin: string;
  readonly publicSite: Pick<Fetcher, "fetch">;
  readonly purgeSecret: string;
}

export type PublicCacheConfiguration =
  | { readonly config: PublicCacheConfig; readonly state: "enabled" }
  | { readonly state: "disabled" };

type PublicCacheEnvironment = Pick<
  CloudflareEnv,
  "SAQI_PUBLIC_CACHE_PURGE_SECRET" | "SAQI_PUBLIC_ORIGIN"
> & { PUBLIC_SITE: Pick<Fetcher, "fetch"> | undefined };

export interface PublishedPoemRoute {
  readonly authorSlug: string;
  readonly poemId: string;
}

export class PublicCacheInvalidationError extends Error {
  readonly details?: {
    status: number;
    errors?: { code: number; message: string }[];
  };

  constructor(
    code: string,
    details?: {
      status: number;
      errors?: { code: number; message: string }[];
    }
  ) {
    super(code);
    this.name = "PublicCacheInvalidationError";
    if (details) this.details = details;
  }
}

export function publicCacheConfig(
  env: PublicCacheEnvironment
): PublicCacheConfiguration {
  const publicSite = env.PUBLIC_SITE;
  const purgeSecret = env.SAQI_PUBLIC_CACHE_PURGE_SECRET;
  if (!publicSite && !purgeSecret) return { state: "disabled" };
  let origin: URL;
  try {
    origin = new URL(env.SAQI_PUBLIC_ORIGIN ?? "");
  } catch {
    throw new PublicCacheInvalidationError("PUBLIC_CACHE_CONFIG_INVALID");
  }
  if (
    !publicSite ||
    !purgeSecret ||
    !/^[\da-f]{64}$/iu.test(purgeSecret) ||
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new PublicCacheInvalidationError("PUBLIC_CACHE_CONFIG_INVALID");
  }
  return {
    config: { publicOrigin: origin.origin, publicSite, purgeSecret },
    state: "enabled",
  };
}

export function publishedPoemUrl(
  publicOrigin: string,
  route: PublishedPoemRoute
): string {
  if (!route.authorSlug || !route.poemId) {
    throw new PublicCacheInvalidationError("PUBLIC_CACHE_ROUTE_INVALID");
  }
  const path = `/author/${encodeURIComponent(route.authorSlug)}/poem/${encodeURIComponent(route.poemId)}`;
  return new URL(path, publicOrigin).href;
}

export async function purgePublishedPoem(
  config: PublicCacheConfig,
  route: PublishedPoemRoute,
  transport: PurgeTransport = (url, init) => config.publicSite.fetch(url, init)
): Promise<string> {
  const url = publishedPoemUrl(config.publicOrigin, route);
  await sendCachePurge(config, route, transport);
  return url;
}

export async function purgePublicCorpus(
  config: PublicCacheConfig,
  transport: PurgeTransport = (url, init) => config.publicSite.fetch(url, init)
): Promise<void> {
  await sendCachePurge(config, { all: true }, transport);
}

async function sendCachePurge(
  config: PublicCacheConfig,
  body: { readonly all: true } | PublishedPoemRoute,
  transport: PurgeTransport
): Promise<void> {
  let response: Awaited<ReturnType<PurgeTransport>>;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    response = await Promise.race([
      transport(`${config.publicOrigin}/internal/purge-publication-cache`, {
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${config.purgeSecret}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Purge timed out")),
          PURGE_TIMEOUT_MS
        );
      }),
    ]);
  } catch {
    throw new PublicCacheInvalidationError("PUBLIC_CACHE_PURGE_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
  if (response.status !== 204) {
    // Only the public Worker's bounded error contract may leave this boundary.
    // Never forward arbitrary response text, headers, or credentials.
    const parsed = PurgeFailureSchema.safeParse(
      await response.json?.().catch(() => null)
    );
    throw new PublicCacheInvalidationError("PUBLIC_CACHE_PURGE_REJECTED", {
      status: response.status,
      ...(parsed.success ? { errors: parsed.data.errors } : {}),
    });
  }
}

const PurgeFailureSchema = z.object({
  code: z.literal("PUBLIC_CACHE_PURGE_FAILED"),
  errors: z
    .array(z.object({ code: z.number().int(), message: z.string().max(300) }))
    .max(10),
});
