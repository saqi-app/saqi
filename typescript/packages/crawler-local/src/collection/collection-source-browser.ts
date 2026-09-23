import { hash, randomUUID, timingSafeEqual } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  type AuthorInventoryPageProjection,
  AuthorInventoryPageSchema,
  type AuthorPoemManifestProjection,
  canonicalAuthorUrl,
  canonicalInventoryPaginationUrl,
  canonicalPoemUrl,
  currentSource,
  LIMITS,
  type PoemDetailProjection,
  PROJECTION_SCHEMA_VERSION,
  SourceProjectionError,
} from "@saqi/source-adapter";
import {
  type BrowserContext,
  chromium,
  type Page,
  type Request,
  type Response,
  type Route,
} from "playwright-core";
import { z } from "zod";

import type { AuthorInventoryPageBrowser } from "./author-inventory-lane.js";
import type { CollectorBrowser } from "./collector.js";

const NAVIGATION_TIMEOUT_MS = 60_000;
const POEM_OPERATION_TIMEOUT_MS = 3 * NAVIGATION_TIMEOUT_MS;
// A maximum-size author feed can require 2,000 requests at the mandatory
// 13-second source gap (~7.2 hours). Keep the outer operation bounded without
// making legitimate large authors mathematically impossible to complete.
// Each navigation, challenge, profile lease, and shutdown remains separately
// bounded by the much shorter limits below.
const AUTHOR_OPERATION_TIMEOUT_MS = 8 * 60 * NAVIGATION_TIMEOUT_MS;
const INVENTORY_OPERATION_TIMEOUT_MS = 3 * NAVIGATION_TIMEOUT_MS;
const OPERATION_SHUTDOWN_GRACE_MS = 10_000;
const CHALLENGE_RESOLUTION_TIMEOUT_MS = 60_000;
const MAXIMUM_CHALLENGE_RESOLUTION_TIMEOUT_MS = 15 * 60_000;
const CHALLENGE_POLL_INTERVAL_MS = 1_000;
const AUTHOR_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
const POEM_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const INVENTORY_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const FEED_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const INLINE_SCRIPT_MAX_BYTES = 256 * 1024;
const INLINE_SCRIPT_MAX_CANDIDATES = 16;
const MAX_FEED_PAGES = 2_000;
const COLLECTOR_MARKER_HEADER = "x-saqi-collector";
const MINIMUM_SOURCE_GAP_MS = 13_000;
const SOURCE_REQUEST_TELEMETRY_TIMEOUT_MS = 1_000;
const PROFILE_LOCK_FILENAME = ".saqi-collector.lock";
const CLOUDFLARE_CHALLENGE_ORIGIN = "https://challenges.cloudflare.com";
const CLOUDFLARE_CHALLENGE_PATH_PREFIX = "/cdn-cgi/challenge-platform/";
const CLOUDFLARE_TURNSTILE_PATH_PREFIX = "/turnstile/";
const FREE_VERSE_LABELS: readonly string[] = Object.freeze([
  "التفعيله",
  "التفعيلة",
  "شعر حر",
  "قصيدة النثر",
]);
const CdpTargetSchema = z.looseObject({ type: z.string() });
const CdpTargetListSchema = z.array(CdpTargetSchema);

export interface FeedConfiguration {
  readonly cursor: string;
  readonly endpoint: string;
  readonly token: string;
}

export interface FeedHttpResult {
  readonly body: string;
  readonly bytes: number;
  readonly cfMitigated: null | string;
  readonly contentType: null | string;
  readonly retryAfter: null | string;
  readonly status: number;
  readonly url: string;
}

export interface SourceFeedPage {
  readonly html: string;
  readonly nextCursor: null | string;
  readonly terminal: boolean;
}

export interface SourceAccessDiagnostic {
  readonly category: "http_access_denied" | "managed_challenge" | "turnstile";
  readonly cfMitigated: boolean;
  readonly httpStatus: null | number;
  readonly schemaVersion: 1;
  readonly surface: "feed" | "navigation" | "projection";
}

export class SourceBrowserError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: null | number;
  readonly sourceAccess: null | SourceAccessDiagnostic;

  constructor(
    code: string,
    message: string,
    retryable = true,
    retryAfterMs: null | number = null,
    sourceAccess: null | SourceAccessDiagnostic = null,
  ) {
    super(message);
    this.name = "SourceBrowserError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.sourceAccess =
      sourceAccess === null
        ? null
        : sourceAccessDiagnostic(
            sourceAccess.category,
            sourceAccess.surface,
            sourceAccess.httpStatus,
            sourceAccess.cfMitigated,
          );
  }
}

interface AbortableSerialQueuePort {
  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
}

export class AbortableSerialQueue implements AbortableSerialQueuePort {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const previous = this.#tail;
    const { promise: tail, resolve: release } =
      Promise.withResolvers<undefined>();
    this.#tail = tail;
    try {
      await abortable(previous, signal);
    } catch (error) {
      void previous
        .then(() => release(undefined))
        .catch(() => release(undefined));
      throw error;
    }
    try {
      return await operation();
    } finally {
      release(undefined);
    }
  }
}

export interface SourceBrowserOptions {
  readonly authorOperationTimeoutMs?: number;
  readonly cdpEndpoint?: string;
  readonly challengeResolutionTimeoutMs?: number;
  readonly executablePath?: string;
  readonly headless?: boolean;
  readonly inventoryOperationTimeoutMs?: number;
  readonly launchPersistentContext?: typeof chromium.launchPersistentContext;
  readonly minimumSourceGapMs?: number;
  readonly onManifestPass?: (certificate: ManifestPassCertificate) => void;
  readonly onSourceRequest?: (
    event: SourceRequestTelemetryEvent,
  ) => Promise<void> | void;
  readonly poemOperationTimeoutMs?: number;
  readonly profileDirectory: string;
  readonly recycleAfter?: number;
  readonly shutdownGraceMs?: number;
}

export interface SourceRequestTelemetryEvent {
  readonly outcome: "failed" | "succeeded";
  readonly surface: "feed" | "navigation";
}

export interface ManifestPassCertificate {
  readonly count: number;
  readonly digest: string;
  readonly pass: 1 | 2;
  readonly terminalCondition:
    "declared_count" | "feed_exhausted" | "pagination_exhausted";
}

export type AuthorPaginationState =
  | { readonly kind: "absent" }
  | { readonly kind: "next"; readonly href: string }
  | { readonly kind: "terminal" };

