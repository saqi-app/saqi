import type { AbortSignal as WorkerAbortSignal } from "@cloudflare/workers-types";
import {
  cancelBody,
  PUBLIC_ROUTE_CAPABILITIES_PATH,
  PublicRouteCapabilitySchema,
  readBoundedJsonBody,
} from "@saqi/precedent-iso";

import type { CloudflareEnv } from "./parse-cloudflare-env";
import { publicCacheConfig } from "./public-cache";

export async function requirePublicRouteReadiness(
  env: CloudflareEnv
): Promise<void> {
  const cache = publicCacheConfig(env);
  if (cache.state === "disabled")
    throw new Error("PUBLIC_ROUTES_SITE_UNAVAILABLE");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const response = await cache.config.publicSite.fetch(
          `${cache.config.publicOrigin}${PUBLIC_ROUTE_CAPABILITIES_PATH}`,
          {
            method: "GET",
            redirect: "manual",
            // The same Web API signal reaches workerd at runtime; Node/DOM
            // and Workers declare incompatible listener overloads for it.
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-type-assertion -- The runtime Web API signal is identical; only Node/DOM and Workers listener declarations differ.
            signal: controller.signal as unknown as WorkerAbortSignal,
            headers: { authorization: `Bearer ${cache.config.purgeSecret}` },
          }
        );
        if (controller.signal.aborted || response.status !== 200) {
          cancelBody(response.body);
          throw new Error("PUBLIC_ROUTES_SITE_NOT_READY");
        }
        const body = await readBoundedJsonBody(
          response.body,
          1_024,
          "PUBLIC_ROUTES_CAPABILITY_TOO_LARGE",
          controller.signal
        );
        controller.signal.throwIfAborted();
        PublicRouteCapabilitySchema.parse(body);
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error("PUBLIC_ROUTES_SITE_TIMEOUT"));
          reject(new Error("PUBLIC_ROUTES_SITE_TIMEOUT"));
        }, 10_000);
      }),
    ]);
  } catch (error) {
    throw new Error("PUBLIC_ROUTES_SITE_NOT_READY", { cause: error });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
