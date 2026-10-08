-- Correct three transcription errors in Aisha Taymur's birth celebration.
-- May Ziyadah, Aisha Taymur (1926), chapter 5, "Poetry of Courtesy":
-- https://www.safahat.org/books/30427571/5/
-- بسمي: namesake, بمنبتها: where the boughs grow, ميامن: auspicious signs.
-- Keep the other readings and paid output; only repair the affected lines.
-- The exact source, publication digest, and unleased version guard this row.
-- Stage a publish-only checkpoint so the validated publisher rebuilds gloss
-- surfaces against the corrected Arabic without paying for another generation.
UPDATE poem
SET content_arabic = json_set(content_arabic,
      '$.content[1]', 'مُذ بشرت بِسمي عَم المُصطَفى',
      '$.content[4]', 'رَقَصَت بمنبتها الغُصون بَشارَة',
      '$.content[6]', 'قالَت ميامن بشره تهن الوَرى'),
    source_hash = '2baa9f8328997ef6a900eb1d763365a75084a2378289d9bdb000fda0c0b36482',
    publication_cache_dirty = 1,
    rig_status = 'blocked',
    rig_version = rig_version + 1,
    rig_checkpoint_json = json_object(
      'phase', 'publish',
      'sourceHash', '2baa9f8328997ef6a900eb1d763365a75084a2378289d9bdb000fda0c0b36482',
      'required', json('["translation","wordMeanings"]'),
      'model', 'gpt-6.1-sol',
      'reasoningEffort', 'xhigh',
      'outputs', json_object('generation', json_object(
        'translation', json_object('lines', json_set(
          (SELECT json_extract(track.value, '$.lines')
           FROM json_each(publication_json, '$.fields.modelEnrichments') track
           WHERE json_extract(track.value, '$.modelKey') = 'saqi-current'),
          '$[1]', 'Since they received glad tidings of the namesake of al-Mustafa’s paternal uncle.',
          '$[4]', 'The boughs danced where they grew, in glad celebration,',
          '$[6]', 'The auspicious signs of his glad tidings said: may humankind rejoice.')),
        'wordMeanings', json((
          SELECT json_group_array(json(CASE
            WHEN CAST(line.key AS INTEGER) = 6
            THEN '["said","the auspicious signs of","his glad tidings","may rejoice","humankind"]'
            ELSE (
              SELECT json_group_array(CASE
                WHEN CAST(line.key AS INTEGER) = 1
                  AND json_extract(segment.value, '$.tokenIndex') = 2
                THEN 'of the namesake of'
                WHEN CAST(line.key AS INTEGER) = 4
                  AND json_extract(segment.value, '$.tokenIndex') = 1
                THEN 'where they grew'
                ELSE json_extract(segment.value, '$.meaning') END)
              FROM json_each(line.value, '$.segments') segment
              WHERE json_extract(segment.value, '$.kind') = 'word'
            ) END))
          FROM json_each(publication_json, '$.fields.wordGlosses.meanings.lines') line
        ))
      ))
    )
WHERE id = '42abb5a1-df0d-47b0-bcb7-c8cdde33ae81'
  AND name_arabic = 'قرت عيون السعادة بالصفا'
  AND source_hash = '5dc8b828bc16150ce597cbee716b257fb4d2c9dcb12f072dc1c95485eb9101cd'
  AND rig_status = 'complete' AND rig_version = 4
  AND rig_lease_token IS NULL AND rig_checkpoint_json IS NULL
  AND publication_source_hash = source_hash
  AND publication_hash = 'c793fecd5c70b677c6fd8d825000ba565cb62824e4d8faa11c6eb92924d0d828'
  AND json_extract(publication_json, '$.active') = 1
  AND json_array_length(content_arabic, '$.content') = 8
  AND json_extract(content_arabic, '$.content[0]') = 'قرت عُيون السَعادَةِ بِالصَفا'
  AND json_extract(content_arabic, '$.content[1]') = 'مُذ بشرت بِسعي عَم المُصطَفى'
  AND json_extract(content_arabic, '$.content[2]') = 'عباس أَشرَق بِالمَعالي نجمه'
  AND json_extract(content_arabic, '$.content[3]') = 'من نير التَوفيق سَعد أَشرَقا'
  AND json_extract(content_arabic, '$.content[4]') = 'رَقَصَت بمنيتها الغُصون بَشارَة'
  AND json_extract(content_arabic, '$.content[5]') = 'بِقُدوم من بوجودِهِ دهر صفا'
  AND json_extract(content_arabic, '$.content[6]') = 'قالَت ميا من بشره تهن الوَرى'
  AND json_extract(content_arabic, '$.content[7]') = 'فَالاِمن وَالتَوفيق فَوزا أَخلَفا'
  AND json_array_length(publication_json, '$.fields.wordGlosses.meanings.lines') = 8
  AND json_extract(publication_json, '$.fields.wordGlosses.sourceHash') = source_hash
  AND json_extract(publication_json, '$.fields.wordGlosses.model') = 'gpt-6.1-sol'
  AND (SELECT count(*) FROM json_each(publication_json, '$.fields.modelEnrichments') track
       WHERE json_extract(track.value, '$.modelKey') = 'saqi-current') = 1
  AND EXISTS (
    SELECT 1 FROM json_each(publication_json, '$.fields.modelEnrichments') track
    WHERE json_extract(track.value, '$.modelKey') = 'saqi-current'
      AND json_extract(track.value, '$.model') = 'gpt-6.1-sol'
      AND json_extract(track.value, '$.reasoningEffort') = 'xhigh'
      AND json_array_length(track.value, '$.lines') = 8
      AND json_extract(track.value, '$.lines[1]') = 'Since they received glad tidings of the endeavor of al-Mustafa’s paternal uncle.'
      AND json_extract(track.value, '$.lines[4]') = 'The boughs danced at their heart’s desire, in glad celebration,'
      AND json_extract(track.value, '$.lines[6]') = 'They said [unclear word]: humankind rejoices at his glad tidings.'
  );