export class SourceChromeCollector
  implements AuthorInventoryPageBrowser, CollectorBrowser
{
  readonly #options: Required<
    Pick<
      SourceBrowserOptions,
      | "authorOperationTimeoutMs"
      | "challengeResolutionTimeoutMs"
      | "headless"
      | "inventoryOperationTimeoutMs"
      | "minimumSourceGapMs"
      | "poemOperationTimeoutMs"
      | "recycleAfter"
      | "shutdownGraceMs"
    >
  > &
    SourceBrowserOptions;
  #context: BrowserContext | null = null;
  readonly #feedMarker = randomUUID();
  #initializingContext: BrowserContext | null = null;
  #launchInProgress = false;
  #profileLock: { readonly handle: FileHandle; readonly token: string } | null =
    null;
  #operations = 0;
  #page: null | Page = null;
  #permittedAuthorPageUrl: null | string = null;
  #poisoned: Error | null = null;
  #permittedFeedToken: null | string = null;
  #permittedFeedUrl: null | string = null;
  readonly #serial = new AbortableSerialQueue();
  #lastSourceCompletedAt = 0;

  private constructor(options: SourceBrowserOptions) {
    const minimumSourceGapMs = effectiveMinimumSourceGapMs(
      options.minimumSourceGapMs,
    );
    if (
      options.cdpEndpoint !== undefined &&
      !isLoopbackCdpEndpoint(options.cdpEndpoint)
    ) {
      throw new Error("cdpEndpoint must be a root loopback HTTP URL");
    }
    if (
      options.recycleAfter !== undefined &&
      (!Number.isSafeInteger(options.recycleAfter) || options.recycleAfter <= 0)
    ) {
      throw new Error("recycleAfter must be a positive integer");
    }
    for (const [name, timeout] of [
      ["authorOperationTimeoutMs", options.authorOperationTimeoutMs],
      ["inventoryOperationTimeoutMs", options.inventoryOperationTimeoutMs],
      ["poemOperationTimeoutMs", options.poemOperationTimeoutMs],
      ["shutdownGraceMs", options.shutdownGraceMs],
    ] as const) {
      if (
        timeout !== undefined &&
        (!Number.isSafeInteger(timeout) || timeout <= 0)
      ) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    if (
      options.challengeResolutionTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.challengeResolutionTimeoutMs) ||
        options.challengeResolutionTimeoutMs < 1_000 ||
        options.challengeResolutionTimeoutMs >
          MAXIMUM_CHALLENGE_RESOLUTION_TIMEOUT_MS)
    ) {
      throw new Error(
        "challengeResolutionTimeoutMs must be an integer between 1000 and 900000",
      );
    }
    const challengeResolutionTimeoutMs =
      options.challengeResolutionTimeoutMs ?? CHALLENGE_RESOLUTION_TIMEOUT_MS;
    const additionalChallengeWaitMs = Math.max(
      0,
      challengeResolutionTimeoutMs - CHALLENGE_RESOLUTION_TIMEOUT_MS,
    );
    this.#options = {
      authorOperationTimeoutMs:
        AUTHOR_OPERATION_TIMEOUT_MS + 2 * additionalChallengeWaitMs,
      challengeResolutionTimeoutMs,
      headless: false,
      inventoryOperationTimeoutMs:
        INVENTORY_OPERATION_TIMEOUT_MS + additionalChallengeWaitMs,
      poemOperationTimeoutMs:
        POEM_OPERATION_TIMEOUT_MS + additionalChallengeWaitMs,
      recycleAfter: 100,
      shutdownGraceMs: OPERATION_SHUTDOWN_GRACE_MS,
      ...options,
      minimumSourceGapMs,
    };
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering -- The public async factory intentionally follows the private constructor whose invariant it enforces.
  static async create(
    options: SourceBrowserOptions,
  ): Promise<SourceChromeCollector> {
    const collector = new SourceChromeCollector(options);
    await mkdir(options.profileDirectory, { mode: 0o700, recursive: true });
    const profile = await lstat(options.profileDirectory);
    if (!profile.isDirectory() || profile.isSymbolicLink()) {
      throw new SourceBrowserError(
        "SOURCE_PROFILE_INVALID",
        "Chrome profile path must be a real directory",
        false,
      );
    }
    await chmod(options.profileDirectory, 0o700);
    await collector.#acquireProfileLock();
    return collector;
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering -- Public collector lifecycle methods remain together after the async factory.
  async close(): Promise<void> {
    await this.#serial.run(
      async () => this.#closeBrowser(),
      new AbortController().signal,
    );
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering -- Public collection entrypoints remain adjacent for a readable adapter surface.
  async collectAuthorManifest(
    authorValue: string,
    signal: AbortSignal,
  ): Promise<AuthorPoemManifestProjection> {
    return this.#exclusive(
      async () =>
        this.#withOperationDeadline(
          signal,
          this.#options.authorOperationTimeoutMs,
          "SOURCE_AUTHOR_OPERATION_TIMEOUT",
          "Author manifest collection exceeded its work deadline; browser shutdown was verified",
          async (operationSignal) => {
            const author = canonicalAuthorUrl(authorValue);
            const page = await this.#readyPage(operationSignal);
            const passes: AuthorPoemManifestProjection[] = [];
            const terminalConditions: ManifestPassCertificate["terminalCondition"][] =
              [];
            for (let pass = 0; pass < 2; pass += 1) {
              // eslint-disable-next-line no-await-in-loop -- Each verification pass must navigate and checkpoint serially.
              const documentHtml = await this.#navigate(
                page,
                author.href,
                AUTHOR_DOCUMENT_MAX_BYTES,
                operationSignal,
              );
              // eslint-disable-next-line no-await-in-loop -- The second pass validates the first pass against the same browser page.
              const result = await this.#collectAuthorPass(
                page,
                author.href,
                documentHtml,
                operationSignal,
              );
              passes.push(result.projection);
              terminalConditions.push(result.terminalCondition);
              this.#options.onManifestPass?.({
                count: result.projection.poems.length,
                digest: manifestDigest(result.projection),
                pass: pass === 0 ? 1 : 2,
                terminalCondition: result.terminalCondition,
              });
            }
            const [first, second] = passes;
            if (
              !first ||
              !second ||
              manifestDigest(first) !== manifestDigest(second) ||
              terminalConditions[0] !== terminalConditions[1]
            ) {
              throw new SourceBrowserError(
                "SOURCE_MANIFEST_UNSTABLE",
                "Fresh author passes produced different poem identities",
              );
            }
            return second;
          },
        ),
      signal,
      this.#options.authorOperationTimeoutMs,
      "SOURCE_AUTHOR_OPERATION_TIMEOUT",
      "Author manifest collection exceeded its browser queue wait deadline",
    );
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering -- Public collection entrypoints remain adjacent for a readable adapter surface.
  async collectAuthorInventoryPage(
    inventoryValue: string,
    expectedPage: number,
    signal: AbortSignal,
  ): Promise<AuthorInventoryPageProjection> {
    return this.#exclusive(
      async () =>
        this.#withOperationDeadline(
          signal,
          this.#options.inventoryOperationTimeoutMs,
          "SOURCE_INVENTORY_OPERATION_TIMEOUT",
          "Author inventory collection exceeded its work deadline; browser shutdown was verified",
          async (operationSignal) => {
            const inventory = canonicalInventoryPaginationUrl(inventoryValue);
            const page = await this.#readyPage(operationSignal);
            await this.#navigate(
              page,
              inventory.href,
              INVENTORY_DOCUMENT_MAX_BYTES,
              operationSignal,
            );
            return AuthorInventoryPageSchema.parse(
              await projectAuthorInventoryPage(page, expectedPage),
            );
          },
        ),
      signal,
      this.#options.inventoryOperationTimeoutMs,
      "SOURCE_INVENTORY_OPERATION_TIMEOUT",
      "Author inventory collection exceeded its browser queue wait deadline",
    );
  }

  async #collectAuthorPass(
    page: Page,
    authorHref: string,
    documentHtml: string,
    signal: AbortSignal,
  ): Promise<{
    readonly projection: AuthorPoemManifestProjection;
    readonly terminalCondition: ManifestPassCertificate["terminalCondition"];
  }> {
    const initial = await projectManifest(page, authorHref, false);
    const poems = new Map(initial.poems.map((poem) => [poem.href, poem]));
    const declaredCount = parseLooseCount(initial.declaredPoemCountText);
    if (declaredCount !== null && poems.size === declaredCount) {
      return {
        projection: { ...initial, terminal: true },
        terminalCondition: "declared_count",
      };
    }
    const initialPaginationState = await projectAuthorPaginationState(page);
    let configuration: FeedConfiguration;
    try {
      configuration = extractFeedConfigurationFromDocument(
        documentHtml,
        authorHref,
      );
    } catch (error) {
      if (
        error instanceof SourceBrowserError &&
        error.code === "SOURCE_FEED_CONFIG_MISSING"
      ) {
        return this.#collectPaginatedAuthorPass(
          page,
          authorHref,
          initial,
          declaredCount,
          signal,
          initialPaginationState,
        );
      }
      throw error;
    }
    const seenCursors = new Set<string>();
    let cursor = configuration.cursor;
    let exhausted = false;
    for (let request = 0; request < MAX_FEED_PAGES; request += 1) {
      throwIfAborted(signal);
      if (seenCursors.has(cursor)) {
        throw new SourceBrowserError(
          "SOURCE_FEED_CURSOR_LOOP",
          "Author feed repeated a cursor",
          false,
        );
      }
      seenCursors.add(cursor);
      let feed: SourceFeedPage;
      try {
        // eslint-disable-next-line no-await-in-loop -- Cursor requests are source-paced and strictly ordered.
        feed = await this.#fetchFeed(page, configuration, cursor, signal);
      } catch (error) {
        if (error instanceof SourceBrowserError) {
          throw new SourceBrowserError(
            error.code,
            `${error.message} (feed request ${String(request + 1)})`,
            error.retryable,
            error.retryAfterMs,
            error.sourceAccess,
          );
        }
        throw error;
      }
      // eslint-disable-next-line no-await-in-loop -- Feed pages are projected before advancing the cursor.
      const extracted = await projectPoemsFromHtml(page, feed.html);
      let added = 0;
      for (const poem of extracted) {
        const existing = poems.get(poem.href);
        if (!existing) {
          poems.set(poem.href, poem);
          added += 1;
        } else if (
          existing.title !== poem.title ||
          (existing.verseCountText !== null &&
            poem.verseCountText !== null &&
            parseLooseCount(existing.verseCountText) !==
              parseLooseCount(poem.verseCountText))
        ) {
          throw new SourceBrowserError(
            "SOURCE_FEED_CONFLICT",
            "Feed returned conflicting data for one poem",
            false,
          );
        } else if (
          existing.verseCountText === null &&
          poem.verseCountText !== null
        ) {
          poems.set(poem.href, poem);
        }
      }
      if (poems.size > LIMITS.poemsPerAuthor) {
        throw new SourceBrowserError(
          "SOURCE_MANIFEST_LIMIT",
          "Author manifest reached its safety limit",
          false,
        );
      }
      if (declaredCount !== null && poems.size > declaredCount) {
        throw new SourceBrowserError(
          "SOURCE_MANIFEST_COUNT_EXCEEDED",
          "Author feed exceeded the declared poem count",
          false,
        );
      }
      if (declaredCount !== null && poems.size === declaredCount) break;
      if (feed.terminal) {
        exhausted = true;
        break;
      }
      assertFeedProgress(feed, cursor, seenCursors, added);
      if (feed.nextCursor === null)
        throw new Error("Unreachable terminal feed");
      cursor = feed.nextCursor;
    }
    if (
      feedManifestNeedsPaginationFallback(declaredCount, poems.size, exhausted)
    ) {
      await this.#navigateAuthorPage(page, authorHref, signal);
      const refreshedInitial = await projectManifest(page, authorHref, false);
      const refreshedDeclaredCount = parseLooseCount(
        refreshedInitial.declaredPoemCountText,
      );
      if (
        declaredCount !== null &&
        refreshedDeclaredCount !== null &&
        refreshedDeclaredCount !== declaredCount
      ) {
        throw new SourceBrowserError(
          "SOURCE_MANIFEST_COUNT_CHANGED",
          "Refreshed author page changed the declared poem count",
          false,
        );
      }
      for (const poem of refreshedInitial.poems) {
        const existing = poems.get(poem.href);
        if (!existing) {
          poems.set(poem.href, poem);
        } else if (
          existing.title !== poem.title ||
          (existing.verseCountText !== null &&
            poem.verseCountText !== null &&
            parseLooseCount(existing.verseCountText) !==
              parseLooseCount(poem.verseCountText))
        ) {
          throw new SourceBrowserError(
            "SOURCE_FEED_PAGINATION_CONFLICT",
            "Feed and refreshed pagination returned conflicting poem data",
            false,
          );
        } else if (
          existing.verseCountText === null &&
          poem.verseCountText !== null
        ) {
          poems.set(poem.href, poem);
        }
      }
      return this.#collectPaginatedAuthorPass(
        page,
        authorHref,
        {
          ...initial,
          // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Runtime targets do not yet expose Iterator Helpers in TypeScript's configured library.
          poems: [...poems.values()],
        },
        declaredCount,
        signal,
        initialPaginationState,
        true,
      );
    }
    if (poems.size === 0 && declaredCount !== 0) {
      throw new SourceBrowserError(
        "SOURCE_MANIFEST_UNVERIFIED_EMPTY",
        "Empty manifest has no explicit zero count",
      );
    }
    return {
      projection: {
        ...initial,
        // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Serialized browser callbacks target runtimes without Iterator Helpers.
        poems: [...poems.values()],
        terminal: true,
      },
      terminalCondition:
        declaredCount === null ? "feed_exhausted" : "declared_count",
    };
  }

  async #collectPaginatedAuthorPass(
    page: Page,
    authorHref: string,
    initial: AuthorPoemManifestProjection,
    declaredCount: null | number,
    signal: AbortSignal,
    initialPaginationState: AuthorPaginationState,
    allowCoveredPages = false,
  ): Promise<{
    readonly projection: AuthorPoemManifestProjection;
    readonly terminalCondition: ManifestPassCertificate["terminalCondition"];
  }> {
    const poems = new Map(initial.poems.map((poem) => [poem.href, poem]));
    const seenCursors = new Set<string>();
    let expectedCount = declaredCount;
    let paginationState = initialPaginationState;
    const initialPaginationKind = paginationState.kind;
    let next = paginationState.kind === "next" ? paginationState.href : null;
    if (paginationState.kind === "absent" && expectedCount === null) {
      throw new SourceBrowserError(
        "SOURCE_MANIFEST_NONTERMINAL",
        "Author page exposed neither a declared poem count nor an explicit next page",
      );
    }
    let exhausted = paginationState.kind === "terminal";
    for (
      let request = 0;
      next !== null && request < MAX_FEED_PAGES;
      request += 1
    ) {
      throwIfAborted(signal);
      const pagination = canonicalAuthorPaginationUrl(next, authorHref);
      if (seenCursors.has(pagination.cursor)) {
        throw new SourceBrowserError(
          "SOURCE_PAGINATION_CURSOR_LOOP",
          "Author pagination repeated a cursor",
          false,
        );
      }
      seenCursors.add(pagination.cursor);
      // eslint-disable-next-line no-await-in-loop -- Cursor pages are source-paced and strictly ordered.
      await this.#navigateAuthorPage(page, pagination.href, signal);
      // eslint-disable-next-line no-await-in-loop -- Each page is projected before following its next cursor.
      const projection = await projectManifest(page, authorHref, false);
      const pageDeclaredCount = parseLooseCount(
        projection.declaredPoemCountText,
      );
      if (pageDeclaredCount !== null) {
        if (expectedCount !== null && pageDeclaredCount !== expectedCount) {
          throw new SourceBrowserError(
            "SOURCE_MANIFEST_COUNT_CHANGED",
            "Author pagination changed the declared poem count",
            false,
          );
        }
        expectedCount = pageDeclaredCount;
      }
      const poemsBeforePage = poems.size;
      for (const poem of projection.poems) {
        const existing = poems.get(poem.href);
        if (!existing) {
          poems.set(poem.href, poem);
        } else if (
          existing.title !== poem.title ||
          (existing.verseCountText !== null &&
            poem.verseCountText !== null &&
            parseLooseCount(existing.verseCountText) !==
              parseLooseCount(poem.verseCountText))
        ) {
          throw new SourceBrowserError(
            "SOURCE_PAGINATION_CONFLICT",
            "Author pagination returned conflicting data for one poem",
            false,
          );
        } else if (
          existing.verseCountText === null &&
          poem.verseCountText !== null
        ) {
          poems.set(poem.href, poem);
        }
      }
      if (poems.size > LIMITS.poemsPerAuthor) {
        throw new SourceBrowserError(
          "SOURCE_MANIFEST_LIMIT",
          "Author manifest reached its safety limit",
          false,
        );
      }
      if (
        paginationPageNeedsProgress(
          poemsBeforePage,
          poems.size,
          allowCoveredPages,
        )
      ) {
        throw new SourceBrowserError(
          "SOURCE_PAGINATION_NO_PROGRESS",
          "Author pagination returned no new poems",
          false,
        );
      }
      if (expectedCount !== null && poems.size > expectedCount) {
        throw new SourceBrowserError(
          "SOURCE_MANIFEST_COUNT_EXCEEDED",
          "Author pagination exceeded the declared poem count",
          false,
        );
      }
      if (expectedCount !== null && poems.size === expectedCount) {
        next = null;
        exhausted = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- The next cursor belongs to the newly settled page.
      paginationState = await projectAuthorPaginationState(page);
      next = paginationState.kind === "next" ? paginationState.href : null;
      exhausted = paginationState.kind === "terminal";
    }
    if (
      !exhausted ||
      (expectedCount !== null && poems.size !== expectedCount)
    ) {
      throw new SourceBrowserError(
        "SOURCE_MANIFEST_NONTERMINAL",
        `Author pagination did not prove manifest completion (initial=${initialPaginationKind}, last=${paginationState.kind}, pages=${String(seenCursors.size)}, collected=${String(poems.size)}, declared=${expectedCount === null ? "unknown" : String(expectedCount)})`,
      );
    }
    if (poems.size === 0 && expectedCount !== 0) {
      throw new SourceBrowserError(
        "SOURCE_MANIFEST_UNVERIFIED_EMPTY",
        "Empty manifest has no explicit zero count",
      );
    }
    return {
      projection: {
        ...initial,
        // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Serialized manifest output requires an ordinary array.
        poems: [...poems.values()],
        terminal: true,
      },
      terminalCondition:
        expectedCount === null ? "pagination_exhausted" : "declared_count",
    };
  }

  async #navigateAuthorPage(
    page: Page,
    href: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#navigate(page, href, AUTHOR_DOCUMENT_MAX_BYTES, signal, href);
  }

  async #fetchFeed(
    page: Page,
    configuration: FeedConfiguration,
    cursor: string,
    signal: AbortSignal,
  ): Promise<SourceFeedPage> {
    await this.#sourceGap(signal);
    let outcome: SourceRequestTelemetryEvent["outcome"] = "failed";
    const expectedFeedUrl = feedRequestUrl(configuration, cursor);
    this.#permittedFeedToken = configuration.token;
    this.#permittedFeedUrl = expectedFeedUrl;
    try {
      let result: FeedHttpResult;
      try {
        result = await abortable(
          page.evaluate(
            async ({
              collectorMarker,
              cursor: feedCursor,
              endpoint,
              feedTimeoutMs,
              maximumBytes,
              token,
            }) => {
              const url = new URL(endpoint, location.origin);
              url.searchParams.set("cursor", feedCursor);
              url.searchParams.set("token", token);
              // eslint-disable-next-line @sarj/no-raw-fetch-outside-clients -- Playwright serializes this callback into the page; it cannot import Node clients. This source client bounds timeout/bytes and validates the permitted feed URL.
              const response = await fetch(url, {
                headers: {
                  "X-Feed-Token": token,
                  "X-Requested-With": "XMLHttpRequest",
                  "X-Saqi-Collector": collectorMarker,
                },
                redirect: "error",
                signal: AbortSignal.timeout(feedTimeoutMs),
              });
              const reader = response.body?.getReader();
              const chunks: Uint8Array[] = [];
              let bytes = 0;
              if (reader) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The loop exits only when the ordered browser stream reports done.
                while (true) {
                  // eslint-disable-next-line no-await-in-loop -- Stream reads must preserve byte order and enforce the running size limit.
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  bytes += chunk.value.byteLength;
                  if (bytes > maximumBytes) {
                    // eslint-disable-next-line no-await-in-loop -- Cancellation must finish before the oversized response is rejected.
                    await reader.cancel();
                    throw new Error("SOURCE_FEED_SIZE");
                  }
                  chunks.push(chunk.value);
                }
              }
              const body = new Uint8Array(bytes);
              let offset = 0;
              for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.byteLength;
              }
              return {
                body: new TextDecoder("utf-8", { fatal: true }).decode(body),
                bytes,
                cfMitigated: response.headers.get("cf-mitigated"),
                contentType: response.headers.get("content-type"),
                retryAfter: response.headers.get("retry-after"),
                status: response.status,
                url: response.url,
              } satisfies FeedHttpResult;
            },
            {
              collectorMarker: this.#feedMarker,
              cursor,
              endpoint: configuration.endpoint,
              feedTimeoutMs: NAVIGATION_TIMEOUT_MS,
              maximumBytes: FEED_DOCUMENT_MAX_BYTES,
              token: configuration.token,
            },
          ),
          signal,
          () => page.close(),
        );
      } catch (error) {
        throwIfAborted(signal);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("SOURCE_FEED_SIZE")) {
          throw new SourceBrowserError(
            "SOURCE_FEED_SIZE",
            "Author feed body exceeded its safety limit",
            false,
          );
        }
        throw new SourceBrowserError(
          "SOURCE_FEED_REQUEST_FAILED",
          `Author feed request failed before a valid response: ${message.slice(0, 1_000)}`,
        );
      }
      const parsed = parseFeedHttpResult(result, configuration, cursor);
      outcome = "succeeded";
      return parsed;
    } finally {
      this.#permittedFeedToken = null;
      this.#permittedFeedUrl = null;
      this.#lastSourceCompletedAt = Date.now();
      this.#operations += 1;
      await this.#recordSourceRequest({ outcome, surface: "feed" });
    }
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering -- Public collection entrypoints remain adjacent to the private workflow each exposes.
  async collectPoemDetail(
    poemValue: string,
    expectedAuthorValue: string,
    signal: AbortSignal,
  ): Promise<PoemDetailProjection> {
    return this.#exclusive(
      async () =>
        this.#withOperationDeadline(
          signal,
          this.#options.poemOperationTimeoutMs,
          "SOURCE_POEM_OPERATION_TIMEOUT",
          "Poem collection exceeded its work deadline; browser shutdown was verified",
          async (operationSignal) => {
            const poem = canonicalPoemUrl(poemValue);
            const expectedAuthor = canonicalAuthorUrl(expectedAuthorValue);
            const page = await this.#readyPage(operationSignal);
            await this.#navigate(
              page,
              poem.href,
              POEM_DOCUMENT_MAX_BYTES,
              operationSignal,
            );
            const projection = await projectPoem(page, expectedAuthor.href);
            if (projection.challengeDetected) {
              throw new SourceBrowserError(
                "SOURCE_HUMAN_REQUIRED",
                "Cloudflare challenge remained in the final poem projection",
                true,
                null,
                sourceAccessDiagnostic(
                  "managed_challenge",
                  "projection",
                  null,
                  false,
                ),
              );
            }
            if (
              canonicalAuthorUrl(projection.authorHref).canonicalId !==
              expectedAuthor.canonicalId
            ) {
              throw new SourceBrowserError(
                "SOURCE_POEM_AUTHOR_MISMATCH",
                "Poem detail belongs to a different author",
                false,
              );
            }
            return projection;
          },
        ),
      signal,
      this.#options.poemOperationTimeoutMs,
      "SOURCE_POEM_OPERATION_TIMEOUT",
      "Poem collection exceeded its browser queue wait deadline",
    );
  }

  async #closeBrowser(): Promise<void> {
    const context = this.#context;
    if (!context) {
      if (this.#poisoned) throw this.#poisoned;
      await this.#resetBrowserState();
      return;
    }
    try {
      const browser = context.browser();
      if (this.#options.cdpEndpoint) {
        if (!browser) throw new Error("SOURCE_CDP_BROWSER_MISSING");
        // Playwright's CDP handshake configures downloads on the default
        // browser context. Some Chrome builds stop exposing that context once
        // its final page target is closed, making every later reconnect fail
        // with Browser.setDownloadBehavior / context-management errors. Keep
        // one inert target across disconnects. The next attachment creates its
        // routed page first, then reclaims this previous target.
        await ensureCdpAnchorPage(context);
        await browser.close({ reason: "SOURCE_COLLECTOR_CLOSED" });
      } else {
        await context.close();
      }
      if (browser?.isConnected())
        throw new Error("SOURCE_BROWSER_DISCONNECT_UNPROVEN");
      await this.#resetBrowserState();
    } catch (error) {
      const cause = toError(error, "Browser close failed");
      this.#poisoned = new SourceBrowserError(
        "SOURCE_BROWSER_RESTART_REQUIRED",
        `Browser close could not prove process isolation: ${cause.message.slice(0, 1_000)}`,
      );
      throw this.#poisoned;
    }
  }

  async #resetBrowserState(): Promise<void> {
    this.#context = null;
    this.#page = null;
    this.#permittedAuthorPageUrl = null;
    this.#permittedFeedToken = null;
    this.#permittedFeedUrl = null;
    this.#poisoned = null;
    await this.#releaseProfileLock();
  }

  async #withOperationDeadline<T>(
    signal: AbortSignal,
    timeoutMs: number,
    timeoutCode: string,
    timeoutMessage: string,
    operation: (operationSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const operationSignal = AbortSignal.any([signal, deadline]);
    const running = Promise.resolve().then(() => operation(operationSignal));
    // The race may finish on abort first; observe any later browser rejection.
    void running.catch(() => undefined);
    const aborted = Promise.withResolvers<undefined>();
    const onAbort = (): void => aborted.resolve(undefined);
    operationSignal.addEventListener("abort", onAbort, { once: true });
    if (operationSignal.aborted) onAbort();
    try {
      const outcome = await Promise.race([
        running.then((value) => ({ type: "completed" as const, value })),
        aborted.promise.then(() => ({ type: "aborted" as const })),
      ]);
      if (outcome.type === "completed") return outcome.value;

      await this.#forceCloseBrowser(
        deadline.aborted && !signal.aborted
          ? timeoutCode
          : "COLLECTOR_OPERATOR_STOP",
      );
      // Browser disconnection prevents further external work. Waiting for the
      // original promise to observe that disconnect keeps serial ownership
      // until initialization, response reads, and projections have settled.
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        // eslint-disable-next-line @sarj/no-silent-promise-catch -- Rejection is already observed above; this branch only reports settlement.
        running.then(() => true).catch(() => true),
        new Promise<false>((resolvePromise) => {
          shutdownTimer = setTimeout(
            () => resolvePromise(false),
            this.#options.shutdownGraceMs,
          );
          shutdownTimer.unref();
        }),
      ]);
      if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
      if (!settled) {
        this.#poisoned = new SourceBrowserError(
          "SOURCE_BROWSER_RESTART_REQUIRED",
          "Browser operation did not settle after forced shutdown; process restart is required to preserve profile isolation",
        );
        throw this.#poisoned;
      }
      // Initialization cleanup can discover that the browser is still alive
      // after the deadline won the race. Preserve that stronger fencing error
      // instead of reporting a verified shutdown that did not occur.
      if (this.#poisoned) throw this.#poisoned;
      if (deadline.aborted && !signal.aborted) {
        throw new SourceBrowserError(timeoutCode, timeoutMessage);
      }
      throw signal.reason ?? new Error("Aborted");
    } finally {
      operationSignal.removeEventListener("abort", onAbort);
    }
  }

  async #forceCloseBrowser(reason: string): Promise<void> {
    const context = this.#context ?? this.#initializingContext;
    if (!context) {
      if (this.#launchInProgress) return;
      await this.#resetBrowserState();
      return;
    }
    const isInitializing = context === this.#initializingContext;
    try {
      const browser = context.browser();
      if (browser) {
        await browser.close({ reason });
        if (browser.isConnected())
          throw new Error("SOURCE_BROWSER_DISCONNECT_UNPROVEN");
      } else {
        await context.close();
      }
      // Initialization still owns the profile fence and will release it only
      // after every setup promise observes the closed browser and settles.
      if (isInitializing) return;
      await this.#resetBrowserState();
    } catch (error) {
      const cause = toError(error, "Browser force-close failed");
      this.#poisoned = new SourceBrowserError(
        "SOURCE_BROWSER_RESTART_REQUIRED",
        `Browser force-close could not prove process isolation: ${cause.message.slice(0, 1_000)}`,
      );
      throw this.#poisoned;
    }
  }

  async #exclusive<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    maximumQueueWaitMs: number,
    timeoutCode: string,
    timeoutMessage: string,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(maximumQueueWaitMs);
    const queueState = { acquired: false };
    try {
      return await this.#serial.run(
        async () => {
          queueState.acquired = true;
          return operation();
        },
        AbortSignal.any([signal, deadline]),
      );
    } catch (error) {
      if (deadline.aborted && !signal.aborted && !queueState.acquired) {
        throw new SourceBrowserError(timeoutCode, timeoutMessage);
      }
      throw error;
    }
  }

  async #navigate(
    page: Page,
    href: string,
    maximumBytes: number,
    signal: AbortSignal,
    permittedAuthorPageUrl: null | string = null,
  ): Promise<string> {
    await this.#sourceGap(signal);
    let outcome: SourceRequestTelemetryEvent["outcome"] = "failed";
    this.#permittedAuthorPageUrl = permittedAuthorPageUrl;
    try {
      let response: null | Response;
      try {
        response = await abortable(
          page.goto(href, {
            timeout: NAVIGATION_TIMEOUT_MS,
            waitUntil: "domcontentloaded",
          }),
          signal,
          () => page.close(),
        );
      } catch (error) {
        throwIfAborted(signal);
        await this.#discardFailedPage(page);
        const cause = toError(error, "Browser navigation failed");
        throw new SourceBrowserError(
          "SOURCE_NAVIGATION_FAILED",
          `Browser navigation failed: ${cause.message.slice(0, 1_000)}`,
        );
      }
      const document = await resolveNavigationDocument(
        page,
        response,
        href,
        maximumBytes,
        signal,
        { timeoutMs: this.#options.challengeResolutionTimeoutMs },
      );
      outcome = "succeeded";
      return document;
    } finally {
      this.#permittedAuthorPageUrl = null;
      this.#lastSourceCompletedAt = Date.now();
      this.#operations += 1;
      await this.#recordSourceRequest({ outcome, surface: "navigation" });
    }
  }

  async #recordSourceRequest(
    event: SourceRequestTelemetryEvent,
  ): Promise<void> {
    try {
      const callback = this.#options.onSourceRequest;
      if (!callback) return;
      await Promise.race([
        callback(event),
        delay(SOURCE_REQUEST_TELEMETRY_TIMEOUT_MS, undefined, { ref: false }),
      ]);
    } catch {
      // Observability must never make a source request fail or stall collection.
    }
  }

  async #discardFailedPage(page: Page): Promise<void> {
    if (this.#page === page) this.#page = null;
    if (page.isClosed()) return;
    try {
      // Chrome can keep its CDP socket alive while dropping the default
      // context after its final page closes. Preserve a replacement target so
      // the next retry can reconnect instead of entering launch backoff.
      if (this.#options.cdpEndpoint && this.#context)
        await ensureCdpReplacementPage(this.#context, page);
      await page.close({ reason: "SOURCE_NAVIGATION_FAILED" });
    } catch (error) {
      const browser = this.#context?.browser();
      if (browser?.isConnected()) {
        await this.#forceCloseBrowser("SOURCE_PAGE_RECOVERY_FAILED");
        return;
      }
      // A disconnected browser cannot perform more source work. Clear the
      // stale handles so the next retry launches a fresh process while
      // preserving the persistent profile and its Cloudflare state.
      this.#context = null;
      this.#page = null;
      if (!(error instanceof Error))
        throw new Error("Browser page recovery failed");
    }
  }

  async #readyPage(signal: AbortSignal): Promise<Page> {
    throwIfAborted(signal);
    // A close can fail transiently while Chrome is tearing down. Retry the
    // fenced close before rejecting unrelated source work. #closeBrowser only
    // clears the profile lock after disconnection has been proven.
    if (this.#poisoned) await this.#closeBrowser();
    if (this.#operations >= this.#options.recycleAfter)
      await this.#closeBrowser();
    if (this.#context?.browser()?.isConnected() === false)
      await this.#closeBrowser();
    await this.#acquireProfileLock();
    if (!this.#context) {
      const executable = this.#options.executablePath;
      const launchPersistentContext =
        this.#options.launchPersistentContext ??
        chromium.launchPersistentContext.bind(chromium);
      let candidate: BrowserContext | null = null;
      this.#launchInProgress = true;
      try {
        if (this.#options.cdpEndpoint) {
          await ensureCdpBootstrapTarget(this.#options.cdpEndpoint);
          const browser = await chromium.connectOverCDP(
            this.#options.cdpEndpoint,
            { timeout: NAVIGATION_TIMEOUT_MS },
          );
          candidate = browser.contexts()[0] ?? null;
          if (candidate === null) {
            await browser.close();
            throw new Error("SOURCE_CDP_CONTEXT_MISSING");
          }
        } else {
          candidate = await launchPersistentContext(
            this.#options.profileDirectory,
            {
              acceptDownloads: false,
              ...(executable
                ? { executablePath: executable }
                : { channel: "chrome" }),
              headless: this.#options.headless,
              serviceWorkers: "block",
              timeout: NAVIGATION_TIMEOUT_MS,
            },
          );
        }
        this.#initializingContext = candidate;
        candidate.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
        if (!this.#options.cdpEndpoint) {
          await candidate.route("**/*", (route, request) =>
            this.#restrictRequest(route, request),
          );
        }
        throwIfAborted(signal);
        const activeContext = candidate;
        activeContext.on("close", () => {
          if (this.#context === activeContext) {
            this.#context = null;
            this.#page = null;
            this.#permittedAuthorPageUrl = null;
            this.#permittedFeedToken = null;
            this.#permittedFeedUrl = null;
          }
        });
        this.#context = candidate;
        this.#operations = 0;
      } catch (error) {
        if (candidate) {
          try {
            const browser = candidate.browser();
            if (browser) {
              if (browser.isConnected())
                await browser.close({ reason: "BROWSER_INIT_FAILED" });
              if (browser.isConnected())
                throw new Error("SOURCE_BROWSER_DISCONNECT_UNPROVEN");
            } else await candidate.close();
          } catch (closeError) {
            this.#context = candidate;
            this.#poisoned = toError(
              closeError,
              "Browser initialization cleanup failed",
            );
            throw this.#poisoned;
          }
        }
        await this.#releaseProfileLock();
        throwIfAborted(signal);
        const cause = toError(error, "Browser launch failed");
        throw new SourceBrowserError(
          "SOURCE_BROWSER_LAUNCH_FAILED",
          `Browser launch failed: ${cause.message.slice(0, 1_000)}`,
        );
      } finally {
        if (this.#initializingContext === candidate)
          this.#initializingContext = null;
        this.#launchInProgress = false;
      }
    }
    if (!this.#page || this.#page.isClosed()) {
      let page: Page;
      if (this.#options.cdpEndpoint) {
        // The CDP browser intentionally outlives the crawler so challenge
        // clearance survives. A hard process exit cannot close the page it
        // owned, though, and repeated watchdog recovery would otherwise leak
        // renderer tabs indefinitely. This profile is exclusively fenced by
        // the collector lock, so reclaim every pre-attach page before taking
        // ownership of the new routed page.
        const orphanedPages = this.#context.pages();
        page = await this.#context.newPage();
        await page.route("**/*", (route, request) =>
          this.#restrictRequest(route, request),
        );
        await reclaimCdpOrphanPages(orphanedPages);
      } else {
        const [retained, ...extras] = this.#context.pages();
        await Promise.all(extras.map((extra) => extra.close()));
        page = retained ?? (await this.#context.newPage());
      }
      this.#page = page;
      page.on("crash", () => {
        if (this.#page === page) this.#page = null;
      });
      page.on("popup", (popup) => void popup.close());
    }
    return this.#page;
  }

  async #acquireProfileLock(): Promise<void> {
    if (this.#profileLock) return;
    const path = join(this.#options.profileDirectory, PROFILE_LOCK_FILENAME);
    const token = randomUUID();
    const record = JSON.stringify({ pid: process.pid, token });
    const recoveryPath = `${path}.recovery`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Lock acquisition retries must serialize against the same profile path.
        const handle = await open(path, "wx", 0o600);
        try {
          // eslint-disable-next-line no-await-in-loop -- Ownership bytes must be written before publishing the acquired handle.
          await handle.writeFile(`${record}\n`, { encoding: "utf8" });
        } catch (error) {
          // eslint-disable-next-line no-await-in-loop -- Failed lock publication must close its handle before quarantine.
          await handle.close();
          // eslint-disable-next-line no-await-in-loop -- Quarantine must finish before another acquisition attempt.
          await rename(path, `${path}.stale.${randomUUID()}`);
          throw error;
        }
        this.#profileLock = { handle, token };
        return;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        if (attempt > 0) {
          throw new SourceBrowserError(
            "SOURCE_PROFILE_LOCKED",
            "Chrome profile is already owned by another collector",
            false,
          );
        }
        // eslint-disable-next-line no-await-in-loop -- Each recovery attempt must inspect the current owner after the failed exclusive create.
        let existing = await readProfileLock(path);
        if (existing?.pid !== undefined && processIsAlive(existing.pid)) {
          throw new SourceBrowserError(
            "SOURCE_PROFILE_LOCKED",
            `Chrome profile is owned by live process ${String(existing.pid)}`,
            false,
          );
        }
        const recoveryToken = randomUUID();
        // eslint-disable-next-line no-await-in-loop -- Recovery ownership must be acquired before re-reading or quarantining the primary lock.
        const recovery = await acquireProfileRecoveryLock(
          recoveryPath,
          recoveryToken,
        );
        if (recovery === null)
          throw new SourceBrowserError(
            "SOURCE_PROFILE_LOCKED",
            "Chrome profile ownership recovery is already in progress",
            false,
          );
        try {
          // eslint-disable-next-line no-await-in-loop -- Recovery revalidates ownership after acquiring its serialization lock.
          existing = await readProfileLock(path);
          if (existing?.pid !== undefined && processIsAlive(existing.pid)) {
            throw new SourceBrowserError(
              "SOURCE_PROFILE_LOCKED",
              `Chrome profile is owned by live process ${String(existing.pid)}`,
              false,
            );
          }
          if (existing === null) {
            throw new SourceBrowserError(
              "SOURCE_PROFILE_LOCK_INVALID",
              "Chrome profile lock is malformed or changed during recovery",
              false,
            );
          }
          // eslint-disable-next-line no-await-in-loop -- The stale owner must be quarantined before the next exclusive-create attempt.
          await rename(path, `${path}.stale.${randomUUID()}`);
        } finally {
          // eslint-disable-next-line no-await-in-loop -- Recovery ownership is released before its token file is inspected.
          await recovery.close();
          // eslint-disable-next-line no-await-in-loop -- Cleanup verifies the exact recovery token after closing the handle.
          const retained = await readProfileLock(recoveryPath);
          if (
            retained?.token !== undefined &&
            constantTimeEqual(retained.token, recoveryToken)
          )
            // eslint-disable-next-line no-await-in-loop -- The serialized recovery token is removed before another acquisition attempt.
            await unlink(recoveryPath);
        }
      }
    }
    throw new Error("Profile lock acquisition exhausted unexpectedly");
  }

  async #releaseProfileLock(): Promise<void> {
    const lock = this.#profileLock;
    if (!lock) return;
    this.#profileLock = null;
    await lock.handle.close();
    const path = join(this.#options.profileDirectory, PROFILE_LOCK_FILENAME);
    const existing = await readProfileLock(path);
    if (
      existing?.token !== undefined &&
      constantTimeEqual(existing.token, lock.token)
    )
      await unlink(path);
  }

  async #sourceGap(signal: AbortSignal): Promise<void> {
    const remainingDelay =
      this.#lastSourceCompletedAt +
      this.#options.minimumSourceGapMs -
      Date.now();
    if (remainingDelay > 0)
      await abortable(globalThisDelay(remainingDelay), signal);
  }

  async #restrictRequest(route: Route, request: Request): Promise<void> {
    if (
      request.url() === this.#permittedAuthorPageUrl &&
      request.method() === "GET" &&
      request.resourceType() === "document" &&
      request.isNavigationRequest() &&
      request.frame().parentFrame() === null
    ) {
      await route.continue();
      return;
    }
    if (["xhr", "fetch"].includes(request.resourceType())) {
      let isFeed = false;
      try {
        isFeed = isFeedUrlStructure(new URL(request.url()));
      } catch {
        // The general request policy below rejects malformed URLs.
      }
      if (isFeed) {
        const headers = request.headers();
        if (
          request.method() !== "GET" ||
          request.url() !== this.#permittedFeedUrl ||
          headers[COLLECTOR_MARKER_HEADER] !== this.#feedMarker ||
          headers["x-requested-with"] !== "XMLHttpRequest" ||
          !constantTimeEqual(
            headers["x-feed-token"] ?? "",
            this.#permittedFeedToken ?? "",
          )
        ) {
          await route.abort("blockedbyclient");
          return;
        }
        this.#permittedFeedToken = null;
        this.#permittedFeedUrl = null;
        const {
          [COLLECTOR_MARKER_HEADER]: ignoredCollectorMarker,
          ...forwardedHeaders
        } = headers;
        void ignoredCollectorMarker;
        await route.continue({ headers: forwardedHeaders });
        return;
      }
    }
    await restrictRequest(route, request);
  }
}

export interface CdpOrphanPage {
  close(options: { readonly reason: string }): Promise<void>;
  isClosed(): boolean;
}

export interface CdpAnchorContext {
  newPage(): Promise<CdpOrphanPage>;
  pages(): readonly CdpOrphanPage[];
}

export type CdpBootstrapResult = "created" | "existing";

/**
 * Chrome exposes no browser context over CDP until at least one page target
 * exists. A dedicated Chrome process can therefore be healthy at
 * /json/version while Playwright attachment still fails after its final tab
 * was closed. Bootstrap a harmless blank page through Chrome's loopback-only
 * discovery endpoint before attaching so retries can recover autonomously.
 */
export async function ensureCdpBootstrapTarget(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CdpBootstrapResult> {
  if (!isLoopbackCdpEndpoint(endpoint))
    throw new Error("SOURCE_CDP_ENDPOINT_FORBIDDEN");

  const listResponse = await fetchImpl(new URL("json/list", endpoint), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!listResponse.ok) throw new Error("SOURCE_CDP_TARGET_LIST_FAILED");
  const targets = CdpTargetListSchema.safeParse(await listResponse.json());
  if (!targets.success) throw new Error("SOURCE_CDP_TARGET_LIST_INVALID");
  if (targets.data.some((target) => target.type === "page")) {
    return "existing";
  }

  const createUrl = new URL("json/new", endpoint);
  createUrl.search = encodeURIComponent("about:blank");
  const createResponse = await fetchImpl(createUrl, {
    method: "PUT",
    signal: AbortSignal.timeout(5_000),
  });
  if (!createResponse.ok) throw new Error("SOURCE_CDP_TARGET_CREATE_FAILED");
  const created = CdpTargetSchema.safeParse(await createResponse.json());
  if (!created.success || created.data.type !== "page") {
    throw new Error("SOURCE_CDP_TARGET_CREATE_INVALID");
  }
  return "created";
}

export async function ensureCdpAnchorPage(
  context: CdpAnchorContext,
): Promise<void> {
  if (context.pages().some((page) => !page.isClosed())) return;
  await context.newPage();
}

export async function ensureCdpReplacementPage(
  context: CdpAnchorContext,
  retiringPage: CdpOrphanPage,
): Promise<void> {
  if (context.pages().some((page) => page !== retiringPage && !page.isClosed()))
    return;
  await context.newPage();
}

export async function reclaimCdpOrphanPages(
  orphanedPages: readonly CdpOrphanPage[],
): Promise<void> {
  await Promise.all(
    orphanedPages
      .filter((orphan) => !orphan.isClosed())
      .map((orphan) =>
        orphan.close({ reason: "SOURCE_COLLECTOR_ORPHAN_RECLAIMED" }),
      ),
  );
}

export function effectiveMinimumSourceGapMs(requested?: number): number {
  if (
    requested !== undefined &&
    (!Number.isSafeInteger(requested) || requested < 0)
  ) {
    throw new Error("minimumSourceGapMs must be a non-negative integer");
  }
  return Math.max(MINIMUM_SOURCE_GAP_MS, requested ?? MINIMUM_SOURCE_GAP_MS);
}

export function isLoopbackCdpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      Number(url.port) >= 1_024 &&
      Number(url.port) <= 65_535
    );
  } catch {
    return false;
  }
}

export function isAllowedBrowserRequest(request: {
  readonly isNavigationRequest: boolean;
  readonly isSubframeNavigation?: boolean;
  readonly method?: string;
  readonly resourceType: string;
  readonly url: string;
}): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return false;
  }
  if (isAllowedCloudflareChallengeRequest(request, url)) return true;
  if (url.origin !== currentSource().origin) return false;
  if (request.isNavigationRequest) {
    try {
      canonicalAuthorUrl(url.href);
      return true;
    } catch {
      try {
        canonicalPoemUrl(url.href);
        return true;
      } catch {
        try {
          canonicalInventoryPaginationUrl(url.href);
          return true;
        } catch {
          return false;
        }
      }
    }
  }
  if (
    ["image", "media", "font", "websocket", "manifest", "other"].includes(
      request.resourceType,
    )
  ) {
    return false;
  }
  if (["xhr", "fetch"].includes(request.resourceType)) {
    return isFeedUrlStructure(url);
  }
  return false;
}

