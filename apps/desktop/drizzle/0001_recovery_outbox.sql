CREATE TABLE `recovery_outbox` (
	`recording_id` text PRIMARY KEY NOT NULL,
	`note_id` text,
	`capture_mode` text NOT NULL,
	`wav_path` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_chunk_index` integer,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
