import { describe, expect, it } from "vitest";

import {
  authorInventoryWorkKind,
  certifyAndSeedAuthorInventory,
  scheduledInventoryRefreshGeneration,
} from "../collection/author-inventory-lane";
import { Ledger } from "../persistence/ledger";
import type { AuthorInventoryPageProjection } from "../source-adapter/index.js";

const PAGES: AuthorInventoryPageProjection[] = [
  {
    authors: [
      { href: "/cat-existing", name: "قديم", poemCountText: "2" },
      { href: "/cat-new", name: "جديد", poemCountText: null },
    ],
    challengeDetected: false,
    kind: "author_inventory_page",
    nextPageHref: null,
    page: 1,
    schemaVersion: 1,
    sourceUrl: "/authers-1",
    terminal: true,
  },
];

describe("author inventory discovery lane", () => {
  it("exposes the source-bound discovery kind for health aggregation", () => {
    expect(authorInventoryWorkKind()).toBe("source_author_inventory_discovery");
  });

  it("derives stable bounded generations for recurring discovery windows", () => {
    const configured = "a".repeat(64);
    const first = scheduledInventoryRefreshGeneration(
      configured,
      86_400_000,
      86_400_000,
    );
    expect(first).toHaveLength(64);
    expect(
      scheduledInventoryRefreshGeneration(
        configured,
        86_400_000,
        2 * 86_400_000 - 1,
      ),
    ).toBe(first);
    expect(
      scheduledInventoryRefreshGeneration(
        configured,
        86_400_000,
        2 * 86_400_000,
      ),
    ).not.toBe(first);
    expect(scheduledInventoryRefreshGeneration("manual", null, 0)).toBe(
      "manual",
    );
  });

  it("reconciles a certificate and deduplicates unchanged manifest revisions", async () => {
    const ledger = Ledger.open(":memory:");
    try {
      const first = await certifyAndSeedAuthorInventory({
        firstPass: PAGES,
        ledger,
        productionSourceAuthors: [
          { canonical_url: "https://source.invalid/cat-existing" },
          { canonical_url: "https://source.invalid/cat-missing" },
        ],
        refreshGeneration: "2026-08-25T22.00Z",
        secondPass: PAGES,
      });
      expect(first).toMatchObject({
        alreadySeededManifests: 0,
        baselineAuthors: 2,
        complete: true,
        discoveredAuthors: 2,
        existingAuthors: 1,
        insertedManifests: 2,
        kind: "source_author_inventory_discovery",
        missingBaselineAuthorIds: ["source:author:missing"],
        newAuthorIds: ["source:author:new"],
        pagesPerPass: 1,
        refreshGeneration: "2026-08-25T22.00Z",
      });
      expect(first.certificateDigest).toMatch(/^[a-f\d]{64}$/);
      const claimedNames = new Set<string>();
      const inspectionClaims = [];
      for (let index = 0; index < 2; index += 1) {
        const claim = ledger.claim(
          "inventory-inspection",
          Date.now() + 1_000,
          10_000,
          ["source_author_manifest"],
        );
        if (!claim) throw new Error("manifest claim missing");
        claimedNames.add(String(claim.work.input["authorNameArabic"]));
        inspectionClaims.push(claim);
      }
      for (const claim of inspectionClaims)
        ledger.operatorRelease(claim, "TEST_INSPECTION", Date.now() + 1_000);
      expect(claimedNames).toEqual(new Set(["قديم", "جديد"]));

      const replay = await certifyAndSeedAuthorInventory({
        firstPass: PAGES,
        ledger,
        productionSourceAuthors: [
          { canonical_url: "https://source.invalid/cat-existing" },
          { canonical_url: "https://source.invalid/cat-missing" },
        ],
        refreshGeneration: "2026-08-25T22.00Z",
        secondPass: PAGES,
      });
      expect(replay).toMatchObject({
        alreadySeededManifests: 2,
        insertedManifests: 0,
      });

      const refresh = await certifyAndSeedAuthorInventory({
        firstPass: PAGES,
        ledger,
        productionSourceAuthors: [
          { canonical_url: "https://source.invalid/cat-existing" },
          { canonical_url: "https://source.invalid/cat-missing" },
        ],
        refreshGeneration: "2026-08-26T22.00Z",
        secondPass: PAGES,
      });
      expect(refresh.insertedManifests).toBe(0);
      expect(
        ledger.sourceAuthorMetadata("https://source.invalid/cat-existing"),
      ).toMatchObject({ refreshGeneration: "2026-08-26T22.00Z" });
      expect(ledger.status().kindProgress).toEqual([
        expect.objectContaining({ kind: "source_author_manifest", total: 2 }),
      ]);
    } finally {
      ledger.close();
    }
  });

  it("rejects invalid generations and duplicate production identities before seeding", async () => {
    const ledger = Ledger.open(":memory:");
    try {
      await expect(
        certifyAndSeedAuthorInventory({
          firstPass: PAGES,
          ledger,
          productionSourceAuthors: [],
          refreshGeneration: "bad generation",
          secondPass: PAGES,
        }),
      ).rejects.toThrow();
      await expect(
        certifyAndSeedAuthorInventory({
          firstPass: PAGES,
          ledger,
          productionSourceAuthors: [
            { canonical_url: "https://source.invalid/cat-same" },
            { canonical_url: "https://source.invalid/cat-same" },
          ],
          refreshGeneration: "generation-1",
          secondPass: PAGES,
        }),
      ).rejects.toThrow("SOURCE_PRODUCTION_AUTHOR_DUPLICATE");
      expect(ledger.status().total).toBe(0);
    } finally {
      ledger.close();
    }
  });
});
