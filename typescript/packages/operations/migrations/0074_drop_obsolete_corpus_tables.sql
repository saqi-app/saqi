-- Canonical-only application is already deployed. All graph FKs were detached
-- by 0071; remove this obsolete graph in its own ledgered transaction.
DROP TABLE IF EXISTS model_publication_receipt;
DROP TABLE IF EXISTS poem_model_publication_pointer;
DROP TABLE IF EXISTS model_enrichment_validation;
DROP TABLE IF EXISTS model_enrichment_artifact;
DROP TABLE IF EXISTS poem_source_revision;
DROP TABLE IF EXISTS crawl_import_record;
DROP TABLE IF EXISTS crawl_import_bundle;
DROP TABLE IF EXISTS source_poem_identity;
DROP TABLE IF EXISTS source_author_identity;
DROP TABLE IF EXISTS enrichment_profile;
DROP TABLE IF EXISTS source_admission_clock;
DROP TABLE IF EXISTS scraper_writer_control;

-- Release postconditions: exactly author + poem application tables, zero FKs
-- broken, and canonical rows/URLs/visible publication hashes equal to preflight.
