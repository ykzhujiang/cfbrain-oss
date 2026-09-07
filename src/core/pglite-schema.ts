/**
 * PGLite schema — derived from schema-embedded.ts (Postgres schema).
 *
 * Differences from Postgres:
 * - No RLS block (no role system in embedded PGLite)
 * - No access_tokens / mcp_request_log (local-only, no remote auth)
 * - Files table included (routed through BrainEngine interface)
 * - No pg_advisory_lock (single connection)
 * - Embedding vector dimension is configurable via CFBRAIN_EMBEDDING_DIMENSIONS
 *
 * Everything else is identical: same tables, triggers, indexes, pgvector HNSW, tsvector GIN.
 *
 * DRIFT WARNING: When schema-embedded.ts changes, update this file to match.
 * test/edge-bundle.test.ts has a drift detection test.
 */

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './embedding.ts';

export function getPgliteSchemaSql(): string {
  const dim = EMBEDDING_DIMENSIONS();
  const model = EMBEDDING_MODEL();
  return buildSchema(dim, model);
}

function buildSchema(dim: number, model: string): string {
  return `
-- CFBrain PGLite schema (local embedded Postgres)

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- pages: the core content table
-- ============================================================
CREATE TABLE IF NOT EXISTS pages (
  id            SERIAL PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,
  types         TEXT[]  NOT NULL DEFAULT '{}',
  title         TEXT    NOT NULL,
  compiled_truth TEXT   NOT NULL DEFAULT '',
  frontmatter   JSONB   NOT NULL DEFAULT '{}',
  content_hash  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pages_types ON pages USING GIN(types);
CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN(frontmatter);
CREATE INDEX IF NOT EXISTS idx_pages_trgm ON pages USING GIN(title gin_trgm_ops);

-- ============================================================
-- content_chunks: chunked content with embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS content_chunks (
  id            SERIAL PRIMARY KEY,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_text    TEXT    NOT NULL,
  chunk_source  TEXT    NOT NULL DEFAULT 'compiled_truth',
  embedding     vector(${dim}),
  model         TEXT    NOT NULL DEFAULT '${model}',
  token_count   INTEGER,
  embedded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- links: cross-references between pages
-- ============================================================
CREATE TABLE IF NOT EXISTS links (
  id           SERIAL PRIMARY KEY,
  from_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type    TEXT    NOT NULL DEFAULT '',
  context      TEXT    NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(from_page_id, to_page_id)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_page_id);

-- ============================================================
-- tags
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
  id      SERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  UNIQUE(page_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);

-- ============================================================
-- raw_data: sidecar data
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_data (
  id         SERIAL PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,
  data       JSONB   NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_id, source)
);

CREATE INDEX IF NOT EXISTS idx_raw_data_page ON raw_data(page_id);

-- ============================================================
-- page_versions: snapshot history
-- ============================================================
CREATE TABLE IF NOT EXISTS page_versions (
  id             SERIAL PRIMARY KEY,
  page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  compiled_truth TEXT    NOT NULL,
  frontmatter    JSONB   NOT NULL DEFAULT '{}',
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id);

-- ============================================================
-- ingest_log
-- ============================================================
CREATE TABLE IF NOT EXISTS ingest_log (
  id            SERIAL PRIMARY KEY,
  source_type   TEXT    NOT NULL,
  source_ref    TEXT    NOT NULL,
  pages_updated JSONB   NOT NULL DEFAULT '[]',
  summary       TEXT    NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- config: brain-level settings
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('version', '1'),
  ('engine', 'pglite'),
  ('embedding_model', '${model}'),
  ('embedding_dimensions', '${dim}'),
  ('chunk_strategy', 'semantic')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- feishu_sync: Feishu/Lark wiki node sync state (Spec 02 R2)
-- ============================================================
CREATE TABLE IF NOT EXISTS feishu_sync (
  slug          TEXT NOT NULL,
  space_id      TEXT NOT NULL,
  node_token    TEXT NOT NULL,
  obj_token     TEXT NOT NULL,
  node_type     TEXT NOT NULL DEFAULT 'origin',
  parent_type   TEXT,
  last_revision INT DEFAULT 0,
  last_push_at  TIMESTAMPTZ,
  content_hash  TEXT,
  title         TEXT,
  PRIMARY KEY (slug, node_token)
);

CREATE INDEX IF NOT EXISTS idx_feishu_sync_slug ON feishu_sync(slug);
CREATE INDEX IF NOT EXISTS idx_feishu_sync_space ON feishu_sync(space_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_sync_origin_unique ON feishu_sync (slug, space_id) WHERE node_type = 'origin';

-- ============================================================
-- files: file attachments (routed through BrainEngine)
-- ============================================================
CREATE TABLE IF NOT EXISTS files (
  id           SERIAL PRIMARY KEY,
  page_slug    TEXT   REFERENCES pages(slug) ON DELETE SET NULL ON UPDATE CASCADE,
  filename     TEXT   NOT NULL,
  storage_path TEXT   NOT NULL,
  mime_type    TEXT,
  size_bytes   BIGINT,
  content_hash TEXT   NOT NULL,
  metadata     JSONB  NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(storage_path)
);
CREATE INDEX IF NOT EXISTS idx_files_page ON files(page_slug);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

-- ============================================================
-- Trigger-based search_vector
-- ============================================================
ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_pages_search ON pages USING GIN(search_vector);

CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.compiled_truth, '')), 'B');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages;
CREATE TRIGGER trg_pages_search_vector
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION update_page_search_vector();
`;
}

// Backward compat: keep the old constant export for any code that may reference it directly.
// This uses the default dimensions at import time.
export const PGLITE_SCHEMA_SQL = buildSchema(1536, 'text-embedding-3-small');
