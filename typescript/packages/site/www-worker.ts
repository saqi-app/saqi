const CANONICAL_HOST = "saqi.app";

export default {
  fetch(request: Request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        headers: {
          Allow: "GET, HEAD",
          "Cache-Control": "no-store",
          "Cloudflare-CDN-Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
        status: 405,
      });
    }
    const url = new URL(request.url);
    url.hostname = CANONICAL_HOST;
    url.protocol = "https:";
    if (url.pathname.startsWith("/author/"))
      url.pathname = `/poet/${url.pathname.slice("/author/".length)}`;
    return new Response(null, {
      headers: {
        "Cache-Control": url.search ? "no-store" : "public, max-age=3600",
        "Cloudflare-CDN-Cache-Control": url.search
          ? "no-store"
          : "public, max-age=86400",
        Location: url.href,
        "X-Content-Type-Options": "nosniff",
      },
      status: 308,
    });
  },
} satisfies ExportedHandler;
