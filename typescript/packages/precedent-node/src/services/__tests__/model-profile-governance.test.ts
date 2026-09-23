import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVED_ENRICHMENT_PROFILES,
  ENRICHMENT_OUTPUT_V3_SCHEMA_VERSION,
} from "@saqi/precedent-iso";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../../app/migrations/", import.meta.url),
);
const MIGRATIONS = readdirSync(MIGRATIONS_DIRECTORY)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .toSorted();
const HASH = "a".repeat(64);

describe("model profile and legacy attribution governance", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const database of databases) database.close();
    databases.length = 0;
  });

  const open = (): Database.Database => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS) {
      database.exec(
        readFileSync(join(MIGRATIONS_DIRECTORY, migration), "utf8"),
      );
    }
    databases.push(database);
    return database;
  };

  it("adds the medium recipe without rewriting historical Sol provenance", () => {
    const database = open();
    expect(
      database
        .prepare(
          `SELECT prompt_version, reasoning_effort,
        input_schema_version, output_schema_version FROM enrichment_profile
        WHERE public_track_key = 'sol-5.6'
        ORDER BY prompt_version, output_schema_version, input_schema_version`,
        )
        .all(),
    ).toEqual(
      [
        ["sol-enrichment-v1", "high", 1],
        ["sol-word-gloss-v2", "high", 2],
        ["sol-word-gloss-v3", "medium", 2],
        ["sol-word-gloss-v3", "medium", 3],
      ].flatMap(([promptVersion, reasoningEffort, outputSchemaVersion]) =>
        [1, 2].map((inputSchemaVersion) => ({
          input_schema_version: inputSchemaVersion,
          output_schema_version: outputSchemaVersion,
          prompt_version: promptVersion,
          reasoning_effort: reasoningEffort,
        })),
      ),
    );
  });

  it("admits complete v3 artifacts through one exact immutable profile", () => {
    const database = open();
    const revisionId = insertRevisionFixture(database);
    const profile = database
      .prepare(
        `SELECT profile_key, public_track_key, model_key, backend_key,
           runtime_model_id, prompt_version, reasoning_effort,
           input_schema_version, output_schema_version, created_at
         FROM enrichment_profile
         WHERE public_track_key = 'sol-5.6'
           AND prompt_version = 'sol-word-gloss-v3'
           AND reasoning_effort = 'medium'
           AND input_schema_version = 2
           AND output_schema_version = 3`,
      )
      .all() as ProfileRow[];
    expect(profile).toHaveLength(1);

    const payload = JSON.stringify({
      insights: {
        culturalSignificance: "A source-grounded cultural note.",
        historicalContext: "Insufficient source evidence for a precise date.",
        literaryDevices: ["A concise image."],
        notableLines: [
          { explanation: "The image anchors the poem.", line: "بيت" },
        ],
        summary: "A concise source-grounded summary.",
        themes: ["Memory"],
      },
      schemaId: "saqi.poem-enrichment-output",
      schemaVersion: 3,
      translation: { lines: ["A verse"] },
      wordGlosses: {
        lines: [
          {
            lineIndex: 0,
            segments: [
              { kind: "word", meaning: "verse", surface: "بيت", tokenIndex: 0 },
            ],
          },
        ],
        tokenizerVersion: "saqi-orthographic-v1",
      },
    });
    insertArtifact(
      database,
      revisionId,
      "artifact-v3",
      "task-v3",
      profile[0],
      payload,
    );
    expect(
      database
        .prepare(
          `SELECT profile_key FROM model_enrichment_artifact_profile
           WHERE artifact_id = 'artifact-v3'`,
        )
        .pluck()
        .get(),
    ).toBe("sol-5.6/word-gloss-v3-output-v3/source-v2");

    expect(() =>
      insertArtifact(
        database,
        revisionId,
        "artifact-v3-as-v2",
        "task-v3-as-v2",
        { ...profile[0], output_schema_version: 2 },
      ),
    ).toThrow();
  });

  it.each([1, 2])(
    "keeps input schema %i aligned with the D1 profile registry",
    (inputSchemaVersion) => {
      const database = open();
      const applicationProfile = APPROVED_ENRICHMENT_PROFILES[0];
      expect(
        database
          .prepare(
            `SELECT count(*) FROM enrichment_profile
             WHERE public_track_key = ? AND model_key = ?
               AND backend_key = ? AND runtime_model_id = ?
               AND prompt_version = ? AND reasoning_effort = ?
               AND input_schema_version = ? AND output_schema_version = ?`,
          )
          .pluck()
          .get(
            applicationProfile.modelKey,
            applicationProfile.model,
            applicationProfile.backendKey,
            applicationProfile.model,
            applicationProfile.promptVersion,
            applicationProfile.reasoningEffort,
            inputSchemaVersion,
            ENRICHMENT_OUTPUT_V3_SCHEMA_VERSION,
          ),
      ).toBe(1);
    },
  );

  it("protects the writer-fence root from skips, anonymous owners, time travel, and deletion", () => {
    const database = open();
    const initialUpdatedAt = database
      .prepare(
        "SELECT updated_at FROM scraper_writer_control WHERE singleton = 1",
      )
      .pluck()
      .get() as number;

    expect(() =>
      database
        .prepare(
          `UPDATE scraper_writer_control
           SET writer_epoch = 3, writer_id = 'skipped', updated_at = ?
           WHERE singleton = 1`,
        )
        .run(initialUpdatedAt + 1),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `UPDATE scraper_writer_control
           SET writer_epoch = 2, writer_id = '', updated_at = ?
           WHERE singleton = 1`,
        )
        .run(initialUpdatedAt + 1),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `UPDATE scraper_writer_control
           SET writer_epoch = 2, writer_id = 'next', updated_at = ?
           WHERE singleton = 1`,
        )
        .run(initialUpdatedAt - 1),
    ).toThrow();
    expect(() =>
      database
        .prepare("DELETE FROM scraper_writer_control WHERE singleton = 1")
        .run(),
    ).toThrow();

    expect(() =>
      database
        .prepare(
          `UPDATE scraper_writer_control
           SET writer_epoch = 2, writer_id = 'next', updated_at = ?
           WHERE singleton = 1`,
        )
        .run(initialUpdatedAt + 1),
    ).not.toThrow();
    expect(
      database
        .prepare(
          "SELECT writer_epoch, writer_id, updated_at FROM scraper_writer_control",
        )
        .get(),
    ).toEqual({
      updated_at: initialUpdatedAt + 1,
      writer_epoch: 2,
      writer_id: "next",
    });
  });

  it("keeps approved model recipes unambiguous and immutable", () => {
    const database = open();
    const profile = requiredProfile(database, "sol-5.6");

    expect(() =>
      database
        .prepare(
          `INSERT INTO enrichment_profile (
             profile_key, public_track_key, model_key, backend_key,
             runtime_model_id, prompt_version, reasoning_effort,
             input_schema_version, output_schema_version, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ambiguous-copy",
          profile.public_track_key,
          profile.model_key,
          profile.backend_key,
          profile.runtime_model_id,
          profile.prompt_version,
          profile.reasoning_effort,
          profile.input_schema_version,
          profile.output_schema_version,
          profile.created_at,
        ),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          "UPDATE enrichment_profile SET created_at = created_at WHERE profile_key = ?",
        )
        .run(profile.profile_key),
    ).toThrow();
    expect(() =>
      database
        .prepare("DELETE FROM enrichment_profile WHERE profile_key = ?")
        .run(profile.profile_key),
    ).toThrow();
  });

  it("rejects profile mismatches while allowing independent model tracks", () => {
    const database = open();
    const revisionId = insertRevisionFixture(database);
    const sol = requiredProfile(database, "sol-5.6");
    const claude = requiredProfile(database, "claude-opus-5");

    expect(() =>
      insertArtifact(
        database,
        revisionId,
        "artifact-mismatch",
        "task-mismatch",
        {
          ...sol,
          public_track_key: claude.public_track_key,
        },
      ),
    ).toThrow(/MODEL_ENRICHMENT_PROFILE_INVALID/u);
    insertArtifact(database, revisionId, "artifact-sol", "task-sol", sol);
    insertArtifact(
      database,
      revisionId,
      "artifact-claude",
      "task-claude",
      claude,
    );
    expect(
      database
        .prepare(
          `SELECT count(DISTINCT artifact.model_key)
           FROM model_enrichment_artifact artifact
           JOIN model_enrichment_artifact_profile binding
             ON binding.artifact_id = artifact.id
           WHERE artifact.source_revision_id = ?`,
        )
        .pluck()
        .get(revisionId),
    ).toBe(2);
    expect(() =>
      database
        .prepare(
          `UPDATE model_enrichment_artifact_profile
           SET profile_key = profile_key WHERE artifact_id = 'artifact-sol'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `DELETE FROM model_enrichment_artifact_profile
           WHERE artifact_id = 'artifact-sol'`,
        )
        .run(),
    ).toThrow();
  });

  it("invalidates legacy attribution by exact payload hash without deleting history", () => {
    const database = open();
    const original = JSON.stringify({ content: ["Legacy translation"] });
    const changed = JSON.stringify({ content: ["Changed translation"] });
    const originalHash = sha256(original);
    const changedHash = sha256(changed);
    const attributionKey = database
      .prepare(
        `SELECT attribution_key FROM legacy_model_attribution
         WHERE certainty = 'inferred_range' ORDER BY attribution_key LIMIT 1`,
      )
      .pluck()
      .get() as string;
    expect(attributionKey).toBeTruthy();

    database
      .prepare(
        `INSERT INTO author(id, slug, name_arabic)
         VALUES ('legacy-author', 'legacy-author', 'شاعر')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO poem(
           id, author_id, slug, verses, name_arabic, content_arabic, translation
         ) VALUES (
           'legacy-poem', 'legacy-author', 'legacy-poem', 1, 'قصيدة',
           '{"content":["بيت"]}', ?
         )`,
      )
      .run(original);
    database
      .prepare(
        `INSERT INTO poem_legacy_payload_attribution (
           poem_id, legacy_field, source_payload_hash, attribution_key,
           attributed_at
         ) VALUES ('legacy-poem', 'translation', ?, ?, 1)`,
      )
      .run(originalHash, attributionKey);

    const lookup = database.prepare(
      `SELECT attribution_key FROM poem_legacy_payload_attribution
       WHERE poem_id = 'legacy-poem' AND legacy_field = 'translation'
         AND source_payload_hash = ?`,
    );
    expect(lookup.pluck().get(originalHash)).toBe(attributionKey);
    database
      .prepare("UPDATE poem SET translation = ? WHERE id = 'legacy-poem'")
      .run(changed);
    expect(lookup.pluck().get(changedHash)).toBeUndefined();
    expect(lookup.pluck().get(originalHash)).toBe(attributionKey);

    expect(() =>
      database
        .prepare(
          `UPDATE poem_legacy_payload_attribution SET attributed_at = 2
           WHERE poem_id = 'legacy-poem'`,
        )
        .run(),
    ).toThrow();
  });
});