function isAllowedCloudflareChallengeRequest(
  request: {
    readonly isNavigationRequest: boolean;
    readonly isSubframeNavigation?: boolean;
    readonly method?: string;
    readonly resourceType: string;
  },
  url: URL,
): boolean {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "POST") return false;
  const sourceChallenge =
    url.origin === currentSource().origin &&
    url.pathname.startsWith(CLOUDFLARE_CHALLENGE_PATH_PREFIX);
  const cloudflareChallenge =
    url.origin === CLOUDFLARE_CHALLENGE_ORIGIN &&
    (url.pathname.startsWith(CLOUDFLARE_CHALLENGE_PATH_PREFIX) ||
      url.pathname.startsWith(CLOUDFLARE_TURNSTILE_PATH_PREFIX));
  if (!sourceChallenge && !cloudflareChallenge) return false;
  if (request.isNavigationRequest) {
    return (
      request.isSubframeNavigation === true &&
      request.resourceType === "document"
    );
  }
  return ["fetch", "script", "stylesheet", "xhr"].includes(
    request.resourceType,
  );
}

async function projectAuthorInventoryPage(
  page: Page,
  expectedPage: number,
): Promise<AuthorInventoryPageProjection> {
  return page.evaluate(
    ({ expectedPage: serializedExpectedPage, maximum, schemaVersion }) => {
      const authors = new Map<
        string,
        { href: string; name: string; poemCountText: null | string }
      >();
      const links = [
        ...document.querySelectorAll<HTMLAnchorElement>('a[href*="/cat-"]'),
      ];
      for (const link of links) {
        const rawHref = link.getAttribute("href") ?? "";
        const url = new URL(rawHref, location.origin);
        if (
          url.origin !== location.origin ||
          !/^\/cat-(?:[1-9]\d*|[^/?#]+)$/u.test(url.pathname)
        )
          continue;
        const name = link.textContent.trim();
        if (!name) continue;
        const container =
          link.closest("article, li, .card, [class*='author'], .row > div") ??
          link.parentElement;
        const text = (container?.textContent ?? "").slice(0, 2_000);
        const poemCountText =
          /[٠-٩۰-۹\d][٠-٩۰-۹\d,٬\s]*(?:قصيدة|قصائد)/u.exec(text)?.[0] ?? null;
        const existing = authors.get(url.pathname);
        if (
          existing &&
          (existing.name !== name || existing.poemCountText !== poemCountText)
        )
          throw new Error("SOURCE_AUTHOR_INVENTORY_DUPLICATE_CONFLICT");
        authors.set(url.pathname, {
          href: url.pathname,
          name,
          poemCountText,
        });
        if (authors.size > maximum)
          throw new Error("SOURCE_AUTHOR_INVENTORY_AUTHOR_LIMIT");
      }
      const expectedNextPath = `/authers-${String(serializedExpectedPage + 1)}`;
      const legacyNext = [
        ...document.querySelectorAll<HTMLAnchorElement>(
          "a[rel='next'], .pagination a[href]",
        ),
      ].find((link) => {
        try {
          return (
            new URL(link.href, location.origin).pathname === expectedNextPath
          );
        } catch {
          return false;
        }
      });
      const loaders = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-infinite-scroll][data-infinite-key="authors-directory"]',
        ),
      ];
      if (loaders.length > 1)
        throw new Error("SOURCE_AUTHOR_INVENTORY_PAGINATOR_MULTIPLE");
      const cursorNext =
        loaders[0]?.getAttribute("data-next-url")?.trim() ?? "";
      const nextPageHref = cursorNext || legacyNext?.href || null;
      return {
        // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Serialized browser callbacks target runtimes without Iterator Helpers.
        authors: [...authors.values()],
        challengeDetected: false,
        kind: "author_inventory_page" as const,
        nextPageHref,
        page: serializedExpectedPage,
        schemaVersion,
        sourceUrl: location.href,
        terminal: nextPageHref === null,
      };
    },
    {
      expectedPage,
      maximum: LIMITS.authorsPerInventory,
      schemaVersion: PROJECTION_SCHEMA_VERSION,
    },
  );
}

