CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
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
	`note_id` integer,
	`title` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_ms` integer,
	`capture_mode` text NOT NULL,
	`state` text NOT NULL,
	`transcription_model` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meetings_note_id_started_at_idx` ON `meetings` (`note_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `meetings_started_at_idx` ON `meetings` (`started_at`);--> statement-breakpoint
CREATE INDEX `meetings_state_idx` ON `meetings` (`state`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` text,
	`context` text,
	`description` text,
	`local_path` text,
	`size_bytes` integer,
	`checksum` text,
	`downloaded_at` integer,
	`original_model` text,
	`speed` real,
	`accuracy` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`provider`, `id`)
);
--> statement-breakpoint
CREATE INDEX `models_provider_idx` ON `models` (`provider`);--> statement-breakpoint
CREATE INDEX `models_type_idx` ON `models` (`type`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '',
	`icon` text,
	`starred` integer DEFAULT false NOT NULL,
	`folder` text,
	`event_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notes_event_id_unique` ON `notes` (`event_id`);--> statement-breakpoint
CREATE TABLE `transcript_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`source` text NOT NULL,
	`speaker` text NOT NULL,
	`text` text NOT NULL,
	`start_time_ms` integer NOT NULL,
	`end_time_ms` integer NOT NULL,
	`segment_order` integer DEFAULT 0 NOT NULL,
	`is_final` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transcript_segments_meeting_id_idx` ON `transcript_segments` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `transcript_segments_meeting_id_segment_order_idx` ON `transcript_segments` (`meeting_id`,`segment_order`);--> statement-breakpoint
CREATE INDEX `transcript_segments_start_time_ms_idx` ON `transcript_segments` (`start_time_ms`);--> statement-breakpoint
CREATE TABLE `transcriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`timestamp` integer DEFAULT (unixepoch()) NOT NULL,
	`language` text DEFAULT 'en',
	`audio_file` text,
	`confidence` real,
	`duration` integer,
	`speech_model` text,
	`formatting_model` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vocabulary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`word` text NOT NULL,
	`replacement_word` text,
	`is_replacement` integer DEFAULT false,
	`date_added` integer DEFAULT (unixepoch()) NOT NULL,
	`usage_count` integer DEFAULT 0,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vocabulary_word_unique` ON `vocabulary` (`word`);--> statement-breakpoint
CREATE TABLE `yjs_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`note_id` integer NOT NULL,
	`update_data` blob NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `yjs_updates_note_id_idx` ON `yjs_updates` (`note_id`);
