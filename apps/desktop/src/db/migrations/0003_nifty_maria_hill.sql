ALTER TABLE `notes` ADD `starred` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `notes` ADD `folder` text;
