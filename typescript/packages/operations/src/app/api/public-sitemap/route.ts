import { getCloudflareEnv } from "@/lib/cloudflare";
import { NO_STORE_HEADERS } from "@/lib/operations-boundary";

export const dynamic = "force-dynamic";

// The operations Worker is protected by Cloudflare Access. A service binding
// reads the deployed public Worker without passing through Bot Fight Mode.
// eslint-disable-next-line @typescript-eslint/naming-convention -- Next.js route handlers use HTTP method exports.
export async function GET(): Promise<Response> {
  const { PUBLIC_SITE } = getCloudflareEnv();
  if (!PUBLIC_SITE) {
    return Response.json(
      { error: "PUBLIC_SITEMAP_UNAVAILABLE" },
      { headers: NO_STORE_HEADERS, status: 502 }
    );
  }
  const response = await PUBLIC_SITE.fetch("https://saqi.app/sitemap-index.xml");
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("application/xml")
  ) {
    return Response.json(
      { error: "PUBLIC_SITEMAP_UNAVAILABLE" },
      { headers: NO_STORE_HEADERS, status: 502 }
    );
  }
  return Response.json(
    { xml: await response.text() },
    { headers: NO_STORE_HEADERS }
  );
}
