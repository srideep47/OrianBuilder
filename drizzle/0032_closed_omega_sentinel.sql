CREATE TABLE `mission_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mission_id` integer NOT NULL,
	`run_id` integer,
	`artifact_type` text NOT NULL,
	`title` text NOT NULL,
	`uri` text,
	`body` text,
	`mime_type` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `mission_runs`(`id`) ON UPDATE no action ON DELETE set null
);
