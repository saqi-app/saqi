import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  approvedEnrichmentValidations,
  LEGACY_ENRICHMENT_PROFILES,
  SAQI_PRODUCTION_DATABASE_ID,
} from "@saqi/precedent-iso";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const DIRECTORY = fileURLToPath(
  new URL("../../../../operations/migrations/", import.meta.url),
);
const MIGRATION_LEDGER = `
  CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;
`;
const PRODUCTION_IDENTITY_SOURCES = {
  app: new URL("../../../../operations/wrangler.jsonc", import.meta.url),
  sitePreview: new URL("../../../../site/wrangler.jsonc", import.meta.url),
  siteProduction: new URL(
    "../../../../site/wrangler.production.jsonc",
    import.meta.url,
  ),
} as const;

describe("production migration compatibility", () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases) database.close();
    databases.length = 0;
  });

  const open = (): Database.Database => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(MIGRATION_LEDGER);
    databases.push(database);
    return database;
  };

  it("keeps every deployment binding and SQL sentinel on one database", () => {
    const configuredIds = Object.fromEntries(
      Object.entries(PRODUCTION_IDENTITY_SOURCES).map(([name, url]) => [
        name,
        extractOnlyDatabaseId(readFileSync(url, "utf8")),
      ]),
    );
    expect(configuredIds).toEqual({
      app: SAQI_PRODUCTION_DATABASE_ID,
      sitePreview: SAQI_PRODUCTION_DATABASE_ID,
      siteProduction: SAQI_PRODUCTION_DATABASE_ID,
    });
    expect(
      extractMigrationDatabaseId(
        readFileSync(
          join(DIRECTORY, "0037_retire_legacy_translation_tasks.sql"),
          "utf8",
        ),
      ),
    ).toBe(SAQI_PRODUCTION_DATABASE_ID);
  });

  it("creates the current schema from a fresh bootstrap and replays as a no-op", () => {
    const database = open();
    const first = applyPending(database, migrationFiles());
    expect(first.at(-1)).toBe("0060_restore_catalog_publishability.sql");
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'idx_legacy_attribution_lookup'",
        )
        .get(),
    ).toBeUndefined();
    expectCorpusRevisionSchema(database);
    expectModelPublicationGuards(database);
    expectLegacySolPublicationPrecedence(database);
    expectSourcePointerGuards(database);
    expectCanonicalDataGuards(database);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'source_author_alias'",
        )
        .get(),
    ).toBeUndefined();
    expectModelProfileRegistry(database);
    expectProductionDeploymentIdentity(database);
    expectSlugIndexesReduced(database);
    expectSlugUniqueness(database);
    expectCatalogPublishability(database);
    const before = schemaSnapshot(database);
    expect(applyPending(database, migrationFiles())).toEqual([]);
    expect(schemaSnapshot(database)).toEqual(before);
  });

  it("restores deployed catalog controls on populated databases", () => {
    const database = open();
    applyPending(
      database,
      migrationFiles().filter((name) => name < "0060_"),
    );
    insertProductionRow(database);
    database.exec(
      "CREATE TABLE catalog_unsafe_control (value TEXT PRIMARY KEY)",
    );
    database
      .prepare("INSERT INTO catalog_unsafe_control (value) VALUES (?)")
      .run("\u{202a}");
    const before = database
      .prepare("SELECT publishable FROM poem WHERE id = ?")
      .pluck()
      .get("00000000-0000-4000-8000-000000000002");

    applyPending(database, migrationFiles());
    expect(
      database
        .prepare("SELECT 1 FROM catalog_unsafe_control WHERE value = ?")
        .get("\u{202a}"),
    ).toEqual({ 1: 1 });
    expect(
      database
        .prepare("SELECT publishable FROM poem WHERE id = ?")
        .pluck()
        .get("00000000-0000-4000-8000-000000000002"),
    ).toBe(before);
    expectCatalogPublishability(database);
  });

  it("rejects unexpected deployed controls without applying the migration", () => {
    const database = open();
    applyPending(
      database,
      migrationFiles().filter((name) => name < "0060_"),
    );
    database.exec(
      "CREATE TABLE catalog_unsafe_control (value TEXT PRIMARY KEY)",
    );
    database
      .prepare("INSERT INTO catalog_unsafe_control (value) VALUES (?)")
      .run("x");

    expect(() => applyPending(database, migrationFiles())).toThrow(
      /CHECK constraint failed/u,
    );
    expect(
      database
        .prepare("SELECT 1 FROM d1_migrations WHERE name = ?")
        .get("0060_restore_catalog_publishability.sql"),
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT 1 FROM catalog_unsafe_control WHERE value = ?")
        .get("x"),
    ).toBeDefined();
  });

  it("backfills current revisions and tracks writes from older Workers", () => {
    const database = open();
    applyPending(
      database,
      migrationFiles().filter((name) => name < "0051_"),
    );
    insertProductionRow(database);
    const hash = "a".repeat(64);
    database
      .prepare(
        `INSERT INTO crawl_import_bundle (
           id, schema_version, manifest_hash, expected_record_count, status,
           writer_epoch, created_at
         ) VALUES ('pointer-bundle', 1, ?, 1, 'open', 1, 1)`,
      )
      .run(hash);
    database
      .prepare(
        `INSERT INTO crawl_import_record (
           bundle_id, ordinal, record_hash, source_name, source_author_id,
           source_author_url, author_name_arabic, canonical_author_id,
           source_poem_id, source_poem_url, canonical_poem_id, title_arabic,
           content_arabic, content_hash, observed_at
         ) VALUES ('pointer-bundle', 0, ?, 'source', 'author',
           'https://example.test/author', 'شاعر', ?, 'poem-42',
           'https://example.test/poem', ?, 'قصيدة',
           '{"content":["صدر","عجز"]}', ?, 1)`,
      )
      .run(
        hash,
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        hash,
      );
    database.exec(`
      INSERT INTO source_author_identity VALUES (
        'pointer-author', 'source', 'author',
        'https://example.test/author', 'شاعر',
        '00000000-0000-4000-8000-000000000001', 1, 1
      );
      INSERT INTO source_poem_identity VALUES (
        'pointer-poem', 'source', 'poem-42', 'pointer-author',
        'https://example.test/poem',
        '00000000-0000-4000-8000-000000000002', 1, 1, NULL
      );
    `);
    database
      .prepare(
        `INSERT INTO poem_source_revision (
           id, source_poem_id, schema_version, content_hash, title_arabic,
           content_arabic, observed_at, created_at, import_bundle_id,
           import_ordinal
         ) VALUES ('pointer-revision', 'pointer-poem', 1, ?, 'قصيدة',
           '{"content":["صدر","عجز"]}', 1, 1, 'pointer-bundle', 0)`,
      )
      .run(hash);
    database.exec(`
      INSERT INTO poem_source_pointer VALUES (
        'pointer-poem', 'pointer-revision', 1, 1, 1
      );
    `);

    expect(
      applyPending(
        database,
        migrationFiles().filter((name) => name < "0052_"),
      ),
    ).toEqual(["0051_expand_source_revision_pointer.sql"]);
    const current = () =>
      database
        .prepare(
          `SELECT current_revision_id AS currentRevisionId,
                  current_revision_version AS currentRevisionVersion,
                  current_revision_writer_epoch AS currentRevisionWriterEpoch,
                  current_revision_updated_at AS currentRevisionUpdatedAt
             FROM source_poem_identity WHERE id = 'pointer-poem'`,
        )
        .get();
    expect(current()).toEqual({
      currentRevisionId: "pointer-revision",
      currentRevisionVersion: 1,
      currentRevisionWriterEpoch: 1,
      currentRevisionUpdatedAt: 1,
    });
    database.exec(`
      UPDATE poem_source_pointer SET pointer_version = 2, updated_at = 2
      WHERE source_poem_id = 'pointer-poem';
    `);
    expect(current()).toEqual({
      currentRevisionId: "pointer-revision",
      currentRevisionVersion: 2,
      currentRevisionWriterEpoch: 1,
      currentRevisionUpdatedAt: 2,
    });
    expect(() =>
      database.exec(`
        UPDATE source_poem_identity SET current_revision_version = 3
        WHERE id = 'pointer-poem';
      `),
    ).toThrow("SOURCE_CURRENT_REVISION_MISMATCH");
    expect(
      applyPending(
        database,
        migrationFiles().filter((name) => name < "0059_"),
      ),
    ).toEqual([
      "0052_guard_legacy_enrichment_contract.sql",
      "0053_retire_legacy_sol_translation_column.sql",
      "0054_retire_legacy_sol_insights_column.sql",
      "0055_retire_legacy_enrichment_tables.sql",
      "0056_stage_database_identity.sql",
      "0057_retire_production_deployment_identity.sql",
      "0058_source_revision_writer_cutover.sql",
    ]);
    database.exec(`
      UPDATE source_poem_identity
      SET current_revision_version = 3, current_revision_updated_at = 3
      WHERE id = 'pointer-poem';
    `);
    expect(
      database
        .prepare(
          `SELECT pointer_version AS pointerVersion, updated_at AS updatedAt
             FROM poem_source_pointer WHERE source_poem_id = 'pointer-poem'`,
        )
        .get(),
    ).toEqual({ pointerVersion: 3, updatedAt: 3 });
    database.exec(`
      UPDATE scraper_writer_control
      SET writer_epoch = 2, writer_id = 'next-writer',
          updated_at = updated_at + 1
      WHERE singleton = 1;
      UPDATE poem_source_pointer
      SET pointer_version = 4, writer_epoch = 2, updated_at = 4
      WHERE source_poem_id = 'pointer-poem';
    `);
    expect(current()).toEqual({
      currentRevisionId: "pointer-revision",
      currentRevisionVersion: 4,
      currentRevisionWriterEpoch: 2,
      currentRevisionUpdatedAt: 4,
    });
    database.exec(`
      UPDATE source_poem_identity
      SET current_revision_version = 5, current_revision_updated_at = 5
      WHERE id = 'pointer-poem';
    `);
    expect(
      database
        .prepare(
          `SELECT pointer_version AS pointerVersion,
                  writer_epoch AS writerEpoch, updated_at AS updatedAt
             FROM poem_source_pointer WHERE source_poem_id = 'pointer-poem'`,
        )
        .get(),
    ).toEqual({ pointerVersion: 5, writerEpoch: 2, updatedAt: 5 });
    expect(() =>
      database.exec(`
        UPDATE source_poem_identity
        SET current_revision_version = 6, current_revision_updated_at = 6,
            current_revision_writer_epoch = 1
        WHERE id = 'pointer-poem';
      `),
    ).toThrow("SOURCE_CURRENT_REVISION_TRANSITION_INVALID");
    database.exec(`
      SAVEPOINT source_pointer_drift;
      DROP TRIGGER poem_source_pointer_sync_update;
      UPDATE poem_source_pointer
      SET pointer_version = 6, updated_at = 6
      WHERE source_poem_id = 'pointer-poem';
    `);
    expect(() => applyPending(database, migrationFiles())).toThrow();
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'poem_source_pointer'",
        )
        .get(),
    ).toBeDefined();
    database.exec(
      "ROLLBACK TO source_pointer_drift; RELEASE source_pointer_drift",
    );
    expect(applyPending(database, migrationFiles())).toEqual([
      "0059_retire_source_revision_pointer.sql",
      "0060_restore_catalog_publishability.sql",
    ]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'poem_source_pointer'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE sql LIKE '%poem_source_pointer%'",
        )
        .all(),
    ).toEqual([]);
    database.exec(`
      UPDATE source_poem_identity
      SET current_revision_version = 6, current_revision_updated_at = 6
      WHERE id = 'pointer-poem';
    `);
    expect(current()).toMatchObject({ currentRevisionVersion: 6 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("folds production identity without disturbing an active writer epoch", () => {
    const database = open();
    applyPending(
      database,
      migrationFiles().filter((name) => name < "0056_"),
    );
    database.exec(`
      UPDATE scraper_writer_control
      SET writer_epoch = 2, writer_id = 'active-rig',
          updated_at = updated_at + 1
      WHERE singleton = 1;
    `);
    expect(
      applyPending(
        database,
        migrationFiles().filter((name) => name < "0057_"),
      ),
    ).toEqual(["0056_stage_database_identity.sql"]);
    expect(
      database
        .prepare(
          `SELECT writer_epoch AS writerEpoch, writer_id AS writerId,
                  database_id AS databaseId
             FROM scraper_writer_control WHERE singleton = 1`,
        )
        .get(),
    ).toEqual({
      writerEpoch: 2,
      writerId: "active-rig",
      databaseId: SAQI_PRODUCTION_DATABASE_ID,
    });
    database.exec(`
      UPDATE scraper_writer_control
      SET writer_epoch = 3, writer_id = 'next-rig',
          updated_at = updated_at + 1
      WHERE singleton = 1;
    `);
    expect(
      database
        .prepare(
          `SELECT database_id AS databaseId
             FROM production_deployment_identity WHERE scope = 'production'`,
        )
        .get(),
    ).toEqual({ databaseId: SAQI_PRODUCTION_DATABASE_ID });
    database.exec(`
      SAVEPOINT identity_drift;
      DROP TRIGGER production_deployment_identity_update_guard;
      UPDATE production_deployment_identity
      SET database_id = '11111111-1111-4111-8111-111111111111'
      WHERE scope = 'production';
    `);
    expect(() => applyPending(database, migrationFiles())).toThrow();
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'production_deployment_identity'",
        )
        .get(),
    ).toBeDefined();
    database.exec("ROLLBACK TO identity_drift; RELEASE identity_drift");
    expect(applyPending(database, migrationFiles())).toEqual([
      "0057_retire_production_deployment_identity.sql",
      "0058_source_revision_writer_cutover.sql",
      "0059_retire_source_revision_pointer.sql",
      "0060_restore_catalog_publishability.sql",
    ]);
    expectProductionDeploymentIdentity(database);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("refuses to fold an unexpected production database identity", () => {
    const database = open();
    applyPending(
      database,
      migrationFiles().filter((name) => name < "0056_"),
    );
    database.exec(`
      UPDATE production_deployment_identity
      SET database_id = '11111111-1111-4111-8111-111111111111'
      WHERE scope = 'production';
    `);
    expect(() => applyPending(database, migrationFiles())).toThrow();
    expect(
      database
        .prepare(
          `SELECT 1 FROM sqlite_schema
            WHERE type = 'table' AND name = 'production_deployment_identity'`,
        )
        .get(),
    ).toBeDefined();
    expect(
      database
        .prepare("PRAGMA table_info(scraper_writer_control)")
        .all()
        .some((row) => (row as { name: string }).name === "database_id"),
    ).toBe(false);
  });

  it("folds dimension metadata without changing published model labels", () => {
    const database = open();
    const files = migrationFiles();
    applyPending(
      database,
      files.filter((name) => name < "0049_"),
    );
    const before = database
      .prepare(
        `SELECT profile.profile_key AS profileKey,
                profile.model_key AS modelKey,
                profile.backend_key AS backendKey,
                vendor.vendor_key AS vendorKey,
                vendor.display_name AS vendorName,
                vendor.created_at AS vendorCreatedAt,
                model.family_key AS modelFamilyKey,
                model.version_label AS modelVersionLabel,
                model.display_name AS modelName,
                model.created_at AS modelCreatedAt,
                backend.display_name AS backendName,
                backend.created_at AS backendCreatedAt
           FROM enrichment_profile profile
           JOIN ai_model model ON model.model_key = profile.model_key
           JOIN ai_vendor vendor ON vendor.vendor_key = model.vendor_key
           JOIN inference_backend backend
             ON backend.backend_key = profile.backend_key
          ORDER BY profile.profile_key`,
      )
      .all();
    expect(before).toHaveLength(18);

    expect(applyPending(database, files)).toEqual([
      "0049_fold_enrichment_dimensions.sql",
      "0050_copy_legacy_enrichment.sql",
      "0051_expand_source_revision_pointer.sql",
      "0052_guard_legacy_enrichment_contract.sql",
      "0053_retire_legacy_sol_translation_column.sql",
      "0054_retire_legacy_sol_insights_column.sql",
      "0055_retire_legacy_enrichment_tables.sql",
      "0056_stage_database_identity.sql",
      "0057_retire_production_deployment_identity.sql",
      "0058_source_revision_writer_cutover.sql",
      "0059_retire_source_revision_pointer.sql",
      "0060_restore_catalog_publishability.sql",
    ]);
    expect(
      database
        .prepare(
          `SELECT profile_key AS profileKey, model_key AS modelKey,
                  backend_key AS backendKey, vendor_key AS vendorKey,
                  vendor_display_name AS vendorName,
                  vendor_created_at AS vendorCreatedAt,
                  model_family_key AS modelFamilyKey,
                  model_version_label AS modelVersionLabel,
                  model_display_name AS modelName,
                  model_created_at AS modelCreatedAt,
                  backend_display_name AS backendName,
                  backend_created_at AS backendCreatedAt
             FROM enrichment_profile ORDER BY profile_key`,
        )
        .all(),
    ).toEqual(before);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("retires unreferenced dimension rows without touching profiles", () => {
    const database = open();
    const files = migrationFiles();
    applyPending(
      database,
      files.filter((name) => name < "0049_"),
    );
    database
      .prepare(
        `INSERT INTO inference_backend (backend_key, display_name, created_at)
         VALUES ('unreferenced-backend', 'Unused Backend', 1)`,
      )
      .run();

    const profilesBefore = database
      .prepare(
        "SELECT profile_key FROM enrichment_profile ORDER BY profile_key",
      )
      .pluck()
      .all();
    expect(applyPending(database, files)).toEqual([
      "0049_fold_enrichment_dimensions.sql",
      "0050_copy_legacy_enrichment.sql",
      "0051_expand_source_revision_pointer.sql",
      "0052_guard_legacy_enrichment_contract.sql",
      "0053_retire_legacy_sol_translation_column.sql",
      "0054_retire_legacy_sol_insights_column.sql",
      "0055_retire_legacy_enrichment_tables.sql",
      "0056_stage_database_identity.sql",
      "0057_retire_production_deployment_identity.sql",
      "0058_source_revision_writer_cutover.sql",
      "0059_retire_source_revision_pointer.sql",
      "0060_restore_catalog_publishability.sql",
    ]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'inference_backend'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT profile_key FROM enrichment_profile ORDER BY profile_key",
        )
        .pluck()
        .all(),
    ).toEqual(profilesBefore);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("moves published legacy Sol content and validation into model tables", () => {
    const database = open();
    applyPending(
      database,
      migrationFiles().filter((name) => name < "0050_"),
    );
    const hash = "a".repeat(64);
    insertProductionRow(database);
    database
      .prepare(
        `INSERT INTO crawl_import_bundle (
          id, schema_version, manifest_hash, expected_record_count, status,
          writer_epoch, created_at
        ) VALUES ('legacy-bundle', 1, ?, 1, 'open', 1, 1)`,
      )
      .run(hash);
    database
      .prepare(
        `INSERT INTO crawl_import_record (
          bundle_id, ordinal, record_hash, source_name, source_author_id,
          source_author_url, author_name_arabic, canonical_author_id,
          source_poem_id, source_poem_url, canonical_poem_id, title_arabic,
          content_arabic, content_hash, observed_at
        ) VALUES ('legacy-bundle', 0, ?, 'source', 'author',
          'https://example.test/author', 'شاعر', ?, 'poem-42',
          'https://example.test/poem', ?, 'قصيدة',
          '{"content":["صدر","عجز"]}', ?, 1)`,
      )
      .run(
        hash,
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        hash,
      );
    database.exec(`
      INSERT INTO source_author_identity VALUES (
        'legacy-author', 'source', 'author', 'https://example.test/author',
        'شاعر', '00000000-0000-4000-8000-000000000001', 1, 1
      );
      INSERT INTO source_poem_identity VALUES (
        'legacy-poem', 'source', 'poem-42', 'legacy-author',
        'https://example.test/poem',
        '00000000-0000-4000-8000-000000000002', 1, 1, NULL
      );
    `);
    database
      .prepare(
        `INSERT INTO poem_source_revision (
          id, source_poem_id, schema_version, content_hash, title_arabic,
          content_arabic, observed_at, created_at, import_bundle_id,
          import_ordinal
        ) VALUES ('legacy-revision', 'legacy-poem', 1, ?, 'قصيدة',
          '{"content":["صدر","عجز"]}', 1, 1, 'legacy-bundle', 0)`,
      )
      .run(hash);
    const payload = JSON.stringify({
      translation: { lines: ["First line", "Second line"] },
      insights: {
        summary: "A reading.",
        themes: ["Memory"],
        historicalContext: "An era.",
        literaryDevices: ["Image"],
        culturalSignificance: "A custom.",
        notableLines: [{ line: "صدر", explanation: "An image." }],
      },
    });
    database
      .prepare(
        `INSERT INTO enrichment_artifact (
          id, source_revision_id, task_key, variant, schema_version,
          prompt_version, model, reasoning_effort, payload_hash, payload,
          created_at
        ) VALUES ('legacy-artifact', 'legacy-revision', 'legacy-task', 0,
          1, 'sol-enrichment-v1', 'gpt-5.6-sol', 'high', ?, ?, 1)`,
      )
      .run(hash, payload);
    const profile = LEGACY_ENRICHMENT_PROFILES[0];
    const validations = approvedEnrichmentValidations(profile).all;
    for (const [index, validation] of validations.entries()) {
      database
        .prepare(
          `INSERT INTO enrichment_validation (
            id, artifact_id, validator_key, validator_version, attempt,
            outcome, highest_severity, report_hash, report, created_at
          ) VALUES (?, 'legacy-artifact', ?, ?, ?, 'pass', 'none', ?, '{}', 1)`,
        )
        .run(
          `legacy-review-${String(index)}`,
          validation.validatorKey,
          validation.validatorVersion,
          validation.attempt,
          hash,
        );
    }
    database.exec(`
      UPDATE poem SET active_source_revision_id = 'legacy-revision',
        active_enrichment_artifact_id = 'legacy-artifact'
      WHERE id = '00000000-0000-4000-8000-000000000002';
      INSERT INTO poem_publication_pointer VALUES (
        '00000000-0000-4000-8000-000000000002', 'legacy-revision',
        'legacy-artifact', 1, 1, 1
      );
    `);

    expect(
      applyPending(
        database,
        migrationFiles().filter((name) => name < "0052_"),
      ),
    ).toEqual([
      "0050_copy_legacy_enrichment.sql",
      "0051_expand_source_revision_pointer.sql",
    ]);
    expect(
      database
        .prepare(
          `SELECT model_key, payload FROM model_enrichment_artifact
           WHERE id = 'legacy/legacy-artifact'`,
        )
        .get(),
    ).toEqual({ model_key: "sol-5.6", payload });
    expect(
      database
        .prepare(
          `SELECT count(*) FROM model_enrichment_validation
           WHERE artifact_id = 'legacy/legacy-artifact'`,
        )
        .pluck()
        .get(),
    ).toBe(2);
    expect(
      database
        .prepare(
          `SELECT enrichment_artifact_id FROM poem_model_publication_pointer
           WHERE poem_id = '00000000-0000-4000-8000-000000000002'
             AND model_key = 'sol-5.6'`,
        )
        .pluck()
        .get(),
    ).toBe("legacy/legacy-artifact");
    for (const name of [
      "enrichment_artifact",
      "enrichment_validation",
      "poem_publication_pointer",
    ]) {
      expect(
        database
          .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
          .get(name),
      ).toBeDefined();
    }
    database.exec(`
      UPDATE poem SET
        translation_sol = '{"content":["First line","Second line"]}',
        insights_sol = (
          SELECT json_extract(payload, '$.insights')
          FROM model_enrichment_artifact WHERE id = 'legacy/legacy-artifact'
        ),
        publishable = 1
      WHERE id = '00000000-0000-4000-8000-000000000002';
    `);
    expect(applyPending(database, migrationFiles())).toEqual([
      "0052_guard_legacy_enrichment_contract.sql",
      "0053_retire_legacy_sol_translation_column.sql",
      "0054_retire_legacy_sol_insights_column.sql",
      "0055_retire_legacy_enrichment_tables.sql",
      "0056_stage_database_identity.sql",
      "0057_retire_production_deployment_identity.sql",
      "0058_source_revision_writer_cutover.sql",
      "0059_retire_source_revision_pointer.sql",
      "0060_restore_catalog_publishability.sql",
    ]);
    for (const name of [
      "enrichment_artifact",
      "enrichment_validation",
      "poem_publication_pointer",
    ]) {
      expect(
        database
          .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
          .get(name),
      ).toBeUndefined();
    }
    expect(
      database
        .prepare(
          `SELECT payload FROM model_enrichment_artifact
           WHERE id = 'legacy/legacy-artifact'`,
        )
        .pluck()
        .get(),
    ).toBe(payload);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps a published Sol projection when no model publication preserves it", () => {
    const database = open();
    applyPending(
      database,
      migrationFiles().filter((name) => name < "0053_"),
    );
    insertProductionRow(database);
    database.exec(`
      UPDATE poem SET publishable = 1,
        translation_sol = '{"content":["Uncopied English"]}'
      WHERE id = '00000000-0000-4000-8000-000000000002';
    `);
    expect(() => applyPending(database, migrationFiles())).toThrow();
    expect(
      database
        .prepare(
          `SELECT translation_sol FROM poem
           WHERE id = '00000000-0000-4000-8000-000000000002'`,
        )
        .pluck()
        .get(),
    ).toBe('{"content":["Uncopied English"]}');
    expect(
      database
        .prepare("SELECT 1 FROM d1_migrations WHERE name LIKE '0053_%'")
        .get(),
    ).toBeUndefined();
  });

  it("rejects a profile whose referenced model is missing", () => {
    const database = open();
    const files = migrationFiles();
    applyPending(
      database,
      files.filter((name) => name < "0049_"),
    );
    database.pragma("foreign_keys = OFF");
    database
      .prepare(
        `INSERT INTO enrichment_profile (
           profile_key, public_track_key, model_key, backend_key,
           runtime_model_id, prompt_version, reasoning_effort,
           input_schema_version, output_schema_version, created_at
         ) SELECT 'orphaned-profile', 'orphaned-track', 'missing-model',
                  backend_key, 'missing-model', prompt_version,
                  reasoning_effort, input_schema_version,
                  output_schema_version, created_at
             FROM enrichment_profile WHERE profile_key = 'sol-5.6/source-v2'`,
      )
      .run();
    database.pragma("foreign_keys = ON");

    expect(() => applyPending(database, files)).toThrow();
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'ai_model'",
        )
        .get(),
    ).toBeDefined();
    expect(
      database
        .prepare("SELECT 1 FROM d1_migrations WHERE name LIKE '0049_%'")
        .get(),
    ).toBeUndefined();
  });

  it("folds an existing promotion receipt into its bundle without changing counts", () => {
    const database = open();
    const files = migrationFiles();
    const throughReceipt = files.filter((name) => !name.startsWith("0049_"));
    applyPending(
      database,
      throughReceipt.filter((name) => !name.startsWith("0048_")),
    );
    database
      .prepare(
        `INSERT INTO crawl_import_bundle (
          id, schema_version, manifest_hash, root_hash, plan_hash,
          promotion_plan, expected_record_count, status, writer_epoch,
          created_at, sealed_at
        ) VALUES ('bundle-fold', 1, ?, ?, ?, '{}', 0, 'sealed', 1, 1, 2)`,
      )
      .run("a".repeat(64), "b".repeat(64), "c".repeat(64));
    database
      .prepare(
        `INSERT INTO crawl_import_receipt (
          bundle_id, plan_hash, writer_epoch, inserted_revisions,
          reused_revisions, advanced_pointers, unchanged_pointers, created_at
        ) VALUES ('bundle-fold', ?, 1, 3, 4, 5, 6, 7)`,
      )
      .run("c".repeat(64));
    expect(applyPending(database, throughReceipt)).toEqual([
      "0048_fold_crawl_import_receipt.sql",
    ]);
    expect(
      database
        .prepare(
          `SELECT status, receipt_created_at, inserted_revisions,
                  reused_revisions, advanced_pointers, unchanged_pointers
             FROM crawl_import_bundle WHERE id = 'bundle-fold'`,
        )
        .get(),
    ).toEqual({
      status: "promoted",
      receipt_created_at: 7,
      inserted_revisions: 3,
      reused_revisions: 4,
      advanced_pointers: 5,
      unchanged_pointers: 6,
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'crawl_import_receipt'",
        )
        .get(),
    ).toBeUndefined();
    expect(applyPending(database, throughReceipt)).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("skips the baseline for the current deployed receipt without touching data", () => {
    const database = open();
    applyPending(database, migrationFiles());
    recordApplied(database, "0036_atomic_model_publication_pointer_upsert.sql");
    insertProductionRow(database);
    database.exec(`
      UPDATE poem SET translation = '{"content":["Preserved translation"]}';
    `);
    const before = {
      schema: schemaSnapshot(database),
      poems: database.prepare("SELECT * FROM poem").all(),
      receipts: database
        .prepare("SELECT * FROM d1_migrations ORDER BY id")
        .all(),
    };

    expect(applyPending(database, migrationFiles())).toEqual([]);
    expect({
      schema: schemaSnapshot(database),
      poems: database.prepare("SELECT * FROM poem").all(),
      receipts: database
        .prepare("SELECT * FROM d1_migrations ORDER BY id")
        .all(),
    }).toEqual(before);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("folds existing translation attribution and retires unused task state", () => {
    const database = open();
    const files = migrationFiles();
    const throughLegacy = files.filter((name) => name < "0046_");
    applyPending(
      database,
      throughLegacy.filter((name) => !name.startsWith("0045_")),
    );
    insertProductionRow(database);
    database
      .prepare(
        `INSERT INTO poem_legacy_payload_attribution (
          poem_id, legacy_field, source_payload_hash, attribution_key,
          attributed_at
        ) VALUES (?, 'translation', ?, 'legacy-claude-1-or-2', 1)`,
      )
      .run("00000000-0000-4000-8000-000000000002", "a".repeat(64));
    database
      .prepare(
        "INSERT INTO task (id, type, status, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("retired-task", "translate-poem", "completed", 1);

    expect(applyPending(database, throughLegacy)).toEqual([
      "0045_fold_legacy_attribution_and_retire_task.sql",
    ]);
    const stored = database
      .prepare("SELECT legacy_translation_attributions FROM poem WHERE id = ?")
      .pluck()
      .get("00000000-0000-4000-8000-000000000002") as string;
    expect(JSON.parse(stored)).toEqual([
      {
        certainty: "inferred_range",
        displayName: "Claude 1 or 2",
        sourcePayloadHash: "a".repeat(64),
        vendorKey: "anthropic",
      },
    ]);
    for (const name of [
      "legacy_model_attribution",
      "poem_legacy_payload_attribution",
      "task",
    ]) {
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
          )
          .get(name),
      ).toBeUndefined();
    }
    expect(applyPending(database, throughLegacy)).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("preserves existing revision fingerprints and one-time append guards", () => {
    const database = open();
    database.exec(`
      CREATE TABLE poem_source_revision (
        id TEXT PRIMARY KEY, source_poem_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL, content_hash TEXT NOT NULL,
        title_arabic TEXT NOT NULL, content_arabic TEXT NOT NULL,
        observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        import_bundle_id TEXT NOT NULL, import_ordinal INTEGER NOT NULL
      );
      CREATE TRIGGER poem_source_revision_immutable_update
      BEFORE UPDATE ON poem_source_revision
      BEGIN SELECT RAISE(ABORT, 'POEM_SOURCE_REVISION_IMMUTABLE'); END;
      CREATE TABLE source_revision_fingerprint (
        source_revision_id TEXT PRIMARY KEY REFERENCES poem_source_revision(id),
        line_nfc_hash TEXT NOT NULL, prompt_material_hash TEXT NOT NULL,
        algorithm TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO poem_source_revision VALUES (
        'revision', 'source', 2, 'content', 'عنوان', '{}', 1, 2, 'bundle', 0
      );
      INSERT INTO poem_source_revision VALUES (
        'unfingerprinted', 'source', 2, 'content', 'عنوان', '{}', 1, 2, 'bundle', 1
      );
    `);
    database
      .prepare("INSERT INTO source_revision_fingerprint VALUES (?, ?, ?, ?, ?)")
      .run(
        "revision",
        "a".repeat(64),
        "b".repeat(64),
        "sha256-canonical-nfc-v1",
        3,
      );

    expect(
      applyPending(database, ["0046_fold_source_revision_fingerprint.sql"]),
    ).toEqual(["0046_fold_source_revision_fingerprint.sql"]);
    expect(
      database
        .prepare(
          `SELECT fingerprint_algorithm, fingerprint_created_at,
                  line_nfc_hash, prompt_material_hash
             FROM poem_source_revision WHERE id = 'revision'`,
        )
        .get(),
    ).toEqual({
      fingerprint_algorithm: "sha256-canonical-nfc-v1",
      fingerprint_created_at: 3,
      line_nfc_hash: "a".repeat(64),
      prompt_material_hash: "b".repeat(64),
    });
    expect(() =>
      database
        .prepare(
          "UPDATE poem_source_revision SET title_arabic = 'changed' WHERE id = 'revision'",
        )
        .run(),
    ).toThrow(/POEM_SOURCE_REVISION_IMMUTABLE/u);
    expect(() =>
      database
        .prepare(
          "UPDATE poem_source_revision SET line_nfc_hash = ? WHERE id = 'revision'",
        )
        .run("c".repeat(64)),
    ).toThrow(/POEM_SOURCE_REVISION_IMMUTABLE/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO poem_source_revision (
            id, source_poem_id, schema_version, content_hash, title_arabic,
            content_arabic, observed_at, created_at, import_bundle_id,
            import_ordinal, line_nfc_hash
          ) VALUES ('partial', 'source', 2, 'content', 'عنوان', '{}', 1, 2,
            'bundle', 2, ?)`,
        )
        .run("c".repeat(64)),
    ).toThrow(/SOURCE_REVISION_FINGERPRINT_INVALID/u);
    expect(() =>
      database
        .prepare(
          `UPDATE poem_source_revision SET fingerprint_algorithm = ?,
            fingerprint_created_at = 4, line_nfc_hash = ?,
            prompt_material_hash = ? WHERE id = 'unfingerprinted'`,
        )
        .run("sha256-canonical-nfc-v1", "c".repeat(64), "d".repeat(64)),
    ).not.toThrow();
    expect(() =>
      database
        .prepare(
          "UPDATE poem_source_revision SET line_nfc_hash = ? WHERE id = 'unfingerprinted'",
        )
        .run("e".repeat(64)),
    ).toThrow(/POEM_SOURCE_REVISION_IMMUTABLE/u);
    expect(
      applyPending(database, ["0046_fold_source_revision_fingerprint.sql"]),
    ).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("initializes the writer timestamp at install time rather than schema generation time", () => {
    const database = open();
    database.function("unixepoch", () => 1_700_000_000);
    applyPending(database, migrationFiles());

    expect(
      database
        .prepare("SELECT updated_at FROM scraper_writer_control")
        .pluck()
        .get(),
    ).toBe(1_700_000_000);
  });

  it.each([
    "0019_remove_legacy_favorites_tts.sql",
    "0021_materialized_public_catalog.sql",
    "0036_atomic_model_publication_pointer_upsert.sql",
  ])(
    "rejects an existing %s catalog without manufacturing a baseline receipt",
    (receipt) => {
      const database = open();
      database.exec(
        "CREATE TABLE author (id TEXT PRIMARY KEY); INSERT INTO author VALUES ('preserved');",
      );
      recordApplied(database, receipt);
      const before = schemaSnapshot(database);

      expect(() => applyPending(database, migrationFiles())).toThrow(
        /table author already exists/u,
      );
      expect(schemaSnapshot(database)).toEqual(before);
      expect(database.prepare("SELECT id FROM author").all()).toEqual([
        { id: "preserved" },
      ]);
      expect(database.prepare("SELECT name FROM d1_migrations").all()).toEqual([
        { name: receipt },
      ]);
    },
  );

  it("rejects noncanonical hashes and malformed source envelopes", () => {
    const database = open();
    applyPending(database, migrationFiles());
    database
      .prepare(
        "INSERT INTO author(id, slug, name_arabic) VALUES ('author-guard', 'author-guard', 'شاعر')",
      )
      .run();

    expect(() =>
      database
        .prepare(
          `INSERT INTO crawl_import_bundle (
            id, schema_version, manifest_hash, expected_record_count, status,
            writer_epoch, created_at
          ) VALUES ('bad-hash', 1, ?, 1, 'open', 1, 1)`,
        )
        .run("A".repeat(64)),
    ).toThrow(/CRAWL_IMPORT_BUNDLE_HASH_INVALID/u);

    database
      .prepare(
        `INSERT INTO crawl_import_bundle (
          id, schema_version, manifest_hash, expected_record_count, status,
          writer_epoch, created_at
        ) VALUES ('shape-guard', 1, ?, 1, 'open', 1, 1)`,
      )
      .run("a".repeat(64));
    expect(() =>
      database
        .prepare(
          `INSERT INTO crawl_import_record (
            bundle_id, ordinal, record_hash, source_name, source_author_id,
            source_author_url, author_name_arabic, canonical_author_id,
            source_poem_id, source_poem_url, canonical_poem_id, title_arabic,
            content_arabic, content_hash, observed_at
          ) VALUES (
            'shape-guard', 0, ?, 'source', 'author-source', 'https://a.test',
            'شاعر', 'author-guard', 'poem-source', 'https://p.test', NULL,
            'قصيدة', '{"content":[]}', ?, 1
          )`,
        )
        .run("b".repeat(64), "c".repeat(64)),
    ).toThrow(/CRAWL_IMPORT_RECORD_DOCUMENT_INVALID/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO crawl_import_record (
            bundle_id, ordinal, record_hash, source_name, source_author_id,
            source_author_url, author_name_arabic, canonical_author_id,
            source_poem_id, source_poem_url, canonical_poem_id, title_arabic,
            content_arabic, content_hash, observed_at
          ) VALUES (
            'shape-guard', 0, ?, 'source', 'author-source', 'https://a.test',
            'شاعر', 'author-guard', 'poem-source', 'https://p.test', NULL,
            'قصيدة', ?, ?, 1
          )`,
        )
        .run(
          "b".repeat(64),
          JSON.stringify({ content: ["x".repeat(2_000_001)] }),
          "c".repeat(64),
        ),
    ).toThrow(/CRAWL_IMPORT_RECORD_DOCUMENT_INVALID/u);
  });

  it("enforces title-aware revision-v2 envelopes without rewriting v1", () => {
    const database = open();
    applyPending(database, migrationFiles());
    const hash = "a".repeat(64);
    database
      .prepare(
        `INSERT INTO crawl_import_bundle (
          id, schema_version, manifest_hash, expected_record_count, status,
          writer_epoch, created_at
        ) VALUES ('v2-bundle', 2, ?, 0, 'open', 1, 1)`,
      )
      .run(hash);
    expect(() =>
      database
        .prepare(
          `INSERT INTO crawl_import_record (
            bundle_id, ordinal, record_hash, source_name, source_author_id,
            source_author_url, author_name_arabic, canonical_author_id,
            source_poem_id, source_poem_url, canonical_poem_id, title_arabic,
            content_arabic, content_hash, observed_at
          ) VALUES (
            'v2-bundle', 0, ?, 'primary-source', 'author', 'https://source.invalid/a',
            'شاعر', 'missing-author', '42', 'https://example.com/p', NULL,
            'العنوان', '{"content":["بيت"]}', ?, 1
          )`,
        )
        .run(hash, hash),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO crawl_import_bundle (
            id, schema_version, manifest_hash, expected_record_count, status,
            writer_epoch, created_at
          ) VALUES ('future', 3, ?, 0, 'open', 1, 1)`,
        )
        .run("b".repeat(64)),
    ).toThrow(/CRAWL_IMPORT_SCHEMA_UNSUPPORTED/u);
  });

  it("fences the writer root and keeps profile attribution immutable", () => {
    const database = open();
    applyPending(database, migrationFiles());

    expect(() =>
      database
        .prepare(
          `UPDATE scraper_writer_control
           SET writer_epoch = 3, writer_id = 'skipped', updated_at = 1
           WHERE singleton = 1`,
        )
        .run(),
    ).toThrow(/SCRAPER_WRITER_CONTROL_UPDATE_INVALID/u);
    expect(() =>
      database
        .prepare(
          `UPDATE scraper_writer_control
           SET writer_epoch = 2, writer_id = 'writer-2',
               updated_at = updated_at + 1
           WHERE singleton = 1`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      database
        .prepare(
          `UPDATE scraper_writer_control
           SET writer_id = 'rewritten', updated_at = updated_at + 1
           WHERE singleton = 1`,
        )
        .run(),
    ).toThrow(/SCRAPER_WRITER_CONTROL_UPDATE_INVALID/u);
    expect(() =>
      database.prepare("DELETE FROM scraper_writer_control").run(),
    ).toThrow(/SCRAPER_WRITER_CONTROL_IMMUTABLE/u);

    expect(() =>
      database
        .prepare(
          "UPDATE enrichment_profile SET reasoning_effort = 'low' WHERE profile_key = 'sol-5.6/source-v2'",
        )
        .run(),
    ).toThrow(/ENRICHMENT_PROFILE_IMMUTABLE/u);

    insertProductionRow(database);
    expect(() =>
      database
        .prepare(
          `UPDATE poem SET legacy_translation_attributions = ? WHERE id = ?`,
        )
        .run("not json", "00000000-0000-4000-8000-000000000002"),
    ).toThrow(/CHECK constraint failed/u);
  });
});

function extractOnlyDatabaseId(source: string): string {
  const ids = source
    .matchAll(/"database_id"\s*:\s*"([^"]+)"/gu)
    .map((match) => match[1])
    .toArray();
  expect(ids).toHaveLength(1);
  return ids[0] ?? "";
}

function extractMigrationDatabaseId(source: string): string {
  const match = /VALUES\s*\(\s*'production'\s*,\s*'([^']+)'\s*\)/u.exec(source);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

function migrationFiles(): readonly string[] {
  return readdirSync(DIRECTORY)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .toSorted();
}

function applyPending(
  database: Database.Database,
  names: readonly string[],
): readonly string[] {
  const applied: string[] = [];
  const run = database.transaction((name: string) => {
    const exists = database
      .prepare("SELECT 1 FROM d1_migrations WHERE name = ?")
      .get(name);
    if (exists) return false;
    database.exec(readFileSync(join(DIRECTORY, name), "utf8"));
    recordApplied(database, name);
    return true;
  });
  for (const name of names) if (run(name)) applied.push(name);
  return applied;
}

function recordApplied(database: Database.Database, name: string): void {
  database.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
}

function insertProductionRow(database: Database.Database): void {
  database
    .prepare(
      `INSERT INTO author(id, slug, name_arabic)
       VALUES ('00000000-0000-4000-8000-000000000001', 'author', 'شاعر')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO poem(
         id, author_id, slug, verses, name_arabic, content_arabic
       ) VALUES (?, ?, 'poem42', 1, 'قصيدة', '{"content":["صدر","عجز"]}')`,
    )
    .run(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    );
}

function expectCorpusRevisionSchema(database: Database.Database): void {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .pluck()
    .all() as string[];
  expect(tables).toEqual(
    expect.arrayContaining([
      "crawl_import_bundle",
      "crawl_import_record",
      "enrichment_profile",
      "model_enrichment_artifact",
      "model_enrichment_validation",
      "model_publication_receipt",
      "poem_model_publication_pointer",
      "poem_source_revision",
      "scraper_writer_control",
      "source_author_identity",
      "source_admission_clock",
      "source_poem_identity",
    ]),
  );
  for (const retired of [
    "enrichment_artifact",
    "enrichment_validation",
    "poem_publication_pointer",
    "poem_source_pointer",
  ])
    expect(tables).not.toContain(retired);
  const poemColumns = database.prepare("PRAGMA table_info(poem)").all() as {
    name: string;
  }[];
  expect(poemColumns.map(({ name }) => name)).toContain(
    "active_source_revision_id",
  );
  for (const retired of [
    "active_enrichment_artifact_id",
    "insights_sol",
    "translation_sol",
  ])
    expect(poemColumns.map(({ name }) => name)).not.toContain(retired);
  const enrichmentColumns = database
    .prepare("PRAGMA table_info(model_enrichment_artifact)")
    .all() as { name: string }[];
  expect(enrichmentColumns.map(({ name }) => name)).toContain("model_key");
  expect(
    database
      .prepare(
        "SELECT writer_epoch FROM scraper_writer_control WHERE singleton = 1",
      )
      .pluck()
      .get(),
  ).toBe(1);
}

function expectCatalogPublishability(database: Database.Database): void {
  const values = database
    .prepare("SELECT hex(value) FROM catalog_unsafe_control ORDER BY value")
    .pluck()
    .all() as string[];
  expect(values).toHaveLength(39);
  expect(values).toContain("00");
  expect(values).toContain("E280AA");
  expect(values).toContain("E281A9");

  const poemId = "00000000-0000-4000-8000-000000000002";
  if (!database.prepare("SELECT 1 FROM poem WHERE id = ?").get(poemId))
    insertProductionRow(database);
  const publishable = () =>
    database
      .prepare("SELECT publishable FROM poem WHERE id = ?")
      .pluck()
      .get(poemId);
  expect(publishable()).toBe(1);
  database
    .prepare("UPDATE poem SET slug = ? WHERE id = ?")
    .run("poem\u{202a}", poemId);
  expect(publishable()).toBe(0);
  database.prepare("UPDATE poem SET slug = 'poem42' WHERE id = ?").run(poemId);
  expect(publishable()).toBe(1);
  database
    .prepare("UPDATE poem SET content_arabic = ? WHERE id = ?")
    .run(JSON.stringify({ content: ["صدر\u{0000}عجز"] }), poemId);
  expect(publishable()).toBe(0);
  database
    .prepare("UPDATE poem SET content_arabic = ? WHERE id = ?")
    .run(JSON.stringify({ content: ["ا".repeat(5001)] }), poemId);
  expect(publishable()).toBe(0);
}

function expectModelPublicationGuards(database: Database.Database): void {
  const triggerNames = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' AND tbl_name = 'poem_model_publication_pointer'
       ORDER BY name`,
    )
    .pluck()
    .all() as string[];
  expect(triggerNames).toEqual(
    expect.arrayContaining([
      "poem_model_publication_pointer_delete_forbidden",
      "poem_model_publication_pointer_insert_relationship",
      "poem_model_publication_pointer_insert_version",
      "poem_model_publication_pointer_insert_writer",
      "poem_model_publication_pointer_update_guard",
    ]),
  );
}

function expectLegacySolPublicationPrecedence(
  database: Database.Database,
): void {
  const triggerNames = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger'
         AND name IN (
           'legacy_sol_model_pointer_create_only',
           'legacy_sol_publication_receipt_create_only'
         )
       ORDER BY name`,
    )
    .pluck()
    .all();
  expect(triggerNames).toEqual([
    "legacy_sol_model_pointer_create_only",
    "legacy_sol_publication_receipt_create_only",
  ]);
}

function expectSourcePointerGuards(database: Database.Database): void {
  const triggerNames = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger'
         AND tbl_name = 'source_poem_identity'
       ORDER BY name`,
    )
    .pluck()
    .all() as string[];
  expect(triggerNames).toEqual(
    expect.arrayContaining(["source_poem_current_revision_transition_guard"]),
  );
}

function expectCanonicalDataGuards(database: Database.Database): void {
  const triggerNames = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' ORDER BY name`,
    )
    .pluck()
    .all() as string[];
  expect(triggerNames).toEqual(
    expect.arrayContaining([
      "crawl_import_bundle_canonical_hash_insert",
      "crawl_import_record_document_insert",
      "poem_source_revision_document_insert",
      "model_enrichment_artifact_document_insert",
      "model_enrichment_validation_document_insert",
      "crawl_import_bundle_receipt_insert_guard",
      "crawl_import_bundle_receipt_update_guard",
    ]),
  );
}

function expectProductionDeploymentIdentity(database: Database.Database): void {
  expect(
    database
      .prepare(
        `SELECT database_id AS databaseId FROM scraper_writer_control
          WHERE singleton = 1`,
      )
      .all(),
  ).toEqual([
    {
      databaseId: "ffaae610-4dae-4d7e-bf86-8232f46ca2b5",
    },
  ]);
  expect(
    database
      .prepare(
        `SELECT 1 FROM sqlite_schema
          WHERE type = 'table' AND name = 'production_deployment_identity'`,
      )
      .get(),
  ).toBeUndefined();
  expect(() =>
    database
      .prepare(
        `UPDATE scraper_writer_control
            SET database_id = '11111111-1111-4111-8111-111111111111'
          WHERE singleton = 1`,
      )
      .run(),
  ).toThrow();
}

function expectModelProfileRegistry(database: Database.Database): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .pluck()
    .all() as string[];
  expect(tables).toContain("enrichment_profile");
  for (const retired of ["ai_model", "ai_vendor", "inference_backend"]) {
    expect(tables).not.toContain(retired);
  }
  expect(
    database.prepare("SELECT count(*) FROM enrichment_profile").pluck().get(),
  ).toBe(18);
  expect(
    database
      .prepare(
        "SELECT count(*) FROM enrichment_profile WHERE output_schema_version = 2",
      )
      .pluck()
      .get(),
  ).toBe(10);
  expect(
    database
      .prepare(
        `SELECT count(*) FROM enrichment_profile
         WHERE prompt_version = 'sol-word-gloss-v3'
           AND output_schema_version = 3`,
      )
      .pluck()
      .get(),
  ).toBe(2);
  expect(
    database
      .prepare(
        `SELECT model_key, backend_key, runtime_model_id
           FROM enrichment_profile
          WHERE profile_key = 'agy-gemini-3.1-pro-high/word-gloss-v2/source-v2'`,
      )
      .get(),
  ).toEqual({
    backend_key: "agy-cli",
    model_key: "gemini-3.1-pro-high",
    runtime_model_id: "gemini-3.1-pro-high",
  });
  expect(
    database
      .prepare(
        `SELECT public_track_key, count(*) AS profiles
           FROM enrichment_profile
          WHERE public_track_key IN (
            'agy-claude-opus-4.6-thinking', 'agy-gemini-3.1-pro-high'
          )
          GROUP BY public_track_key ORDER BY public_track_key`,
      )
      .all(),
  ).toEqual([
    { profiles: 4, public_track_key: "agy-claude-opus-4.6-thinking" }, // gitleaks:allow -- Public legacy model identifier, not a credential.
    { profiles: 2, public_track_key: "agy-gemini-3.1-pro-high" },
  ]);
  const triggers = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'")
    .pluck()
    .all() as string[];
  expect(triggers).toEqual(
    expect.arrayContaining([
      "model_enrichment_artifact_profile_required",
      "model_enrichment_word_gloss_v2_shape",
      "model_publication_profile_insert_guard",
      "model_publication_profile_update_guard",
      "scraper_writer_control_delete_forbidden",
      "scraper_writer_control_update_guard",
    ]),
  );
}

function expectSlugIndexesReduced(database: Database.Database): void {
  const authorIndexes = indexNames(database, "author");
  const poemIndexes = indexNames(database, "poem");
  expect(authorIndexes).not.toContain("idx_author_slug");
  expect(poemIndexes).not.toContain("idx_poem_slug");
  expect(authorIndexes).toContain("sqlite_autoindex_author_2");
  expect(poemIndexes).toContain("sqlite_autoindex_poem_2");

  const authorPlan = queryPlan(
    database,
    "SELECT id FROM author WHERE slug = ?",
  );
  const poemPlan = queryPlan(database, "SELECT id FROM poem WHERE slug = ?");
  expect(authorPlan).toContain("sqlite_autoindex_author_2");
  expect(poemPlan).toContain("sqlite_autoindex_poem_2");
}

function expectSlugUniqueness(database: Database.Database): void {
  database
    .prepare("INSERT INTO author(id, slug, name_arabic) VALUES (?, ?, ?)")
    .run("unique-author-1", "unique-author", "شاعر");
  expect(() =>
    database
      .prepare("INSERT INTO author(id, slug, name_arabic) VALUES (?, ?, ?)")
      .run("unique-author-2", "unique-author", "شاعر ثان"),
  ).toThrow(/UNIQUE constraint failed: author\.slug/u);

  database
    .prepare(
      `INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "unique-poem-1",
      "unique-author-1",
      "unique-poem",
      1,
      "قصيدة",
      '{"content":["صدر","عجز"]}',
    );
  expect(() =>
    database
      .prepare(
        `INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "unique-poem-2",
        "unique-author-1",
        "unique-poem",
        1,
        "قصيدة ثانية",
        '{"content":["صدر","عجز"]}',
      ),
  ).toThrow(/UNIQUE constraint failed: poem\.slug/u);
}

function indexNames(database: Database.Database, tableName: string): string[] {
  return database
    .prepare("SELECT name FROM pragma_index_list(?) ORDER BY name")
    .pluck()
    .all(tableName) as string[];
}

function queryPlan(database: Database.Database, query: string): string {
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${query}`).all("slug") as {
      detail: string;
    }[]
  )
    .map(({ detail }) => detail)
    .join("\n");
}

function schemaSnapshot(database: Database.Database): string {
  return JSON.stringify(
    database
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all(),
  );
}
