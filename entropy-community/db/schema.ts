import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const snapshotControl = sqliteTable('community_snapshot_control', {
  id: text('id').primaryKey().notNull(),
  generation: text('generation').notNull(),
  sourceRevision: integer('source_revision').notNull(),
  digest: text('digest').notNull(),
  updatedAt: text('updated_at').notNull(),
  publishedAt: integer('published_at').notNull(),
});

export const snapshotChunks = sqliteTable('community_snapshot_chunks', {
  generation: text('generation').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.generation, table.chunkIndex] }),
  index('community_snapshot_chunks_created_at_idx').on(table.createdAt),
]);
