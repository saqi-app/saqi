import type { CloudflareEnv } from "./parse-cloudflare-env";
import { PublicRouteRepository } from "./public-route-repository";
import { requirePublicRouteReadiness } from "./require-public-route-readiness";

export async function maintainPublicRoutes(env: CloudflareEnv): Promise<void> {
  try {
    const repository = new PublicRouteRepository(env.DB);
    if (!(await repository.pending())) return;
    await requirePublicRouteReadiness(env);
    await repository.advance(5);
  } catch {
    // Metadata allocation is independent of publication/cache maintenance.
    // Keep pending generations for a later tick, with no private body/error log.
    console.warn("[ops] Public route maintenance deferred");
  }
}