function isFeedUrlStructure(url: URL): boolean {
  return (
    /^\/cat-[1-9]\d*\/poems-feed$/.test(url.pathname) &&
    url.searchParams.size === 2 &&
    url.searchParams.getAll("cursor").length === 1 &&
    url.searchParams.get("cursor") !== "" &&
    url.searchParams.getAll("token").length === 1 &&
    url.searchParams.get("token") !== ""
  );
}

export function canonicalAuthorPaginationUrl(
  value: string,
  authorValue: string,
): { readonly cursor: string; readonly href: string } {
  if (value.length > LIMITS.url)
    throw new SourceBrowserError(
      "SOURCE_PAGINATION_URL_INVALID",
      "Author pagination URL is oversized",
      false,
    );
  const author = canonicalAuthorUrl(authorValue);
  let candidate: URL;
  try {
    candidate = new URL(value, author.href);
  } catch {
    throw new SourceBrowserError(
      "SOURCE_PAGINATION_URL_INVALID",
      "Author pagination URL is invalid",
      false,
    );
  }
  const authorUrl = new URL(author.href);
  const cursor = candidate.searchParams.get("cursor");
  if (
    candidate.origin !== authorUrl.origin ||
    candidate.pathname !== authorUrl.pathname ||
    candidate.username !== "" ||
    candidate.password !== "" ||
    candidate.hash !== "" ||
    candidate.searchParams.size !== 1 ||
    candidate.searchParams.getAll("cursor").length !== 1 ||
    cursor === null ||
    !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)
  ) {
    throw new SourceBrowserError(
      "SOURCE_PAGINATION_URL_INVALID",
      "Author pagination URL is outside the expected cursor boundary",
      false,
    );
  }
  return { cursor, href: candidate.href };
}