interface ProfileRow {
  backend_key: string;
  created_at: number;
  input_schema_version: number;
  model_key: string;
  output_schema_version: number;
  profile_key: string;
  prompt_version: string;
  public_track_key: string;
  reasoning_effort: string;
  runtime_model_id: string;
}

function requiredProfile(
  database: Database.Database,
  publicTrackKey: string,
): ProfileRow {
  const row = database
    .prepare(
      `SELECT profile_key, public_track_key, model_key, backend_key,
         runtime_model_id, prompt_version, reasoning_effort,
         input_schema_version, output_schema_version, created_at
       FROM enrichment_profile WHERE public_track_key = ?`,
    )
    .get(publicTrackKey) as ProfileRow | undefined;
  if (!row) throw new Error(`Missing profile fixture: ${publicTrackKey}`);
  return row;
}

function insertRevisionFixture(database: Database.Database): string {
  const document = JSON.stringify({ content: ["بيت"], titleArabic: "قصيدة" });
  database
    .prepare(
      "INSERT INTO author(id, slug, name_arabic) VALUES ('author', 'author', 'شاعر')",
    )
    .run();
  database
    .prepare(
      `INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic)
       VALUES ('poem', 'author', 'poem', 1, 'قصيدة', ?)`,
    )
    .run(document);
  database
    .prepare(
      `INSERT INTO crawl_import_bundle (
         id, schema_version, manifest_hash, expected_record_count, status,
         writer_epoch, created_at
       ) VALUES ('bundle', 2, ?, 1, 'open', 1, 1)`,
    )
    .run("b".repeat(64));
  database
    .prepare(
      `INSERT INTO crawl_import_record (
         bundle_id, ordinal, record_hash, source_name, source_author_id,
         source_author_url, author_name_arabic, canonical_author_id,
         source_poem_id, source_poem_url, canonical_poem_id, title_arabic,
         content_arabic, content_hash, observed_at
       ) VALUES (
         'bundle', 0, ?, 'source', 'author-source', 'https://example.test/a',
         'شاعر', 'author', 'poem-source', 'https://example.test/p', 'poem',
         'قصيدة', ?, ?, 1
       )`,
    )
    .run("c".repeat(64), document, HASH);
  database
    .prepare(
      `INSERT INTO source_author_identity (
         id, source_name, external_id, canonical_url, name_arabic,
         canonical_author_id, first_observed_at, last_observed_at
       ) VALUES (
         'source-author', 'source', 'author-source', 'https://example.test/a',
         'شاعر', 'author', 1, 1
       )`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO source_poem_identity (
         id, source_name, external_id, source_author_id, canonical_url,
         canonical_poem_id, first_observed_at, last_observed_at
       ) VALUES (
         'source-poem', 'source', 'poem-source', 'source-author',
         'https://example.test/p', 'poem', 1, 1
       )`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO poem_source_revision (
         id, source_poem_id, schema_version, content_hash, title_arabic,
         content_arabic, observed_at, created_at, import_bundle_id,
         import_ordinal
       ) VALUES (
         'revision', 'source-poem', 2, ?, 'قصيدة', ?, 1, 1, 'bundle', 0
       )`,
    )
    .run(HASH, document);
  database
    .prepare(
      "UPDATE poem SET active_source_revision_id = 'revision' WHERE id = 'poem'",
    )
    .run();
  return "revision";
}

function insertArtifact(
  database: Database.Database,
  revisionId: string,
  artifactId: string,
  taskKey: string,
  profile: ProfileRow,
  payload = "{}",
): void {
  database
    .prepare(
      `INSERT INTO model_enrichment_artifact (
         id, source_revision_id, task_key, variant, schema_version,
         prompt_version, model, model_key, reasoning_effort, payload_hash,
         payload, created_at
       ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      artifactId,
      revisionId,
      taskKey,
      profile.output_schema_version,
      profile.prompt_version,
      profile.runtime_model_id,
      profile.public_track_key,
      profile.reasoning_effort,
      HASH,
      payload,
    );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
