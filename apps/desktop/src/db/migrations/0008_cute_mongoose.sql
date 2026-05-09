DROP INDEX `folders_lower_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `folders_lower_name_parent_unique` ON `folders` (LOWER("name"), COALESCE("parent_id", 0));