async function projectAuthorPaginationState(
  page: Page,
): Promise<AuthorPaginationState> {
  const projection = await page.evaluate(() => {
    const paginators = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-infinite-scroll][data-infinite-key="poet-poems"]',
      ),
    ];
    return {
      count: paginators.length,
      nextUrl: paginators[0]?.getAttribute("data-next-url")?.trim() ?? "",
    };
  });
  return authorPaginationStateFromProjection(projection);
}

export function authorPaginationStateFromProjection(projection: {
  readonly count: number;
  readonly nextUrl: string;
}): AuthorPaginationState {
  if (!Number.isSafeInteger(projection.count) || projection.count < 0) {
    throw new SourceBrowserError(
      "SOURCE_PAGINATION_PROJECTION_INVALID",
      "Author paginator projection is invalid",
      false,
    );
  }
  if (projection.count > 1) {
    throw new SourceBrowserError(
      "SOURCE_PAGINATION_URL_AMBIGUOUS",
      "Author page exposes multiple poem paginators",
      false,
    );
  }
  if (projection.count === 0) return { kind: "absent" };
  if (projection.nextUrl === "") return { kind: "terminal" };
  return { href: projection.nextUrl, kind: "next" };
}

export function feedManifestNeedsPaginationFallback(
  declaredCount: null | number,
  collectedCount: number,
  exhausted: boolean,
): boolean {
  return declaredCount === null ? !exhausted : collectedCount !== declaredCount;
}

export function paginationPageNeedsProgress(
  poemsBeforePage: number,
  poemsAfterPage: number,
  allowCoveredPage: boolean,
): boolean {
  return !allowCoveredPage && poemsAfterPage === poemsBeforePage;
}

export function extractFeedConfigurationFromInlineScripts(
  scripts: readonly string[],
  authorValue: string,
): FeedConfiguration {
  const author = canonicalAuthorUrl(authorValue);
  const sourceUrl = new URL(author.href);
  let bytes = 0;
  const bounded: string[] = [];
  for (const script of scripts) {
    bytes += new TextEncoder().encode(script).byteLength;
    if (bytes > INLINE_SCRIPT_MAX_BYTES) {
      throw new SourceBrowserError(
        "SOURCE_FEED_CONFIG_SIZE",
        "Inline feed configuration is oversized",
        false,
      );
    }
    bounded.push(script);
  }
  if (!bounded.some((script) => script.includes("poems-feed"))) {
    throw new SourceBrowserError(
      "SOURCE_FEED_CONFIG_MISSING",
      "Author page has no trusted inline feed configuration",
    );
  }
  const joined = bounded.join("\n");
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Runtime compatibility requires an ordinary array before array transforms.
  const endpoints = [
    ...joined.matchAll(/["']([^"'\n]{1,2048}poems-feed)["']/gu),
  ]
    .map((match) => match[1]?.replaceAll(String.raw`\/`, "/") ?? "")
    .filter(Boolean);
  const matchingEndpoints = endpoints.filter((value) => {
    try {
      const candidate = new URL(value, currentSource().origin);
      return (
        candidate.origin === currentSource().origin &&
        /^\/cat-[1-9]\d*\/poems-feed$/.test(candidate.pathname) &&
        candidate.search === "" &&
        candidate.hash === ""
      );
    } catch {
      // eslint-disable-next-line @sarj/no-sentinel-return-on-catch -- Invalid endpoint candidates are expected while scanning unrelated scripts.
      return false;
    }
  });
  if (matchingEndpoints.length === 0) {
    throw new SourceBrowserError(
      "SOURCE_FEED_ENDPOINT_INVALID",
      "Inline feed endpoint does not match the author",
      false,
    );
  }
  const token = extractInlineValue(
    joined,
    /(?:x-feed-token|feed[_-]?token)/iu,
    "SOURCE_FEED_TOKEN_MISSING",
  );
  const cursor = extractInlineValue(
    joined,
    /(?:initial[_-]?cursor|next[_-]?(?:poems?[_-]?)?cursor|feed[_-]?cursor|cursor)/iu,
    "SOURCE_FEED_CURSOR_MISSING",
  );
  const uniqueEndpoints = new Set(
    matchingEndpoints.map((value) => new URL(value, sourceUrl.origin).href),
  );
  if (uniqueEndpoints.size !== 1) {
    throw new SourceBrowserError(
      "SOURCE_FEED_ENDPOINT_AMBIGUOUS",
      "Author page declares multiple feed endpoints",
      false,
    );
  }
  const [endpoint] = uniqueEndpoints;
  if (!endpoint) throw new Error("Validated endpoint unexpectedly missing");
  return {
    cursor,
    endpoint,
    token,
  };
}

