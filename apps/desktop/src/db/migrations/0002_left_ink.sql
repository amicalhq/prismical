CREATE TABLE `note_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` integer NOT NULL,
	`kind` text DEFAULT 'summary' NOT NULL,
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
CREATE INDEX `note_artifacts_note_id_kind_idx` ON `note_artifacts` (`note_id`,`kind`);