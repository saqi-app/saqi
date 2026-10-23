import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) =>
  Response.redirect(new URL("/sitemaps/poets-1.xml", site), 308);