export function parseFeedHttpResult(
  result: FeedHttpResult,
  configuration: FeedConfiguration,
  cursor: string,
): SourceFeedPage {
  const cfMitigated = result.cfMitigated?.toLowerCase() === "challenge";
  const challengeCategory = classifyCloudflareChallengeEvidence(
    {
      html: result.body,
    },
    cfMitigated,
  );
  if (cfMitigated || challengeCategory !== null) {
    throw new SourceBrowserError(
      "SOURCE_HUMAN_REQUIRED",
      "Cloudflare requires human interaction; automatic bypass is disabled",
      true,
      null,
      sourceAccessDiagnostic(
        challengeCategory ?? "managed_challenge",
        "feed",
        result.status,
        cfMitigated,
      ),
    );
  }
  if (result.status !== 200) {
    if (result.status === 429) {
      const retryAfterMs = parseRetryAfterMs(result.retryAfter);
      throw new SourceBrowserError(
        "SOURCE_RATE_LIMITED",
        `Author feed rate-limited the collector${retryAfterMs === null ? "" : ` for ${String(retryAfterMs)}ms`}`,
        true,
        retryAfterMs,
      );
    }
    if (result.status === 401 || result.status === 403) {
      throw new SourceBrowserError(
        "SOURCE_HUMAN_REQUIRED",
        `collection source denied feed access with HTTP ${String(result.status)}; automatic bypass is disabled`,
        true,
        null,
        sourceAccessDiagnostic(
          "http_access_denied",
          "feed",
          result.status,
          false,
        ),
      );
    }
    throw new SourceBrowserError(
      "SOURCE_FEED_HTTP_STATUS",
      `Author feed returned HTTP ${String(result.status)}`,
      isRetryableHttpStatus(result.status),
    );
  }
  const contentType = result.contentType
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new SourceBrowserError(
      "SOURCE_FEED_CONTENT_TYPE",
      "Author feed is not JSON",
      false,
    );
  }
  const actualBytes = new TextEncoder().encode(result.body).byteLength;
  if (result.bytes !== actualBytes || actualBytes > FEED_DOCUMENT_MAX_BYTES) {
    throw new SourceBrowserError(
      "SOURCE_FEED_SIZE",
      "Author feed body size is invalid",
      false,
    );
  }
  if (result.url !== feedRequestUrl(configuration, cursor)) {
    throw new SourceBrowserError(
      "SOURCE_FEED_REDIRECT",
      "Author feed redirected or changed its query",
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new SourceBrowserError(
      "SOURCE_FEED_JSON_INVALID",
      "Author feed returned malformed JSON",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => !["html", "next_cursor"].includes(key)) ||
    !("html" in parsed) ||
    !("next_cursor" in parsed) ||
    typeof parsed.html !== "string"
  ) {
    throw new SourceBrowserError(
      "SOURCE_FEED_SCHEMA_INVALID",
      "Author feed JSON does not match the expected schema",
      false,
    );
  }
  // eslint-disable-next-line @sarj/prefer-schema-for-api-payload -- The exhaustive structural checks above are the boundary validator for this tiny dynamic feed payload.
  const nextCursor = normalizeNextCursor(parsed.next_cursor);
  return {
    html: parsed.html,
    nextCursor,
    terminal: parsed.html.trim() === "" || nextCursor === null,
  };
}

function parseRetryAfterMs(value: null | string): null | number {
  if (value === null) return null;
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}

function feedRequestUrl(
  configuration: FeedConfiguration,
  cursor: string,
): string {
  const expected = new URL(configuration.endpoint);
  expected.searchParams.set("cursor", cursor);
  expected.searchParams.set("token", configuration.token);
  return expected.href;
}

export function assertFeedProgress(
  feed: SourceFeedPage,
  currentCursor: string,
  seenCursors: ReadonlySet<string>,
  addedPoems: number,
): void {
  if (feed.terminal) return;
  if (addedPoems === 0) {
    throw new SourceBrowserError(
      "SOURCE_FEED_NO_PROGRESS",
      "Nonterminal author feed did not add poems",
    );
  }
  if (
    feed.nextCursor === null ||
    feed.nextCursor === currentCursor ||
    seenCursors.has(feed.nextCursor)
  ) {
    throw new SourceBrowserError(
      "SOURCE_FEED_CURSOR_LOOP",
      "Author feed repeated a cursor",
      false,
    );
  }
}

export function extractFeedConfigurationFromDocument(
  documentHtml: string,
  authorHref: string,
): FeedConfiguration {
  const scripts: string[] = [];
  let bytes = 0;
  for (const match of documentHtml.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu,
  )) {
    const attributes = match[1] ?? "";
    const source = match[2] ?? "";
    if (/(?:^|\s)src\s*=/iu.test(attributes) || !source.includes("poems-feed"))
      continue;
    bytes += new TextEncoder().encode(source).byteLength;
    if (
      scripts.length >= INLINE_SCRIPT_MAX_CANDIDATES ||
      bytes > INLINE_SCRIPT_MAX_BYTES
    ) {
      throw new SourceBrowserError(
        "SOURCE_FEED_CONFIG_SIZE",
        "Inline feed configuration exceeded its safety limits",
        false,
      );
    }
    scripts.push(source);
  }
  return extractFeedConfigurationFromInlineScripts(scripts, authorHref);
}

function extractInlineValue(
  source: string,
  key: RegExp,
  projectionErrorCode: string,
): string {
  const expression = new RegExp(
    String.raw`["']?(?:${key.source})["']?\s*[:=]\s*(?:(["'])([^"'\\\s]{1,4096})\1|(\d{1,100}))`,
    "giu",
  );
  const values = new Set(
    // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Runtime compatibility requires an ordinary array before array transforms.
    [...source.matchAll(expression)]
      .map((match) => match[2] ?? match[3] ?? "")
      .filter(Boolean),
  );
  if (values.size === 0) {
    throw new SourceBrowserError(
      projectionErrorCode,
      "Inline feed configuration is incomplete",
    );
  }
  if (values.size !== 1) {
    throw new SourceBrowserError(
      `${projectionErrorCode}_AMBIGUOUS`,
      "Inline feed configuration declares conflicting values",
      false,
    );
  }
  const [value] = values;
  if (!value) throw new Error("Validated inline value unexpectedly missing");
  return value;
}

function normalizeNextCursor(value: unknown): null | string {
  if (value === null || value === false || value === "" || value === 0) {
    return null;
  }
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
  ) {
    throw new SourceBrowserError(
      "SOURCE_FEED_CURSOR_INVALID",
      "Author feed returned an invalid cursor",
      false,
    );
  }
  const cursor = String(value).trim();
  if (cursor.length === 0) return null;
  if (cursor.length > 4_096) {
    throw new SourceBrowserError(
      "SOURCE_FEED_CURSOR_INVALID",
      "Author feed cursor is oversized",
      false,
    );
  }
  return cursor;
}

async function restrictRequest(route: Route, request: Request): Promise<void> {
  if (
    !isAllowedBrowserRequest({
      isNavigationRequest: request.isNavigationRequest(),
      isSubframeNavigation:
        request.isNavigationRequest() && request.frame().parentFrame() !== null,
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
    })
  ) {
    await route.abort("blockedbyclient");
    return;
  }
  await route.continue();
}

export async function resolveNavigationDocument(
  page: Page,
  response: null | Response,
  expectedHref: string,
  maximumBytes: number,
  signal: AbortSignal,
  timing: ChallengeResolutionTiming = {},
): Promise<string> {
  const envelope = await readNavigationEnvelope(
    response,
    expectedHref,
    maximumBytes,
  );
  if (!response) throw new Error("Validated response unexpectedly missing");
  throwIfAborted(signal);
  const resolved = await abortable(
    resolveCloudflareChallenge(
      page,
      response,
      envelope.html,
      expectedHref,
      signal,
      timing,
    ),
    signal,
    () => page.close(),
  );
  if (envelope.status !== 200 && !resolved) {
    throw new SourceBrowserError(
      "SOURCE_HTTP_STATUS",
      `Navigation returned HTTP ${String(envelope.status)}`,
      isRetryableHttpStatus(envelope.status),
    );
  }
  return resolved
    ? readSettledDocument(page, expectedHref, maximumBytes, signal)
    : envelope.html;
}

interface NavigationEnvelope {
  readonly html: string;
  readonly status: number;
}

async function readNavigationEnvelope(
  response: null | Response,
  expectedHref: string,
  maximumBytes: number,
): Promise<NavigationEnvelope> {
  if (!response)
    throw new SourceBrowserError(
      "SOURCE_NO_RESPONSE",
      "Navigation returned no response",
    );
  const headers = await response.allHeaders();
  const status = response.status();
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers["retry-after"] ?? null);
    throw new SourceBrowserError(
      "SOURCE_RATE_LIMITED",
      `Navigation rate-limited the collector${retryAfterMs === null ? "" : ` for ${String(retryAfterMs)}ms`}`,
      true,
      retryAfterMs,
    );
  }
  const headerChallenged =
    headers["cf-mitigated"]?.toLowerCase() === "challenge";
  if (status !== 200 && status !== 401 && status !== 403 && !headerChallenged) {
    throw new SourceBrowserError(
      "SOURCE_HTTP_STATUS",
      `Navigation returned HTTP ${String(status)}`,
      isRetryableHttpStatus(status),
    );
  }
  if (response.url() !== expectedHref)
    throw new SourceBrowserError(
      "SOURCE_REDIRECT",
      "Navigation redirected",
      false,
    );
  const contentType = headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    throw new SourceBrowserError(
      "SOURCE_CONTENT_TYPE",
      "Document is not HTML",
      false,
    );
  }
  const length = headers["content-length"];
  if (length) {
    const parsed = Number(length);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new SourceBrowserError(
        "SOURCE_DOCUMENT_SIZE",
        "Document is oversized",
        false,
      );
    }
  }
  const body = await response.body();
  if (body.byteLength > maximumBytes) {
    throw new SourceBrowserError(
      "SOURCE_DOCUMENT_SIZE",
      "Document is oversized",
      false,
    );
  }
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new SourceBrowserError(
      "SOURCE_DOCUMENT_ENCODING",
      "Document is not valid UTF-8",
      false,
    );
  }
  if (
    status !== 200 &&
    !headerChallenged &&
    !isCloudflareChallengeEvidence({ html })
  ) {
    if (status === 401 || status === 403) {
      throw new SourceBrowserError(
        "SOURCE_HUMAN_REQUIRED",
        `collection source denied browser access with HTTP ${String(status)}; automatic bypass is disabled`,
        true,
        null,
        sourceAccessDiagnostic(
          "http_access_denied",
          "navigation",
          status,
          false,
        ),
      );
    }
    throw new SourceBrowserError(
      "SOURCE_HTTP_STATUS",
      `Navigation returned HTTP ${String(status)}`,
      isRetryableHttpStatus(status),
    );
  }
  return { html, status };
}

interface ChallengeResolutionTiming {
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
}

interface CloudflareChallengeEvidence {
  readonly bodyText?: string;
  readonly hasChallengeOption?: boolean;
  readonly hasManagedChallengeElement?: boolean;
  readonly hasTurnstileElement?: boolean;
  readonly html?: string;
  readonly scriptSources?: string;
  readonly title?: string;
}

