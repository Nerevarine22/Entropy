CREATE TABLE community_snapshot_control (
  id TEXT PRIMARY KEY NOT NULL,
  generation TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at INTEGER NOT NULL
);

CREATE TABLE community_snapshot_chunks (
  generation TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (generation, chunk_index)
);

CREATE INDEX community_snapshot_chunks_created_at_idx
  ON community_snapshot_chunks(created_at);
