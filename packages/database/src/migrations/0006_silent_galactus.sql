ALTER TABLE `external_event_cache` ADD `classification` text;--> statement-breakpoint
ALTER TABLE `external_event_cache` ADD `classified_at` text;--> statement-breakpoint
CREATE INDEX `external_event_cache_credential_purged_idx` ON `external_event_cache` (`credential_id`,`purged_at`);--> statement-breakpoint
CREATE INDEX `task_edges_to_idx` ON `task_edges` (`to_task_id`);