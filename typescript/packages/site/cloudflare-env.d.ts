// eslint-disable-next-line no-restricted-syntax -- Wrangler consumers use this ambient Cloudflare namespace.
declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    SAQI_PUBLICATION_PROJECTION_ACTIVE: string;
  }
}
type CloudflareEnv = Cloudflare.Env;
