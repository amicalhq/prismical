CREATE TABLE `note_generation_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` integer,
	`model_instance_id` text NOT NULL,
	`model_id` text NOT NULL,
	`provider_type` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`raw_usage_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `note_generation_audit_note_id_idx` ON `note_generation_audit` (`note_id`);--> statement-breakpoint
CREATE INDEX `note_generation_audit_created_at_idx` ON `note_generation_audit` (`created_at`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `total_tokens` integer;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `raw_usage_json` text;