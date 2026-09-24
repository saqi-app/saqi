-- Preserve exact, hash-scoped translation attribution on its poem before
-- retiring two legacy lookup tables. Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN legacy_translation_attributions TEXT -- sarj-noqa: SARJ102 — SQLite has no ADD COLUMN IF NOT EXISTS; Wrangler applies each migration once.
  CHECK (CASE
    WHEN legacy_translation_attributions IS NULL THEN 1
    WHEN json_valid(legacy_translation_attributions)
      THEN json_type(legacy_translation_attributions) = 'array'
    ELSE 0
  END);

UPDATE poem
SET legacy_translation_attributions = (
  SELECT json_group_array(json_object(
    'sourcePayloadHash', payload.source_payload_hash,
    'certainty', attribution.certainty,
    'displayName', attribution.display_name,
    'vendorKey', attribution.vendor_key
  ))
  FROM poem_legacy_payload_attribution payload
  JOIN legacy_model_attribution attribution
    ON attribution.attribution_key = payload.attribution_key
  WHERE payload.poem_id = poem.id
    AND payload.legacy_field = 'translation'
)
WHERE EXISTS (
  SELECT 1 FROM poem_legacy_payload_attribution payload
  WHERE payload.poem_id = poem.id
    AND payload.legacy_field = 'translation'
);

DROP TABLE IF EXISTS poem_legacy_payload_attribution;
DROP TABLE IF EXISTS legacy_model_attribution;
DROP TABLE IF EXISTS task;
