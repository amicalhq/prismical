CREATE TABLE `instances` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `instances_provider_idx` ON `instances` (`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `instances_provider_label_unique` ON `instances` (`provider`,`label`);--> statement-breakpoint
DROP TABLE `models`;