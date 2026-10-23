import {
  AuthorIndexCacheRepository,
  type PendingAuthorIndexCache,
} from "./author-index-cache-repository";
import type { CloudflareEnv } from "./parse-cloudflare-env";
import {
  bootstrapAuthorIndex,
  type PublicCacheConfig,
  publicCacheConfig,
  purgeAuthorIndex,
  purgePublishedPoems,
  purgePublishedPoemsAndAuthorIndex,
} from "./public-cache";
import { PublicRouteCacheRepository } from "./public-route-cache-repository";
import { RigPublicationRepository } from "./rig-publication-repository";

type PendingPoems = Awaited<
  ReturnType<RigPublicationRepository["pendingPurges"]>
>;
type PurgeState = "disabled" | "empty" | "pending" | "purged";

export async function purgeDirtyPublicCache(
  env: CloudflareEnv,
  poemId?: string
): Promise<PurgeState> {
  return drainPublicCache(env, poemId, "normal");
}

export async function bootstrapDirtyPublicCache(
  env: CloudflareEnv
): Promise<PurgeState> {
  await new AuthorIndexCacheRepository(env.DB).requestBootstrap();
  // Explicit deployment compatibility purges are rare and bypass the normal
  // content budget, just like the isolated zero-DB deployment probe.
  return drainPublicCache(env, undefined, "deployment");
}

async function drainPublicCache(
  env: CloudflareEnv,
  poemId: string | undefined,
  operation: "deployment" | "normal"
): Promise<PurgeState> {
  const cache = publicCacheConfig(env);
  if (cache.state === "disabled") return "disabled";
  const indexRepository = new AuthorIndexCacheRepository(env.DB);
  const publicationRepository = new RigPublicationRepository(env.DB);
  const routeCacheRepository = new PublicRouteCacheRepository(env.DB);
  // A previous full purge can cover more than one bounded acknowledgement
  // batch. Keep draining its durable proof even after the index is clean.
  const [routeRead] = await Promise.allSettled([
    routeCacheRepository.acknowledge(),
  ]);
  const reads = await Promise.allSettled([
    indexRepository.pending(),
    readPendingPoems(publicationRepository, poemId),
  ]);
  const routeCache =
    routeRead.status === "fulfilled"
      ? routeRead.value
      : { acknowledged: 0, pending: true };
  const index = reads[0].status === "fulfilled" ? reads[0].value : null;
  const candidates = reads[1].status === "fulfilled" ? reads[1].value : [];
  const poems = index ? candidates.slice(0, 49) : candidates;
  if (!index && poems.length === 0) {
    propagateFailure([routeRead, ...reads]);
    return routeCache.pending
      ? "pending"
      : routeCache.acknowledged > 0
        ? "purged"
        : "empty";
  }
  if (operation === "normal" && !(await indexRepository.reservePurge())) {
    propagateFailure([routeRead, ...reads]);
    return "pending";
  }
  await purgeCapturedCache(cache.config, index, poems);
  const acknowledgements = await Promise.allSettled([
    index ? indexRepository.acknowledge(index) : Promise.resolve(true),
    acknowledgePoems(publicationRepository, poems, poemId),
    acknowledgeCoveredRoutes(routeCacheRepository, index),
  ]);
  // Successful work in one queue is durable even when the other queue's read
  // or acknowledgement failed. Only captured rows/epochs can be cleared.
  propagateFailure([routeRead, ...reads, ...acknowledgements]);
  const complete = acknowledgements.every(
    (result) => result.status === "fulfilled" && result.value
  );
  return complete && poems.length === candidates.length ? "purged" : "pending";
}

async function acknowledgeCoveredRoutes(
  repository: PublicRouteCacheRepository,
  index: null | PendingAuthorIndexCache
): Promise<boolean> {
  // Only an actual successful full-corpus request proves coverage. Use the
  // captured index generation, never a later live generation or old bootstrap ID.
  if (index !== null && index.bootstrapGeneration !== null)
    await repository.recordPurge(index.generation);
  const result = await repository.acknowledge();
  return !result.pending;
}

async function readPendingPoems(
  repository: RigPublicationRepository,
  poemId: string | undefined
): Promise<PendingPoems> {
  if (poemId === undefined) return repository.pendingPurges();
  const row = await repository.pendingPurge(poemId);
  return row ? [row] : [];
}

async function acknowledgePoems(
  repository: RigPublicationRepository,
  poems: PendingPoems,
  poemId: string | undefined
): Promise<boolean> {
  const [poem] = poems;
  if (poemId !== undefined && poem) return repository.clearCacheDirty(poem);
  const count = await repository.clearCacheDirtyBatch(poems);
  return count === poems.length;
}

async function purgeCapturedCache(
  config: PublicCacheConfig,
  index: null | PendingAuthorIndexCache,
  poems: PendingPoems
): Promise<void> {
  if (index !== null && index.bootstrapGeneration !== null) {
    await bootstrapAuthorIndex(config);
  } else if (index && poems.length > 0) {
    await purgePublishedPoemsAndAuthorIndex(config, poems);
  } else if (index) {
    await purgeAuthorIndex(config);
  } else {
    await purgePublishedPoems(config, poems);
  }
}

function propagateFailure(
  results: readonly PromiseSettledResult<unknown>[]
): void {
  for (const result of results) {
    if (result.status !== "rejected") continue;
    if (result.reason instanceof Error) throw result.reason;
    throw new Error("PUBLIC_CACHE_MAINTENANCE_UNAVAILABLE");
  }
}
