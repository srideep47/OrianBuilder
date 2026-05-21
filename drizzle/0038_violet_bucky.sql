CREATE TABLE `device_identity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_key` text NOT NULL,
	`private_key_encrypted` text NOT NULL,
	`device_name` text NOT NULL,
	`device_type` text DEFAULT 'desktop' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `friend_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_public_key` text NOT NULL,
	`from_display_name` text NOT NULL,
	`invite_code` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trusted_peers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`display_name` text NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer,
	`added_via` text DEFAULT 'invite' NOT NULL,
	`shared_compute_enabled` integer DEFAULT 0 NOT NULL,
	`allowed_models` text,
	`permissions` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trusted_peers_public_key_unique` ON `trusted_peers` (`public_key`);