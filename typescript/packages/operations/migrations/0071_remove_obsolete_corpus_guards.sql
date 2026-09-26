-- Unapplied predecessor failed with D1 internal error 7500 and rolled back.
-- Detach obsolete FKs in a separate transaction before dropping their targets.
-- Retire the obsolete model/source graph after canonical reader/writer deployment.
-- Exhaustive public parity and full D1 restore passed; require a fresh archive.
-- Live collection/Codex checks follow contraction per the owner's deletion priority.
-- Wrangler records this atomic migration once; never rewrite applied migrations.

DROP TRIGGER IF EXISTS crawl_import_bundle_canonical_hash_insert;
DROP TRIGGER IF EXISTS crawl_import_bundle_canonical_hash_update;
DROP TRIGGER IF EXISTS crawl_import_bundle_delete_forbidden;
DROP TRIGGER IF EXISTS crawl_import_bundle_epoch_transition;
DROP TRIGGER IF EXISTS crawl_import_bundle_identity_immutable;
DROP TRIGGER IF EXISTS crawl_import_bundle_plan_immutable;
DROP TRIGGER IF EXISTS crawl_import_bundle_receipt_insert_guard;
DROP TRIGGER IF EXISTS crawl_import_bundle_receipt_update_guard;
DROP TRIGGER IF EXISTS crawl_import_bundle_seal_fields_immutable;
DROP TRIGGER IF EXISTS crawl_import_bundle_status_transition;
DROP TRIGGER IF EXISTS crawl_import_bundle_supported_schema_insert;
DROP TRIGGER IF EXISTS crawl_import_record_author_relationship_insert;
DROP TRIGGER IF EXISTS crawl_import_record_document_insert;
DROP TRIGGER IF EXISTS crawl_import_record_immutable_delete;
DROP TRIGGER IF EXISTS crawl_import_record_immutable_update;
DROP TRIGGER IF EXISTS crawl_import_record_open_bundle_insert;
DROP TRIGGER IF EXISTS crawl_import_record_revision_envelope_insert;
DROP TRIGGER IF EXISTS enrichment_profile_dimension_insert_guard;
DROP TRIGGER IF EXISTS enrichment_profile_immutable_delete;
DROP TRIGGER IF EXISTS enrichment_profile_immutable_update;
DROP TRIGGER IF EXISTS legacy_sol_model_pointer_create_only;
DROP TRIGGER IF EXISTS legacy_sol_publication_receipt_create_only;
DROP TRIGGER IF EXISTS model_enrichment_artifact_document_insert;
DROP TRIGGER IF EXISTS model_enrichment_artifact_immutable_delete;
DROP TRIGGER IF EXISTS model_enrichment_artifact_immutable_update;
DROP TRIGGER IF EXISTS model_enrichment_artifact_profile_required;
DROP TRIGGER IF EXISTS model_enrichment_complete_v3_shape;
DROP TRIGGER IF EXISTS model_enrichment_validation_document_insert;
DROP TRIGGER IF EXISTS model_enrichment_validation_immutable_delete;
DROP TRIGGER IF EXISTS model_enrichment_validation_immutable_update;
DROP TRIGGER IF EXISTS model_enrichment_word_gloss_v2_shape;
DROP TRIGGER IF EXISTS model_publication_profile_insert_guard;
DROP TRIGGER IF EXISTS model_publication_profile_update_guard;
DROP TRIGGER IF EXISTS model_publication_receipt_immutable_delete;
DROP TRIGGER IF EXISTS model_publication_receipt_immutable_update;
DROP TRIGGER IF EXISTS model_publication_receipt_pointer_precondition;
DROP TRIGGER IF EXISTS model_publication_receipt_publish;
DROP TRIGGER IF EXISTS model_publication_receipt_relationship_insert;
DROP TRIGGER IF EXISTS poem_model_publication_pointer_delete_forbidden;
DROP TRIGGER IF EXISTS poem_model_publication_pointer_insert_relationship;
DROP TRIGGER IF EXISTS poem_model_publication_pointer_insert_version;
DROP TRIGGER IF EXISTS poem_model_publication_pointer_insert_writer;
DROP TRIGGER IF EXISTS poem_model_publication_pointer_update_guard;
DROP TRIGGER IF EXISTS poem_source_revision_document_insert;
DROP TRIGGER IF EXISTS poem_source_revision_fingerprint_insert_guard;
DROP TRIGGER IF EXISTS poem_source_revision_immutable_delete;
DROP TRIGGER IF EXISTS poem_source_revision_immutable_update;
DROP TRIGGER IF EXISTS poem_source_revision_relationship_insert;
DROP TRIGGER IF EXISTS poem_source_revision_revision_envelope_insert;
DROP TRIGGER IF EXISTS scraper_writer_control_delete_forbidden;
DROP TRIGGER IF EXISTS scraper_writer_control_insert_forbidden;
DROP TRIGGER IF EXISTS scraper_writer_control_update_guard;
DROP TRIGGER IF EXISTS scraper_writer_database_identity_immutable;
DROP TRIGGER IF EXISTS sol_model_pointer_prevent_recipe_downgrade;
DROP TRIGGER IF EXISTS sol_word_gloss_v3_output_schema_guard;
DROP TRIGGER IF EXISTS source_admission_clock_immutable_delete;
DROP TRIGGER IF EXISTS source_admission_clock_immutable_update;
DROP TRIGGER IF EXISTS source_author_identity_delete_forbidden;
DROP TRIGGER IF EXISTS source_author_identity_ownership_immutable;
DROP TRIGGER IF EXISTS source_poem_current_revision_insert_guard;
DROP TRIGGER IF EXISTS source_poem_current_revision_transition_guard;
DROP TRIGGER IF EXISTS source_poem_identity_author_relationship_insert;
DROP TRIGGER IF EXISTS source_poem_identity_delete_forbidden;
DROP TRIGGER IF EXISTS source_poem_identity_ownership_immutable;

DROP INDEX IF EXISTS idx_poem_active_source_revision;
