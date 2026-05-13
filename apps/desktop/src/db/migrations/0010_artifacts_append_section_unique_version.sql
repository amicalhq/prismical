CREATE UNIQUE INDEX `artifacts_note_id_skill_id_version_append_unique` ON `artifacts` (`note_id`,`skill_id`,`version`) WHERE mode = 'append-section';
