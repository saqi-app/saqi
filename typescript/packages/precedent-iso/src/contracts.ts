import { z, type ZodType } from "zod";

import { ResourceIdSchema } from "./resource-id-schema.js";

const EmptyHttpPartSchema = z.strictObject({});
const TextDocumentSchema = z.string().describe("Rendered response body");
const AuthorSlugSchema = z
  .string()
  .min(1)
  .max(512)
  .describe("URL-encoded author slug");
const PositiveIntegerSegmentSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .describe("A base-10 positive integer path segment");

export const ErrorResponseSchema = z
  .strictObject({ error: z.string().min(1) })
  .describe("Non-sensitive API error response");

export const AuthorRouteParamsSchema = z.strictObject({
  authorSlug: AuthorSlugSchema,
});
export const AuthorPageRouteParamsSchema = AuthorRouteParamsSchema.extend({
  pageNumber: PositiveIntegerSegmentSchema,
});
export const PoemRouteParamsSchema = AuthorRouteParamsSchema.extend({
  poemId: ResourceIdSchema,
});
export const PublicCachePurgeRequestSchema = z.strictObject({
  authorSlug: z.string().min(1).max(128),
  poemId: z.string().min(1).max(128),
});
export const SitemapRouteParamsSchema = z.strictObject({
  shard: PositiveIntegerSegmentSchema,
});

type HttpMethod = "GET" | "POST";
type HttpService = "operations" | "public-site";
type HttpAudience = "authenticated" | "public";

interface HttpContract {
  audience: HttpAudience;
  body: null | ZodType;
  id: string;
  method: HttpMethod;
  params: ZodType;
  path: string;
  query: ZodType;
  responses: readonly {
    body: null | ZodType;
    contentType: string;
    status: number;
  }[];
  service: HttpService;
  summary: string;
}

