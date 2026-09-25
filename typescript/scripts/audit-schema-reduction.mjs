import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
const publicTables = [
  "author",
  "catalog_unsafe_control",
  "crawl_import_bundle",
  "crawl_import_record",
  "enrichment_profile",
  "insights_collection_month",
  "insights_model_count",
  "insights_rollup",
  "model_enrichment_artifact",
  "model_enrichment_validation",
  "model_publication_receipt",
  "poem",
  "poem_model_publication_pointer",
  "poem_source_revision",
  "scraper_writer_control",
  "source_admission_clock",
  "source_author_identity",
  "source_poem_identity",
];
const sql = `
SELECT
  (SELECT COUNT(*) FROM author) AS authors,
  (SELECT COUNT(*) FROM poem) AS poems,
  (SELECT COUNT(*) FROM source_author_identity) AS source_authors,
  (SELECT COUNT(*) FROM source_poem_identity) AS source_poems,
  (SELECT COUNT(*) FROM crawl_import_bundle WHERE status = 'sealed') AS sealed_bundles,
  (SELECT COUNT(*) FROM crawl_import_record record
     JOIN crawl_import_bundle bundle ON bundle.id = record.bundle_id
     WHERE bundle.status = 'sealed') AS sealed_records,
  (SELECT COUNT(*) FROM crawl_import_record record
     JOIN crawl_import_bundle bundle ON bundle.id = record.bundle_id
     LEFT JOIN source_poem_identity identity
       ON identity.source_name = record.source_name
      AND identity.external_id = record.source_poem_id
     WHERE bundle.status = 'sealed' AND identity.id IS NULL) AS sealed_unmapped,
  (SELECT COUNT(*) FROM poem poem
     LEFT JOIN source_poem_identity identity
       ON identity.canonical_poem_id = poem.id
     WHERE identity.id IS NULL) AS poems_without_source,
  (SELECT COUNT(*) FROM poem poem
     LEFT JOIN source_poem_identity own
       ON own.canonical_poem_id = poem.id
     JOIN source_poem_identity other
       ON other.source_name = 'aldiwan'
      AND other.external_id = substr(poem.slug, 5)
      AND other.canonical_poem_id <> poem.id
     WHERE own.id IS NULL AND poem.slug GLOB 'poem[1-9]*'
       AND substr(poem.slug, 5) NOT GLOB '*[^0-9]*') AS legacy_poem_id_collisions,
  (SELECT COUNT(*) FROM author author
     JOIN source_author_identity identity
       ON identity.source_name = 'aldiwan'
      AND identity.external_id = author.slug
      AND identity.canonical_author_id <> author.id) AS legacy_author_id_collisions,
  (SELECT COUNT(*) FROM source_poem_identity identity
     JOIN poem poem ON poem.id = identity.canonical_poem_id
     WHERE poem.active_source_revision_id IS NOT identity.current_revision_id)
       AS current_source_disagreements,
  (SELECT COUNT(*) FROM source_poem_identity
     WHERE canonical_poem_id IS NOT NULL
       AND current_revision_version IS NULL)
       AS mapped_source_poems_without_version,
  (SELECT COUNT(*) FROM (
     SELECT canonical_author_id FROM source_author_identity
     GROUP BY canonical_author_id HAVING COUNT(*) > 1
   )) AS authors_with_multiple_source_keys,
  (SELECT COUNT(*) FROM (
     SELECT canonical_poem_id FROM source_poem_identity
     WHERE canonical_poem_id IS NOT NULL
     GROUP BY canonical_poem_id HAVING COUNT(*) > 1
   )) AS poems_with_multiple_source_keys,
  (SELECT COUNT(*) FROM poem poem JOIN author author
     ON author.id = poem.author_id
     WHERE poem.hidden = 0 AND poem.publishable = 1 AND author.hidden = 0)
       AS public_flagged_joined_poems,
  (SELECT COUNT(*) FROM poem WHERE translation IS NOT NULL)
       AS poems_with_legacy_translation_payload,
  (SELECT COUNT(*) FROM poem WHERE translation_gemini IS NOT NULL)
       AS poems_with_gemini_translation_payload,
  (SELECT COUNT(*) FROM poem WHERE insights IS NOT NULL)
       AS poems_with_legacy_insights_payload,
  (SELECT COUNT(DISTINCT pointer.poem_id)
     FROM poem_model_publication_pointer pointer
     JOIN poem poem ON poem.id = pointer.poem_id
     WHERE pointer.source_revision_id = poem.active_source_revision_id)
       AS poems_with_active_model_pointer,
  (SELECT COUNT(*) FROM (
     SELECT pointer.poem_id FROM poem_model_publication_pointer pointer
     JOIN poem poem ON poem.id = pointer.poem_id
     WHERE pointer.source_revision_id = poem.active_source_revision_id
     GROUP BY pointer.poem_id HAVING COUNT(*) > 1
   )) AS poems_with_multiple_active_model_pointers;
PRAGMA foreign_key_check;
SELECT ${publicTables
  .map((table) => `(SELECT count(*) FROM ${table}) AS ${table}`)
  .join(", ")};
`;

const { stdout } = await run(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "saqi-db",
    "--remote",
    "--config",
    "packages/operations/wrangler.jsonc",
    "--json",
    "--command",
    sql,
  ],
  { cwd: root, maxBuffer: 1024 * 1024 },
);
const results = JSON.parse(stdout);
if (
  !Array.isArray(results) ||
  results.length !== 3 ||
  results.some((result) => result.success !== true)
) {
  throw new Error("Production audit returned incomplete results");
}
const counts = results[0].results?.[0];
const foreignKeyViolations = results[1].results?.length;
if (!counts || foreignKeyViolations === undefined)
  throw new Error("Production audit omitted counts or foreign-key result");
process.stdout.write(
  `${JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      databaseBytes: results[0].meta?.size_after,
      counts,
      foreignKeyViolations,
      tableRows: results[2].results?.[0],
    },
    null,
    2,
  )}\n`,
);
