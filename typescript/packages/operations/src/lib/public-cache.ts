import type {
  AbortSignal as WorkerAbortSignal,
  Fetcher,
} from "@cloudflare/workers-types";
import { type BodyStream, readBoundedJsonBody } from "@saqi/precedent-iso";
import { z } from "zod";

import type { CloudflareEnv } from "./parse-cloudflare-env";

const PURGE_TIMEOUT_MS = 10_000;
type PurgeTransport = (
  url: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: "POST";
    signal: WorkerAbortSignal;
  }
) => Promise<{ status: number; body?: BodyStream | null }>;

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

interface PurgeFailureDetails {
  errors?: { code: number; message: string }[];
  status: number;
}

export class PublicCacheInvalidationError extends Error {
  readonly details?: PurgeFailureDetails;

  constructor(
    code: string,
    options?: ErrorOptions & { details?: PurgeFailureDetails }
  ) {
    super(code, options);
    this.name = "PublicCacheInvalidationError";
    if (options?.details) this.details = options.details;
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
  const path = `/poet/${encodeURIComponent(route.authorSlug)}/poem/${encodeURIComponent(route.poemId)}`;
  return new URL(path, publicOrigin).href;
}

export async function purgePublishedPoem(
  config: PublicCacheConfig,
  route: PublishedPoemRoute,
  transport: PurgeTransport = (url, init) => config.publicSite.fetch(url, init)
): Promise<string> {
  const url = publishedPoemUrl(config.publicOrigin, route);
  await sendCachePurge(
    config,
    { authorSlug: route.authorSlug, poemId: route.poemId },
    transport
  );
  return url;
}

export async function purgePublishedPoems(
  config: PublicCacheConfig,
  poems: readonly PublishedPoemRoute[],
  transport: PurgeTransport = (url, init) => config.publicSite.fetch(url, init)
): Promise<void> {
  await sendCachePurge(
    config,
    { poems: poems.map(({ authorSlug, poemId }) => ({ authorSlug, poemId })) },
    transport
  );
}

export async function purgePublishedPoemsAndAuthorIndex(
  config: PublicCacheConfig,
  poems: readonly PublishedPoemRoute[],
  transport: PurgeTransport = (url, init) => config.publicSite.fetch(url, init)
): Promise<void> {
  await sendCachePurge(
    config,
    {
      authorIndex: true,
      poems: poems.map(({ authorSlug, poemId }) => ({ authorSlug, poemId })),
    },
    transport
  );
}

export async function purgeAuthorIndex(
  config: PublicCacheConfig,
  transport: PurgeTransport = (url, init) => config.publicSite.fetch(url, init)
): Promise<void> {
  await sendCachePurge(config, { authorIndex: true }, transport);
}

export async function bootstrapAuthorIndex(
  config: PublicCacheConfig,
  transport: PurgeTransport = (url, init) => config.publicSite.fetch(url, init)
): Promise<void> {
  await sendCachePurge(
    config,
    { authorIndex: true, bootstrap: true },
    transport
  );
}

async function sendCachePurge(
  config: PublicCacheConfig,
  body:
    | { readonly authorIndex: true; readonly bootstrap?: true }
    | {
        readonly authorIndex: true;
        readonly poems: readonly PublishedPoemRoute[];
      }
    | { readonly poems: readonly PublishedPoemRoute[] }
    | PublishedPoemRoute,
  transport: PurgeTransport
): Promise<void> {
  let response: Awaited<ReturnType<PurgeTransport>> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    await Promise.race([
      (async () => {
        response = await transport(
          `${config.publicOrigin}/internal/purge-publication-cache`,
          {
            body: JSON.stringify(body),
            headers: {
              authorization: `Bearer ${config.purgeSecret}`,
              "content-type": "application/json",
            },
            method: "POST",
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-type-assertion -- The runtime signal is shared; DOM and Workers listener declarations differ.
            signal: controller.signal as unknown as WorkerAbortSignal,
          }
        );
        if (response.status === 204) return;
        const details: NonNullable<PublicCacheInvalidationError["details"]> = {
          status: response.status,
        };
        // Failure diagnostics are optional. Bound both the body and the total
        // request time so a stalled error body cannot stall cache maintenance.
        const parsed = PurgeFailureSchema.safeParse(
          await readBoundedJsonBody(
            response.body ?? null,
            16_384,
            "Purge response too large",
            controller.signal
          ).catch(() => null)
        );
        if (parsed.success) details.errors = parsed.data.errors;
        throw new PublicCacheInvalidationError("PUBLIC_CACHE_PURGE_REJECTED", {
          details,
        });
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Purge timed out")),
          PURGE_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof PublicCacheInvalidationError) throw error;
    if (response && response.status !== 204) {
      throw new PublicCacheInvalidationError("PUBLIC_CACHE_PURGE_REJECTED", {
        details: { status: response.status },
      });
    }
    throw new PublicCacheInvalidationError("PUBLIC_CACHE_PURGE_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

const PurgeFailureSchema = z.object({
  code: z.literal("PUBLIC_CACHE_PURGE_FAILED"),
  errors: z
    .array(z.object({ code: z.number().int(), message: z.string().max(300) }))
    .max(10),
});