const HTML_RESPONSE = {
  body: TextDocumentSchema,
  contentType: "text/html; charset=utf-8",
  status: 200,
} as const;
const NOT_FOUND_RESPONSE = {
  body: TextDocumentSchema,
  contentType: "text/html; charset=utf-8",
  status: 404,
} as const;
const EMPTY_INPUT = {
  body: null,
  params: EmptyHttpPartSchema,
  query: EmptyHttpPartSchema,
} as const;
export const HTTP_CONTRACTS = [
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.author-index",
    method: "GET",
    path: "/",
    responses: [HTML_RESPONSE],
    service: "public-site",
    summary: "List and search all poets with published poems",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.database-schema",
    method: "GET",
    path: "/docs",
    responses: [HTML_RESPONSE],
    service: "public-site",
    summary: "Explore the database schema generated from migrations",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.legacy-author-page",
    method: "GET",
    params: z.strictObject({ pageNumber: PositiveIntegerSegmentSchema }),
    path: "/authors/page/{pageNumber}",
    responses: [
      {
        body: null,
        contentType: "text/plain; charset=utf-8",
        status: 308,
      },
    ],
    service: "public-site",
    summary: "Redirect a legacy paginated author index to the complete index",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.author",
    method: "GET",
    params: AuthorRouteParamsSchema,
    path: "/author/{authorSlug}",
    responses: [HTML_RESPONSE, NOT_FOUND_RESPONSE],
    service: "public-site",
    summary: "Render an author's first page of published poems",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.author-page",
    method: "GET",
    params: AuthorPageRouteParamsSchema,
    path: "/author/{authorSlug}/page/{pageNumber}",
    responses: [HTML_RESPONSE, NOT_FOUND_RESPONSE],
    service: "public-site",
    summary: "Render a numbered page of an author's published poems",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.poem",
    method: "GET",
    params: PoemRouteParamsSchema,
    path: "/author/{authorSlug}/poem/{poemId}",
    responses: [HTML_RESPONSE, NOT_FOUND_RESPONSE],
    service: "public-site",
    summary: "Render a published poem and its available translations",
  },
  {
    audience: "authenticated",
    body: PublicCachePurgeRequestSchema,
    id: "public.cache-purge",
    method: "POST",
    params: EmptyHttpPartSchema,
    path: "/internal/purge-publication-cache",
    query: EmptyHttpPartSchema,
    responses: [204, 400, 404, 415, 503].map((status) => ({
      body: null,
      contentType: "text/plain; charset=utf-8",
      status,
    })),
    service: "public-site",
    summary: "Purge published poem and author listing cache tags",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.not-found",
    method: "GET",
    path: "/404",
    responses: [NOT_FOUND_RESPONSE],
    service: "public-site",
    summary: "Render the noindex public not-found document",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.server-error",
    method: "GET",
    path: "/500",
    responses: [
      {
        body: TextDocumentSchema,
        contentType: "text/html; charset=utf-8",
        status: 500,
      },
    ],
    service: "public-site",
    summary: "Render the noindex public server-error document",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.robots",
    method: "GET",
    path: "/robots.txt",
    responses: [
      {
        body: TextDocumentSchema,
        contentType: "text/plain; charset=utf-8",
        status: 200,
      },
    ],
    service: "public-site",
    summary: "Publish crawler policy and the sitemap index location",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.sitemap-index",
    method: "GET",
    path: "/sitemap-index.xml",
    responses: [
      {
        body: TextDocumentSchema,
        contentType: "application/xml; charset=utf-8",
        status: 200,
      },
    ],
    service: "public-site",
    summary: "List the stable sitemap shards",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.author-sitemap",
    method: "GET",
    path: "/sitemaps/authors-1.xml",
    responses: [
      {
        body: TextDocumentSchema,
        contentType: "application/xml; charset=utf-8",
        status: 200,
      },
    ],
    service: "public-site",
    summary: "List the public author URLs",
  },
  {
    ...EMPTY_INPUT,
    audience: "public",
    id: "public.poem-sitemap",
    method: "GET",
    params: SitemapRouteParamsSchema,
    path: "/sitemaps/poems-{shard}.xml",
    responses: [
      {
        body: TextDocumentSchema,
        contentType: "application/xml; charset=utf-8",
        status: 200,
      },
      {
        body: TextDocumentSchema,
        contentType: "text/plain; charset=utf-8",
        status: 404,
      },
    ],
    service: "public-site",
    summary: "List one bounded shard of public poem URLs",
  },
  {
    ...EMPTY_INPUT,
    audience: "authenticated",
    id: "operations.home",
    method: "GET",
    path: "/",
    responses: [HTML_RESPONSE],
    service: "operations",
    summary: "Render the authenticated operations landing page",
  },
  {
    ...EMPTY_INPUT,
    audience: "authenticated",
    id: "operations.not-found",
    method: "GET",
    path: "/404",
    responses: [NOT_FOUND_RESPONSE],
    service: "operations",
    summary: "Render the authenticated operations not-found page",
  },
  {
    ...EMPTY_INPUT,
    audience: "authenticated",
    id: "operations.public-sitemap",
    method: "GET",
    path: "/api/public-sitemap",
    responses: [
      {
        body: z.strictObject({ xml: z.string() }),
        contentType: "application/json",
        status: 200,
      },
      {
        body: ErrorResponseSchema,
        contentType: "application/json",
        status: 502,
      },
    ],
    service: "operations",
    summary:
      "Read the deployed public sitemap through an internal service binding",
  },
  {
    audience: "authenticated",
    body: z.looseObject({ action: z.string().min(1) }),
    id: "operations.rig-state",
    method: "POST",
    params: EmptyHttpPartSchema,
    path: "/api/rig/state",
    query: EmptyHttpPartSchema,
    responses: [200, 400, 403, 409, 415, 503].map((status) => ({
      body: z.unknown(),
      contentType: "application/json",
      status,
    })),
    service: "operations",
    summary: "Claim, recover, and publish one canonical poem",
  },
  {
    audience: "authenticated",
    body: z.looseObject({ action: z.string().min(1) }),
    id: "operations.rig-source",
    method: "POST",
    params: EmptyHttpPartSchema,
    path: "/api/rig/source",
    query: EmptyHttpPartSchema,
    responses: [200, 400, 403, 409, 415, 503].map((status) => ({
      body: z.unknown(),
      contentType: "application/json",
      status,
    })),
    service: "operations",
    summary:
      "Upsert current source authors and poems directly into canonical rows",
  },
] as const satisfies readonly HttpContract[];

export const CLOUDFLARE_WORKER_CONTRACTS = [
  {
    bindings: ["ASSETS", "DB", "PUBLIC_SITE"],
    handlers: ["fetch"],
    id: "operations",
    requiredVariables: [
      "SAQI_ACCESS_AUDIENCE",
      "SAQI_ACCESS_TEAM_ORIGIN",
      "SAQI_PUBLIC_CACHE_PURGE_SECRET",
    ],
  },
  {
    bindings: ["ASSETS", "DB"],
    handlers: ["fetch"],
    id: "public-site",
    requiredVariables: ["SAQI_PUBLIC_CACHE_PURGE_SECRET"],
  },
  {
    bindings: [],
    handlers: ["fetch"],
    id: "www-redirect",
    requiredVariables: [],
  },
] as const;

function jsonSchema(schema: ZodType) {
  return z.toJSONSchema(schema);
}

export function generateContractCatalog() {
  return {
    version: 1,
    http: HTTP_CONTRACTS.map((contract) => ({
      audience: contract.audience,
      id: contract.id,
      method: contract.method,
      path: contract.path,
      request: {
        body: contract.body ? jsonSchema(contract.body) : null,
        params: jsonSchema(contract.params),
        query: jsonSchema(contract.query),
      },
      responses: contract.responses.map((response) => ({
        body: response.body ? jsonSchema(response.body) : null,
        contentType: response.contentType,
        status: response.status,
      })),
      service: contract.service,
      summary: contract.summary,
    })),
    actions: [],
    workers: CLOUDFLARE_WORKER_CONTRACTS,
    queues: [],
  };
}
