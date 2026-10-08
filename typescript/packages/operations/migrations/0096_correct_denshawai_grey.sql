-- This Denshawai song addresses Sir Edward Grey, not someone named Gary.
-- Contemporary reference: UK Parliament, 2 July 1906, Denshawi Executions.
-- https://api.parliament.uk/historic-hansard/commons/1906/jul/02/the-denshawi-executions
-- Preserve the paid translation and glosses in a publish-only checkpoint.
-- Exact source/output/version guards prevent replacing changed or leased work.
-- The public snapshot stays visible until the validated publisher replaces it.
UPDATE poem
SET rig_status = 'blocked',
    rig_version = rig_version + 1,
    rig_checkpoint_json = json_object(
      'phase', 'publish',
      'sourceHash', source_hash,
      'required', json('["translation","wordMeanings"]'),
      'model', 'gpt-6.1-sol',
      'reasoningEffort', 'xhigh',
      'outputs', json_object('generation', json_object(
        'translation', json_object('lines', json_set(
          (SELECT json_extract(track.value, '$.lines')
           FROM json_each(publication_json, '$.fields.modelEnrichments') track
           WHERE json_extract(track.value, '$.modelKey') = 'saqi-current'),
          '$[1]', 'Lament to Sir Grey')),
        'wordMeanings', json((
          SELECT json_group_array(json((
            SELECT json_group_array(CASE
              WHEN CAST(line.key AS INTEGER) = 1
                AND json_extract(segment.value, '$.tokenIndex') = 2
              THEN 'Grey'
              ELSE json_extract(segment.value, '$.meaning') END)
            FROM json_each(line.value, '$.segments') segment
            WHERE json_extract(segment.value, '$.kind') = 'word'
          )))
          FROM json_each(publication_json, '$.fields.wordGlosses.meanings.lines') line
        ))
      ))
    )
WHERE id = '1decb5cf-9f1a-4590-ac03-075df4f6c18d'
  AND rig_status = 'complete' AND rig_version = 4
  AND rig_lease_token IS NULL AND rig_checkpoint_json IS NULL
  AND publication_source_hash = source_hash
  AND publication_hash IS NOT NULL
  AND json_extract(publication_json, '$.active') = 1
  AND json_array_length(content_arabic, '$.content') = 8
  AND json_extract(content_arabic, '$.content[1]') = 'نوِّحي للسير جارى'
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
      AND json_extract(track.value, '$.lines[1]') = 'Lament to Sir Gary'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(publication_json, '$.fields.wordGlosses.meanings.lines[1].segments') segment
    WHERE json_extract(segment.value, '$.kind') = 'word'
      AND json_extract(segment.value, '$.tokenIndex') = 2
      AND json_extract(segment.value, '$.surface') = 'جارى'
      AND json_extract(segment.value, '$.meaning') = 'Gary'
  );
