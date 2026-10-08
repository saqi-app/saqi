import { hash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  arabicWords,
  canonicalJson,
  wordGlossesFromMeanings,
} from "@saqi/precedent-iso";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import fixture from "./fixtures/aisha-birth-publication.json";

const DIRECTORY = fileURLToPath(
  new URL("../../../migrations/", import.meta.url)
);
const MIGRATION = "0097_correct_aisha_birth_transcription.sql";
const SQL = readFileSync(join(DIRECTORY, MIGRATION), "utf8");
const POEM_ID = "42abb5a1-df0d-47b0-bcb7-c8cdde33ae81";
const AUTHOR_ID = "00000000-0000-4000-8000-000000000001";
const DATABASES: Database.Database[] = [];

afterEach(() => {
  for (const database of DATABASES) database.close();
  DATABASES.length = 0;
});

function setup() {
  const database = new Database(":memory:");
  DATABASES.push(database);
  for (const name of readdirSync(DIRECTORY)
    .filter(
      (fileName) => /^\d{4}_.+\.sql$/u.test(fileName) && fileName < MIGRATION
    )
    .toSorted())
    database.exec(readFileSync(join(DIRECTORY, name), "utf8"));
  database
    .prepare(
      "INSERT INTO author(id,slug,name_arabic,source_author_id) VALUES (?, 'poet-Aisha-Taymur', 'عائشة تيمور', 'aisha')"
    )
    .run(AUTHOR_ID);
  database
    .prepare(
      `INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,source_poem_id,source_hash,publication_json,publication_hash,publication_source_hash,rig_status,rig_version,publication_cache_dirty)
    VALUES (?,?,'birth',4,?,?,'aisha-birth',?,?,?,?,'complete',4,0)`
    )
    .run(
      POEM_ID,
      AUTHOR_ID,
      fixture.source.titleArabic,
      JSON.stringify(fixture.source),
      fixture.sourceHash,
      JSON.stringify(fixture.snapshot),
      fixture.publicationHash,
      fixture.sourceHash
    );
  return database;
}

function row(database: Database.Database) {
  return database
    .prepare(
      "SELECT content_arabic AS contentArabic,source_hash AS sourceHash,publication_json AS publicationJson,publication_hash AS publicationHash,publication_source_hash AS publicationSourceHash,rig_status AS rigStatus,rig_version AS rigVersion,rig_checkpoint_json AS rigCheckpointJson,publication_cache_dirty AS cacheDirty FROM poem WHERE id=?"
    )
    .get(POEM_ID) as {
    contentArabic: string;
    sourceHash: string;
    publicationJson: string;
    publicationHash: string;
    publicationSourceHash: string;
    rigStatus: string;
    rigVersion: number;
    rigCheckpointJson: string;
    cacheDirty: number;
  };
}

describe("Aisha birth transcription correction", () => {
  it("repairs the source and stages aligned paid output while preserving the existing snapshot", () => {
    const database = setup();
    const before = row(database);
    expect(hash("sha256", canonicalJson(fixture.source))).toBe(
      fixture.sourceHash
    );
    expect(hash("sha256", JSON.stringify(fixture.snapshot))).toBe(
      fixture.publicationHash
    );
    database.exec(SQL);
    const after = row(database);
    const source = JSON.parse(after.contentArabic) as typeof fixture.source;
    const checkpoint = JSON.parse(after.rigCheckpointJson) as {
      phase: string;
      sourceHash: string;
      model: string;
      reasoningEffort: string;
      outputs: {
        generation: {
          translation: { lines: string[] };
          wordMeanings: string[][];
        };
      };
    };
    const output = checkpoint.outputs.generation;
    expect(after.sourceHash).toBe(hash("sha256", canonicalJson(source)));
    expect(checkpoint.sourceHash).toBe(after.sourceHash);
    expect(checkpoint.phase).toBe("publish");
    expect(checkpoint.model).toBe("gpt-6.1-sol");
    expect(checkpoint.reasoningEffort).toBe("xhigh");
    expect(after.rigStatus).toBe("blocked");
    expect(after.rigVersion).toBe(5);
    expect(after.cacheDirty).toBe(1);
    expect(after.publicationJson).toBe(before.publicationJson);
    expect(after.publicationHash).toBe(before.publicationHash);
    expect(after.publicationSourceHash).toBe(before.publicationSourceHash);
    expect(output.translation.lines).toHaveLength(8);
    expect(output.wordMeanings).toHaveLength(8);
    for (const index of [0, 2, 3, 5, 7]) {
      expect(source.content[index]).toBe(fixture.source.content[index]);
      expect(output.translation.lines[index]).toBe(
        fixture.snapshot.fields.modelEnrichments[0]?.lines[index]
      );
      expect(output.wordMeanings[index]).toEqual(
        fixture.snapshot.fields.wordGlosses.meanings.lines[index]?.segments
          .filter((segment) => segment.kind === "word")
          .map((segment) =>
            "meaning" in segment ? segment.meaning : undefined
          )
      );
    }
    for (const [index, line] of source.content.entries())
      expect(output.wordMeanings[index]).toHaveLength(arabicWords(line).length);
    expect(source.content[1]).toContain("بِسمي");
    expect(source.content[4]).toContain("بمنبتها");
    expect(source.content[6]).toContain("ميامن");
    expect(output.translation.lines[1]).toContain("namesake");
    expect(output.translation.lines[4]).toContain("where they grew");
    expect(output.translation.lines[6]).toContain("auspicious signs");
    const glosses = wordGlossesFromMeanings(
      source.content,
      output.wordMeanings
    );
    expect(
      glosses.lines[6]?.segments.filter((segment) => segment.kind === "word")
    ).toHaveLength(5);
    expect(glosses.lines[6]?.segments).toContainEqual({
      kind: "word",
      surface: "ميامن",
      meaning: "the auspicious signs of",
      tokenIndex: 1,
    });
    const once = row(database);
    database.exec(SQL);
    expect(row(database)).toEqual(once);
  });

  it.each([
    ["changed version", "rig_version=6"],
    ["in-flight work", "rig_status='dispatching'"],
    ["leased work", "rig_lease_token='00000000-0000-4000-8000-000000000002'"],
    ["existing checkpoint", "rig_checkpoint_json='{}'"],
    ["changed source", "source_hash='changed'"],
    ["changed publication source", "publication_source_hash='changed'"],
    ["changed publication", "publication_hash='changed'"],
    ["changed title", "name_arabic='changed'"],
    [
      "changed Arabic",
      "content_arabic=json_set(content_arabic,'$.content[0]','changed')",
    ],
    [
      "inactive snapshot",
      "publication_json=json_set(publication_json,'$.active',json('false'))",
    ],
    [
      "changed translation",
      "publication_json=json_set(publication_json,'$.fields.modelEnrichments[0]?.lines[1]','changed')",
    ],
    [
      "changed model",
      "publication_json=json_set(publication_json,'$.fields.modelEnrichments[0].model','changed')",
    ],
    [
      "changed gloss source",
      "publication_json=json_set(publication_json,'$.fields.wordGlosses.sourceHash','changed')",
    ],
  ])("preserves %s", (_label, mutation) => {
    const database = setup();
    database.exec(`UPDATE poem SET ${mutation} WHERE id='${POEM_ID}'`);
    const before = row(database);
    database.exec(SQL);
    expect(row(database)).toEqual(before);
  });
});
