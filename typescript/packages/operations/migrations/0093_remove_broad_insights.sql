-- Word glosses and all English translation tracks remain in publication_json.
-- A NULL hash is the existing CAS token for rows edited by SQL; the next
-- publication computes a fresh SHA-256 hash. Mark changed pages for purge.
UPDATE poem
SET publication_json = CASE
      WHEN json_type(publication_json, '$.fields.modelEnrichments') = 'array'
      THEN json_set(
        json_remove(publication_json,
          '$.fields.insights', '$.fields.insightsModel',
          '$.fields.insightsReasoningEffort', '$.fields.insightsTrack'),
        '$.fields.modelEnrichments',
        json((SELECT json_group_array(json(json_remove(track.value, '$.insights')))
          FROM json_each(publication_json, '$.fields.modelEnrichments') track))
      )
      ELSE json_remove(publication_json,
        '$.fields.insights', '$.fields.insightsModel',
        '$.fields.insightsReasoningEffort', '$.fields.insightsTrack')
    END,
    publication_hash = NULL,
    publication_cache_dirty = 1
WHERE publication_json IS NOT NULL
  AND (json_type(publication_json, '$.fields.insights') IS NOT NULL
    OR json_type(publication_json, '$.fields.insightsModel') IS NOT NULL
    OR json_type(publication_json, '$.fields.insightsReasoningEffort') IS NOT NULL
    OR json_type(publication_json, '$.fields.insightsTrack') IS NOT NULL
    OR EXISTS (SELECT 1 FROM json_each(publication_json, '$.fields.modelEnrichments') track
      WHERE json_type(track.value, '$.insights') IS NOT NULL));
