export type { SourceConfiguration } from "./constants.js";
export {
  configureSource,
  currentSource,
  LIMITS,
  PROJECTION_SCHEMA_VERSION,
} from "./constants.js";
export type { AuthorPoemManifest } from "./parse.js";
export {
  parseAuthorPoemManifest,
  parsePoemDetail,
  SourceProjectionError,
} from "./parse.js";
export type {
  AuthorPoemManifestProjection,
  PoemDetailProjection,
} from "./projections.js";
export { canonicalAuthorUrl, canonicalPoemUrl } from "./url.js";