function sourceAccessDiagnostic(
  category: SourceAccessDiagnostic["category"],
  surface: SourceAccessDiagnostic["surface"],
  httpStatus: null | number,
  cfMitigated: boolean,
): SourceAccessDiagnostic {
  if (
    !["http_access_denied", "managed_challenge", "turnstile"].includes(
      category,
    ) ||
    !["feed", "navigation", "projection"].includes(surface) ||
    typeof cfMitigated !== "boolean"
  ) {
    throw new Error("Source access diagnostic is invalid");
  }
  if (
    httpStatus !== null &&
    (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
  ) {
    throw new Error("Source access HTTP status must be null or 100..599");
  }
  return Object.freeze({
    category,
    cfMitigated,
    httpStatus,
    schemaVersion: 1,
    surface,
  });
}

type ChallengePageState = "challenge" | "clear" | "transition";

export function isCloudflareChallengeEvidence(
  evidence: CloudflareChallengeEvidence,
): boolean {
  return classifyCloudflareChallengeEvidence(evidence) !== null;
}

export function classifyCloudflareChallengeEvidence(
  evidence: CloudflareChallengeEvidence,
  challengeConfirmed = false,
): "managed_challenge" | "turnstile" | null {
  const title = (evidence.title ?? "").toLowerCase();
  const content = [
    evidence.bodyText ?? "",
    (evidence.html ?? "").slice(0, INLINE_SCRIPT_MAX_BYTES),
    evidence.scriptSources ?? "",
  ]
    .join("\n")
    .toLowerCase();
  const challengeTitle =
    title.includes("just a moment") ||
    title.includes("attention required") ||
    /<title[^>]*>\s*(?:just a moment|attention required)/u.test(content);
  const challengePhrase =
    content.includes("verify you are human") ||
    content.includes("performing security verification") ||
    content.includes("enable javascript and cookies to continue");
  const challengeRuntime = content.includes("_cf_chl_opt");
  const challengeResource =
    content.includes("/orchestrate/chl_page/") ||
    content.includes("/cdn-cgi/challenge-platform/");
  const turnstile =
    evidence.hasTurnstileElement === true ||
    content.includes("challenges.cloudflare.com") ||
    content.includes("cf-turnstile");
  const challenged =
    challengeConfirmed ||
    evidence.hasManagedChallengeElement === true ||
    evidence.hasChallengeOption === true ||
    challengePhrase ||
    challengeRuntime ||
    (challengeTitle && (challengeResource || turnstile));
  if (!challenged) return null;
  return turnstile ? "turnstile" : "managed_challenge";
}

export async function resolveCloudflareChallenge(
  page: Page,
  response: Response,
  documentHtml: string,
  expectedHref: string,
  signal: AbortSignal,
  timing: ChallengeResolutionTiming = {},
): Promise<boolean> {
  const headers = await response.allHeaders();
  const initialInspection = await inspectChallengePage(page, expectedHref);
  const cfMitigated = headers["cf-mitigated"]?.toLowerCase() === "challenge";
  const documentCategory = classifyCloudflareChallengeEvidence(
    {
      html: documentHtml,
    },
    cfMitigated,
  );
  let challengeCategory =
    initialInspection.category ?? documentCategory ?? "managed_challenge";
  const challenged =
    cfMitigated ||
    initialInspection.state === "challenge" ||
    documentCategory !== null;
  if (!challenged) return false;

  const resolved = await waitForChallengeResolution(
    async () => {
      const inspection = await inspectChallengePage(page, expectedHref);
      if (inspection.category === "turnstile") challengeCategory = "turnstile";
      return inspection.state;
    },
    signal,
    timing,
  );
  if (!resolved)
    throw new SourceBrowserError(
      "SOURCE_HUMAN_REQUIRED",
      "Cloudflare requires human interaction; automatic bypass is disabled",
      true,
      null,
      sourceAccessDiagnostic(
        challengeCategory,
        "navigation",
        response.status(),
        cfMitigated,
      ),
    );
  if (page.url() !== expectedHref)
    throw new SourceBrowserError(
      "SOURCE_REDIRECT",
      "Navigation redirected while resolving Cloudflare verification",
      false,
    );
  return true;
}

async function inspectChallengePage(
  page: Page,
  expectedHref: string,
): Promise<{
  readonly category: "managed_challenge" | "turnstile" | null;
  readonly state: ChallengePageState;
}> {
  try {
    const snapshot = await page.evaluate(
      ({ challengeScriptMaximum, expectedHref: serializedExpectedHref }) => {
        const bodyText = document.body.innerText.slice(0, 20_000);
        const expectedPath = new URL(serializedExpectedHref).pathname;
        const poemTarget = /^\/poem[1-9]\d*\.html$/.test(expectedPath);
        const authorTarget = /^\/cat-[^/]+$/.test(expectedPath);
        const poemContent = document.querySelector("#poem_content");
        const hasMeaningfulPoemContent =
          (poemContent?.textContent ?? "").trim().length > 0;
        const hasAuthorEvidence =
          document.querySelector('a[href*="poem"]') !== null ||
          /[٠-٩۰-۹\d][٠-٩۰-۹\d,٬\s]*(?:قصيدة|قصائد)/u.test(bodyText);
        return {
          bodyText,
          hasChallengeOption: "_cf_chl_opt" in globalThis,
          hasManagedChallengeElement:
            document.querySelector("#challenge-form, .cf-challenge-running") !==
            null,
          hasTurnstileElement:
            document.querySelector(
              ".cf-turnstile, iframe[src*='challenges.cloudflare.com']",
            ) !== null,
          href: location.href,
          readyState: document.readyState,
          scriptSources: [
            ...document.querySelectorAll<HTMLScriptElement>("script[src]"),
          ]
            .slice(0, challengeScriptMaximum)
            .map((script) => script.src)
            .join("\n"),
          targetReady:
            location.href !== serializedExpectedHref ||
            (poemTarget
              ? hasMeaningfulPoemContent
              : authorTarget
                ? hasAuthorEvidence
                : bodyText.trim().length > 0),
          title: document.title,
        };
      },
      {
        challengeScriptMaximum: INLINE_SCRIPT_MAX_CANDIDATES,
        expectedHref,
      },
    );
    const category = classifyCloudflareChallengeEvidence(snapshot);
    if (category !== null) return { category, state: "challenge" };
    return {
      category: null,
      state:
        snapshot.readyState === "loading" || !snapshot.targetReady
          ? "transition"
          : "clear",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /execution context was destroyed|cannot find context|because of a navigation/i.test(
        message,
      )
    )
      return { category: null, state: "transition" };
    throw error;
  }
}

async function readSettledDocument(
  page: Page,
  expectedHref: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const snapshot = await abortable(
    page.evaluate((serializedMaximumBytes) => {
      const html = document.documentElement.outerHTML;
      if (html.length > serializedMaximumBytes) {
        return {
          byteLength: serializedMaximumBytes + 1,
          contentType: document.contentType,
          href: location.href,
          html: null,
          readyState: document.readyState,
        };
      }
      const byteLength = new TextEncoder().encode(html).byteLength;
      return {
        byteLength,
        contentType: document.contentType,
        href: location.href,
        html: byteLength > serializedMaximumBytes ? null : html,
        readyState: document.readyState,
      };
    }, maximumBytes),
    signal,
    () => page.close(),
  );
  if (snapshot.href !== expectedHref)
    throw new SourceBrowserError(
      "SOURCE_REDIRECT",
      "Navigation redirected while reading the settled document",
      false,
    );
  if (
    snapshot.contentType !== "text/html" &&
    snapshot.contentType !== "application/xhtml+xml"
  ) {
    throw new SourceBrowserError(
      "SOURCE_CONTENT_TYPE",
      "Settled document is not HTML",
      false,
    );
  }
  if (snapshot.readyState === "loading")
    throw new SourceBrowserError(
      "SOURCE_DOCUMENT_NOT_READY",
      "Settled document is still loading",
    );
  if (snapshot.html === null || snapshot.byteLength > maximumBytes)
    throw new SourceBrowserError(
      "SOURCE_DOCUMENT_SIZE",
      "Settled document is oversized",
      false,
    );
  return snapshot.html;
}

export async function waitForChallengeResolution(
  inspect: () => Promise<ChallengePageState>,
  signal: AbortSignal,
  timing: ChallengeResolutionTiming = {},
): Promise<boolean> {
  const now = timing.now ?? Date.now;
  const sleep = timing.sleep ?? globalThisDelay;
  const timeoutMs = timing.timeoutMs ?? CHALLENGE_RESOLUTION_TIMEOUT_MS;
  const pollIntervalMs = timing.pollIntervalMs ?? CHALLENGE_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Challenge timeout must be a positive integer");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
    throw new Error("Challenge poll interval must be a positive integer");
  const deadline = now() + timeoutMs;
  let consecutiveClear = 0;
  while (now() < deadline) {
    throwIfAborted(signal);
    // eslint-disable-next-line no-await-in-loop -- Challenge observations must remain sequential.
    const state = await inspect();
    consecutiveClear = state === "clear" ? consecutiveClear + 1 : 0;
    if (consecutiveClear >= 2) return true;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    // eslint-disable-next-line no-await-in-loop -- Polling waits between sequential challenge observations.
    await abortable(sleep(Math.min(pollIntervalMs, remaining)), signal);
  }
  return false;
}

async function projectManifest(
  page: Page,
  authorHref: string,
  terminal: boolean,
): Promise<AuthorPoemManifestProjection> {
  return page.evaluate(
    ({
      authorHref: serializedAuthorHref,
      maximum,
      schemaVersion,
      terminal: serializedTerminal,
    }) => {
      const links = [
        ...document.querySelectorAll<HTMLAnchorElement>('a[href*="poem"]'),
      ];
      const poems = new Map<
        string,
        { href: string; title: string; verseCountText: null | string }
      >();
      for (const link of links) {
        const href = link.getAttribute("href") ?? "";
        const url = new URL(href, location.origin);
        if (url.origin !== location.origin) continue;
        const path = url.pathname;
        if (!/^\/poem[1-9]\d*\.html$/.test(path)) continue;
        const container =
          link.closest("article, li, [class*='poem'], .row > div") ??
          link.parentElement;
        const title =
          link
            .querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6")
            ?.textContent.trim() ||
          link
            .querySelector<HTMLElement>(".poet-poem-line")
            ?.textContent.trim() ||
          link.textContent.trim();
        if (!title) continue;
        const text = (container?.textContent ?? "").trim();
        const verseCountText =
          /[٠-٩۰-۹\d][٠-٩۰-۹\d,٬\s]*(?:بيت|أبيات)/u.exec(text)?.[0] ?? null;
        const existing = poems.get(path);
        if (!existing) {
          poems.set(path, { href: path, title, verseCountText });
        } else {
          const existingIsCount = /^[٠-٩۰-۹\d,٬\s]+$/u.test(existing.title);
          const candidateIsCount = /^[٠-٩۰-۹\d,٬\s]+$/u.test(title);
          poems.set(path, {
            href: path,
            title:
              existingIsCount && !candidateIsCount ? title : existing.title,
            verseCountText: existing.verseCountText ?? verseCountText,
          });
        }
        if (poems.size > maximum) break;
      }
      const bodyText = document.body.innerText.slice(0, 100_000);
      const profilePoemCount = [
        ...document.querySelectorAll<HTMLElement>(
          ".poet-profile-stats > div, .poet-identity-stats > div",
        ),
      ].find((profileEntry) =>
        [...profileEntry.querySelectorAll<HTMLElement>(":scope > span")].some(
          (label) => /^(?:قصيدة|قصائد)$/u.test(label.textContent.trim()),
        ),
      );
      const declaredPoemCountText =
        profilePoemCount?.textContent.trim() ??
        /[٠-٩۰-۹\d][٠-٩۰-۹\d,٬ \t]*(?:قصيدة|قصائد)/u.exec(bodyText)?.[0] ??
        null;
      return {
        authorHref: serializedAuthorHref,
        challengeDetected: false,
        declaredPoemCountText,
        kind: "author_poem_manifest" as const,
        // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Serialized browser callbacks target runtimes without Iterator Helpers.
        poems: [...poems.values()],
        schemaVersion,
        sourceUrl: location.href,
        terminal: serializedTerminal,
      };
    },
    {
      authorHref,
      maximum: LIMITS.poemsPerAuthor,
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      terminal,
    },
  );
}

async function projectPoemsFromHtml(
  page: Page,
  html: string,
): Promise<AuthorPoemManifestProjection["poems"]> {
  const poems = await page.evaluate(
    ({ html: serializedHtml, maximum }) => {
      const parsedDocument = new DOMParser().parseFromString(
        serializedHtml,
        "text/html",
      );
      const links = [
        ...parsedDocument.querySelectorAll<HTMLAnchorElement>(
          'a[href*="poem"]',
        ),
      ];
      const results = new Map<
        string,
        { href: string; title: string; verseCountText: null | string }
      >();
      for (const link of links) {
        const href = link.getAttribute("href") ?? "";
        const url = new URL(href, location.origin);
        if (url.origin !== location.origin) continue;
        const path = url.pathname;
        if (!/^\/poem[1-9]\d*\.html$/.test(path)) continue;
        const container =
          link.closest("article, li, [class*='poem'], .row > div") ??
          link.parentElement;
        const title =
          link
            .querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6")
            ?.textContent.trim() ||
          link
            .querySelector<HTMLElement>(".poet-poem-line")
            ?.textContent.trim() ||
          link.textContent.trim();
        if (!title) continue;
        const text = (container?.textContent ?? "").trim();
        const verseCountText =
          /[٠-٩۰-۹\d][٠-٩۰-۹\d,٬\s]*(?:بيت|أبيات)/u.exec(text)?.[0] ?? null;
        const existing = results.get(path);
        if (!existing) {
          results.set(path, { href: path, title, verseCountText });
        } else {
          const existingIsCount = /^[٠-٩۰-۹\d,٬\s]+$/u.test(existing.title);
          const candidateIsCount = /^[٠-٩۰-۹\d,٬\s]+$/u.test(title);
          results.set(path, {
            href: path,
            title:
              existingIsCount && !candidateIsCount ? title : existing.title,
            verseCountText: existing.verseCountText ?? verseCountText,
          });
        }
        if (results.size > maximum) break;
      }
      // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Serialized browser callbacks target runtimes without Iterator Helpers.
      return [...results.values()];
    },
    { html, maximum: LIMITS.poemsPerAuthor },
  );
  if (poems.length > LIMITS.poemsPerAuthor) {
    throw new SourceBrowserError(
      "SOURCE_MANIFEST_LIMIT",
      "Feed extraction exceeded its safety limit",
      false,
    );
  }
  return poems;
}

async function projectPoem(
  page: Page,
  expectedAuthorHref: string,
): Promise<PoemDetailProjection> {
  const evidence = await page.evaluate(
    ({
      challengeScriptMaximum,
      expectedAuthorHref: serializedExpectedAuthorHref,
      maximumLines,
      schemaVersion,
    }) => {
      const legacyContent = document.querySelector("#poem_content");
      const modernContent = document.querySelector("#poemText");
      const legacyLineNodes = legacyContent
        ? [...legacyContent.querySelectorAll<HTMLElement>(":scope > h3")]
        : [];
      const modernRows = modernContent
        ? [
            ...modernContent.querySelectorAll<HTMLElement>(
              ":scope > .poem-line",
            ),
          ]
        : [];
      const modernRowLines = modernRows.map((row) =>
        [...row.querySelectorAll<HTMLElement>(":scope > span")].map((span) =>
          (span.innerText || span.textContent || "").trim(),
        ),
      );
      const modernClassicalMalformed = modernRowLines.some(
        (rowLines, index) =>
          (rowLines.length !== 2 &&
            !(index === modernRowLines.length - 1 && rowLines.length === 1)) ||
          rowLines.some((line) => line === ""),
      );
      const modernLines = modernClassicalMalformed
        ? []
        : modernRowLines.flatMap((rowLines, index) =>
            index === modernRowLines.length - 1 && rowLines.length === 1
              ? [rowLines[0] ?? "", ""]
              : rowLines,
          );
      // Modern prose/free-verse pages use direct <p> children under #poemText
      // and intentionally have no classical .poem-line rows. Keep the modern
      // container as the fallback source even when it has no classical nodes.
      const content = modernContent ?? legacyContent;
      const fallback = content
        ? [...content.querySelectorAll<HTMLElement>(":scope > p, :scope > div")]
        : [];
      const selected = legacyLineNodes.length > 0 ? legacyLineNodes : fallback;
      const lines =
        modernLines.length > 0
          ? modernLines
          : selected
              .flatMap((node) =>
                (node.innerText || node.textContent || "").split(/\r?\n/u),
              )
              .map((line) => line.trim());
      if (modernLines.length === 0) {
        while (lines[0] === "") lines.shift();
        while (lines.at(-1) === "") lines.pop();
      }
      const boundedLines = lines.slice(0, maximumLines + 1);
      const expectedAuthorPath = new URL(serializedExpectedAuthorHref).pathname;
      const author = [
        ...document.querySelectorAll<HTMLAnchorElement>('a[href*="cat-"]'),
      ].find(
        (candidate) =>
          new URL(candidate.getAttribute("href") ?? "", location.origin)
            .pathname === expectedAuthorPath,
      );
      const metadataTitle =
        document
          .querySelector<HTMLMetaElement>('meta[property="og:title"]')
          ?.getAttribute("content") ?? document.title;
      const title = metadataTitle.split(/\s+-\s+/u, 1)[0]?.trim() ?? "";
      const bodyText = document.body.innerText.slice(0, 100_000);
      const reader =
        content?.closest<HTMLElement>(".poem-reader-card") ?? content;
      const poemMetadataText =
        reader
          ?.querySelector<HTMLElement>(".poem-meta-inline")
          ?.innerText.slice(0, 2_000) ?? "";
      const declaredVerseCountText =
        /[٠-٩۰-۹\d][٠-٩۰-۹\d,٬\s]*(?:بيت|أبيات)/u.exec(poemMetadataText)?.[0] ??
        null;
      const structureLabels = [
        ...(reader?.querySelectorAll<HTMLElement>("a, span") ?? []),
      ]
        .slice(0, 2_000)
        .map((node) => node.textContent.trim().normalize("NFC"));
      const challengeTitle = document.title;
      const challengeScriptSources = [
        ...document.querySelectorAll<HTMLScriptElement>("script[src]"),
      ]
        .slice(0, challengeScriptMaximum)
        .map((script) => script.src)
        .join("\n");
      return {
        authorHref: author?.getAttribute("href") ?? "",
        challengeEvidence: {
          bodyText: bodyText.slice(0, 20_000),
          hasChallengeOption: "_cf_chl_opt" in globalThis,
          hasManagedChallengeElement:
            document.querySelector("#challenge-form, .cf-challenge-running") !==
            null,
          hasTurnstileElement:
            document.querySelector(
              ".cf-turnstile, iframe[src*='challenges.cloudflare.com']",
            ) !== null,
          scriptSources: challengeScriptSources,
          title: challengeTitle,
        },
        declaredVerseCountText,
        kind: "poem_detail" as const,
        lines: boundedLines,
        schemaVersion,
        sourceUrl: location.href,
        structureLabels,
        classicalLineNodeCount:
          modernLines.length > 0 ? modernLines.length : legacyLineNodes.length,
        modernClassicalMalformed,
        title,
      };
    },
    {
      challengeScriptMaximum: INLINE_SCRIPT_MAX_CANDIDATES,
      expectedAuthorHref,
      maximumLines: LIMITS.poemLines,
      schemaVersion: PROJECTION_SCHEMA_VERSION,
    },
  );
  const {
    challengeEvidence,
    classicalLineNodeCount,
    modernClassicalMalformed,
    structureLabels,
    ...projection
  } = evidence;
  const challengeCategory =
    classifyCloudflareChallengeEvidence(challengeEvidence);
  if (challengeCategory !== null) {
    throw new SourceBrowserError(
      "SOURCE_HUMAN_REQUIRED",
      "Cloudflare challenge remained in the final poem projection",
      true,
      null,
      sourceAccessDiagnostic(challengeCategory, "projection", null, false),
    );
  }
  const structure = classifyPoemStructureEvidence(
    structureLabels,
    classicalLineNodeCount > 0,
  );
  if (modernClassicalMalformed && structure !== "free_verse") {
    throw new SourceProjectionError(
      "SOURCE_POEM_STRUCTURE_INVALID",
      "Modern classical poem rows must contain exactly two nonempty hemistichs",
    );
  }
  return {
    ...projection,
    challengeDetected: false,
    declaredVerseCountText:
      structure === "free_verse"
        ? null
        : (projection.declaredVerseCountText ??
          (structure === "classical" && classicalLineNodeCount % 2 === 0
            ? String(classicalLineNodeCount / 2)
            : null)),
    structure,
  };
}

export function classifyPoemStructureEvidence(
  markerTexts: readonly string[],
  hasClassicalLineNodes: boolean,
): PoemDetailProjection["structure"] {
  if (
    markerTexts.some((value) =>
      FREE_VERSE_LABELS.includes(value.trim().normalize("NFC")),
    )
  ) {
    return "free_verse";
  }
  return hasClassicalLineNodes ? "classical" : "unknown";
}

function parseLooseCount(value: null | string): null | number {
  if (!value) return null;
  const translated = Array.from(value, (character) => {
    const index = "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹".indexOf(character);
    return index < 0 ? character : String(index % 10);
  }).join("");
  const match = /\d+/.exec(translated.replaceAll(/[,٬ ]/g, ""));
  return match ? Number(match[0]) : null;
}

export function manifestDigest(manifest: AuthorPoemManifestProjection): string {
  const records = manifest.poems
    .map(({ href, title, verseCountText }) => ({
      canonicalId: canonicalPoemUrl(href).canonicalId,
      title: title.trim().normalize("NFC"),
      verses: parseLooseCount(verseCountText),
    }))
    .toSorted((left, right) =>
      left.canonicalId.localeCompare(right.canonicalId),
    );
  const semanticManifest = JSON.stringify({
    declaredPoemCount: parseLooseCount(manifest.declaredPoemCountText),
    records,
  });
  return hash("sha256", semanticManifest, "hex");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Aborted");
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => unknown,
): Promise<T> {
  throwIfAborted(signal);
  const { promise: result, reject, resolve } = Promise.withResolvers<T>();
  let settled = false;
  const cleanup = (): void => signal.removeEventListener("abort", abort);
  const abort = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    const cleanupTasks = onAbort ? [Promise.resolve().then(onAbort)] : [];
    void Promise.allSettled(cleanupTasks).then(() =>
      reject(toError(signal.reason, "Aborted")),
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  void promise
    .then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    })
    .catch((error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(toError(error, "Operation failed"));
    });
  return result;
}

