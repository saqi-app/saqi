export const SITEMAP_SHARD_COUNT = 16;

const HASH_MODULUS = 2_147_483_647;

export function sitemapShardForId(identifier: string): number {
  let hash = 0;
  for (const character of identifier) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % HASH_MODULUS;
  }
  return hash % SITEMAP_SHARD_COUNT;
}
