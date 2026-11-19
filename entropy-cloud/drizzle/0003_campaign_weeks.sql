CREATE TABLE IF NOT EXISTS `entropy_campaign_decisions` (
	`week_id` text NOT NULL,
	`rubric_id` text NOT NULL,
	`post_id` text NOT NULL,
	`post_body` text NOT NULL,
	`model_status` text NOT NULL,
	`model_choice` text,
	`confidence` real,
	`model` text,
	`manual_status` text,
	`reviewed_at` text,
	`reviewed_by` text,
	`revision` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`week_id`, `rubric_id`, `post_id`),
	CONSTRAINT "campaign_model_status" CHECK("entropy_campaign_decisions"."model_status" IN ('match','review','off_topic')),
	CONSTRAINT "campaign_model_choice" CHECK("entropy_campaign_decisions"."model_choice" IN ('match','review','off_topic')),
	CONSTRAINT "campaign_manual_status" CHECK("entropy_campaign_decisions"."manual_status" IN ('match','review','off_topic'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `entropy_campaign_weeks` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`topic` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`rubric_id` text NOT NULL
);
