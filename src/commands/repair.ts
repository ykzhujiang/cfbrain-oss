import type { BrainEngine } from '../core/engine.ts';
import { extractWikiLinks } from '../core/operations.ts';

/**
 * Repair command — bulk reconcile wiki-links, rebuild embeddings, reindex, and dedup.
 */
export async function runRepair(engine: BrainEngine, args: string[]) {
  const doLinks = args.includes('--links') || args.includes('--all');
  const doEmbed = args.includes('--embed') || args.includes('--all');
  const doIndex = args.includes('--index') || args.includes('--all');
  const doDedup = args.includes('--dedup') || args.includes('--all');

  if (!doLinks && !doEmbed && !doIndex && !doDedup) {
    console.error('Usage: cfbrain repair [--links|--embed|--index|--dedup|--all]');
    process.exit(1);
  }

  // Dedup should run before reindex — remove duplicate rows first, then rebuild indexes
  if (doDedup) {
    console.log('=== Deduplicating primary key rows ===');
    await repairDedup(engine);
    console.log('');
  }

  if (doIndex) {
    console.log('=== Reindexing database tables ===');
    await repairIndexes(engine);
    console.log('');
  }

  if (doEmbed) {
    console.log('=== Embedding all chunks ===');
    const { runEmbed } = await import('./embed.ts');
    await runEmbed(engine, ['--stale']);
    console.log('');
  }

  if (doLinks) {
    console.log('=== Reconciling wiki-links ===');
    await repairLinks(engine);
  }
}

/**
 * Deduplicate primary key rows in pages and content_chunks tables.
 *
 * Strategy:
 * - pages: keep the row with the latest updated_at for each duplicate slug
 * - content_chunks: keep the row with the highest id (most recently inserted) for each duplicate (page_id, chunk_index)
 * After dedup, REINDEX TABLE on affected tables to rebuild indexes cleanly.
 */
async function repairDedup(engine: BrainEngine) {
  let totalDeleted = 0;

  // --- pages table: dedup by slug, keep latest updated_at ---
  try {
    // Check if pages table exists
    const pagesExists = await engine.executeRaw(
      `SELECT to_regclass('pages') IS NOT NULL AS exists`,
      [],
    );
    if (!pagesExists[0]?.exists) {
      console.log('  [SKIP] pages table does not exist');
    } else {
      // Find duplicate slugs
      const dupPages = await engine.executeRaw(
        `SELECT slug, COUNT(*) AS cnt FROM pages GROUP BY slug HAVING COUNT(*) > 1`,
        [],
      );

      if (dupPages.length === 0) {
        console.log('  [OK] pages: no duplicate slugs found');
      } else {
        console.log(`  Found ${dupPages.length} duplicate slug(s) in pages`);

        // Log which slugs will be deduped
        for (const row of dupPages) {
          console.log(`    - slug="${row.slug}" (${row.cnt} rows)`);
        }

        // Delete duplicates: for each slug, keep only the row with the latest updated_at
        // If updated_at ties, keep the row with the highest id (most recently inserted)
        const deleteResult = await engine.executeRaw(
          `DELETE FROM pages
           WHERE id IN (
             SELECT id FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY slug
                        ORDER BY updated_at DESC, id DESC
                      ) AS rn
               FROM pages
             ) ranked
             WHERE rn > 1
           )`,
          [],
        );

        // Count deleted rows — PGLite executeRaw may not return affected row count,
        // so we re-check to confirm
        const postDupPages = await engine.executeRaw(
          `SELECT slug, COUNT(*) AS cnt FROM pages GROUP BY slug HAVING COUNT(*) > 1`,
          [],
        );

        const deletedCount = dupPages.reduce((sum, r) => sum + (Number(r.cnt) - 1), 0);
        console.log(`  [OK] pages: removed ~${deletedCount} duplicate row(s)`);
        totalDeleted += deletedCount;

        if (postDupPages.length > 0) {
          console.log(`  [WARN] pages: ${postDupPages.length} slug(s) still have duplicates after dedup`);
        }

        // Reindex pages after dedup
        try {
          await engine.executeRaw(`REINDEX TABLE pages`, []);
          console.log('  [OK] REINDEX TABLE pages');
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`  [WARN] REINDEX TABLE pages failed: ${msg.slice(0, 80)}`);
        }
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  [FAIL] pages dedup error: ${msg.slice(0, 100)}`);
  }

  // --- content_chunks table: dedup by (page_id, chunk_index), keep highest id ---
  try {
    const chunksExists = await engine.executeRaw(
      `SELECT to_regclass('content_chunks') IS NOT NULL AS exists`,
      [],
    );
    if (!chunksExists[0]?.exists) {
      console.log('  [SKIP] content_chunks table does not exist');
    } else {
      // Find duplicate (page_id, chunk_index) pairs
      const dupChunks = await engine.executeRaw(
        `SELECT page_id, chunk_index, COUNT(*) AS cnt FROM content_chunks GROUP BY page_id, chunk_index HAVING COUNT(*) > 1`,
        [],
      );

      if (dupChunks.length === 0) {
        console.log('  [OK] content_chunks: no duplicate (page_id, chunk_index) pairs found');
      } else {
        console.log(`  Found ${dupChunks.length} duplicate (page_id, chunk_index) pair(s) in content_chunks`);

        // Log which pairs will be deduped (limit output for large sets)
        const logLimit = Math.min(dupChunks.length, 20);
        for (let i = 0; i < logLimit; i++) {
          const row = dupChunks[i];
          console.log(`    - page_id=${row.page_id}, chunk_index=${row.chunk_index} (${row.cnt} rows)`);
        }
        if (dupChunks.length > logLimit) {
          console.log(`    ... and ${dupChunks.length - logLimit} more`);
        }

        // Delete duplicates: keep the row with the highest id for each (page_id, chunk_index)
        await engine.executeRaw(
          `DELETE FROM content_chunks
           WHERE id IN (
             SELECT id FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY page_id, chunk_index
                        ORDER BY id DESC
                      ) AS rn
               FROM content_chunks
             ) ranked
             WHERE rn > 1
           )`,
          [],
        );

        // Verify
        const postDupChunks = await engine.executeRaw(
          `SELECT page_id, chunk_index, COUNT(*) AS cnt FROM content_chunks GROUP BY page_id, chunk_index HAVING COUNT(*) > 1`,
          [],
        );

        const deletedCount = dupChunks.reduce((sum, r) => sum + (Number(r.cnt) - 1), 0);
        console.log(`  [OK] content_chunks: removed ~${deletedCount} duplicate row(s)`);
        totalDeleted += deletedCount;

        if (postDupChunks.length > 0) {
          console.log(`  [WARN] content_chunks: ${postDupChunks.length} pair(s) still have duplicates after dedup`);
        }

        // Reindex content_chunks after dedup
        try {
          await engine.executeRaw(`REINDEX TABLE content_chunks`, []);
          console.log('  [OK] REINDEX TABLE content_chunks');
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`  [WARN] REINDEX TABLE content_chunks failed: ${msg.slice(0, 80)}`);
        }
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  [FAIL] content_chunks dedup error: ${msg.slice(0, 100)}`);
  }

  console.log(`\n  Dedup complete: ${totalDeleted} total duplicate row(s) removed`);
}

