import { integer, primaryKey, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

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
]);
