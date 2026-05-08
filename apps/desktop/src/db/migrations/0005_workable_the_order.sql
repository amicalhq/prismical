CREATE TABLE `folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_lower_name_unique` ON `folders` (LOWER("name"));--> statement-breakpoint
CREATE INDEX `folders_created_at_idx` ON `folders` (`created_at`);--> statement-breakpoint
CREATE INDEX `folders_is_favorite_idx` ON `folders` (`is_favorite`);