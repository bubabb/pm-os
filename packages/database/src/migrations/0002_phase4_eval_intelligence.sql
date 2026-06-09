CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`suite` text NOT NULL,
	`runner` text NOT NULL,
	`total` integer NOT NULL,
	`passed` integer NOT NULL,
	`pass_rate` real NOT NULL,
	`avg_score` real NOT NULL,
	`results` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `eval_runs_project_suite_idx` ON `eval_runs` (`project_id`,`suite`);--> statement-breakpoint
CREATE TABLE `learnings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source` text NOT NULL,
	`task_id` text,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `learnings_project_idx` ON `learnings` (`project_id`);