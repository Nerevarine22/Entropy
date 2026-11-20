ALTER TABLE entropy_campaign_weeks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entropy_records_campaign_date_idx ON entropy_records (
  generation,
  CASE WHEN json_valid(payload) THEN julianday(json_extract(payload,'$.publishedAt')) ELSE -1 END
) WHERE kind='post' AND chunk_index=0;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS entropy_campaign_decision_insert AFTER INSERT ON entropy_campaign_decisions
BEGIN
  UPDATE entropy_campaign_weeks SET revision=revision+1 WHERE id=NEW.week_id AND rubric_id=NEW.rubric_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS entropy_campaign_decision_update AFTER UPDATE ON entropy_campaign_decisions
BEGIN
  UPDATE entropy_campaign_weeks SET revision=revision+1 WHERE id=NEW.week_id AND rubric_id=NEW.rubric_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS entropy_campaign_decision_delete AFTER DELETE ON entropy_campaign_decisions
BEGIN
  UPDATE entropy_campaign_weeks SET revision=revision+1 WHERE id=OLD.week_id AND rubric_id=OLD.rubric_id;
END;
