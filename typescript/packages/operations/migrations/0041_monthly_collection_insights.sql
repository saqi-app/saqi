-- Keep collection history at the granularity shown on the public page.
-- Rebuild from immutable first-observed timestamps so this migration can replay.

CREATE TABLE IF NOT EXISTS insights_collection_month (
  month TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-01'),
  poem_count INTEGER NOT NULL CHECK (poem_count >= 0)
) STRICT;

DELETE FROM insights_collection_month;
INSERT INTO insights_collection_month (month, poem_count)
SELECT date(first_observed_at, 'unixepoch', 'start of month'), count(*)
FROM source_poem_identity
GROUP BY date(first_observed_at, 'unixepoch', 'start of month')
ON CONFLICT(month) DO UPDATE SET poem_count = excluded.poem_count;

-- Keep the daily trigger until the monthly reader has been deployed.
CREATE TRIGGER IF NOT EXISTS insights_source_poem_month_insert
AFTER INSERT ON source_poem_identity
BEGIN
  INSERT INTO insights_collection_month (month, poem_count)
  VALUES (date(NEW.first_observed_at, 'unixepoch', 'start of month'), 1)
  ON CONFLICT(month) DO UPDATE SET poem_count = poem_count + 1;
END;
