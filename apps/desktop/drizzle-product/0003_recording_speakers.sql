CREATE TABLE `recording_speaker` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`speaker_key` text NOT NULL,
	`source` text NOT NULL,
	`display_name` text,
	`person_id` text,
	`confidence` integer,
	`is_owner` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_speaker_recording_key_idx` ON `recording_speaker` (`recording_id`,`speaker_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `recording_speaker_owner_idx` ON `recording_speaker` (`recording_id`) WHERE "recording_speaker"."is_owner" = 1;