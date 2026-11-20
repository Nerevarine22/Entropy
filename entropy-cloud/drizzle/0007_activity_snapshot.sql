CREATE TABLE `entropy_activity_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`refreshed_at` integer NOT NULL,
	`payload` text NOT NULL
);
