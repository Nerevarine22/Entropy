import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, real, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

// A generation is published only by a successful revision compare-and-swap.
// Leases and usage reservations live outside browser-editable snapshot data.
export const entropyControl = sqliteTable('entropy_control', {
  id: text('id').primaryKey(),
  generation: text('generation').notNull(),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
  dailyDate: text('daily_date').notNull().default(''),
  dailyAttempts: integer('daily_attempts').notNull().default(0),
});

// Individual entities, with bounded Unicode-safe chunks for unusually long
// posts or identity ledgers. No API key is stored in these records.
export const entropyRecords = sqliteTable('entropy_records', {
  generation: text('generation').notNull(),
  kind: text('kind').notNull(),
  recordId: text('record_id').notNull(),
  chunkIndex: integer('chunk_index').notNull().default(0),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.generation, table.kind, table.recordId, table.chunkIndex] }),
  index('entropy_records_created_at_idx').on(table.createdAt),
  index('entropy_records_campaign_date_idx')
    .on(table.generation, sql`CASE WHEN json_valid(${table.payload}) THEN julianday(json_extract(${table.payload},'$.publishedAt')) ELSE -1 END`)
    .where(sql`${table.kind}='post' AND ${table.chunkIndex}=0`),
]);

export const entropyCreatorReviews = sqliteTable('entropy_creator_reviews', {
  authorId: text('author_id').primaryKey(),
  snapshotId: text('snapshot_id').notNull(),
  datasetAsOf: text('dataset_as_of'),
  reviewedAt: text('reviewed_at').notNull(),
  actorId: text('actor_id').notNull(),
});

export const entropyModerationLog = sqliteTable('entropy_moderation_log', {
  id: text('id').primaryKey(),
  authorId: text('author_id').notNull(),
  postId: text('post_id'),
  action: text('action').notNull(),
  reason: text('reason'),
  snapshotId: text('snapshot_id').notNull(),
  actorId: text('actor_id').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [index('entropy_moderation_log_author_idx').on(table.authorId, table.createdAt)]);

export const entropyLeaderboardIngestion = sqliteTable('entropy_leaderboard_ingestion', {
  id: text('id').primaryKey(),
  payload: text('payload').notNull(),
});

export const entropyCampaignWeeks = sqliteTable('entropy_campaign_weeks', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  topic: text('topic').notNull(),
  startsAt: text('starts_at').notNull(),
  endsAt: text('ends_at').notNull(),
  rubricId: text('rubric_id').notNull(),
  revision: integer('revision').notNull().default(0),
});

export const entropyCampaignDecisions = sqliteTable('entropy_campaign_decisions', {
  weekId: text('week_id').notNull(),
  rubricId: text('rubric_id').notNull(),
  postId: text('post_id').notNull(),
  postBody: text('post_body').notNull(),
  modelStatus: text('model_status').notNull(),
  modelChoice: text('model_choice'),
  confidence: real('confidence'),
  model: text('model'),
  manualStatus: text('manual_status'),
  reviewedAt: text('reviewed_at'),
  reviewedBy: text('reviewed_by'),
  revision: integer('revision').notNull().default(0),
}, table => [
  primaryKey({ columns: [table.weekId, table.rubricId, table.postId] }),
  check('campaign_model_status', sql`${table.modelStatus} IN ('match','review','off_topic')`),
  check('campaign_model_choice', sql`${table.modelChoice} IN ('match','review','off_topic')`),
  check('campaign_manual_status', sql`${table.manualStatus} IN ('match','review','off_topic')`),
]);

export const entropyCampaignCollection = sqliteTable('entropy_campaign_collection', {
  id: text('id').primaryKey(),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at').notNull().default(0),
  lastStatus: text('last_status'),
  lastAttemptAt: integer('last_attempt_at'),
});

export const entropyDailyRanks = sqliteTable('entropy_daily_ranks', {
  day: text('day').notNull(),
  board: text('board').notNull(),
  ranks: text('ranks').notNull(),
}, table => [primaryKey({ columns: [table.day, table.board] })]);
