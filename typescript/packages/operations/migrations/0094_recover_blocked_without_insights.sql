-- Fifteen acknowledged blocked checkpoints still contain useful English and
-- word-meaning output. Remove only retired prose; keep every other output and
-- the checkpoint for validation by the existing publisher. The published poem
-- and its cache are untouched until a validated publish succeeds.
UPDATE poem
SET rig_checkpoint_json = CASE
      WHEN json_type(rig_checkpoint_json, '$.required') = 'array'
        AND json_array_length(rig_checkpoint_json, '$.required') > 1
      THEN json_set(
        json_remove(rig_checkpoint_json, '$.outputs.generation.insights'),
        '$.required',
        json((SELECT json_group_array(component.value)
          FROM json_each(rig_checkpoint_json, '$.required') component
          WHERE component.value <> 'insights')))
      ELSE json_remove(rig_checkpoint_json,
        '$.outputs.generation.insights', '$.required')
    END,
    rig_status = CASE WHEN json_extract(rig_checkpoint_json, '$.sourceHash') = source_hash
      AND json_type(rig_checkpoint_json, '$.outputs.generation.translation.lines') = 'array'
      AND json_type(rig_checkpoint_json, '$.outputs.generation.wordMeanings') = 'array'
      AND json_array_length(rig_checkpoint_json, '$.outputs.generation.translation.lines')
        = json_array_length(content_arabic, '$.content')
      AND json_array_length(rig_checkpoint_json, '$.outputs.generation.wordMeanings')
        = json_array_length(content_arabic, '$.content')
      THEN 'claimed' ELSE rig_status END,
    rig_version = rig_version + CASE
      WHEN json_extract(rig_checkpoint_json, '$.sourceHash') = source_hash
        AND json_type(rig_checkpoint_json, '$.outputs.generation.translation.lines') = 'array'
        AND json_type(rig_checkpoint_json, '$.outputs.generation.wordMeanings') = 'array'
        AND json_array_length(rig_checkpoint_json, '$.outputs.generation.translation.lines')
          = json_array_length(content_arabic, '$.content')
        AND json_array_length(rig_checkpoint_json, '$.outputs.generation.wordMeanings')
          = json_array_length(content_arabic, '$.content')
      THEN 1 ELSE 0 END
WHERE rig_status = 'blocked' AND rig_checkpoint_json IS NOT NULL
  AND (json_type(rig_checkpoint_json, '$.outputs.generation.insights') IS NOT NULL
    OR EXISTS (SELECT 1 FROM json_each(rig_checkpoint_json, '$.required') component
      WHERE component.value = 'insights'));
