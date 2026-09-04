CREATE TABLE `local_model` (
	`model_id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum` text NOT NULL,
	`downloaded_at` text NOT NULL,
	`verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
