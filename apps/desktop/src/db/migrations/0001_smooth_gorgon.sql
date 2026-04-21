ALTER TABLE `events` ADD `start_at` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `end_at` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `is_all_day` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `events_start_at_idx` ON `events` (`start_at`);--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `start_time`;--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `end_time`;--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `date`;