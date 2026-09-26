-- Apply after graph contraction and deployment of the canonical
-- reader/writer, with a fresh verified archive and full public-output parity.
-- Run once through the D1 migration ledger; do not rewrite applied migrations.
-- Two English-title inputs stay until their validator-aware backfill is proved.

DROP TRIGGER IF EXISTS poem_catalog_flags_after_update;
DROP TRIGGER IF EXISTS poem_sort_name_after_insert;
CREATE TRIGGER poem_sort_name_after_insert
AFTER INSERT ON poem
BEGIN
  UPDATE poem
  SET sort_name_arabic = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    trim(NEW.name_arabic),
    'ـ', ''), 'ً', ''), 'ٌ', ''), 'ٍ', ''), 'َ', ''), 'ُ', ''), 'ِ', ''), 'ّ', ''), 'ْ', ''), 'ٰ', ''),
    'أ', 'ا'), 'إ', 'ا'), 'آ', 'ا'), 'ٱ', 'ا'), 'ى', 'ي'), 'ؤ', 'و'), 'ئ', 'ي')
  WHERE id = NEW.id;
END;

ALTER TABLE poem DROP COLUMN translation;
ALTER TABLE poem DROP COLUMN translation_gemini;
ALTER TABLE poem DROP COLUMN insights;
ALTER TABLE poem DROP COLUMN english_name_original_translation;
ALTER TABLE poem DROP COLUMN legacy_translation_attributions;
ALTER TABLE poem DROP COLUMN has_english;
ALTER TABLE poem DROP COLUMN has_insights;
ALTER TABLE poem DROP COLUMN source_version;
ALTER TABLE poem DROP COLUMN publication_version;
