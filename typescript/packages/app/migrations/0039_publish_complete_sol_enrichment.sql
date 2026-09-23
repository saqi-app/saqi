-- Migration 0038 registered the v3 prompt against output schema 2. Preserve
-- those immutable, unused profile rows as historical evidence and add the
-- corrected identities that can admit the complete schema-3 payload.
INSERT INTO enrichment_profile (
  profile_key, public_track_key, model_key, backend_key, runtime_model_id,
  prompt_version, reasoning_effort, input_schema_version,
  output_schema_version, created_at
) VALUES
  ('sol-5.6/word-gloss-v3-output-v3/source-v1', 'sol-5.6', 'gpt-5.6-sol', 'openai-codex-cli', 'gpt-5.6-sol', 'sol-word-gloss-v3', 'medium', 1, 3, 0),
  ('sol-5.6/word-gloss-v3-output-v3/source-v2', 'sol-5.6', 'gpt-5.6-sol', 'openai-codex-cli', 'gpt-5.6-sol', 'sol-word-gloss-v3', 'medium', 2, 3, 0)
ON CONFLICT(profile_key) DO NOTHING;

-- The v3 recipe must never be paired with its accidentally registered v2
-- output identity, even if a future caller bypasses the application schema.
CREATE TRIGGER sol_word_gloss_v3_output_schema_guard
BEFORE INSERT ON model_enrichment_artifact
WHEN NEW.prompt_version = 'sol-word-gloss-v3'
  AND NEW.schema_version <> 3
BEGIN
  SELECT RAISE(ABORT, 'SOL_WORD_GLOSS_V3_OUTPUT_SCHEMA_INVALID');
END;

-- Retain a D1 boundary check for the complete artifact. Detailed semantic
-- validation (line alignment, lossless gloss reconstruction, and grounded
-- notable lines) remains in the versioned application contract.
CREATE TRIGGER model_enrichment_complete_v3_shape
BEFORE INSERT ON model_enrichment_artifact
WHEN NEW.schema_version = 3 AND (
  json_type(NEW.payload) <> 'object'
  OR (SELECT count(*) FROM json_each(NEW.payload)) <> 5
  OR json_extract(NEW.payload, '$.schemaId') <> 'saqi.poem-enrichment-output'
  OR json_type(NEW.payload, '$.schemaVersion') <> 'integer'
  OR json_extract(NEW.payload, '$.schemaVersion') <> 3
  OR json_type(NEW.payload, '$.translation') <> 'object'
  OR json_type(NEW.payload, '$.translation.lines') <> 'array'
  OR json_array_length(NEW.payload, '$.translation.lines') NOT BETWEEN 1 AND 2000
  OR json_type(NEW.payload, '$.wordGlosses') <> 'object'
  OR json_extract(NEW.payload, '$.wordGlosses.tokenizerVersion')
       <> 'saqi-orthographic-v1'
  OR json_type(NEW.payload, '$.wordGlosses.lines') <> 'array'
  OR json_array_length(NEW.payload, '$.wordGlosses.lines') NOT BETWEEN 1 AND 2000
  OR json_type(NEW.payload, '$.insights') <> 'object'
  OR (SELECT count(*) FROM json_each(NEW.payload, '$.insights')) <> 6
  OR json_type(NEW.payload, '$.insights.summary') <> 'text'
  OR length(trim(json_extract(NEW.payload, '$.insights.summary'))) NOT BETWEEN 1 AND 20000
  OR json_type(NEW.payload, '$.insights.themes') <> 'array'
  OR json_array_length(NEW.payload, '$.insights.themes') NOT BETWEEN 1 AND 100
  OR json_type(NEW.payload, '$.insights.historicalContext') <> 'text'
  OR length(trim(json_extract(NEW.payload, '$.insights.historicalContext'))) NOT BETWEEN 1 AND 20000
  OR json_type(NEW.payload, '$.insights.literaryDevices') <> 'array'
  OR json_array_length(NEW.payload, '$.insights.literaryDevices') NOT BETWEEN 1 AND 100
  OR json_type(NEW.payload, '$.insights.culturalSignificance') <> 'text'
  OR length(trim(json_extract(NEW.payload, '$.insights.culturalSignificance'))) NOT BETWEEN 1 AND 20000
  OR json_type(NEW.payload, '$.insights.notableLines') <> 'array'
  OR json_array_length(NEW.payload, '$.insights.notableLines') NOT BETWEEN 1 AND 100
)
BEGIN
  SELECT RAISE(ABORT, 'MODEL_ENRICHMENT_COMPLETE_V3_INVALID');
END;
