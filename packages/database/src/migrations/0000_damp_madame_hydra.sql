CREATE TABLE `agent_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`permission_scope` text DEFAULT '{}' NOT NULL,
	`daily_token_limit` integer,
	`daily_cost_limit_cents` integer,
	`tokens_used_today` integer DEFAULT 0 NOT NULL,
	`cost_used_today_cents` integer DEFAULT 0 NOT NULL,
	`tokens_reset_date` text,
	`last_active_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `approval_gates` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`reviewer_note` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `agent_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`ip_address` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `board_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`is_terminal` integer DEFAULT false NOT NULL,
	`wip_limit` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `board_items` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`column_id` text NOT NULL,
	`task_id` text NOT NULL,
	`sprint_id` text,
	`story_points` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`column_id`) REFERENCES `board_columns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sprint_id`) REFERENCES `sprints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'kanban' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cost_records` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`agent_workspace_id` text NOT NULL,
	`trace_id` text,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_cents` integer NOT NULL,
	`recorded_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_workspace_id`) REFERENCES `agent_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trace_id`) REFERENCES `traces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`domain` text NOT NULL,
	`project_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`resource_type` text,
	`resource_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_project_created_idx` ON `events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_domain_type_idx` ON `events` (`domain`,`type`);--> statement-breakpoint
CREATE INDEX `events_resource_idx` ON `events` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `external_event_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`source` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`entity_url` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`fetched_at` text NOT NULL,
	`purged_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `integration_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ext_cache_source_entity_idx` ON `external_event_cache` (`source`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `ext_cache_project_fetched_idx` ON `external_event_cache` (`project_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `integration_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source` text NOT NULL,
	`label` text NOT NULL,
	`encrypted_token` text NOT NULL,
	`iv` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `integration_credentials_project_source_idx` ON `integration_credentials` (`project_id`,`source`);--> statement-breakpoint
CREATE TABLE `integration_sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_synced_at` text,
	`sync_cursor` text,
	`last_error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `integration_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `milestone_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`milestone_id` text NOT NULL,
	`task_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`milestone_id`) REFERENCES `milestones`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `milestone_tasks_unique_idx` ON `milestone_tasks` (`milestone_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`due_date` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`resource_type` text,
	`resource_id` text,
	`read_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_user_read_idx` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `pm_digest_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`digest_type` text NOT NULL,
	`content` text NOT NULL,
	`generated_at` text NOT NULL,
	`valid_until` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`owner_id` text NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`iv` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sprints` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`goal` text,
	`status` text DEFAULT 'planning' NOT NULL,
	`start_date` text,
	`end_date` text,
	`velocity` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_task_id` text NOT NULL,
	`to_task_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_edges_unique_edge_idx` ON `task_edges` (`from_task_id`,`to_task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`assignee_id` text,
	`agent_workspace_id` text,
	`estimated_minutes` integer,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_workspace_id`) REFERENCES `agent_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_project_priority_idx` ON `tasks` (`project_id`,`priority`);--> statement-breakpoint
CREATE TABLE `tool_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`tool_version_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'deploying' NOT NULL,
	`deployed_by_id` text NOT NULL,
	`previous_version_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tool_version_id`) REFERENCES `tool_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deployed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`previous_version_id`) REFERENCES `tool_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tool_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`version` text NOT NULL,
	`schema` text NOT NULL,
	`implementation` text NOT NULL,
	`changelog` text,
	`published_by_id` text NOT NULL,
	`published_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`published_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tools` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_by_id` text NOT NULL,
	`latest_version_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`latest_version_id`) REFERENCES `tool_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trace_events` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`type` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`duration_ms` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`trace_id`) REFERENCES `traces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `traces` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`agent_workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_workspace_id`) REFERENCES `agent_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `traces_workspace_started_idx` ON `traces` (`agent_workspace_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `traces_project_status_idx` ON `traces` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_settings_unique_idx` ON `user_settings` (`user_id`,`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`role` text DEFAULT 'engineer' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);