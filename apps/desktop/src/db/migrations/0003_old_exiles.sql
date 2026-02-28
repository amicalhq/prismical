CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`calendar_color` text NOT NULL,
	`meeting_url` text,
	`calendar_event_url` text,
	`start_time` text,
	`end_time` text,
	`date` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `notes` ADD `starred` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `folder` text;--> statement-breakpoint
ALTER TABLE `notes` ADD `event_id` text REFERENCES events(id);--> statement-breakpoint
CREATE UNIQUE INDEX `notes_event_id_unique` ON `notes` (`event_id`);