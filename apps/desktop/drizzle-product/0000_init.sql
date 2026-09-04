CREATE TABLE `artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`recording_id` text,
	`mode` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`prev_content` text,
	`meta` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `artifact_note_id_idx` ON `artifact` (`note_id`);--> statement-breakpoint
CREATE TABLE `ask_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`messages` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `folder` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`icon_url` text,
	`is_favorite` integer DEFAULT false NOT NULL,
	`meta` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `note` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`title_source` text DEFAULT 'manual' NOT NULL,
	`title_revision` integer DEFAULT 0 NOT NULL,
	`folder_id` text,
	`event_id` text,
	`icon_url` text,
	`starred` integer DEFAULT false NOT NULL,
	`meta` text,
	`trashed_at` text,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_updated_at` text NOT NULL,
	`deleted_at` text,
	`content_markdown` text,
	`content_text` text,
	`first_line` text
);
--> statement-breakpoint
CREATE INDEX `note_folder_id_idx` ON `note` (`folder_id`);--> statement-breakpoint
CREATE TABLE `note_body_update` (
	`note_id` text NOT NULL,
	`seq` integer NOT NULL,
	`update` blob NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`note_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `note_tag` (
	`note_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	PRIMARY KEY(`note_id`, `tag_id`)
);
--> statement-breakpoint
CREATE INDEX `note_tag_tag_id_idx` ON `note_tag` (`tag_id`);--> statement-breakpoint
CREATE TABLE `note_title_run` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`title` text NOT NULL,
	`previous_title` text NOT NULL,
	`revisions` text,
	`applied_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `note_title_run_note_id_idx` ON `note_title_run` (`note_id`);--> statement-breakpoint
CREATE TABLE `recording` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`capture_mode` text NOT NULL,
	`status` text DEFAULT 'recording' NOT NULL,
	`note_id` text,
	`event_id` text,
	`transcription_config` text,
	`started_at` text,
	`ended_at` text,
	`duration_ms` integer,
	`meta` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `recording_note_id_idx` ON `recording` (`note_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `schema_meta` (
	`version` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`config` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `transcript_segment` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`source` text NOT NULL,
	`speaker` text NOT NULL,
	`text` text NOT NULL,
	`start_time_ms` integer NOT NULL,
	`end_time_ms` integer NOT NULL,
	`segment_order` integer DEFAULT 0 NOT NULL,
	`is_final` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_segment_recording_order_idx` ON `transcript_segment` (`recording_id`,`segment_order`);--> statement-breakpoint
CREATE TABLE `vocabulary` (
	`id` text PRIMARY KEY NOT NULL,
	`word` text NOT NULL,
	`replacement_word` text,
	`is_replacement` integer DEFAULT false NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vocabulary_word_idx` ON `vocabulary` (`word`);
--> statement-breakpoint
-- Hand-authored FTS5 note search index (drizzle-kit cannot model virtual tables
-- or triggers — never run drizzle-kit push against a product DB). `note` uses
-- TEXT primary keys and fts5 rowids are integers, so external-content mapping is
-- impossible; instead note_fts is a standalone fts5 table carrying the note id as
-- an UNINDEXED column, kept in sync by delete-then-insert triggers on `note`.
-- Soft-deleted rows (deleted_at or trashed_at set) are treated as deletes.
CREATE VIRTUAL TABLE `note_fts` USING fts5(`note_id` UNINDEXED, `title`, `content_text`);--> statement-breakpoint
CREATE TRIGGER `note_fts_after_insert` AFTER INSERT ON `note` BEGIN
	INSERT INTO `note_fts` (`note_id`, `title`, `content_text`)
	SELECT new.`id`, new.`title`, coalesce(new.`content_text`, '')
	WHERE new.`deleted_at` IS NULL AND new.`trashed_at` IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `note_fts_after_update` AFTER UPDATE ON `note` BEGIN
	DELETE FROM `note_fts` WHERE `note_id` = old.`id`;
	INSERT INTO `note_fts` (`note_id`, `title`, `content_text`)
	SELECT new.`id`, new.`title`, coalesce(new.`content_text`, '')
	WHERE new.`deleted_at` IS NULL AND new.`trashed_at` IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `note_fts_after_delete` AFTER DELETE ON `note` BEGIN
	DELETE FROM `note_fts` WHERE `note_id` = old.`id`;
END;