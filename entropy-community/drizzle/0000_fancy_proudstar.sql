CREATE TABLE `community_snapshot_chunks` (
	`generation` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`generation`, `chunk_index`)
);
--> statement-breakpoint
CREATE INDEX `community_snapshot_chunks_created_at_idx` ON `community_snapshot_chunks` (`created_at`);--> statement-breakpoint
CREATE TABLE `community_snapshot_control` (
	`id` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`source_revision` integer NOT NULL,
	`digest` text NOT NULL,
	`updated_at` text NOT NULL,
	`published_at` integer NOT NULL
);
