-- Hand-authored (drizzle-kit cannot model FTS5): rebuild `note_fts` with the
-- porter stemmer over unicode61 so local search stems like the cloud lane's
-- websearch_to_tsquery('english', …) does — "timelines" finds "timeline".
-- The triggers on `note` reference the virtual table by name and keep
-- working across the drop + create; the repopulate below reindexes every
-- live note.
DROP TABLE IF EXISTS `note_fts`;--> statement-breakpoint
CREATE VIRTUAL TABLE `note_fts` USING fts5(`note_id` UNINDEXED, `title`, `content_text`, tokenize = 'porter unicode61');--> statement-breakpoint
INSERT INTO `note_fts` (`note_id`, `title`, `content_text`)
	SELECT `id`, `title`, coalesce(`content_text`, '') FROM `note`
	WHERE `deleted_at` IS NULL AND `trashed_at` IS NULL;
