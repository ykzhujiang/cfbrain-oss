import type { BrainEngine } from '../core/engine.ts';
import * as db from '../core/db.ts';
import { LATEST_VERSION } from '../core/migrate.ts';
import { loadConfig } from '../core/config.ts';
import { isLarkCliAvailable } from '../core/feishu.ts';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export async function runDoctor(engine: BrainEngine, args: string[]) {
  const jsonOutput = args.includes('--json');
  const checks: Check[] = [];

  // 1. Connection
  try {
    const stats = await engine.getStats();
    checks.push({ name: 'connection', status: 'ok', message: `Connected, ${stats.page_count} pages` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'connection', status: 'fail', message: msg });
    outputResults(checks, jsonOutput);
    return;
  }

  // 2. pgvector extension
  try {
    const sql = db.getConnection();
    const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    if (ext.length > 0) {
      checks.push({ name: 'pgvector', status: 'ok', message: 'Extension installed' });
    } else {
      checks.push({ name: 'pgvector', status: 'fail', message: 'Extension not found. Run: CREATE EXTENSION vector;' });
    }
  } catch {
    checks.push({ name: 'pgvector', status: 'warn', message: 'Could not check pgvector extension' });
  }

  // 3. RLS
  try {
    const sql = db.getConnection();
    const tables = await sql`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('pages','content_chunks','links','tags','raw_data',
                           'page_versions','ingest_log','config','files')
    `;
    const noRls = tables.filter((t: any) => !t.rowsecurity);
    if (noRls.length === 0) {
      checks.push({ name: 'rls', status: 'ok', message: 'RLS enabled on all tables' });
    } else {
      const names = noRls.map((t: any) => t.tablename).join(', ');
      checks.push({ name: 'rls', status: 'warn', message: `RLS not enabled on: ${names}` });
    }
  } catch {
    checks.push({ name: 'rls', status: 'warn', message: 'Could not check RLS status' });
  }

  // 4. Schema version
  try {
    const version = await engine.getConfig('version');
    const v = parseInt(version || '0', 10);
    if (v >= LATEST_VERSION) {
      checks.push({ name: 'schema_version', status: 'ok', message: `Version ${v} (latest: ${LATEST_VERSION})` });
    } else {
      checks.push({ name: 'schema_version', status: 'warn', message: `Version ${v}, latest is ${LATEST_VERSION}. Run cfbrain init to migrate.` });
    }
  } catch {
    checks.push({ name: 'schema_version', status: 'warn', message: 'Could not check schema version' });
  }

  // 5. Embedding health
  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      checks.push({ name: 'embeddings', status: 'ok', message: `${pct}% coverage, ${health.missing_embeddings} missing` });
    } else if (health.embed_coverage > 0) {
      checks.push({ name: 'embeddings', status: 'warn', message: `${pct}% coverage, ${health.missing_embeddings} missing. Run: cfbrain embed refresh` });
    } else {
      checks.push({ name: 'embeddings', status: 'warn', message: 'No embeddings yet. Run: cfbrain embed refresh' });
    }
  } catch {
    checks.push({ name: 'embeddings', status: 'warn', message: 'Could not check embedding health' });
  }

  // 5b. Index health (detect corrupted indexes on feishu_sync and other tables)
  try {
    // Probe the partial unique index on feishu_sync by running a query that forces index usage.
    // If the index is corrupted, PostgreSQL/PGLite will throw a "heap tid from index tuple" error.
    await engine.executeRaw(
      `EXPLAIN (COSTS OFF) SELECT * FROM feishu_sync WHERE slug = '__health_check__' AND space_id = '__health_check__' AND node_type = 'origin'`,
      [],
    );
    // Also do a lightweight count that exercises the index scan path
    await engine.executeRaw(
      `SELECT count(*) FROM feishu_sync WHERE slug IS NOT NULL LIMIT 1`,
      [],
    );
    checks.push({ name: 'index_health', status: 'ok', message: 'All indexes healthy' });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('heap tid') || msg.includes('index tuple') || msg.includes('index corruption')) {
      checks.push({
        name: 'index_health',
        status: 'fail',
        message: `Index corruption detected: ${msg.slice(0, 100)}. Run: cfbrain repair --index`,
      });
    } else if (msg.includes('does not exist') || msg.includes('to_regclass')) {
      // feishu_sync table might not exist yet — not a corruption issue
      checks.push({ name: 'index_health', status: 'ok', message: 'Index check skipped (feishu_sync table not found)' });
    } else {
      checks.push({ name: 'index_health', status: 'warn', message: `Could not verify index health: ${msg.slice(0, 80)}` });
    }
  }

  // 5c. Primary key integrity (detect duplicate PK rows in pages and content_chunks)
  try {
    const dupPages = await engine.executeRaw(
      `SELECT slug, COUNT(*) AS cnt FROM pages GROUP BY slug HAVING COUNT(*) > 1`,
      [],
    );
    const dupChunks = await engine.executeRaw(
      `SELECT page_id, chunk_index, COUNT(*) AS cnt FROM content_chunks GROUP BY page_id, chunk_index HAVING COUNT(*) > 1`,
      [],
    );

    const totalDupPages = dupPages.length;
    const totalDupChunks = dupChunks.length;

    if (totalDupPages === 0 && totalDupChunks === 0) {
      checks.push({ name: 'pk_integrity', status: 'ok', message: 'No duplicate rows in pages or content_chunks' });
    } else {
      const parts: string[] = [];
      if (totalDupPages > 0) {
        parts.push(`pages: ${totalDupPages} duplicate slug(s)`);
      }
      if (totalDupChunks > 0) {
        parts.push(`content_chunks: ${totalDupChunks} duplicate (page_id, chunk_index) pair(s)`);
      }
      checks.push({
        name: 'pk_integrity',
        status: 'warn',
        message: `Duplicate rows found — ${parts.join('; ')}. Run: cfbrain repair --dedup`,
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('does not exist')) {
      checks.push({ name: 'pk_integrity', status: 'ok', message: 'PK integrity check skipped (table not found)' });
    } else {
      checks.push({ name: 'pk_integrity', status: 'warn', message: `Could not check PK integrity: ${msg.slice(0, 80)}` });
    }
  }

  // 6. lark-cli (Feishu integration)
  const config = loadConfig();
  if (config?.feishu?.enabled) {
    try {
      const available = await isLarkCliAvailable();
      if (available) {
        checks.push({ name: 'lark-cli', status: 'ok', message: 'lark-cli found and reachable' });
      } else {
        checks.push({ name: 'lark-cli', status: 'fail', message: 'lark-cli not found. Install it: npm install -g lark-cli, then run lark-cli auth login' });
      }
    } catch {
      checks.push({ name: 'lark-cli', status: 'fail', message: 'Could not check lark-cli availability' });
    }
  }

  // 7. pages/*.md vs DB slug consistency
  // pages/ is the authoritative truth source (Spec 14 R1), the DB is a search index.
  // A divergence means either a page is invisible to search (orphan file) or search
  // points at a page that no longer exists on disk (missing file). Neither was
  // detectable before: this is the check that surfaces test pollution like the 208
  // `list-test` commits leaked into the production brain between 2026-04 and 2026-08.
  try {
    const fsDbConfig = config;
    if (!fsDbConfig) {
      checks.push({ name: 'fs_db_consistency', status: 'ok', message: 'Consistency check skipped (no config found)' });
    } else {
      const { getPagesDir } = await import('../core/pages-fs.ts');
      const { readdirSync, existsSync } = await import('fs');
      const pagesDir = getPagesDir(fsDbConfig);

      if (!existsSync(pagesDir)) {
        checks.push({ name: 'fs_db_consistency', status: 'ok', message: `Consistency check skipped (${pagesDir} not found)` });
      } else {
        // Top level only, and .md only — ignores pages/.trash/ and other subdirectories.
        const fsSlugs = new Set(
          readdirSync(pagesDir, { withFileTypes: true })
            .filter(e => e.isFile() && e.name.endsWith('.md'))
            .map(e => e.name.slice(0, -3)),
        );

        // Raw SQL rather than listPages(), which silently caps at limit=100.
        const rows = await engine.executeRaw('SELECT slug FROM pages');
        const dbSlugs = new Set(rows.map(r => String((r as Record<string, unknown>).slug)));

        const orphanFiles = [...fsSlugs].filter(s => !dbSlugs.has(s)).sort();
        const missingFiles = [...dbSlugs].filter(s => !fsSlugs.has(s)).sort();

        if (orphanFiles.length === 0 && missingFiles.length === 0) {
          checks.push({
            name: 'fs_db_consistency',
            status: 'ok',
            message: `pages/ and DB agree on all ${fsSlugs.size} slugs`,
          });
        } else {
          // List every slug, not just a count — a count still leaves the human to go
          // hunting for which pages are actually affected.
          const parts: string[] = [];
          if (orphanFiles.length > 0) {
            parts.push(`${orphanFiles.length} orphan file(s) not in DB: ${orphanFiles.join(', ')}`);
          }
          if (missingFiles.length > 0) {
            parts.push(`${missingFiles.length} DB page(s) with no file: ${missingFiles.join(', ')}`);
          }
          checks.push({
            name: 'fs_db_consistency',
            status: 'warn',
            message: `${parts.join('; ')}. Orphan files are often test pollution — verify before deleting.`,
          });
        }
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'fs_db_consistency', status: 'warn', message: `Could not compare pages/ with DB: ${msg.slice(0, 120)}` });
  }

  outputResults(checks, jsonOutput);
}

function outputResults(checks: Check[], json: boolean) {
  if (json) {
    const hasFail = checks.some(c => c.status === 'fail');
    console.log(JSON.stringify({ status: hasFail ? 'unhealthy' : 'healthy', checks }));
    process.exit(hasFail ? 1 : 0);
    return;
  }

  console.log('\nCFBrain Health Check');
  console.log('===================');
  for (const c of checks) {
    const icon = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
  }

  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  if (hasFail) {
    console.log('\nFailed checks found. Fix the issues above.');
  } else if (hasWarn) {
    console.log('\nAll checks OK (some warnings).');
  } else {
    console.log('\nAll checks passed.');
  }
  process.exit(hasFail ? 1 : 0);
}
