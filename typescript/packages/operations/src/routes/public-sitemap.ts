import type { AbortSignal as WorkerAbortSignal } from "@cloudflare/workers-types";
import { cancelBody, readBoundedTextBody } from "@saqi/precedent-iso";

import { NO_STORE_HEADERS } from "../lib/operations-boundary";
import type { CloudflareEnv } from "../lib/parse-cloudflare-env";

// The operations Worker is protected by Cloudflare Access. A service binding
// reads the deployed public Worker without passing through Bot Fight Mode.
export async function publicSitemap(env: CloudflareEnv): Promise<Response> {
  const { PUBLIC_SITE } = env;
  if (!PUBLIC_SITE) return unavailable();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const xml = await Promise.race([
      (async () => {
        const response = await PUBLIC_SITE.fetch(
          "https://saqi.app/sitemap-index.xml",
          {
            redirect: "manual",
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-type-assertion -- DOM and Workers signal declarations differ; the runtime Web API signal is identical.
            signal: controller.signal as unknown as WorkerAbortSignal,
          }
        );
        if (
          controller.signal.aborted ||
          !response.ok ||
          response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase() !== "application/xml"
        ) {
          cancelBody(response.body);
          throw new Error("PUBLIC_SITEMAP_UNAVAILABLE");
        }
        return readBoundedTextBody(
          response.body,
          1_048_576,
          "PUBLIC_SITEMAP_TOO_LARGE",
          controller.signal
        );
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("PUBLIC_SITEMAP_TIMEOUT"));
        }, 10_000);
      }),
    ]);
    return Response.json({ xml }, { headers: NO_STORE_HEADERS });
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timeout);
  }
}

function unavailable(): Response {
  return Response.json(
    { error: "PUBLIC_SITEMAP_UNAVAILABLE" },
    { headers: NO_STORE_HEADERS, status: 502 }
  );
}
