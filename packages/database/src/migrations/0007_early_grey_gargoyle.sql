CREATE TABLE `mutation_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`op_id` text NOT NULL,
	`project_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`source` text NOT NULL,
	`remote_link_id` text,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`base_version` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`result` text,
	`applied_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `integration_credentials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`remote_link_id`) REFERENCES `remote_links`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mutation_queue_op_id_unique` ON `mutation_queue` (`op_id`);--> statement-breakpoint
CREATE INDEX `mutation_queue_credential_status_created_idx` ON `mutation_queue` (`credential_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `remote_links` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`source` text NOT NULL,
	`local_type` text NOT NULL,
	`local_id` text NOT NULL,
	`remote_type` text NOT NULL,
	`remote_id` text NOT NULL,
	`container_remote_id` text,
	`remote_url` text,
	`remote_version` text,
	`last_synced_hash` text,
	`last_pulled_at` text,
	`last_pushed_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `integration_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_links_local_unique_idx` ON `remote_links` (`local_type`,`local_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_links_remote_unique_idx` ON `remote_links` (`credential_id`,`remote_type`,`remote_id`);--> statement-breakpoint
CREATE INDEX `remote_links_project_source_idx` ON `remote_links` (`project_id`,`source`);--> statement-breakpoint
CREATE TABLE `sync_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`remote_link_id` text NOT NULL,
	`mutation_id` text,
	`base_snapshot` text DEFAULT '{}' NOT NULL,
	`local_snapshot` text DEFAULT '{}' NOT NULL,
	`remote_snapshot` text DEFAULT '{}' NOT NULL,
	`resolution` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`remote_link_id`) REFERENCES `remote_links`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mutation_id`) REFERENCES `mutation_queue`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sync_conflicts_project_resolved_idx` ON `sync_conflicts` (`project_id`,`resolved_at`);