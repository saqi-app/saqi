-- 0085 backfilled and audited all visible legacy English titles; deployed
-- readers use only name_english. Separate physical rewrites for D1 limits.
ALTER TABLE poem DROP COLUMN poem_title_first_line;
