import { z } from "zod";

export const PUBLIC_ROUTE_CAPABILITIES_PATH =
  "/internal/public-route-capabilities";
export const PUBLIC_ROUTE_VERSION = "persistent-alias-v1";
export const PublicRouteCapabilitySchema = z.strictObject({
  ok: z.literal(true),
  publicRoutes: z.literal(PUBLIC_ROUTE_VERSION),
});
