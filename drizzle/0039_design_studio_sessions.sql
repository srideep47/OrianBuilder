CREATE TABLE `design_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`skill_id` text,
	`design_system_id` text,
	`messages_json` text NOT NULL DEFAULT '[]',
	`current_artifact` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
