CREATE TABLE `mission_interrupts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mission_id` integer NOT NULL,
	`source` text DEFAULT 'system' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`injected_at` integer,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
