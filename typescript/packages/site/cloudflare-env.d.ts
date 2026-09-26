// Cloudflare bindings used by the site. Keep runtime flags broad so a later
// production config change can enable them without changing this declaration.
interface __BaseEnv_CloudflareEnv {
	DB: D1Database;
	ASSETS: Fetcher;
	SAQI_PUBLICATION_PROJECTION_ACTIVE: string;
}
declare namespace Cloudflare {
	interface Env extends __BaseEnv_CloudflareEnv {}
}
interface CloudflareEnv extends __BaseEnv_CloudflareEnv {}
