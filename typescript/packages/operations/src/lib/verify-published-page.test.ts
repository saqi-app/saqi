import { expect, test, vi } from "vitest";

import { PublicationSnapshotSchema } from "../../../site/src/lib/publication-snapshot";
import { parseCloudflareEnv } from "./parse-cloudflare-env";
import { verifyPublishedPage } from "./verify-published-page";

const EXPECTED = "https://saqi.app/poet/old/poem/first-line-0123456789abcdef";
function publication() {
  return {
    authorSlug: "poet-old",
    canonicalAuthorSlug: "old",
    canonicalPoemSlug: "first-line-0123456789abcdef",
    sourceHash: "a".repeat(64),
    publicationSourceHash: "a".repeat(64),
    publicationHash: "b".repeat(64),
    cacheDirty: 0,
    snapshot: PublicationSnapshotSchema.parse({
      schemaVersion: 2,
      active: true,
      fields: {
        linesEnglish: ["Bread & wine"],
        wordGlosses: {
          sourceHash: "a".repeat(64),
          model: "gpt-6.1-sol",
          meanings: {
            tokenizerVersion: "saqi-orthographic-v1",
            lines: [
              {
                lineIndex: 0,
                segments: [
                  {
                    kind: "word",
                    surface: "بيت",
                    tokenIndex: 0,
                    meaning: 'bread "loaf"',
                  },
                ],
              },
            ],
          },
        },
      },
    }),
  };
}
function environment(html: string, redirect = true) {
  const responses = [
    ...(redirect
      ? [new Response(null, { status: 308, headers: { location: EXPECTED } })]
      : []),
    new Response(html),
  ];
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch");
    return response;
  });
  return {
    fetch,
    env: parseCloudflareEnv({
      DB: { prepare: vi.fn() },
      PUBLIC_SITE: { fetch },
      SAQI_SOURCE_NAME: "fixture",
      SAQI_SOURCE_BASE_URL: "https://poetry.example",
    }),
  };
}
test.each(["correct", "missing", "wrong"])(
  "both content assertions require independently correct canonical metadata (%s)",
  async (canonical) => {
    const link =
      canonical === "missing"
        ? ""
        : `<link rel="canonical" href="${canonical === "correct" ? EXPECTED : "https://saqi.app/poet/other/poem/wrong"}">`;
    const { env, fetch } = environment(
      `<head>${link}</head><p>Bread &amp; wine</p><span data-meaning="bread &quot;loaf&quot;">بيت</span>`
    );
    const result = await verifyPublishedPage(publication(), "uuid", env);
    expect(result).toMatchObject({
      url: "https://saqi.app/poet/poet-old/poem/uuid",
      resolvedUrl: EXPECTED,
      expectedUrl: EXPECTED,
      status: 200,
      canonicalMatches: canonical === "correct",
      translationMatches: canonical === "correct",
      wordMeaningsMatch: canonical === "correct",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://saqi.app/poet/old/poem/uuid",
      expect.objectContaining({ redirect: "manual" })
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);
test("fresh text at a successful historical URL cannot hide a missing canonical redirect", async () => {
  const { env, fetch } = environment(
    `<link rel="canonical" href="${EXPECTED}"><p>Bread &amp; wine</p>`,
    false
  );
  await expect(
    verifyPublishedPage(publication(), "uuid", env)
  ).resolves.toEqual({
    url: "https://saqi.app/poet/poet-old/poem/uuid",
    error: "PUBLIC_PAGE_UNAVAILABLE",
  });
  expect(fetch).toHaveBeenCalledOnce();
});

test("a retired source author namespace cannot hide a valid current publication", async () => {
  const { env, fetch } = environment(
    `<head><link rel="canonical" href="${EXPECTED}"></head><p>Bread &amp; wine</p><span data-meaning="bread &quot;loaf&quot;">بيت</span>`
  );
  const data = { ...publication(), authorSlug: "retired-source-token" };
  await expect(verifyPublishedPage(data, "uuid", env)).resolves.toMatchObject({
    url: "https://saqi.app/poet/retired-source-token/poem/uuid",
    checkedUrl: "https://saqi.app/poet/old/poem/uuid",
    resolvedUrl: EXPECTED,
    status: 200,
    canonicalMatches: true,
    translationMatches: true,
    wordMeaningsMatch: true,
  });
  expect(fetch.mock.calls).toHaveLength(2);
});

test.each([true, false])(
  "verifies normalized model-track word meanings, present=%s",
  async (present) => {
    const data = publication();
    const meanings = data.snapshot.fields.wordGlosses?.meanings;
    delete data.snapshot.fields.wordGlosses;
    data.snapshot.fields.modelEnrichments = [
      {
        modelKey: "sol-6.1",
        model: "gpt-6.1-sol",
        reasoningEffort: "xhigh",
        lines: ["Bread & wine"],
        wordGlosses: meanings,
      },
    ];
    const { env } = environment(
      `<head><link rel="canonical" href="${EXPECTED}"></head><p>Bread &amp; wine</p>${present ? "<span>bread &quot;loaf&quot;</span>" : ""}`
    );
    await expect(verifyPublishedPage(data, "uuid", env)).resolves.toMatchObject(
      {
        status: 200,
        canonicalMatches: true,
        translationMatches: true,
        wordMeaningsMatch: present,
      }
    );
  }
);
