CREATE TABLE `meeting_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`artifact_type` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meeting_artifacts_meeting_id_idx` ON `meeting_artifacts` (`meeting_id`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_ms` integer,
	`capture_mode` text NOT NULL,
	`state` text NOT NULL,
	`transcription_model` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `meetings_started_at_idx` ON `meetings` (`started_at`);--> statement-breakpoint
CREATE INDEX `meetings_state_idx` ON `meetings` (`state`);--> statement-breakpoint
CREATE TABLE `transcript_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`source` text NOT NULL,
	`speaker` text NOT NULL,
	`text` text NOT NULL,
	`start_time_ms` integer NOT NULL,
	`end_time_ms` integer NOT NULL,
	`is_final` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transcript_segments_meeting_id_idx` ON `transcript_segments` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `transcript_segments_start_time_ms_idx` ON `transcript_segments` (`start_time_ms`);