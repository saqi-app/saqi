import { cacheTags } from "./cache-tags";
import { isReadMethod } from "./canonical-request";

const CLIENT_CACHE_CONTROL =
  "public, max-age=60, stale-while-revalidate=300, stale-if-error=86400";
const EDGE_CACHE_CONTROL =
  "public, max-age=300, stale-while-revalidate=60, stale-if-error=86400";
const POEM_EDGE_CACHE_CONTROL =
  "public, max-age=86400, stale-while-revalidate=60, stale-if-error=86400";
const ERROR_EDGE_CACHE_CONTROL = "public, max-age=15";

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'none'; require-trusted-types-for 'script'; upgrade-insecure-requests",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy":
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
} as const;

export function withResponseHeaders(
  response: Response,
  method: string,
  production: boolean,
  pathname = "/",
) {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    result.headers.set(name, value);
  }
  if (!production) {
    result.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }

  const readRequest = isReadMethod(method);
  if (
    production &&
    readRequest &&
    (result.status === 404 || result.status === 410)
  ) {
    result.headers.set("Cache-Control", "no-store");
    result.headers.set(
      "Cloudflare-CDN-Cache-Control",
      ERROR_EDGE_CACHE_CONTROL,
    );
  } else if (!readRequest || result.status >= 400) {
    result.headers.set("Cache-Control", "no-store");
    result.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  } else {
    result.headers.set("Cache-Control", CLIENT_CACHE_CONTROL);
    result.headers.set(
      "Cloudflare-CDN-Cache-Control",
      /^\/author\/[^/]+\/poem\/[^/]+\/?$/u.test(pathname)
        ? POEM_EDGE_CACHE_CONTROL
        : EDGE_CACHE_CONTROL,
    );
    result.headers.set("Cache-Tag", cacheTags(pathname).join(","));
  }
  return result;
}

export async function allowDocumentInlineScripts(
  response: Response,
): Promise<Response> {
  if (!response.headers.get("Content-Type")?.includes("text/html"))
    return response;
  const html = await response.clone().text();
  const scripts: string[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/giu,
  )) {
    if (match[1]) scripts.push(match[1]);
  }
  if (scripts.length === 0) return response;
  const hashes = await Promise.all(
    scripts.map(async (script) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(script),
      );
      return `'sha256-${btoa(String.fromCodePoint(...new Uint8Array(digest)))}'`;
    }),
  );
  const policy = response.headers.get("Content-Security-Policy");
  if (!policy) throw new Error("DOCS_CSP_MISSING");
  const directives = policy.split("; ");
  const scriptDirective = "script-src 'self'";
  if (!directives.includes(scriptDirective))
    throw new Error("DOCS_CSP_SCRIPT_MISSING");
  response.headers.set(
    "Content-Security-Policy",
    directives
      .map((directive) =>
        directive === scriptDirective
          ? `${scriptDirective} ${hashes.join(" ")}`
          : directive,
      )
      .join("; "),
  );
  return response;
}
