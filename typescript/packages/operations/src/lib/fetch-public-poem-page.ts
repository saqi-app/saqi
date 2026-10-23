import type {
  AbortSignal as WorkerAbortSignal,
  Fetcher,
} from "@cloudflare/workers-types";
import { cancelBody, readBoundedTextBody } from "@saqi/precedent-iso";

import { publicRouteRequest } from "../../../site/src/lib/public-route-request";

function poemUrl(value: string, base?: string): URL {
  // Inspect the raw location before URL normalizes dot paths and backslashes.
  if (
    !value ||
    value.length > 8192 ||
    // eslint-disable-next-line no-control-regex -- Refuse ambiguous raw URL syntax before authority and route checks.
    /[\\\u{0000}-\u{0020}\u{007f}?#,]/u.test(value) ||
    /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu.test(value)
  )
    throw new Error("PUBLIC_PAGE_LOCATION_INVALID");
  const url = new URL(value, base);
  if (
    url.origin !== "https://saqi.app" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    publicRouteRequest(url.href)?.kind !== "poem"
  )
    throw new Error("PUBLIC_PAGE_LOCATION_INVALID");
  return url;
}
interface PublicPoemPage {
  html: string;
  status: number;
  url: string;
}

export async function fetchPublicPoemPage(
  publicSite: Pick<Fetcher, "fetch">,
  initialUrl: string,
  expectedUrl: string
): Promise<PublicPoemPage> {
  const initial = poemUrl(initialUrl);
  const expected = poemUrl(expectedUrl);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let url = initial;
        const visited = new Set<string>();
        for (let redirects = 0; redirects <= 3; redirects += 1) {
          if (visited.has(url.href))
            throw new Error("PUBLIC_PAGE_REDIRECT_LOOP");
          visited.add(url.href);
          // eslint-disable-next-line no-await-in-loop -- Follow only a bounded chain of validated public URLs through the same binding.
          const response = await publicSite.fetch(url.href, {
            redirect: "manual",
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-type-assertion -- The runtime Web API signal is shared; DOM and Workers listener declarations differ.
            signal: controller.signal as unknown as WorkerAbortSignal,
          });
          if (controller.signal.aborted) {
            cancelBody(response.body);
            controller.signal.throwIfAborted();
          }
          if (response.status === 308) {
            const location = response.headers.get("location");
            cancelBody(response.body);
            if (redirects === 3 || !location)
              throw new Error("PUBLIC_PAGE_REDIRECT_INVALID");
            url = poemUrl(location.trim(), url.href);
            continue;
          }
          if (response.status !== 200) {
            cancelBody(response.body);
            return { url: url.href, status: response.status, html: "" };
          }
          if (url.href !== expected.href) {
            cancelBody(response.body);
            throw new Error("PUBLIC_PAGE_CANONICAL_MISMATCH");
          }
          // eslint-disable-next-line no-await-in-loop -- Read only the terminal page with a shared byte and request deadline.
          const html = await readBoundedTextBody(
            response.body,
            16 * 1024 * 1024,
            "PUBLIC_PAGE_TOO_LARGE",
            controller.signal
          );
          controller.signal.throwIfAborted();
          return { url: url.href, status: 200, html };
        }
        throw new Error("PUBLIC_PAGE_REDIRECT_INVALID");
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("PUBLIC_PAGE_TIMEOUT"));
        }, 10000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
