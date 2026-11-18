CREATE TABLE IF NOT EXISTS entropy_creator_reviews (
  author_id TEXT PRIMARY KEY NOT NULL,
  snapshot_id TEXT NOT NULL,
  dataset_as_of TEXT,
  reviewed_at TEXT NOT NULL,
  actor_id TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS entropy_moderation_log (
  id TEXT PRIMARY KEY NOT NULL,
  author_id TEXT NOT NULL,
  post_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  snapshot_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entropy_moderation_log_author_idx
  ON entropy_moderation_log(author_id, created_at);
