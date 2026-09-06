ALTER TABLE `recovery_outbox` ADD `owner` text;--> statement-breakpoint
ALTER TABLE `recovery_outbox` ADD `create_input` text;--> statement-breakpoint
ALTER TABLE `recovery_outbox` ADD `engine_config` text;--> statement-breakpoint
ALTER TABLE `recovery_outbox` ADD `phase` text;--> statement-breakpoint
ALTER TABLE `recovery_outbox` ADD `ended_at` integer;--> statement-breakpoint
ALTER TABLE `recovery_outbox` ADD `duration_ms` integer;