function globalThisDelay(milliseconds: number): Promise<void> {
  return delay(milliseconds);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = hash("sha256", left, "buffer");
  const rightDigest = hash("sha256", right, "buffer");
  return timingSafeEqual(leftDigest, rightDigest);
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function toError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}

function isFileExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

async function readProfileLock(path: string): Promise<{
  readonly pid: number;
  readonly raw: string;
  readonly token: string;
} | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("pid" in parsed) ||
      !("token" in parsed) ||
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      typeof parsed.token !== "string" ||
      !/^[a-f\d-]{36}$/i.test(parsed.token)
    ) {
      return null;
    }
    return { pid: Number(parsed.pid), raw, token: parsed.token };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(errorCode(error) === "ESRCH");
  }
}

async function acquireProfileRecoveryLock(
  path: string,
  token: string,
): Promise<FileHandle | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Recovery-lock attempts serialize exclusive creation for one profile path.
      const handle = await open(path, "wx", 0o600);
      try {
        // eslint-disable-next-line no-await-in-loop -- The recovery token must be durable before returning ownership.
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, token })}\n`,
          "utf8",
        );
        return handle;
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop -- Failed recovery publication closes before removing its partial token.
        await handle.close();
        // eslint-disable-next-line no-await-in-loop -- Partial recovery state must be removed before retrying.
        await unlink(path);
        throw error;
      }
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      // eslint-disable-next-line no-await-in-loop -- Each retry inspects the latest recovery owner after exclusive-create contention.
      const existing = await readProfileLock(path);
      if (existing && processIsAlive(existing.pid)) return null;
      // eslint-disable-next-line no-await-in-loop -- Malformed recovery locks are age-checked before quarantine.
      const pathStats = await stat(path);
      if (!existing && Date.now() - pathStats.mtimeMs <= 60_000) return null;
      try {
        // eslint-disable-next-line no-await-in-loop -- Stale recovery ownership is quarantined before the next exclusive-create attempt.
        await rename(path, `${path}.stale.${randomUUID()}`);
      } catch (renameError) {
        if (errorCode(renameError) !== "ENOENT") throw renameError;
      }
    }
  }
  return null;
}
