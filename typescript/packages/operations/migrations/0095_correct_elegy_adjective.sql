-- The elegy addresses Atiyya after his brothers Muhammad, Abdullah, and Yahya.
-- العليين is an adjective here, not two people called Ali.
-- Source: https://alghadir-encyclopedia.com/52-الفقيه-عمارة/
-- Preserve the paid output in a publish-only checkpoint. The public snapshot
-- remains visible until the ordinary validated publisher replaces it.
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
          '$[1]', 'your brother, and your two noble brothers who went before,')),
        'wordMeanings', json((
          SELECT json_group_array(json((
            SELECT json_group_array(CASE
              WHEN CAST(line.key AS INTEGER) = 1
                AND json_extract(segment.value, '$.tokenIndex') = 2
              THEN 'the two noble ones'
              ELSE json_extract(segment.value, '$.meaning') END)
            FROM json_each(line.value, '$.segments') segment
            WHERE json_extract(segment.value, '$.kind') = 'word'
          )))
          FROM json_each(publication_json, '$.fields.wordGlosses.meanings.lines') line
        ))
      ))
    )
WHERE id = 'b2d4eaf2-6345-4049-8132-a489b785dad7'
  AND rig_status = 'complete' AND rig_version = 4
  AND rig_lease_token IS NULL AND rig_checkpoint_json IS NULL
  AND publication_source_hash = source_hash
  AND publication_hash IS NOT NULL
  AND json_extract(publication_json, '$.active') = 1
  AND json_array_length(content_arabic, '$.content') = 18
  AND json_extract(content_arabic, '$.content[1]') = 'أخيك وصنويك العليين من قبل'
  AND json_array_length(publication_json, '$.fields.wordGlosses.meanings.lines') = 18
  AND json_extract(publication_json, '$.fields.wordGlosses.sourceHash') = source_hash
  AND json_extract(publication_json, '$.fields.wordGlosses.model') = 'gpt-6.1-sol'
  AND (SELECT count(*) FROM json_each(publication_json, '$.fields.modelEnrichments') track
       WHERE json_extract(track.value, '$.modelKey') = 'saqi-current') = 1
  AND EXISTS (
    SELECT 1 FROM json_each(publication_json, '$.fields.modelEnrichments') track
    WHERE json_extract(track.value, '$.modelKey') = 'saqi-current'
      AND json_extract(track.value, '$.model') = 'gpt-6.1-sol'
      AND json_extract(track.value, '$.reasoningEffort') = 'xhigh'
      AND json_array_length(track.value, '$.lines') = 18
      AND json_extract(track.value, '$.lines[1]') = 'your brother, and your two brothers, the two Alis, who went before,'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(publication_json, '$.fields.wordGlosses.meanings.lines[1].segments') segment
    WHERE json_extract(segment.value, '$.kind') = 'word'
      AND json_extract(segment.value, '$.tokenIndex') = 2
      AND json_extract(segment.value, '$.surface') = 'العليين'
      AND json_extract(segment.value, '$.meaning') = 'the two Alis'
  );
