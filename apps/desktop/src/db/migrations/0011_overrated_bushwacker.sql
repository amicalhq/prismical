CREATE TABLE `note_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`note_id` integer NOT NULL,
	`label` text,
	`kind` text NOT NULL,
	`ydoc_state` blob NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_snapshots_note_id_created_at_idx` ON `note_snapshots` (`note_id`,`created_at`);