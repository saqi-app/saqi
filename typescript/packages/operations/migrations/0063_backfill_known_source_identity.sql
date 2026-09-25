-- Copy only identities that the existing corpus has already established.
-- Legacy poemNNN slugs are deliberately excluded: thousands collide with
-- different canonical poems and need explicit reconciliation.
-- D1 limits each query/batch to 30 seconds. This migration copies at most
-- 500 rows per phase; scripts/backfill-source-identity.mjs resumes the same
-- idempotent statements until all eligible rows have been copied.
UPDATE author
SET (source_name, source_author_id, source_url, collected_at) = (
  SELECT source_name, external_id, canonical_url, last_observed_at
  FROM source_author_identity
  WHERE canonical_author_id = author.id
)
WHERE source_name IS NULL AND id IN (
  SELECT canonical_author_id FROM source_author_identity
  WHERE canonical_author_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM author
      WHERE author.id = source_author_identity.canonical_author_id
        AND author.source_name IS NULL)
  ORDER BY canonical_author_id LIMIT 500
);

UPDATE poem
SET (source_name, source_poem_id, source_url, source_version, collected_at) = (
  SELECT source_name, external_id, canonical_url,
         coalesce(current_revision_version, 0), last_observed_at
  FROM source_poem_identity
  WHERE canonical_poem_id = poem.id
)
WHERE source_name IS NULL AND id IN (
  SELECT canonical_poem_id FROM source_poem_identity
  WHERE canonical_poem_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM poem
      WHERE poem.id = source_poem_identity.canonical_poem_id
        AND poem.source_name IS NULL)
  ORDER BY canonical_poem_id LIMIT 500
);

UPDATE poem
SET source_hash = (
  SELECT revision.content_hash
  FROM source_poem_identity source
  JOIN poem_source_revision revision
    ON revision.id = source.current_revision_id
  WHERE source.canonical_poem_id = poem.id
    AND poem.active_source_revision_id = source.current_revision_id
)
WHERE source_hash IS NULL
  AND active_source_revision_id IS NOT NULL
  AND id IN (
    SELECT source.canonical_poem_id
    FROM source_poem_identity source
    JOIN poem canonical ON canonical.id = source.canonical_poem_id
    WHERE canonical.source_hash IS NULL
      AND canonical.active_source_revision_id = source.current_revision_id
    ORDER BY source.canonical_poem_id LIMIT 500
  );
