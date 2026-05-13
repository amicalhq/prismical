ALTER TABLE `note_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
ALTER TABLE `artifacts` RENAME COLUMN "kind" TO "skill_id";--> statement-breakpoint
CREATE TABLE `org_skill_installations` (
	`org_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`installed_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`org_id`, `skill_id`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon_url` text,
	`body` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`config` text NOT NULL,
	`allowed_tools` text,
	`created_by` text,
	`org_id` text,
	`system` integer DEFAULT false NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`parent_skill_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`parent_skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_unique` ON `skills` (`slug`);--> statement-breakpoint
CREATE INDEX `skills_enabled_idx` ON `skills` (`enabled`);--> statement-breakpoint
CREATE TABLE `user_skill_preferences` (
	`user_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`user_id`, `skill_id`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` integer NOT NULL,
	`skill_id` text NOT NULL,
	`mode` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`generator` text NOT NULL,
	`model_id` text,
	`meta` text,
	`generated_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_artifacts`("id", "note_id", "skill_id", "mode", "version", "content", "generator", "model_id", "meta", "generated_at", "created_at", "updated_at") SELECT "id", "note_id", "skill_id", 'replace-doc', 1, "content", "generator", "model_id", "meta", "generated_at", "created_at", "updated_at" FROM `artifacts`;--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `artifacts_note_id_skill_id_idx` ON `artifacts` (`note_id`,`skill_id`);--> statement-breakpoint
CREATE INDEX `artifacts_note_id_generated_at_idx` ON `artifacts` (`note_id`,`generated_at`);