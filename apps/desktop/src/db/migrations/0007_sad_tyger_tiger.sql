ALTER TABLE `folders` ADD `parent_id` integer REFERENCES folders(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `folders_parent_id_idx` ON `folders` (`parent_id`);