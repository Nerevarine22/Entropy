CREATE TABLE `entropy_control` (
	`id` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`daily_date` text DEFAULT '' NOT NULL,
	`daily_attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entropy_records` (
	`generation` text NOT NULL,
	`kind` text NOT NULL,
	`record_id` text NOT NULL,
	`chunk_index` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`generation`, `kind`, `record_id`, `chunk_index`)
);
--> statement-breakpoint
CREATE INDEX `entropy_records_created_at_idx` ON `entropy_records` (`created_at`);