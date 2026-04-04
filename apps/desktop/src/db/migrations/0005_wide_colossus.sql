ALTER TABLE `meetings` ADD `note_id` integer REFERENCES notes(id);--> statement-breakpoint
CREATE INDEX `meetings_note_id_started_at_idx` ON `meetings` (`note_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `transcript_segments` ADD `segment_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `transcript_segments_meeting_id_segment_order_idx` ON `transcript_segments` (`meeting_id`,`segment_order`);