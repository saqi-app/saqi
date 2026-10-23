import { expect, test } from "vitest";

import { PublicCachePurgeRequestSchema } from "../public-cache-purge-request-schema";

test.each([
  { authorSlug: "poet", poemId: "poem" },
  { poems: [{ authorSlug: "poet", poemId: "poem" }] },
  { all: true },
  { authorIndex: true },
  { authorIndex: true, bootstrap: true },
  { authorIndex: true, poems: [{ authorSlug: "poet", poemId: "poem" }] },
])("retains compatible cache purge contracts: %j", (body) => {
  expect(PublicCachePurgeRequestSchema.parse(body)).toEqual(body);
});

test.each([
  { authorIndex: false },
  { bootstrap: true },
  { authorIndex: true, bootstrap: false },
  { authorIndex: true, all: true },
  { authorIndex: true, authorSlug: "poet", poemId: "poem" },
  {
    authorIndex: true,
    bootstrap: true,
    poems: [{ authorSlug: "poet", poemId: "poem" }],
  },
])("rejects ambiguous or unsupported cache purge contracts: %j", (body) => {
  expect(PublicCachePurgeRequestSchema.safeParse(body).success).toBe(false);
});

test.each([
  [49, true, true],
  [50, true, false],
  [50, false, true],
] as const)(
  "bounds %i poems with index=%s to at most one hundred tags",
  (count, withIndex, accepted) => {
    const body: {
      poems: { authorSlug: string; poemId: string }[];
      authorIndex?: true;
    } = {
      poems: Array.from({ length: count }, (_, index) => ({
        authorSlug: `poet-${String(index)}`,
        poemId: `p-${String(index)}`,
      })),
    };
    if (withIndex) body.authorIndex = true;
    expect(PublicCachePurgeRequestSchema.safeParse(body).success).toBe(
      accepted
    );
  }
);
