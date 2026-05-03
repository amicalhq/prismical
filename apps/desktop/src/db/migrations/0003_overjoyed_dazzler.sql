CREATE TABLE `instances` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `instances_type_idx` ON `instances` (`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `instances_type_label_unique` ON `instances` (`type`,`label`);--> statement-breakpoint
DROP TABLE `models`;