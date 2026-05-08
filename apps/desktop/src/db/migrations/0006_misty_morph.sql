ALTER TABLE `notes` ADD `folder_id` integer REFERENCES folders(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `notes_folder_id_idx` ON `notes` (`folder_id`);--> statement-breakpoint
ALTER TABLE `notes` DROP COLUMN `folder`;