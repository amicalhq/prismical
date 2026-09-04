ALTER TABLE `note_title_run` ADD `skill_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `note_title_run` ADD `previous_source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `note_title_run` ADD `base_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `note_title_run` ADD `applied_revision` integer;--> statement-breakpoint
ALTER TABLE `note_title_run` ADD `result` text;--> statement-breakpoint
ALTER TABLE `note_title_run` ADD `undone_at` text;--> statement-breakpoint
ALTER TABLE `skill` ADD `icon_url` text;--> statement-breakpoint
ALTER TABLE `skill` ADD `body` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `skill` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `skill` ADD `allowed_tools` text;--> statement-breakpoint
ALTER TABLE `skill` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `skill` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `skill` ADD `deleted_at` text;