CREATE TABLE IF NOT EXISTS entropy_campaign_collection (
  id TEXT PRIMARY KEY NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  last_attempt_at INTEGER
);
--> statement-breakpoint
INSERT OR IGNORE INTO entropy_campaign_collection (id) VALUES ('main');
