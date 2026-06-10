CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`label` text NOT NULL,
	`encrypted_token` text NOT NULL,
	`iv` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `global_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`iv` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `global_settings_key_unique` ON `global_settings` (`key`);