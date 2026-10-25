-- A channel's own description — what the panel shows under its name.
--
-- ⚠️ Added rather than shipped in 0007 because the first cut rendered every channel with the *default
-- stream's* description ("Community-wide discussion"), which is a claim about content the channel does
-- not necessarily hold. A row that describes a channel it is not describing is the same defect as any
-- other placeholder standing in for real data.
--
-- Nullable: a channel created before this column existed has no description, and that is a different
-- fact from an empty one. The panel renders nothing rather than inventing a line.
ALTER TABLE channels ADD COLUMN description TEXT;
