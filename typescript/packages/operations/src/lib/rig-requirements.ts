// Canonical publication JSON is the queue. These expressions are shared by the
// candidate read and atomic claim so incomplete publications cannot be skipped.
const HasEnglishSql = `coalesce((
  json_array_length(publication_json, '$.fields.linesEnglish') > 0
  OR json_array_length(publication_json, '$.fields.linesEnglishSol') > 0
  OR json_array_length(publication_json, '$.fields.linesEnglishGemini') > 0
  OR EXISTS (SELECT 1 FROM json_each(publication_json, '$.fields.modelEnrichments') track
             WHERE json_array_length(track.value, '$.lines') > 0)
), 0)`;
const CurrentSql = `(publication_json IS NOT NULL
  AND publication_source_hash = source_hash
  AND json_extract(publication_json, '$.active') = 1)`;
const InsightsSql = `coalesce((
  length(trim(json_extract(publication_json, '$.fields.insights.summary'))) > 0
  AND length(trim(json_extract(publication_json, '$.fields.insights.historicalContext'))) > 0
  AND length(trim(json_extract(publication_json, '$.fields.insights.culturalSignificance'))) > 0
  AND json_array_length(publication_json, '$.fields.insights.themes') > 0
  AND json_array_length(publication_json, '$.fields.insights.literaryDevices') > 0
  AND json_array_length(publication_json, '$.fields.insights.notableLines') > 0
), 0)`;
const GlossesSql = `coalesce((
  (json_extract(publication_json, '$.fields.wordGlosses.sourceHash') = source_hash
    AND json_array_length(publication_json, '$.fields.wordGlosses.meanings.lines') = json_array_length(content_arabic, '$.content'))
  OR EXISTS (SELECT 1 FROM json_each(publication_json, '$.fields.modelEnrichments') track
    WHERE json_array_length(track.value, '$.wordGlosses.lines') = json_array_length(content_arabic, '$.content'))
), 0)`;
export const RequiredSql = `(SELECT json_group_array(component) FROM (
  SELECT 'translation' AS component WHERE NOT coalesce(${CurrentSql} AND ${HasEnglishSql}, 0)
  UNION ALL SELECT 'insights' WHERE NOT coalesce(${CurrentSql} AND ${InsightsSql}, 0)
  UNION ALL SELECT 'wordMeanings' WHERE NOT coalesce(${CurrentSql} AND ${GlossesSql}, 0)
))`;
export const NeedsEnrichmentSql = `json_array_length(${RequiredSql}) > 0`;
export const EnrichmentPrioritySql = `CASE WHEN NOT ${HasEnglishSql} THEN 0
  WHEN ${CurrentSql} THEN 1 ELSE 2 END`;
