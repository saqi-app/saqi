import json
import os
import subprocess
from datetime import datetime, timezone
from typing import TypeAlias


AuditCountRow: TypeAlias = dict[str, int | str | None]


def validated_audit_row(raw: object) -> AuditCountRow:
    if not isinstance(raw, list) or len(raw) != 1:
        raise RuntimeError("Corpus count query failed")
    response = raw[0]
    if not isinstance(response, dict) or response.get("success") is not True:
        raise RuntimeError("Corpus count query failed")
    rows = response.get("results")
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise RuntimeError("Corpus count query failed")
    row = rows[0]
    for key, value in row.items():
        if key in ("rigSampleId", "legacySampleId"):
            valid = value is None or isinstance(value, str)
        else:
            valid = isinstance(value, int) and not isinstance(value, bool) and value >= 0
        if not valid:
            raise RuntimeError("Corpus count query returned an invalid aggregate")
    return row


def query_audit_counts(sql) -> AuditCountRow:
    result = subprocess.run(
        ["yarn", "workspace", "@saqi/operations", "db:execute",
         "--remote", "--json", "--command", sql],
        check=True, capture_output=True, text=True, timeout=40,
    )
    return validated_audit_row(json.loads(result.stdout))  # sarj-noqa: SARJ411 — The stdlib validator above checks response shape and every field; malformed-response fixtures enforce it.


started_at = datetime.now(timezone.utc).isoformat()
totals = {"poems": 0, "translatedPoems": 0, "rigPublishedTranslatedPoems": 0, "rigPublicationsWithCurrentSource": 0, "rigPublicationsPendingCachePurge": 0, "poemsWithInvalidTrimIdentity": 0, "poemsWithoutMeaningfulArabic": 0}
samples = []
whitespace = [*range(9, 14), 32, 160, 5760, *range(8192, 8203), 8232, 8233, 8239, 8287, 12288, 65279]
whitespace_sql = " || ".join(f"char({codepoint})" for codepoint in whitespace)
# Cover every ID, including non-UUID legacy IDs, with disjoint ranges.
boundaries = ["", *"123456789abcdef", None]
for lower, upper in zip(boundaries, boundaries[1:]):
    upper_bound = f"AND p.id < '{upper}'" if upper is not None else ""
    sql = f"""
    WITH translation_presence AS (
      SELECT p.id,
      p.source_hash, p.publication_source_hash,
      p.publication_cache_dirty AS cache_dirty,
      (trim(p.id, {whitespace_sql}) = '' OR p.id <> trim(p.id, {whitespace_sql})
        OR trim(p.slug, {whitespace_sql}) = '' OR p.slug <> trim(p.slug, {whitespace_sql})
        OR trim(p.name_arabic, {whitespace_sql}) = '' OR p.name_arabic <> trim(p.name_arabic, {whitespace_sql})) AS invalid_trim_identity,
      NOT EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(p.content_arabic)
          THEN p.content_arabic ELSE '{{"content":[]}}' END, '$.content') line
        WHERE line.type = 'text' AND trim(line.value, {whitespace_sql}) <> ''
      ) AS no_meaningful_arabic,
      coalesce((
        EXISTS (
          SELECT 1 FROM json_each(p.publication_json, '$.fields.linesEnglish') line
          WHERE line.type = 'text' AND trim(line.value, {whitespace_sql}) <> ''
        ) OR EXISTS (
          SELECT 1 FROM json_each(p.publication_json, '$.fields.linesEnglishSol') line
          WHERE line.type = 'text' AND trim(line.value, {whitespace_sql}) <> ''
        ) OR EXISTS (
          SELECT 1 FROM json_each(p.publication_json, '$.fields.linesEnglishGemini') line
          WHERE line.type = 'text' AND trim(line.value, {whitespace_sql}) <> ''
        ) OR EXISTS (
          SELECT 1 FROM json_each(p.publication_json, '$.fields.modelEnrichments') track,
            json_each(CASE WHEN track.type = 'object' THEN track.value ELSE '{{}}' END, '$.lines') line
          WHERE line.type = 'text' AND trim(line.value, {whitespace_sql}) <> ''
        )
      ), 0) AS has_english,
      coalesce(json_extract(p.publication_json, '$.active'), 0) AS active
      FROM poem p JOIN author a ON a.id = p.author_id
      WHERE p.id >= '{lower}' {upper_bound}
    )
    SELECT count(*) AS poems,
      coalesce(sum(has_english), 0) AS translatedPoems,
      coalesce(sum(has_english AND active = 1), 0) AS rigPublishedTranslatedPoems,
      coalesce(sum(has_english AND active = 1 AND source_hash IS NOT NULL
        AND publication_source_hash = source_hash), 0) AS rigPublicationsWithCurrentSource,
      coalesce(sum(has_english AND active = 1 AND cache_dirty = 1), 0) AS rigPublicationsPendingCachePurge,
      coalesce(sum(invalid_trim_identity), 0) AS poemsWithInvalidTrimIdentity,
      coalesce(sum(no_meaningful_arabic), 0) AS poemsWithoutMeaningfulArabic,
      min(CASE WHEN has_english AND active = 1 THEN id END) AS rigSampleId,
      min(CASE WHEN has_english AND active = 0 THEN id END) AS legacySampleId
    FROM translation_presence;
    """
    row = query_audit_counts(sql)
    samples.append({key: row[key] for key in ("rigSampleId", "legacySampleId")})
    for key in totals:
        totals[key] += row[key]
author_counts = query_audit_counts(f"""
SELECT count(*) AS authors,
  coalesce(sum(trim(id, {whitespace_sql}) = '' OR id <> trim(id, {whitespace_sql})
    OR trim(slug, {whitespace_sql}) = '' OR slug <> trim(slug, {whitespace_sql})
    OR trim(name_arabic, {whitespace_sql}) = '' OR name_arabic <> trim(name_arabic, {whitespace_sql})
    OR (name IS NOT NULL AND trim(name, {whitespace_sql}) <> ''
      AND name <> trim(name, {whitespace_sql}))), 0) AS authorsWithInvalidTrimIdentity
FROM author;
""")
report = {
    "startedAt": started_at,
    "checkedAt": datetime.now(timezone.utc).isoformat(),
    **totals,
    **author_counts,
    "samples": samples,
}
print("SAQI_TRANSLATION_TOTALS " + json.dumps(report), flush=True)
with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
    summary.write("Translated poem totals (each poem counted once):\n\n")
    summary.write("`rigPublishedTranslatedPoems` counts completed rig snapshots, not every visible English translation. "
                  "The public site also renders valid legacy snapshots with `active: false`. "
                  "These database counts do not verify every public URL or snapshot schema.\n\n")
    summary.write("Catalog whitespace counts use all 25 ECMAScript trim characters and return only aggregates. "
                  "Queries are read-only, partitioned, and limited to 40 seconds each; live writers continue normally.\n\n")
    summary.write("```json\n" + json.dumps(report, indent=2) + "\n```\n")