/**
 * Reindex all indexes on critical tables (feishu_sync, pages, content_chunks, links).
 * REINDEX is a safe, idempotent operation — it rebuilds the index from the heap data.
 * This fixes "heap tid from index tuple" corruption errors in PGLite.
 */
async function repairIndexes(engine: BrainEngine) {
  // Tables to reindex
  const tables = ['feishu_sync', 'pages', 'content_chunks', 'links'];
  let succeeded = 0;
  let failed = 0;

  // First, try to get specific index names from feishu_sync (the most commonly corrupted)
  try {
    const indexRows = await engine.executeRaw(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'feishu_sync'`,
      [],
    );
    if (indexRows.length > 0) {
      console.log(`  Found ${indexRows.length} index(es) on feishu_sync`);
      for (const row of indexRows) {
        const indexName = row.indexname as string;
        try {
          await engine.executeRaw(`REINDEX INDEX ${indexName}`, []);
          console.log(`  [OK] REINDEX INDEX ${indexName}`);
          succeeded++;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`  [FAIL] REINDEX INDEX ${indexName}: ${msg.slice(0, 80)}`);
          failed++;
        }
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  [WARN] Could not query feishu_sync indexes: ${msg.slice(0, 80)}`);
    // Fall through to table-level REINDEX
  }

  // Then REINDEX TABLE for all critical tables (covers any indexes not handled above)
  for (const table of tables) {
    try {
      // Check if table exists before attempting REINDEX
      const existsRows = await engine.executeRaw(
        `SELECT to_regclass('${table}') IS NOT NULL AS exists`,
        [],
      );
      if (!existsRows[0]?.exists) {
        console.log(`  [SKIP] Table ${table} does not exist`);
        continue;
      }

      await engine.executeRaw(`REINDEX TABLE ${table}`, []);
      console.log(`  [OK] REINDEX TABLE ${table}`);
      succeeded++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  [FAIL] REINDEX TABLE ${table}: ${msg.slice(0, 80)}`);
      failed++;
    }
  }

  console.log(`\n  Reindex complete: ${succeeded} succeeded, ${failed} failed`);
  if (failed > 0) {
    console.log('  Some reindex operations failed. Try: cfbrain rebuild (full database rebuild from pages/)');
  }
}

async function repairLinks(engine: BrainEngine) {
  const pages = await engine.listPages({ limit: 100000 });
  let linksCreated = 0;
  let linksRemoved = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const fullPage = await engine.getPage(page.slug);
    if (!fullPage) continue;

    const newSlugs = extractWikiLinks(fullPage.compiled_truth);

    // Get existing wiki-links
    const existingLinks = await engine.getLinks(page.slug);
    const existingWikiTargets = new Set(
      existingLinks
        .filter((l: any) => l.link_type === 'wiki-link')
        .map((l: any) => l.to_slug as string),
    );

    // Add new
    for (const target of newSlugs) {
      if (target === page.slug) continue;
      if (existingWikiTargets.has(target)) {
        existingWikiTargets.delete(target);
        continue;
      }
      const targetPage = await engine.getPage(target).catch(() => null);
      if (targetPage) {
        await engine.addLink(page.slug, target, '', 'wiki-link');
        linksCreated++;
      }
    }

    // Remove stale
    for (const staleTarget of existingWikiTargets) {
      await engine.removeLink(page.slug, staleTarget);
      linksRemoved++;
    }

    process.stdout.write(`\r  ${i + 1}/${pages.length} pages scanned`);
  }

  console.log(`\n\nLinks created: ${linksCreated}, removed: ${linksRemoved}`);
}
