-- 0086 removed all invalid poems; 0088 dropped the flag-dependent indexes
-- and triggers. The deployed catalog and rig never read this flag.
ALTER TABLE poem DROP COLUMN publishable;
