import type { BrainEngine } from './engine.ts';
import { slugifyPath } from './sync.ts';

/**
 * Schema migrations — run automatically on initSchema().
 *
 * Each migration is a version number + idempotent SQL. Migrations are embedded
 * as string constants (Bun's --compile strips the filesystem).
 *
 * Each migration runs in a transaction: if the SQL fails, the version stays
 * where it was and the next run retries cleanly.
 *
 * Migrations can also include a handler function for application-level logic
 * (e.g., data transformations that need TypeScript, not just SQL).
 */

interface Migration {
  version: number;
  name: string;
  sql: string;
  handler?: (engine: BrainEngine) => Promise<void>;
}

// Migrations are embedded here, not loaded from files.
// Add new migrations at the end. Never modify existing ones.
const MIGRATIONS: Migration[] = [
  // Version 1 is the baseline (schema.sql creates everything with IF NOT EXISTS).
  {
    version: 2,
    name: 'slugify_existing_pages',
    sql: '',
    handler: async (engine) => {
      const pages = await engine.listPages();
      let renamed = 0;
      for (const page of pages) {
        const newSlug = slugifyPath(page.slug);
        if (newSlug !== page.slug) {
          try {
            await engine.updateSlug(page.slug, newSlug);
            await engine.rewriteLinks(page.slug, newSlug);
            renamed++;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`  Warning: could not rename "${page.slug}" → "${newSlug}": ${msg}`);
          }
        }
      }
      if (renamed > 0) console.log(`  Renamed ${renamed} slugs`);
    },
  },
  {
    version: 3,
    name: 'unique_chunk_index',
    sql: `
      -- Deduplicate any existing duplicate (page_id, chunk_index) rows before adding constraint
      DELETE FROM content_chunks a USING content_chunks b
        WHERE a.page_id = b.page_id AND a.chunk_index = b.chunk_index AND a.id > b.id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
    `,
  },
  {
    version: 4,
    name: 'access_tokens_and_mcp_log',
    sql: `
      CREATE TABLE IF NOT EXISTS access_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT[],
        created_at TIMESTAMPTZ DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS mcp_request_log (
        id SERIAL PRIMARY KEY,
        token_name TEXT,
        operation TEXT NOT NULL,
        latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'success',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    version: 5,
    name: 'type_to_types_array',
    sql: `
      DO $$
      BEGIN
        -- Only run column migration if old 'type' column exists (upgrading from old schema)
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pages' AND column_name = 'type') THEN
          ALTER TABLE pages ADD COLUMN IF NOT EXISTS types TEXT[] NOT NULL DEFAULT '{}';
          UPDATE pages SET types = ARRAY[type] WHERE type IS NOT NULL AND types = '{}';
          DROP INDEX IF EXISTS idx_pages_type;
          ALTER TABLE pages DROP COLUMN type;
        END IF;
        -- Create GIN index if it doesn't exist (idempotent for both fresh installs and upgrades)
        CREATE INDEX IF NOT EXISTS idx_pages_types ON pages USING GIN(types);
      END $$;
    `,
  },
  {
    version: 6,
    name: 'feishu_sync_table',
    sql: `
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
        PRIMARY KEY (slug, node_token)
      );
      CREATE INDEX IF NOT EXISTS idx_feishu_sync_slug ON feishu_sync(slug);
      CREATE INDEX IF NOT EXISTS idx_feishu_sync_space ON feishu_sync(space_id);
    `,
  },
  {
    version: 7,
    name: 'remove_timeline',
    sql: `
      ALTER TABLE pages DROP COLUMN IF EXISTS timeline;
      DROP TRIGGER IF EXISTS trg_timeline_search_vector ON timeline_entries;
      DROP FUNCTION IF EXISTS update_page_search_vector_from_timeline();
      DROP TABLE IF EXISTS timeline_entries;
    `,
  },
  {
    version: 8,
    name: 'feishu_sync_title_column',
    sql: `
      ALTER TABLE feishu_sync ADD COLUMN IF NOT EXISTS title TEXT;
    `,
  },
  {
    version: 9,
    name: 'feishu_sync_origin_unique',
    sql: `
      -- Clean duplicate origins: keep only the newest per (slug, space_id)
      DELETE FROM feishu_sync
      WHERE (slug, node_token) IN (
        SELECT slug, node_token FROM (
          SELECT slug, node_token, ROW_NUMBER() OVER (PARTITION BY slug, space_id ORDER BY last_push_at DESC NULLS LAST) as rn
          FROM feishu_sync
          WHERE node_type = 'origin'
        ) ranked
        WHERE rn > 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_sync_origin_unique ON feishu_sync (slug, space_id) WHERE node_type = 'origin';
    `,
  },
  {
    version: 10,
    name: 'feishu_sync_root_parent_type',
    sql: `
      -- Spec 19 R3: rename parent_type 'root' → '__root__' for root-pinning shortcuts
      UPDATE feishu_sync SET parent_type = '__root__' WHERE parent_type = 'root' AND node_type = 'shortcut';
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS.length > 0
  ? MIGRATIONS[MIGRATIONS.length - 1].version
  : 1;

export async function runMigrations(engine: BrainEngine): Promise<{ applied: number; current: number }> {
  const currentStr = await engine.getConfig('version');
  const current = parseInt(currentStr || '1', 10);

  let applied = 0;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      // SQL migration (transactional)
      if (m.sql) {
        await engine.transaction(async (tx) => {
          await tx.runMigration(m.version, m.sql);
        });
      }

      // Application-level handler (runs outside transaction for flexibility)
      if (m.handler) {
        await m.handler(engine);
      }

      // Update version after both SQL and handler succeed
      await engine.setConfig('version', String(m.version));
      console.log(`  Migration ${m.version} applied: ${m.name}`);
      applied++;
    }
  }

  return { applied, current: applied > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : current };
}
