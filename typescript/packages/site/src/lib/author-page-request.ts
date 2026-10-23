import type { CatalogRepository } from "./catalog";
import {
  publicRouteRedirectUrl,
  publicRouteRequest,
} from "./public-route-request";
import { authorPagePath } from "./routes";

export async function authorPageRequest(
  requestUrl: string,
  catalog: Pick<CatalogRepository, "getAuthorPage">
) {
  const route = publicRouteRequest(requestUrl);
  if (route?.kind !== "author") return undefined;
  const path = authorPagePath({ slug: route.authorSlug }, route.pageNumber);
  return catalog.getAuthorPage(route.authorSlug, route.pageNumber, {
    redirectOnly: publicRouteRedirectUrl(requestUrl, path) !== undefined,
  });
}
