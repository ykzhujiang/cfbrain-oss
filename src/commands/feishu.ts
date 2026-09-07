import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, saveConfig, DEFAULT_TYPE_LABELS, type FeishuConfig, type GBrainConfig } from '../core/config.ts';
import {
  isLarkCliAvailable,
  feishuCreateNode,
  feishuValidateNode,
  feishuListNodes,
  feishuListComments,
  feishuUpdateDoc,
  feishuReplyComment,
  feishuResolveComment,
  feishuMoveNode,
  serializeForFeishu,
  convertWikiLinks,
  convertMarkdownToBlocks,
  feishuUpdateDocBlocks,
  feishuIncrementalUpdateDocBlocks,
  feishuFetchDocBlocks,
  findAttachmentSectionStart,
  feishuRenameNode,
  feishuUpdateDocTitle,
  findExistingChildByTitle,
  runLarkCli,
  LarkCliError,
  feishuInsertFile,
  feishuGetBotOpenId,
  // buildAttachmentBlocks no longer needed — using feishuInsertFile directly
} from '../core/feishu.ts';
import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { getPagesDir, getBrainDir } from '../core/pages-fs.ts';
import { parseMarkdown } from '../core/markdown.ts';
import { normalizeRawSource, resolveRawPath, getRawMediaType } from '../core/raw-files.ts';
import { extractWikiLinks } from '../core/operations.ts';
import type { Page } from '../core/types.ts';

/**
 * Read a page from pages/ file first (truth source), fall back to DB.
 * Spec 14 R6: feishu push reads from pages/ files.
 */
async function getPageFromFileOrDB(engine: BrainEngine, slug: string, config: GBrainConfig | null): Promise<Page | null> {
  if (config) {
    const filePath = join(getPagesDir(config), slug + '.md');
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const parsed = parseMarkdown(content);
        // Construct a Page-like object from file content
        const dbPage = await engine.getPage(slug).catch(() => null);
        if (dbPage) {
          // Merge: file content is truth, but use DB for metadata not in file
          return {
            ...dbPage,
            compiled_truth: parsed.compiled_truth,
            types: parsed.types?.length ? parsed.types : dbPage.types,
            title: parsed.title || dbPage.title,
            frontmatter: parsed.frontmatter,
          };
        }
      } catch { /* fall through to DB */ }
    }
  }
  return engine.getPage(slug);
}

/**
 * Spec 41: Check if any [[slug]] wiki-link references in a page now point to
 * Feishu nodes that were pushed AFTER the page's own last push. If so, the page
 * needs a content rewrite to resolve previously-broken wiki-links.
 *
 * Only called when content_hash would otherwise trigger a skip (R3: no overhead
 * for pages that are already being written).
 */
async function hasNewlyAvailableWikiLinks(
  engine: BrainEngine,
  compiledTruth: string,
  slug: string,
  spaceId: string,
): Promise<boolean> {
  const wikiSlugs = extractWikiLinks(compiledTruth);
  if (wikiSlugs.length === 0) return false;

  // Get this page's last_push_at
  const selfRows = await rawQuery(
    engine,
    `SELECT last_push_at FROM feishu_sync WHERE slug = $1 AND space_id = $2 AND node_type = 'origin' LIMIT 1`,
    [slug, spaceId],
  );
  if (selfRows.length === 0) return false;
  const selfPushAt = selfRows[0].last_push_at as string | null;
  if (!selfPushAt) return false; // never pushed — will be written anyway

  // Check if any referenced slug has a feishu_sync record with last_push_at >= selfPushAt
  // (i.e., was pushed to Feishu at or after this page's last push — >= catches same-batch pushes)
  for (const refSlug of wikiSlugs) {
    if (refSlug === slug) continue; // skip self-references
    const refRows = await rawQuery(
      engine,
      `SELECT last_push_at FROM feishu_sync WHERE slug = $1 AND space_id = $2 AND node_type = 'origin' LIMIT 1`,
      [refSlug, spaceId],
    );
    if (refRows.length === 0) continue; // still no Feishu node — nothing new
    const refPushAt = refRows[0].last_push_at as string | null;
    if (!refPushAt) continue;
    if (refPushAt >= selfPushAt) {
      return true; // this wiki-link target was pushed at or after our last push
    }
  }
  return false;
}

/**
 * Insert raw source files into a Feishu doc with a "📎 原始素材" heading.
 * Images are inserted inline (visible); other files as downloadable attachments.
 * Uses lark-cli docs +media-insert which handles the full upload orchestration.
 * Silently skips if no raw_source in frontmatter or files don't exist.
 */
async function appendRawAttachments(
  objToken: string,
  page: Page,
  config: GBrainConfig,
  jsonOutput: boolean,
): Promise<void> {
  const rawSources = normalizeRawSource(page.frontmatter?.raw_source);
  if (rawSources.length === 0) return;

  // Check if any raw files actually exist before adding heading
  const existingSources = rawSources.filter(rs => {
    const absPath = resolveRawPath(config, rs);
    return existsSync(absPath);
  });
  if (existingSources.length === 0) return;

  // Add divider + heading via API
  try {
    await runLarkCli([
      'api', 'POST',
      `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}/children`,
      '--data', JSON.stringify({
        children: [
          { block_type: 22, divider: {} },
          { block_type: 4, heading2: { elements: [{ text_run: { content: '📎 原始素材' } }] } },
        ],
        index: -1,
      }),
    ]);
  } catch {
    // heading insertion failure is non-fatal
  }

  // Insert each raw source with appropriate type
  for (const rawSource of existingSources) {
    const absPath = resolveRawPath(config, rawSource);
    const mediaType = getRawMediaType(rawSource);
    const ok = await feishuInsertFile(objToken, absPath, mediaType);
    if (!ok && !jsonOutput) {
      console.warn(`  WARN  failed to insert ${mediaType} attachment: ${rawSource}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Raw SQL runner: delegates to BrainEngine.executeRaw()
// ---------------------------------------------------------------------------
async function rawQuery(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return engine.executeRaw(sql, params);
}

// ---------------------------------------------------------------------------
// Index corruption detection and auto-repair
// ---------------------------------------------------------------------------
function isIndexCorruptionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('heap tid from index') || msg.includes('index tuple');
}

/**
 * Track whether auto-reindex has been attempted this session to avoid infinite loops.
 * Only attempt once per push invocation.
 */
let _autoReindexAttempted = false;

/**
 * Attempt to auto-repair corrupted indexes by running REINDEX.
 * Returns true if REINDEX was executed (caller should retry the failed operation).
 * Returns false if REINDEX was already attempted or not applicable.
 */
async function autoReindexOnCorruption(engine: BrainEngine, err: unknown, jsonOutput: boolean): Promise<boolean> {
  if (!isIndexCorruptionError(err)) return false;
  if (_autoReindexAttempted) return false;
  _autoReindexAttempted = true;

  const msg = '[AUTO-REPAIR] Index corruption detected, running REINDEX...';
  if (!jsonOutput) console.log(`  ${msg}`);

  const tables = ['feishu_sync', 'pages', 'content_chunks', 'links'];
  let reindexed = 0;

  // Try individual indexes on feishu_sync first (most likely culprit)
  try {
    const indexRows = await engine.executeRaw(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'feishu_sync'`,
      [],
    );
    for (const row of indexRows) {
      const indexName = row.indexname as string;
      try {
        await engine.executeRaw(`REINDEX INDEX ${indexName}`, []);
        if (!jsonOutput) console.log(`  [AUTO-REPAIR] Reindexed ${indexName}`);
        reindexed++;
      } catch {
        // Try table-level REINDEX as fallback below
      }
    }
  } catch {
    // Fall through to table-level REINDEX
  }

  // REINDEX TABLE for all critical tables
  for (const table of tables) {
    try {
      await engine.executeRaw(`REINDEX TABLE ${table}`, []);
      reindexed++;
    } catch {
      // Non-fatal: some tables may not exist
    }
  }

  if (reindexed > 0) {
    if (!jsonOutput) console.log(`  [AUTO-REPAIR] Reindex complete (${reindexed} operations). Retrying push...`);
    return true;
  }

  if (!jsonOutput) console.log(`  [AUTO-REPAIR] Reindex failed — no indexes could be rebuilt`);
  return false;
}

// ---------------------------------------------------------------------------
// feishu status
// ---------------------------------------------------------------------------
async function runFeishuStatus(engine: BrainEngine, args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json');

  // 1. Total synced pages (distinct slugs in feishu_sync)
  let totalSynced = 0;
  let lastPushAt: string | null = null;
  let pendingCount = 0;
  let tableExists = true;

  try {
    const existsRows = await rawQuery(
      engine,
      `SELECT to_regclass('feishu_sync') IS NOT NULL AS exists`,
      [],
    );
    tableExists = !!(existsRows[0]?.exists);
  } catch {
    tableExists = false;
  }

  if (!tableExists) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        error: 'feishu_sync table not found',
        hint: 'Run cfbrain init to apply latest schema migrations',
      }));
      process.exit(1);
    }
    console.error('feishu_sync table not found. Run: cfbrain init');
    process.exit(1);
  }

  // Total synced pages
  try {
    const rows = await rawQuery(
      engine,
      `SELECT COUNT(DISTINCT slug)::int AS cnt FROM feishu_sync`,
      [],
    );
    totalSynced = Number(rows[0]?.cnt ?? 0);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (jsonOutput) {
      console.log(JSON.stringify({ error: msg }));
      process.exit(1);
    }
    console.error(`Could not query feishu_sync: ${msg}`);
    process.exit(1);
  }

  // Last push time
  try {
    const rows = await rawQuery(
      engine,
      `SELECT MAX(last_push_at) AS ts FROM feishu_sync`,
      [],
    );
    const raw = rows[0]?.ts;
    if (raw != null) {
      lastPushAt = raw instanceof Date
        ? raw.toISOString()
        : String(raw);
    }
  } catch {
    // non-fatal; leave lastPushAt as null
  }

  // Pending changes: rows where brain page content_hash differs from feishu_sync content_hash
  try {
    const rows = await rawQuery(
      engine,
      `SELECT COUNT(*)::int AS cnt
         FROM feishu_sync fs
         JOIN pages p ON p.slug = fs.slug
        WHERE p.content_hash IS DISTINCT FROM fs.content_hash`,
      [],
    );
    pendingCount = Number(rows[0]?.cnt ?? 0);
  } catch {
    // non-fatal; leave pendingCount as 0
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      total_synced: totalSynced,
      last_push_at: lastPushAt,
      pending_changes: pendingCount,
    }));
    return;
  }

  console.log('\nFeishu Sync Status');
  console.log('==================');
  console.log(`  Total synced pages : ${totalSynced}`);
  console.log(`  Last push          : ${lastPushAt ?? 'never'}`);
  console.log(`  Pending changes    : ${pendingCount}`);
  if (pendingCount > 0) {
    console.log('');
    console.log(`  ${pendingCount} page(s) have brain changes not yet pushed to Feishu.`);
    console.log('  Run: cfbrain feishu push --all');
  } else if (totalSynced > 0) {
    console.log('');
    console.log('  Brain and Feishu are in sync.');
  }
}

// ---------------------------------------------------------------------------
// feishu unlink
// ---------------------------------------------------------------------------
async function runFeishuUnlink(_engine: BrainEngine, args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json');

  const config = loadConfig();
  if (!config) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: 'No brain configured' }));
      process.exit(1);
    }
    console.error('No brain configured. Run: cfbrain init');
    process.exit(1);
    return;
  }

  if (!config.feishu?.enabled) {
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'already_disabled', message: 'Feishu integration is not enabled' }));
      return;
    }
    console.log('Feishu integration is already disabled.');
    return;
  }

  // Set feishu.enabled = false, preserve all other feishu config fields
  config.feishu = {
    ...config.feishu,
    enabled: false,
  };

  saveConfig(config);

  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'unlinked', message: 'Feishu integration disabled. Feishu docs are intact.' }));
    return;
  }

  console.log('Feishu integration disabled.');
  console.log('Your Feishu docs are intact — only the sync connection is removed.');
  console.log('To re-enable: update feishu.enabled in ~/.cfbrain/config.json');
}

// ---------------------------------------------------------------------------
// feishu init
// ---------------------------------------------------------------------------
async function runFeishuInit(_engine: BrainEngine, args: string[]): Promise<void> {
  // 1. Check lark-cli availability
  const available = await isLarkCliAvailable();
  if (!available) {
    console.error('lark-cli is not available in PATH.');
    console.error('Install it and authenticate before running feishu init.');
    console.error('See: https://github.com/larksuite/lark-cli');
    process.exit(1);
  }

  // 2. Resolve space_id from --space-id flag or prompt
  let spaceId: string | undefined;
  const spaceIdFlagIndex = args.indexOf('--space-id');
  if (spaceIdFlagIndex !== -1 && args[spaceIdFlagIndex + 1]) {
    spaceId = args[spaceIdFlagIndex + 1];
  }

  if (!spaceId) {
    process.stdout.write('Feishu Wiki Space ID: ');
    // Read a single line from stdin
    const buf = Buffer.alloc(256);
    let totalRead = 0;
    try {
      // Bun synchronous stdin read
      const fd = (await import('fs')).openSync('/dev/tty', 'r');
      totalRead = (await import('fs')).readSync(fd, buf, 0, buf.length, null);
      (await import('fs')).closeSync(fd);
    } catch {
      // Fall back to process.stdin in non-TTY environments
      totalRead = 0;
    }
    if (totalRead > 0) {
      spaceId = buf.slice(0, totalRead).toString('utf-8').trim();
    }
  }

  if (!spaceId) {
    console.error('No space ID provided. Use --space-id <id> or enter it interactively.');
    process.exit(1);
  }

  // 3. Load existing config (must already be initialised)
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: cfbrain init');
    process.exit(1);
    return;
  }

  // 4. Build feishu config object
  const feishuConfig = {
    enabled: true,
    space_id: spaceId,
    auto_push: false,
    type_labels: DEFAULT_TYPE_LABELS,
  };

  // 5. Create root directory nodes for each default type
  const typeEntries = Object.entries(DEFAULT_TYPE_LABELS);
  console.log(`Creating ${typeEntries.length} root directory nodes in Feishu wiki space ${spaceId}...`);

  // Idempotent: check existing root-level nodes first, only create missing ones
  const existingRootNodes = await feishuListNodes(spaceId);
  const nodeTokens: Record<string, string> = {};
  for (const [typeKey, typeLabel] of typeEntries) {
    const existing = existingRootNodes.find(n => n.title === typeLabel && n.parent_node_token === '');
    if (existing) {
      nodeTokens[typeKey] = existing.node_token;
      console.log(`  Reusing existing "${typeLabel}" (${typeKey}) (${existing.node_token})`);
      continue;
    }
    process.stdout.write(`  Creating "${typeLabel}" (${typeKey})... `);
    try {
      // Use space root as parent: pass the space_id as parentToken for root-level nodes
      const result = await feishuCreateNode(spaceId, '', typeLabel);
      nodeTokens[typeKey] = result.node_token;
      console.log(`done (${result.node_token})`);
    } catch (err) {
      if (err instanceof LarkCliError) {
        console.log('failed');
        console.error(`  Error creating node for "${typeLabel}": ${err.message}`);
        // Non-fatal: continue creating remaining nodes
      } else {
        console.log('failed');
        console.error(`  Unexpected error for "${typeLabel}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 6. Create trash directory node (🗑️ 废弃)
  // Spec 07 Bug 1: Check if one already exists first
  let trashNodeToken: string | undefined;
  try {
    const existingNodes = await feishuListNodes(spaceId);
    const existingTrash = existingNodes.find(n => n.title === '🗑️ 废弃');
    if (existingTrash) {
      trashNodeToken = existingTrash.node_token;
      console.log(`  Reusing existing "🗑️ 废弃" (trash) (${trashNodeToken})`);
    }
  } catch {
    // If listing fails, fall through to create
  }
  if (!trashNodeToken) {
    process.stdout.write('  Creating "🗑️ 废弃" (trash)... ');
    try {
      const trashNode = await feishuCreateNode(spaceId, '', '🗑️ 废弃');
      trashNodeToken = trashNode.node_token;
      console.log(`done (${trashNode.node_token})`);
    } catch (err) {
      console.log('failed');
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Error creating trash node: ${msg}`);
    }
  }

  // 7. Save feishu config (with node tokens if any were created)
  const feishuConfigWithTokens = {
    ...feishuConfig,
    ...(Object.keys(nodeTokens).length > 0 ? { root_node_tokens: nodeTokens } : {}),
    ...(trashNodeToken ? { trash_node_token: trashNodeToken } : {}),
  };

  config.feishu = feishuConfigWithTokens as typeof config.feishu;
  saveConfig(config);

  console.log('');
  console.log('Feishu integration configured.');
  console.log(`  Space ID  : ${spaceId}`);
  console.log(`  Auto-push : false (run cfbrain feishu push to sync manually)`);
  console.log('');
  console.log('Next steps:');
  console.log('  cfbrain feishu push --all   Push all brain pages to Feishu');
  console.log('  cfbrain feishu status       Check sync status');
}

// ---------------------------------------------------------------------------
// Helper: ensure trash directory node exists, auto-recreate if missing
// ---------------------------------------------------------------------------
async function ensureTrashNode(
  spaceId: string,
  config: GBrainConfig,
): Promise<string | null> {
  const feishuCfg = config.feishu as FeishuConfig | undefined;
  const existing = feishuCfg?.trash_node_token;
  if (existing) return existing;

  // Spec 07 Bug 1: Before creating trash, check if one already exists
  // by listing root nodes and looking for "🗑️ 废弃" title.
  try {
    const nodes = await feishuListNodes(spaceId);
    const trashNode = nodes.find(n => n.title === '🗑️ 废弃');
    if (trashNode) {
      // Found existing trash dir — reuse it and persist to config
      const freshConfig = loadConfig();
      if (freshConfig?.feishu) {
        freshConfig.feishu.trash_node_token = trashNode.node_token;
        saveConfig(freshConfig);
      }
      return trashNode.node_token;
    }
  } catch {
    // If we can't list nodes, fall through to create
  }

  // No existing trash directory found — create one
  try {
    const trashNode = await feishuCreateNode(spaceId, '', '🗑️ 废弃');
    // Persist to config
    const freshConfig = loadConfig();
    if (freshConfig?.feishu) {
      freshConfig.feishu.trash_node_token = trashNode.node_token;
      saveConfig(freshConfig);
    }
    return trashNode.node_token;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// feishu push
// ---------------------------------------------------------------------------
async function runFeishuPush(engine: BrainEngine, args: string[]): Promise<void> {
  const forceAll = args.includes('--all');
  const cleanupOnly = args.includes('--cleanup');
  const noCleanup = args.includes('--no-cleanup');
  const jsonOutput = args.includes('--json');

  // Resolve optional --slug <slug>
  let singleSlug: string | undefined;
  const slugFlagIdx = args.indexOf('--slug');
  if (slugFlagIdx !== -1 && args[slugFlagIdx + 1]) {
    singleSlug = args[slugFlagIdx + 1];
  }

  // ------------------------------------------------------------------
  // 1. Load and validate config
  // ------------------------------------------------------------------
  const config = loadConfig();
  if (!config) {
    const msg = 'No brain configured. Run: cfbrain init';
    if (jsonOutput) { console.log(JSON.stringify({ error: msg })); process.exit(1); }
    console.error(msg);
    process.exit(1);
    return;
  }

  if (!config.feishu?.enabled) {
    const msg = 'Feishu integration is not enabled. Run: cfbrain feishu init';
    if (jsonOutput) { console.log(JSON.stringify({ error: msg })); process.exit(1); }
    console.error(msg);
    process.exit(1);
    return;
  }

  const feishuCfg = config.feishu;
  const spaceId = feishuCfg.space_id;
  const rootNodeTokens: Record<string, string> = feishuCfg.root_node_tokens ?? {};

  // ------------------------------------------------------------------
  // 2. Check lark-cli is available
  // ------------------------------------------------------------------
  const available = await isLarkCliAvailable();
  if (!available) {
    const msg = 'lark-cli is not available in PATH. Install and authenticate first.';
    if (jsonOutput) { console.log(JSON.stringify({ error: msg })); process.exit(1); }
    console.error(msg);
    process.exit(1);
    return;
  }

  // ------------------------------------------------------------------
  // 3. Verify feishu_sync table exists
  // ------------------------------------------------------------------
  try {
    const existsRows = await rawQuery(engine, `SELECT to_regclass('feishu_sync') IS NOT NULL AS exists`, []);
    if (!existsRows[0]?.exists) throw new Error('table missing');
  } catch {
    const msg = 'feishu_sync table not found. Run: cfbrain init';
    if (jsonOutput) { console.log(JSON.stringify({ error: msg })); process.exit(1); }
    console.error(msg);
    process.exit(1);
    return;
  }

  // ------------------------------------------------------------------
  // 3b. Cleanup-only mode (R7): only archive stale pages, skip push
  // ------------------------------------------------------------------
  if (cleanupOnly) {
    await runCleanupFlow(engine, spaceId, config, jsonOutput);
    return;
  }

  // ------------------------------------------------------------------
  // 4. Build list of slugs to push
  // ------------------------------------------------------------------
  let slugsToPush: string[] = [];

  if (singleSlug) {
    const page = await getPageFromFileOrDB(engine, singleSlug, config);
    if (!page) {
      const msg = `Page not found: ${singleSlug}`;
      if (jsonOutput) { console.log(JSON.stringify({ error: msg })); process.exit(1); }
      console.error(msg);
      process.exit(1);
      return;
    }
    slugsToPush = [singleSlug];
  } else if (forceAll) {
    const pages = await engine.listPages({ limit: 100000 });
    slugsToPush = pages.map(p => p.slug);
  } else {
    const rows = await rawQuery(
      engine,
      `SELECT p.slug
         FROM pages p
         LEFT JOIN feishu_sync fs ON fs.slug = p.slug AND fs.space_id = $1 AND fs.node_type != 'archived'
        WHERE fs.slug IS NULL
           OR p.content_hash IS DISTINCT FROM fs.content_hash`,
      [spaceId],
    );
    slugsToPush = rows.map(r => r.slug as string);
  }

  if (slugsToPush.length === 0 && !forceAll) {
    if (jsonOutput) { console.log(JSON.stringify({ pushed: 0, skipped: 0, failed: 0 })); return; }
    console.log('Nothing to push — brain and Feishu are already in sync.');
    return;
  }

  if (!jsonOutput && slugsToPush.length > 0) {
    const mode = singleSlug ? `single slug (${singleSlug})` : forceAll ? 'force-all' : 'changed pages';
    console.log(`\nFeishu Push  [${mode}]`);
    console.log(`  ${slugsToPush.length} page(s) to push to space ${spaceId}\n`);
  }

  // ------------------------------------------------------------------
  // 5. Push pages (R1: idempotent, R2: transactional, R5: auto-recovery)
  //    Spec 12: Two-pass push for multi-page mode, single-pass for --slug
  // ------------------------------------------------------------------
  let pushed = 0;
  let failed = 0;
  const failures: Array<{ slug: string; error: string }> = [];

  // Run-level cache: type key → node_token for the type's directory node
  const dirTokenCache: Record<string, string> = { ...rootNodeTokens };

  // Build wiki-link → Feishu URL mapping from feishu_sync table (Spec 09: wiki-link conversion)
  const syncMapRows = await rawQuery(
    engine,
    `SELECT slug, obj_token FROM feishu_sync WHERE space_id = $1 AND node_type != 'archived'`,
    [spaceId],
  );
  const feishuSyncMap = new Map<string, string>();
  for (const row of syncMapRows) {
    feishuSyncMap.set(row.slug as string, row.obj_token as string);
  }

  // Track node info from Pass 1 for use in Pass 2
  const nodeInfo = new Map<string, { nodeToken: string; objToken: string; isNewNode: boolean }>();

  // Spec 22: Build a node cache for duplicate prevention — avoids creating nodes
  // with the same title when feishu_sync records are lost.
  let allNodesCache: Array<{ node_token: string; title: string; obj_token: string; node_type: string; parent_node_token: string }> = [];
  try {
    allNodesCache = await feishuListNodes(spaceId);
  } catch {
    // If listing fails, proceed without cache (findExistingChildByTitle will fetch per-call)
  }

  // Spec 22: Wrapper that checks for existing node before creating.
  // Reuses existing nodes by title to prevent duplicates.
  async function createNodeChecked(
    parentToken: string,
    title: string,
    nodeType?: string,
    referenceNodeToken?: string,
  ): Promise<{ node_token: string; obj_token: string; reused: boolean }> {
    const existing = await findExistingChildByTitle(spaceId, parentToken, title, allNodesCache.length > 0 ? allNodesCache : undefined);
    if (existing) {
      return { ...existing, reused: true };
    }
    const created = await feishuCreateNode(spaceId, parentToken, title, nodeType, referenceNodeToken);
    // Update cache with newly created node
    allNodesCache.push({
      node_token: created.node_token,
      title,
      obj_token: created.obj_token,
      node_type: nodeType ?? 'doc',
      parent_node_token: parentToken,
    });
    return { ...created, reused: false };
  }

  // ================================================================
  // PASS 1: Create/update Feishu nodes (get obj_tokens for ALL pages)
  // For single-slug mode, this pass also writes content (single-pass).
  // ================================================================
  if (!singleSlug && !jsonOutput && slugsToPush.length > 1) {
    console.log('  Pass 1: Creating/updating Feishu nodes...');
  }

  for (const slug of slugsToPush) {
    try {
      // a. Read page from brain (pages/ file first, DB fallback — Spec 14 R6)
      const page = await getPageFromFileOrDB(engine, slug, config);
      if (!page) {
        failures.push({ slug, error: 'page not found' });
        failed++;
        if (!jsonOutput) console.log(`  SKIP  ${slug}  (page not found)`);
        continue;
      }

      // b. Determine primary type for directory routing
      const primaryType = page.types[0] ?? 'note';

      // c. Check for existing feishu_sync record (R1: idempotency check)
      const existingRows = await rawQuery(
        engine,
        `SELECT node_token, obj_token, parent_type, node_type, content_hash, title FROM feishu_sync
          WHERE slug = $1 AND space_id = $2 AND node_type = 'origin'
          ORDER BY last_push_at DESC NULLS LAST
          LIMIT 1`,
        [slug, spaceId],
      );

      let nodeToken: string;
      let objToken: string;
      let isNewNode = false;

      if (existingRows.length > 0) {
        const existingNodeType = existingRows[0].node_type as string;

        if (existingNodeType === 'archived') {
          // R1: archived node → recreate (page was trashed but Brain still has it)
          const parentToken = await resolveParentToken(spaceId, primaryType, feishuCfg, dirTokenCache);
          const newNode = await createNodeChecked(parentToken, page.title);
          nodeToken = newNode.node_token;
          objToken = newNode.obj_token;
          isNewNode = !newNode.reused;
          if (newNode.reused && !jsonOutput) console.log(`  REUSE  ${slug}  (existing node found by title)`);
        } else {
          // R1: origin node → validate existence before trusting (T48: stale sync check)
          const existNodeToken = existingRows[0].node_token as string;
          const existObjToken = existingRows[0].obj_token as string;
          const nodeExists = await feishuValidateNode(spaceId, existNodeToken);
          if (nodeExists) {
            nodeToken = existNodeToken;
            objToken = existObjToken;

            // T136-T137: detect primary type change and move origin node to new type directory
            const existingParentType = existingRows[0].parent_type as string | null;
            if (existingParentType && existingParentType !== primaryType) {
              try {
                const newParentToken = await resolveParentToken(spaceId, primaryType, feishuCfg, dirTokenCache);
                await feishuMoveNode(spaceId, nodeToken, newParentToken);
                if (!jsonOutput) console.log(`  MOVED  ${slug}: ${existingParentType} → ${primaryType}`);
              } catch (e: unknown) {
                console.log(`  ⚠ move failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }

            // T78/T177-T179: detect title change → rename wiki node + update doc title block
            if (existingRows[0].title && existingRows[0].title !== page.title) {
              // Spec 38 R1: rename wiki node (sidebar/breadcrumb)
              try {
                await feishuRenameNode(spaceId, nodeToken, page.title);
                console.log(`  RENAMED ${slug}: "${existingRows[0].title}" → "${page.title}"`);
              } catch (e: unknown) {
                console.log(`  ⚠ rename failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
              }
              // Spec 38 R2: update document title block (Page block, block_type=1)
              try {
                await feishuUpdateDocTitle(objToken, page.title);
              } catch (e: unknown) {
                console.log(`  ⚠ doc title update failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          } else {
            // Stale record — archive old Feishu node and clean sync record
            if (!jsonOutput) console.log(`  STALE  ${slug}  — archiving old node and creating new`);
            // Try to move old node to trash (best-effort)
            try {
              const trashToken = await ensureTrashNode(spaceId, config);
              if (trashToken) {
                await feishuMoveNode(spaceId, existNodeToken, trashToken);
              }
            } catch { /* best-effort — node may already be gone */ }
            await rawQuery(engine,
              `DELETE FROM feishu_sync WHERE slug = $1 AND node_token = $2`,
              [slug, existNodeToken]);
            const parentToken = await resolveParentToken(spaceId, primaryType, feishuCfg, dirTokenCache);
            const newNode = await createNodeChecked(parentToken, page.title);
            nodeToken = newNode.node_token;
            objToken = newNode.obj_token;
            isNewNode = !newNode.reused;
            if (newNode.reused && !jsonOutput) console.log(`  REUSE  ${slug}  (existing node found by title)`);
          }
        }
      } else {
        // R1: no record → create new node
        const parentToken = await resolveParentToken(spaceId, primaryType, feishuCfg, dirTokenCache);
        const newNode = await createNodeChecked(parentToken, page.title);
        nodeToken = newNode.node_token;
        objToken = newNode.obj_token;
        isNewNode = !newNode.reused;
        if (newNode.reused && !jsonOutput) console.log(`  REUSE  ${slug}  (existing node found by title)`);
      }

      // d. Upsert feishu_sync record immediately (R3: idempotent — node recorded before content write)
      const nowIso = new Date().toISOString();
      if (isNewNode) {
        // New node — INSERT (may conflict on slug+node_token PK)
        // Spec 40: Do NOT set content_hash here — only after successful content write
        await rawQuery(
          engine,
          `INSERT INTO feishu_sync
             (slug, space_id, node_token, obj_token, node_type, parent_type, last_push_at, content_hash, title)
           VALUES ($1, $2, $3, $4, 'origin', $5, $6, NULL, $7)
           ON CONFLICT (slug, node_token) DO UPDATE
             SET obj_token    = EXCLUDED.obj_token,
                 node_type    = 'origin',
                 parent_type  = EXCLUDED.parent_type,
                 last_push_at = EXCLUDED.last_push_at,
                 title        = EXCLUDED.title`,
          [slug, spaceId, nodeToken, objToken, primaryType, nowIso, page.title],
        );
      } else {
        // Existing or REUSEd node — UPSERT to ensure feishu_sync row exists with node_type='origin'
        // Spec 24 R1: Do NOT update content_hash here — let Pass 2 decide whether to rewrite
        await rawQuery(
          engine,
          `INSERT INTO feishu_sync
             (slug, space_id, node_token, obj_token, node_type, parent_type, last_push_at, title)
           VALUES ($1, $2, $3, $4, 'origin', $5, $6, $7)
           ON CONFLICT (slug, node_token) DO UPDATE
             SET obj_token    = EXCLUDED.obj_token,
                 node_type    = 'origin',
                 parent_type  = EXCLUDED.parent_type,
                 last_push_at = EXCLUDED.last_push_at,
                 title        = EXCLUDED.title`,
          [slug, spaceId, nodeToken, objToken, primaryType, nowIso, page.title],
        );
      }

      // Update syncMap so all pages can resolve wiki-links
      feishuSyncMap.set(slug, objToken);
      nodeInfo.set(slug, { nodeToken, objToken, isNewNode });

      // ----------------------------------------------------------------
      // Spec 17 R2: Create shortcut nodes for secondary types
      // Spec 17 R3: Root pinning via pin_to_root frontmatter
      // Spec 17 R4: Cleanup stale shortcuts on type change
      // ----------------------------------------------------------------
      {
        // Query existing shortcuts for this slug (exclude the origin node_token to avoid false matches)
        const existingShortcuts = await rawQuery(
          engine,
          `SELECT node_token, obj_token, parent_type, node_type FROM feishu_sync
            WHERE slug = $1 AND space_id = $2 AND node_type = 'shortcut' AND node_token != $3`,
          [slug, spaceId, nodeToken],
        );
        const existingShortcutsByType = new Map<string, { node_token: string; obj_token: string }>();
        for (const row of existingShortcuts) {
          existingShortcutsByType.set(
            row.parent_type as string,
            { node_token: row.node_token as string, obj_token: row.obj_token as string },
          );
        }

        // R2: Create shortcuts for secondary types (types[1], types[2], ...)
        const secondaryTypes = (page.types ?? []).slice(1);
        const expectedShortcutTypes = new Set(secondaryTypes);

        for (const secType of secondaryTypes) {
          const existing = existingShortcutsByType.get(secType);
          if (existing) {
            // Validate the shortcut still exists on Feishu
            const shortcutValid = await feishuValidateNode(spaceId, existing.node_token);
            if (shortcutValid) {
              if (!jsonOutput) console.log(`  SHORTCUT  ${slug} → ${secType}  (exists)`);
              continue;
            }
            // Stale shortcut — clean up record
            await rawQuery(engine,
              `DELETE FROM feishu_sync WHERE slug = $1 AND node_token = $2`,
              [slug, existing.node_token]);
          }

          // Create shortcut pointing to origin node (Spec 22: check first)
          try {
            const secParentToken = await resolveParentToken(spaceId, secType, feishuCfg, dirTokenCache);
            const shortcutNode = await createNodeChecked(secParentToken, page.title, 'shortcut', nodeToken);
            // Record shortcut in feishu_sync
            const nowShortcut = new Date().toISOString();
            await rawQuery(
              engine,
              `INSERT INTO feishu_sync
                 (slug, space_id, node_token, obj_token, node_type, parent_type, last_push_at)
               VALUES ($1, $2, $3, $4, 'shortcut', $5, $6)
               ON CONFLICT (slug, node_token) DO UPDATE
                 SET node_type = 'shortcut', parent_type = EXCLUDED.parent_type, last_push_at = EXCLUDED.last_push_at`,
              [slug, spaceId, shortcutNode.node_token, shortcutNode.obj_token, secType, nowShortcut],
            );
            if (!jsonOutput) console.log(`  SHORTCUT  ${slug} → ${secType}  (created)`);
          } catch (scErr) {
            const msg = scErr instanceof Error ? scErr.message : String(scErr);
            // Spec 18 R1: Handle Feishu 131001 error (shortcut already exists) — recover existing node
            if (msg.includes('131001')) {
              try {
                const secParentToken = await resolveParentToken(spaceId, secType, feishuCfg, dirTokenCache);
                // List children of the specific type directory (not root)
                const dirChildren = await rawQuery(engine,
                  `SELECT 1 FROM feishu_sync WHERE slug = $1 AND space_id = $2 AND parent_type = $3 AND node_type = 'shortcut'`,
                  [slug, spaceId, secType]);
                if (dirChildren.length > 0) {
                  // Already recorded — skip
                  if (!jsonOutput) console.log(`  SHORTCUT  ${slug} → ${secType}  (exists)`);
                } else {
                  // Try to find via Feishu API
                  const parentNodes = await runLarkCli([
                    'wiki', 'nodes', 'list',
                    '--params', JSON.stringify({ space_id: spaceId, parent_node_token: secParentToken }),
                    '--format', 'json',
                  ]).catch(() => '{}');
                  const parsed = JSON.parse(parentNodes.replace(/^[^{]*/, '').replace(/[^}]*$/, '') || '{}');
                  const items = parsed?.data?.items || [];
                  const existing = items.find((n: any) => n.title === page.title);
                  if (existing) {
                    const nowRecovered = new Date().toISOString();
                    await rawQuery(engine,
                      `INSERT INTO feishu_sync (slug, space_id, node_token, obj_token, node_type, parent_type, last_push_at)
                       VALUES ($1, $2, $3, $4, 'shortcut', $5, $6)
                       ON CONFLICT (slug, node_token) DO UPDATE SET node_type = 'shortcut', parent_type = EXCLUDED.parent_type, last_push_at = EXCLUDED.last_push_at`,
                      [slug, spaceId, existing.node_token, existing.obj_token, secType, nowRecovered]);
                    if (!jsonOutput) console.log(`  SHORTCUT-RECOVERED  ${slug} → ${secType}  (131001 → found)`);
                  } else {
                    if (!jsonOutput) console.log(`  SHORTCUT  ${slug} → ${secType}  (131001 — already exists on Feishu)`);
                  }
                }
              } catch (recoveryErr) {
                const recoveryMsg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
                if (!jsonOutput) console.log(`  SHORTCUT-FAIL  ${slug} → ${secType}  — recovery failed: ${recoveryMsg}`);
              }
            } else {
              if (!jsonOutput) console.log(`  SHORTCUT-FAIL  ${slug} → ${secType}  — ${msg}`);
            }
          }
        }

        // R3: Root pinning — create shortcut at wiki root if pin_to_root is set
        const pinToRoot = page.frontmatter?.pin_to_root === true;
        const existingRootShortcut = existingShortcutsByType.get('__root__');

        if (pinToRoot) {
          if (existingRootShortcut) {
            const rootValid = await feishuValidateNode(spaceId, existingRootShortcut.node_token);
            if (rootValid) {
              if (!jsonOutput) console.log(`  PIN-ROOT  ${slug}  (exists)`);
            } else {
              // Stale root shortcut — recreate (Spec 22: check first)
              await rawQuery(engine,
                `DELETE FROM feishu_sync WHERE slug = $1 AND node_token = $2`,
                [slug, existingRootShortcut.node_token]);
              try {
                const rootShortcut = await createNodeChecked('', page.title, 'shortcut', nodeToken);
                const nowRoot = new Date().toISOString();
                await rawQuery(
                  engine,
                  `INSERT INTO feishu_sync
                     (slug, space_id, node_token, obj_token, node_type, parent_type, last_push_at)
                   VALUES ($1, $2, $3, $4, 'shortcut', '__root__', $5)
                   ON CONFLICT (slug, node_token) DO UPDATE
                     SET node_type = 'shortcut', parent_type = '__root__', last_push_at = EXCLUDED.last_push_at`,
                  [slug, spaceId, rootShortcut.node_token, rootShortcut.obj_token, nowRoot],
                );
                if (!jsonOutput) console.log(`  PIN-ROOT  ${slug}  (${rootShortcut.reused ? 'reused' : 'recreated'})`);
              } catch (rootErr) {
                const msg = rootErr instanceof Error ? rootErr.message : String(rootErr);
                if (!jsonOutput) console.log(`  PIN-ROOT-FAIL  ${slug}  — ${msg}`);
              }
            }
          } else {
            // Create new root shortcut (Spec 22: check first)
            try {
              const rootShortcut = await createNodeChecked('', page.title, 'shortcut', nodeToken);
              const nowRoot = new Date().toISOString();
              await rawQuery(
                engine,
                `INSERT INTO feishu_sync
                   (slug, space_id, node_token, obj_token, node_type, parent_type, last_push_at)
                 VALUES ($1, $2, $3, $4, 'shortcut', '__root__', $5)
                 ON CONFLICT (slug, node_token) DO UPDATE
                   SET node_type = 'shortcut', parent_type = '__root__', last_push_at = EXCLUDED.last_push_at`,
                [slug, spaceId, rootShortcut.node_token, rootShortcut.obj_token, nowRoot],
              );
              if (!jsonOutput) console.log(`  PIN-ROOT  ${slug}  (${rootShortcut.reused ? 'reused' : 'created'})`);
            } catch (rootErr) {
              const msg = rootErr instanceof Error ? rootErr.message : String(rootErr);
              if (!jsonOutput) console.log(`  PIN-ROOT-FAIL  ${slug}  — ${msg}`);
            }
          }
        } else if (existingRootShortcut) {
          // R3: pin_to_root removed — archive existing root shortcut
          try {
            const trashToken = await ensureTrashNode(spaceId, config);
            if (trashToken) {
              await feishuMoveNode(spaceId, existingRootShortcut.node_token, trashToken);
            }
            await rawQuery(engine,
              `UPDATE feishu_sync SET node_type = 'archived' WHERE slug = $1 AND node_token = $2`,
              [slug, existingRootShortcut.node_token]);
            if (!jsonOutput) console.log(`  UNPIN-ROOT  ${slug}  (archived)`);
          } catch (unpinErr) {
            const msg = unpinErr instanceof Error ? unpinErr.message : String(unpinErr);
            if (!jsonOutput) console.log(`  UNPIN-ROOT-FAIL  ${slug}  — ${msg}`);
          }
        }

        // R4: Cleanup stale shortcuts — remove shortcuts for types no longer on the page
        const primaryType2 = (page.types ?? [])[0] ?? 'note';
        for (const [parentType, shortcutInfo] of existingShortcutsByType) {
          if (parentType === '__root__') continue; // Root handled separately above
          if (parentType === primaryType2) continue; // Skip primary type — origin lives there, not a stale shortcut
          if (!expectedShortcutTypes.has(parentType)) {
            // This shortcut's type is no longer in page.types — archive it
            try {
              const trashToken = await ensureTrashNode(spaceId, config);
              if (trashToken) {
                await feishuMoveNode(spaceId, shortcutInfo.node_token, trashToken);
              }
              await rawQuery(engine,
                `UPDATE feishu_sync SET node_type = 'archived' WHERE slug = $1 AND node_token = $2`,
                [slug, shortcutInfo.node_token]);
              if (!jsonOutput) console.log(`  CLEANUP  shortcut ${slug} from ${parentType}  (type removed)`);
            } catch (cleanErr) {
              const msg = cleanErr instanceof Error ? cleanErr.message : String(cleanErr);
              if (!jsonOutput) console.log(`  CLEANUP-FAIL  shortcut ${slug} from ${parentType}  — ${msg}`);
            }
          }
        }
      }

      // e. For single-slug mode (Spec 12 R2): write content immediately (single-pass)
      //    Uses Feishu block API for clickable hyperlinks (Spec 11 R1/R3)
      if (singleSlug) {
        // Spec 17 R1: Skip content write if hash unchanged and not a new node
        // Spec 41: Unless a wiki-link target was pushed after our last push
        const storedSingleHash = existingRows.length > 0 ? (existingRows[0].content_hash as string | null) : null;
        let singleSkip = !isNewNode && storedSingleHash && page.content_hash && storedSingleHash === page.content_hash;
        if (singleSkip) {
          // Spec 41 R1-R3: check for newly-available wiki-link targets
          const staleLinks = await hasNewlyAvailableWikiLinks(engine, page.compiled_truth, slug, spaceId);
          if (staleLinks) {
            singleSkip = false;
            if (!jsonOutput) console.log(`  REWRITE ${slug}  (wiki-link targets updated)`);
          }
        }
        if (singleSkip) {
          // Spec 48 R4: recover missing attachments even when content unchanged
          const rawSources = normalizeRawSource(page.frontmatter?.raw_source);
          if (rawSources.length > 0) {
            const skipBlocks = await feishuFetchDocBlocks(objToken);
            if (findAttachmentSectionStart(skipBlocks) < 0) {
              await appendRawAttachments(objToken, page, config, jsonOutput);
              if (!jsonOutput) console.log(`  OK    ${slug}  (unchanged, attachments recovered)`);
            } else {
              if (!jsonOutput) console.log(`  OK    ${slug}  (unchanged)`);
            }
          } else {
            if (!jsonOutput) console.log(`  OK    ${slug}  (unchanged)`);
          }
          pushed++;
        } else {
          const singleMarkdown = serializeForFeishu(page.compiled_truth, page.title);
          const blocks = convertMarkdownToBlocks(
            singleMarkdown,
            feishuSyncMap,
          );
          try {
            // Spec 48: exclude attachment section from INCR diff
            const existingBlocks = await feishuFetchDocBlocks(objToken);
            const attachIdx = findAttachmentSectionStart(existingBlocks);
            await feishuIncrementalUpdateDocBlocks(
              objToken, blocks,
              attachIdx >= 0 ? attachIdx : undefined,
              existingBlocks,
            );
          } catch (updateErr) {
            const errMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
            const is404 = errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('NotFound') || errMsg.includes('resource deleted') || errMsg.includes('1770003');

            if (!isNewNode && is404) {
              if (!jsonOutput) console.log(`  RECOVER  ${slug}  (Feishu node lost, recreating...)`);
              const parentToken = await resolveParentToken(spaceId, primaryType, feishuCfg, dirTokenCache);
              const recoveredNode = await createNodeChecked(parentToken, page.title);
              // Clean up old feishu_sync records before updating
              await rawQuery(engine, `DELETE FROM feishu_sync WHERE slug = $1 AND space_id = $2 AND node_type = 'origin'`, [slug, spaceId]);
              nodeInfo.set(slug, { nodeToken: recoveredNode.node_token, objToken: recoveredNode.obj_token, isNewNode: !recoveredNode.reused });
              await feishuUpdateDocBlocks(recoveredNode.obj_token, blocks, singleMarkdown);
            } else if (isNewNode) {
              const trashToken = await ensureTrashNode(spaceId, config);
              if (trashToken) {
                try { await feishuMoveNode(spaceId, nodeToken, trashToken); } catch { /* best-effort */ }
              }
              throw updateErr;
            } else {
              throw updateErr;
            }
          }
          // Append raw file attachments (Spec 25 R3)
          await appendRawAttachments(objToken, page, config, jsonOutput);
          // Spec 40: Update content_hash AFTER successful write
          const pushNowSingle = new Date().toISOString();
          const singleInfo = nodeInfo.get(slug);
          await rawQuery(engine,
            `UPDATE feishu_sync SET content_hash = $1, last_push_at = $2 WHERE slug = $3 AND node_type = 'origin' AND space_id = $4`,
            [page.content_hash, pushNowSingle, slug, spaceId]);
          pushed++;
          if (!jsonOutput) console.log(`  OK    ${slug}`);
        }
      } else {
        if (!jsonOutput) console.log(`  NODE  ${slug}  (${isNewNode ? 'created' : 'exists'})`);
      }

    } catch (err) {
      // Auto-repair: detect index corruption and attempt REINDEX before failing
      if (isIndexCorruptionError(err)) {
        const repaired = await autoReindexOnCorruption(engine, err, jsonOutput);
        if (repaired) {
          // Retry this slug — push it back for retry by not counting as failure
          // We'll retry in a second pass below
          if (!jsonOutput) console.log(`  RETRY  ${slug}  (after auto-repair)`);
          // Don't add to failures; mark for retry
          if (!nodeInfo.has(slug)) {
            // Will be retried in the retry loop below
            (slugsToPush as any).__retryAfterReindex = (slugsToPush as any).__retryAfterReindex || [];
            (slugsToPush as any).__retryAfterReindex.push(slug);
          }
          continue;
        }
      }
      const errMsg = err instanceof LarkCliError
        ? err.message
        : err instanceof Error ? err.message : String(err);
      failures.push({ slug, error: errMsg });
      failed++;
      if (!jsonOutput) console.log(`  FAIL  ${slug}  — ${errMsg}`);
      // Spec 40 T186: Clear content_hash on failure so next push retries
      try {
        await rawQuery(engine,
          `UPDATE feishu_sync SET content_hash = NULL WHERE slug = $1 AND node_type = 'origin' AND space_id = $2`,
          [slug, spaceId]);
      } catch { /* best-effort */ }
    }
  }

  // ================================================================
  // PASS 1 RETRY: Re-push slugs that failed due to index corruption (after auto-repair)
  // ================================================================
  const retrySlugsList: string[] = (slugsToPush as any).__retryAfterReindex || [];
  if (retrySlugsList.length > 0 && !jsonOutput) {
    console.log(`\n  Retrying ${retrySlugsList.length} slug(s) after index repair...`);
  }
  for (const slug of retrySlugsList) {
    try {
      const page = await getPageFromFileOrDB(engine, slug, config);
      if (!page) {
        failures.push({ slug, error: 'page not found (retry)' });
        failed++;
        continue;
      }
      const primaryType = page.types[0] ?? 'note';
      const parentToken = await resolveParentToken(spaceId, primaryType, feishuCfg, dirTokenCache);
      const newNode = await createNodeChecked(parentToken, page.title);
      const nodeToken = newNode.node_token;
      const objToken = newNode.obj_token;
      const isNewNode = !newNode.reused;

      const nowIso = new Date().toISOString();
      await rawQuery(
        engine,
        `INSERT INTO feishu_sync
           (slug, space_id, node_token, obj_token, node_type, parent_type, last_push_at, content_hash, title)
         VALUES ($1, $2, $3, $4, 'origin', $5, $6, NULL, $7)
         ON CONFLICT (slug, node_token) DO UPDATE
           SET obj_token    = EXCLUDED.obj_token,
               node_type    = 'origin',
               parent_type  = EXCLUDED.parent_type,
               last_push_at = EXCLUDED.last_push_at,
               title        = EXCLUDED.title`,
        [slug, spaceId, nodeToken, objToken, primaryType, nowIso, page.title],
      );
      feishuSyncMap.set(slug, objToken);
      nodeInfo.set(slug, { nodeToken, objToken, isNewNode });
      if (!jsonOutput) console.log(`  NODE  ${slug}  (${isNewNode ? 'created' : 'exists'} — retry OK)`);
    } catch (retryErr) {
      const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      failures.push({ slug, error: errMsg });
      failed++;
      if (!jsonOutput) console.log(`  FAIL  ${slug}  — ${errMsg} (retry failed)`);
    }
  }

  // ================================================================
  // PASS 1.5: Single-slug backlink resolution
  // When pushing a single slug, find other Feishu pages that reference
  // [[this-slug]] and rewrite them so wiki-links become clickable.
  // ================================================================
  if (singleSlug && pushed > 0 && failed === 0) {
    // Refresh syncMap after Pass 1 (the pushed slug now has an obj_token)
    const freshSingleRows = await rawQuery(
      engine,
      `SELECT slug, obj_token FROM feishu_sync WHERE space_id = $1 AND node_type != 'archived'`,
      [spaceId],
    );
    feishuSyncMap.clear();
    for (const row of freshSingleRows) {
      feishuSyncMap.set(row.slug as string, row.obj_token as string);
    }

    // Find pages whose compiled_truth contains [[pushed-slug]]
    const backlinkPattern = `[[${singleSlug}]]`;
    const allPages = await rawQuery(
      engine,
      `SELECT slug, compiled_truth, content_hash FROM pages WHERE compiled_truth LIKE $1`,
      [`%${backlinkPattern}%`],
    );
    const backlinkSlugs = allPages
      .map((r: any) => r.slug as string)
      .filter((s: string) => s !== singleSlug);

    if (backlinkSlugs.length > 0) {
      if (!jsonOutput) console.log(`  Backlink resolution: ${backlinkSlugs.length} page(s) reference [[${singleSlug}]]`);

      for (const blSlug of backlinkSlugs) {
        // Only update pages that are already pushed to Feishu
        const blObjToken = feishuSyncMap.get(blSlug);
        if (!blObjToken) continue;

        try {
          const blPage = await getPageFromFileOrDB(engine, blSlug, config);
          if (!blPage) continue;

          const blMarkdown = serializeForFeishu(blPage.compiled_truth, blPage.title);
          const blBlocks = convertMarkdownToBlocks(blMarkdown, feishuSyncMap);
          // Spec 48: exclude attachment section from INCR diff
          const blExistingBlocks = await feishuFetchDocBlocks(blObjToken);
          const blAttachIdx = findAttachmentSectionStart(blExistingBlocks);
          await feishuIncrementalUpdateDocBlocks(
            blObjToken, blBlocks,
            blAttachIdx >= 0 ? blAttachIdx : undefined,
            blExistingBlocks,
          );
          await appendRawAttachments(blObjToken, blPage, config, jsonOutput);

          // Update content_hash + last_push_at
          const blPushNow = new Date().toISOString();
          await rawQuery(engine,
            `UPDATE feishu_sync SET content_hash = $1, last_push_at = $2 WHERE slug = $3 AND node_type = 'origin' AND space_id = $4`,
            [blPage.content_hash, blPushNow, blSlug, spaceId]);

          if (!jsonOutput) console.log(`  REWRITE ${blSlug}  (backlink to [[${singleSlug}]] resolved)`);
        } catch (blErr) {
          const blMsg = blErr instanceof Error ? blErr.message : String(blErr);
          if (!jsonOutput) console.log(`  BACKLINK-FAIL  ${blSlug}  — ${blMsg}`);
          // Non-fatal: backlink update failure shouldn't fail the main push
        }
      }
    }
  }

  // ================================================================
  // PASS 2: Write content with complete wiki-link resolution
  // Only runs for multi-page push (not single-slug)
  // ================================================================
  if (!singleSlug && nodeInfo.size > 0) {
    if (!jsonOutput) {
      console.log(`  Pass 2: Writing content with resolved wiki-links...`);
    }

    // Rebuild feishuSyncMap from DB to ensure completeness
    // Also build syncHashMap for content-hash skip (Spec 17 R1)
    const freshSyncRows = await rawQuery(
      engine,
      `SELECT slug, obj_token, content_hash FROM feishu_sync WHERE space_id = $1 AND node_type != 'archived'`,
      [spaceId],
    );
    feishuSyncMap.clear();
    const syncHashMap = new Map<string, string | null>();
    for (const row of freshSyncRows) {
      feishuSyncMap.set(row.slug as string, row.obj_token as string);
      syncHashMap.set(row.slug as string, (row.content_hash as string) ?? null);
    }

    for (const slug of slugsToPush) {
      const info = nodeInfo.get(slug);
      if (!info) continue; // Failed in Pass 1

      try {
        const page = await getPageFromFileOrDB(engine, slug, config);
        if (!page) continue;

        const primaryType = page.types[0] ?? 'note';

        // Spec 17 R1: Skip content write if hash unchanged and not a new node
        // Spec 41: Unless a wiki-link target was pushed after our last push
        const storedHash = syncHashMap.get(slug);
        let pass2Skip = !!(
          !info.isNewNode && storedHash && page.content_hash && storedHash === page.content_hash
        );
        if (pass2Skip) {
          // Spec 41 R1-R3: check for newly-available wiki-link targets
          const staleLinks = await hasNewlyAvailableWikiLinks(engine, page.compiled_truth, slug, spaceId);
          if (staleLinks) {
            pass2Skip = false;
            if (!jsonOutput) console.log(`  REWRITE ${slug}  (wiki-link targets updated)`);
          }
        }
        if (pass2Skip) {
          pushed++;
          if (!jsonOutput) console.log(`  OK    ${slug}  (unchanged)`);
          continue;
        }

        // Convert to Feishu block API format with complete wiki-link map (Spec 11 R1/R3)
        const pass2Markdown = serializeForFeishu(page.compiled_truth, page.title);
        const blocks = convertMarkdownToBlocks(
          pass2Markdown,
          feishuSyncMap,
        );

        let { nodeToken, objToken, isNewNode } = info;

        // Write content (R2: transactional, R5: auto-recovery)
        try {
          // Spec 48: exclude attachment section from INCR diff
          const pass2ExistingBlocks = await feishuFetchDocBlocks(objToken);
          const pass2AttachIdx = findAttachmentSectionStart(pass2ExistingBlocks);
          await feishuIncrementalUpdateDocBlocks(
            objToken, blocks,
            pass2AttachIdx >= 0 ? pass2AttachIdx : undefined,
            pass2ExistingBlocks,
          );
        } catch (updateErr) {
          const errMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
          const is404 = errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('NotFound') || errMsg.includes('resource deleted') || errMsg.includes('1770003');

          if (!isNewNode && is404) {
            if (!jsonOutput) console.log(`  RECOVER  ${slug}  (Feishu node lost, recreating...)`);
            const parentToken = await resolveParentToken(spaceId, primaryType, feishuCfg, dirTokenCache);
            const recoveredNode = await createNodeChecked(parentToken, page.title);
            nodeToken = recoveredNode.node_token;
            objToken = recoveredNode.obj_token;
            isNewNode = !recoveredNode.reused;
            // Clean up old feishu_sync records for this slug before inserting new one
            await rawQuery(
              engine,
              `DELETE FROM feishu_sync WHERE slug = $1 AND space_id = $2 AND node_type = 'origin'`,
              [slug, spaceId],
            );
            // Update feishu_sync with new node
            // Spec 40: Do NOT set content_hash here — the post-write UPDATE below handles it
            const nowIso = new Date().toISOString();
            await rawQuery(
              engine,
              `INSERT INTO feishu_sync
                 (slug, space_id, node_token, obj_token, node_type, parent_type, last_push_at, content_hash)
               VALUES ($1, $2, $3, $4, 'origin', $5, $6, NULL)
               ON CONFLICT (slug, node_token) DO UPDATE
                 SET obj_token = EXCLUDED.obj_token, node_type = 'origin',
                     parent_type = EXCLUDED.parent_type, last_push_at = EXCLUDED.last_push_at`,
              [slug, spaceId, nodeToken, objToken, primaryType, nowIso],
            );
            await feishuUpdateDocBlocks(objToken, blocks, pass2Markdown);
          } else if (isNewNode) {
            const trashToken = await ensureTrashNode(spaceId, config);
            if (trashToken) {
              try { await feishuMoveNode(spaceId, nodeToken, trashToken); } catch { /* best-effort */ }
            }
            throw updateErr;
          } else {
            throw updateErr;
          }
        }

        // Append raw file attachments (Spec 25 R3)
        await appendRawAttachments(objToken, page, config, jsonOutput);

        // Update content_hash after successful write (so next push skips unchanged)
        const pushNow = new Date().toISOString();
        await rawQuery(engine,
          `UPDATE feishu_sync SET content_hash = $1, last_push_at = $2 WHERE slug = $3 AND node_type = 'origin' AND space_id = $4`,
          [page.content_hash, pushNow, slug, spaceId]);
        pushed++;
        if (!jsonOutput) console.log(`  OK    ${slug}`);

      } catch (err) {
        // Auto-repair: detect index corruption in Pass 2 and attempt REINDEX
        if (isIndexCorruptionError(err)) {
          const repaired = await autoReindexOnCorruption(engine, err, jsonOutput);
          if (repaired) {
            // Retry this specific slug's content write
            try {
              const retryPage = await getPageFromFileOrDB(engine, slug, config);
              if (retryPage) {
                const retryMarkdown = serializeForFeishu(retryPage.compiled_truth, retryPage.title);
                const retryBlocks = convertMarkdownToBlocks(retryMarkdown, feishuSyncMap);
                await feishuUpdateDocBlocks(info.objToken, retryBlocks, retryMarkdown);
                await appendRawAttachments(info.objToken, retryPage, config, jsonOutput);
                const retryPushNow = new Date().toISOString();
                await rawQuery(engine,
                  `UPDATE feishu_sync SET content_hash = $1, last_push_at = $2 WHERE slug = $3 AND node_type = 'origin' AND space_id = $4`,
                  [retryPage.content_hash, retryPushNow, slug, spaceId]);
                pushed++;
                if (!jsonOutput) console.log(`  OK    ${slug}  (retry after auto-repair)`);
                continue;
              }
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              failures.push({ slug, error: `auto-repair retry failed: ${retryMsg}` });
              failed++;
              if (!jsonOutput) console.log(`  AUTO-REPAIR-ERR  ${slug}  — retry failed: ${retryMsg}`);
              // Spec 40 T186: Clear content_hash on failure so next push retries
              try {
                await rawQuery(engine,
                  `UPDATE feishu_sync SET content_hash = NULL WHERE slug = $1 AND node_type = 'origin' AND space_id = $2`,
                  [slug, spaceId]);
              } catch { /* best-effort */ }
              continue;
            }
          }
        }
        const errMsg = err instanceof LarkCliError
          ? err.message
          : err instanceof Error ? err.message : String(err);
        failures.push({ slug, error: errMsg });
        failed++;
        if (!jsonOutput) console.log(`  FAIL  ${slug}  — ${errMsg}`);
        // Spec 40 T186: Clear content_hash on failure so next push retries
        try {
          await rawQuery(engine,
            `UPDATE feishu_sync SET content_hash = NULL WHERE slug = $1 AND node_type = 'origin' AND space_id = $2`,
            [slug, spaceId]);
        } catch { /* best-effort */ }
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. Spec 15 R3: Cleanup stale pages on all multi-page pushes
  //    (opt out with --no-cleanup; single-slug pushes skip cleanup)
  // ------------------------------------------------------------------
  let archived = 0;
  if (!singleSlug && !noCleanup) {
    archived = await runCleanupFlow(engine, spaceId, config, jsonOutput);
  }

  // ------------------------------------------------------------------
  // 6b. Spec 09 R2: Push CHANGELOG.md as wiki page "📋 修改历史"
  // ------------------------------------------------------------------
  await pushChangelogToFeishu(engine, spaceId, config, jsonOutput);

  // ------------------------------------------------------------------
  // 7. Summary
  // ------------------------------------------------------------------
  if (jsonOutput) {
    console.log(JSON.stringify({ pushed, failed, archived, failures }));
    if (failed > 0) process.exit(1);
    return;
  }

  console.log('');
  console.log(`Push complete: ${pushed} pushed, ${failed} failed${!singleSlug && !noCleanup ? `, ${archived} archived` : ''}`);
  if (failures.length > 0) {
    console.log('\nFailed pages:');
    for (const f of failures) {
      console.log(`  ${f.slug}: ${f.error}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve parent directory token for a type, creating dir if needed
// ---------------------------------------------------------------------------
async function resolveParentToken(
  spaceId: string,
  primaryType: string,
  feishuCfg: FeishuConfig,
  dirTokenCache: Record<string, string>,
): Promise<string> {
  if (dirTokenCache[primaryType]) return dirTokenCache[primaryType];

  // No known root node for this type — check if one exists before creating (Spec 22)
  const typeLabel = feishuCfg.type_labels?.[primaryType] ?? primaryType;
  try {
    const existing = await findExistingChildByTitle(spaceId, '', typeLabel);
    if (existing) {
      dirTokenCache[primaryType] = existing.node_token;
      return existing.node_token;
    }
    const dirNode = await feishuCreateNode(spaceId, '', typeLabel);
    dirTokenCache[primaryType] = dirNode.node_token;
    // Persist to config
    const freshConfig = loadConfig();
    if (freshConfig?.feishu) {
      freshConfig.feishu.root_node_tokens = {
        ...(freshConfig.feishu.root_node_tokens ?? {}),
        [primaryType]: dirNode.node_token,
      };
      saveConfig(freshConfig);
    }
    return dirNode.node_token;
  } catch {
    return spaceId; // Fallback to space root
  }
}

// ---------------------------------------------------------------------------
// Truncate CHANGELOG to latest N entries for Feishu push
// (local CHANGELOG.md keeps full history; Feishu only shows recent)
// ---------------------------------------------------------------------------
function truncateChangelog(content: string, maxEntries: number): string {
  const lines = content.split('\n');
  const entryStartIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      entryStartIndices.push(i);
    }
  }

  if (entryStartIndices.length <= maxEntries) {
    return content; // No truncation needed
  }

  // Take only the first maxEntries entries (newest first in file)
  const cutoffLine = entryStartIndices[maxEntries];
  const truncated = lines.slice(0, cutoffLine).join('\n');
  return truncated.trimEnd() + '\n\n---\n*（仅显示最近 ' + maxEntries + ' 条记录）*\n';
}

// ---------------------------------------------------------------------------
// Spec 09 R2: Push CHANGELOG.md to Feishu as "📋 修改历史" root-level page
// ---------------------------------------------------------------------------
async function pushChangelogToFeishu(
  engine: BrainEngine,
  spaceId: string,
  config: GBrainConfig,
  jsonOutput: boolean,
): Promise<void> {
  const brainDir = getBrainDir(config);
  const changelogPath = `${brainDir}/CHANGELOG.md`;

  let changelogContent: string;
  try {
    changelogContent = await Bun.file(changelogPath).text();
  } catch {
    // No CHANGELOG.md — nothing to push
    return;
  }

  if (!changelogContent.trim()) return;

  // Check content hash to avoid unnecessary pushes
  const { createHash } = await import('crypto');
  const truncatedContent = truncateChangelog(changelogContent, 100);
  const hash = createHash('sha256').update(truncatedContent).digest('hex').slice(0, 16);

  const CHANGELOG_SLUG = '__changelog__';

  // Check existing feishu_sync record (exclude archived)
  const existingRows = await rawQuery(
    engine,
    `SELECT node_token, obj_token, content_hash FROM feishu_sync
      WHERE slug = $1 AND space_id = $2 AND node_type != 'archived'
      LIMIT 1`,
    [CHANGELOG_SLUG, spaceId],
  );

  if (existingRows.length > 0 && existingRows[0].content_hash === hash) {
    // No changes since last push
    return;
  }

  try {
    let nodeToken: string;
    let objToken: string;

    if (existingRows.length > 0) {
      nodeToken = existingRows[0].node_token as string;
      objToken = existingRows[0].obj_token as string;
    } else {
      // Create new root-level node for changelog (Spec 22: check first)
      const existing = await findExistingChildByTitle(spaceId, '', '📋 修改历史');
      if (existing) {
        nodeToken = existing.node_token;
        objToken = existing.obj_token;
      } else {
        const node = await feishuCreateNode(spaceId, '', '📋 修改历史');
        nodeToken = node.node_token;
        objToken = node.obj_token;
      }
    }

    const blocks = convertMarkdownToBlocks(truncatedContent, new Map());
    await feishuUpdateDocBlocks(objToken, blocks, truncatedContent);

    // Upsert feishu_sync record
    const nowIso = new Date().toISOString();
    await rawQuery(
      engine,
      `INSERT INTO feishu_sync
         (slug, space_id, node_token, obj_token, node_type, last_push_at, content_hash)
       VALUES ($1, $2, $3, $4, 'origin', $5, $6)
       ON CONFLICT (slug, node_token) DO UPDATE
         SET last_push_at = EXCLUDED.last_push_at,
             content_hash = EXCLUDED.content_hash`,
      [CHANGELOG_SLUG, spaceId, nodeToken, objToken, nowIso, hash],
    );

    if (!jsonOutput) console.log(`  OK    📋 修改历史 (CHANGELOG)`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!jsonOutput) console.log(`  FAIL  📋 修改历史 (CHANGELOG) — ${errMsg}`);
  }
}

// ---------------------------------------------------------------------------
// R4: Cleanup flow — diff Brain slugs vs feishu_sync, archive stale pages
// ---------------------------------------------------------------------------
async function runCleanupFlow(
  engine: BrainEngine,
  spaceId: string,
  config: GBrainConfig,
  jsonOutput: boolean,
): Promise<number> {
  // Find feishu_sync records with no corresponding Brain page (stale)
  const staleRows = await rawQuery(
    engine,
    `SELECT fs.slug, fs.node_token, fs.obj_token
       FROM feishu_sync fs
       LEFT JOIN pages p ON p.slug = fs.slug
      WHERE p.slug IS NULL
        AND fs.space_id = $1
        AND fs.node_type != 'archived'
        AND fs.slug NOT LIKE '__%__'`,
    [spaceId],
  );

  if (staleRows.length === 0) {
    if (!jsonOutput) console.log('  No stale Feishu pages to archive.');
    return 0;
  }

  if (!jsonOutput) {
    console.log(`\n  Archiving ${staleRows.length} stale Feishu page(s)...`);
  }

  const trashToken = await ensureTrashNode(spaceId, loadConfig() ?? config);
  let archived = 0;

  for (const row of staleRows) {
    const slug = row.slug as string;
    const nodeToken = row.node_token as string;

    try {
      if (trashToken) {
        await feishuMoveNode(spaceId, nodeToken, trashToken);
      }
      // Mark as archived in feishu_sync
      await rawQuery(
        engine,
        `UPDATE feishu_sync SET node_type = 'archived' WHERE slug = $1 AND node_token = $2`,
        [slug, nodeToken],
      );
      archived++;
      if (!jsonOutput) console.log(`  ARCHIVED  ${slug}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!jsonOutput) console.log(`  ARCHIVE-FAIL  ${slug}  — ${msg}`);
    }
  }

  return archived;
}

// ---------------------------------------------------------------------------
// feishu poll — process unresolved comments on all synced Feishu documents
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// R1 (Spec 08): poll is a PURE COLLECTOR — outputs pending comments as JSON.
// No Brain modification, no comment resolution.  The Agent (LLM) reads this
// output, understands intent, modifies the brain, then calls resolve-comment.
// ---------------------------------------------------------------------------
async function runFeishuPoll(engine: BrainEngine, args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json');

  // 0. Fetch bot open_id for @mention filtering
  let botOpenId = '';
  try {
    botOpenId = await feishuGetBotOpenId();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ error: `Could not get bot open_id: ${msg}` }));
      process.exit(1);
    }
    console.error(`feishu poll: could not get bot open_id: ${msg}`);
    console.error('Ensure lark-cli is authenticated and the bot app is configured.');
    process.exit(1);
  }

  // 1. Fetch all synced documents from feishu_sync
  let syncedRows: Record<string, unknown>[] = [];
  try {
    syncedRows = await rawQuery(
      engine,
      `SELECT DISTINCT ON (slug) slug, obj_token
         FROM feishu_sync
        ORDER BY slug, last_push_at DESC NULLS LAST`,
      [],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ error: `Could not query feishu_sync: ${msg}` }));
      process.exit(1);
    }
    console.error(`feishu poll: could not query feishu_sync: ${msg}`);
    console.error('Run: cfbrain init');
    process.exit(1);
  }

  if (syncedRows.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ pending_comments: [], docs_scanned: 0 }));
      return;
    }
    console.log('No synced Feishu documents found. Run: cfbrain feishu push --all');
    return;
  }

  const pendingComments: Array<{
    slug: string;
    obj_token: string;
    comment_id: string;
    quote: string;
    content: string;
    commenter: string;
  }> = [];
  const errors: Array<{ slug: string; error: string }> = [];

  // 2. Collect unresolved comments from each synced document
  for (const row of syncedRows) {
    const slug = String(row.slug ?? '');
    const objToken = String(row.obj_token ?? '');

    if (!slug || !objToken) continue;

    let comments: Array<{ comment_id: string; content: string; quote: string; is_solved: boolean; commenter?: string; mention_open_ids?: string[] }>;
    try {
      comments = await feishuListComments(objToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ slug, error: `feishuListComments failed: ${msg}` });
      if (!jsonOutput) {
        console.error(`  [${slug}] Could not fetch comments: ${msg}`);
      }
      continue;
    }

    const unresolved = comments.filter((c) => c.is_solved === false);

    for (const c of unresolved) {
      if (!c.comment_id) continue;
      // Spec 36: Only process comments that @mention the bot
      const mentions = c.mention_open_ids ?? [];
      if (botOpenId && !mentions.includes(botOpenId)) continue;

      pendingComments.push({
        slug,
        obj_token: objToken,
        comment_id: c.comment_id,
        quote: c.quote ?? '',
        content: c.content ?? '',
        commenter: (c as Record<string, unknown>).commenter as string ?? '',
      });
    }

    if (!jsonOutput && unresolved.length > 0) {
      console.log(`  [${slug}] ${unresolved.length} unresolved comment(s)`);
    }
  }

  // 3. Output collected comments
  if (jsonOutput) {
    console.log(JSON.stringify({
      pending_comments: pendingComments,
      docs_scanned: syncedRows.length,
      errors: errors.length > 0 ? errors : undefined,
    }));
    return;
  }

  if (pendingComments.length === 0) {
    console.log(`\nScanned ${syncedRows.length} document(s) — no pending comments.`);
    return;
  }

  console.log(`\n${pendingComments.length} pending comment(s) across ${syncedRows.length} document(s):\n`);
  for (const pc of pendingComments) {
    console.log(`  ${pc.slug}  comment_id=${pc.comment_id}`);
    if (pc.quote) console.log(`    quote: "${pc.quote.slice(0, 100)}"`);
    console.log(`    content: ${pc.content.slice(0, 200)}`);
    console.log('');
  }
  console.log('Use the comment skill or resolve-comment to process these.');
  if (errors.length > 0) {
    console.log(`${errors.length} error(s) encountered. Re-run with --json for details.`);
  }
}

// ---------------------------------------------------------------------------
// R2 (Spec 08): resolve-comment — replies to and marks a comment as solved.
// Used by the Agent after it has processed the comment and updated the brain.
// ---------------------------------------------------------------------------
async function runFeishuResolveComment(_engine: BrainEngine, args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json');

  // Parse required args
  let commentId = '';
  let objToken = '';
  let reply = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--comment-id' && args[i + 1]) {
      commentId = args[++i];
    } else if (args[i] === '--obj-token' && args[i + 1]) {
      objToken = args[++i];
    } else if (args[i] === '--reply' && args[i + 1]) {
      reply = args[++i];
    }
  }

  if (!commentId || !objToken) {
    const usage = 'Usage: cfbrain feishu resolve-comment --comment-id <id> --obj-token <token> [--reply "message"]';
    if (jsonOutput) {
      console.log(JSON.stringify({ error: 'Missing required --comment-id or --obj-token', usage }));
      process.exit(1);
    }
    console.error(usage);
    process.exit(1);
  }

  const errors: string[] = [];

  // 1. Reply to the comment (optional — skip if no reply text)
  if (reply) {
    try {
      await feishuReplyComment(objToken, commentId, reply);
      if (!jsonOutput) console.log(`Replied to comment ${commentId}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`feishuReplyComment failed: ${msg}`);
      if (!jsonOutput) console.error(`Failed to reply: ${msg}`);
    }
  }

  // 2. Mark comment as solved
  try {
    await feishuResolveComment(objToken, commentId);
    if (!jsonOutput) console.log(`Resolved comment ${commentId}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`feishuResolveComment failed: ${msg}`);
    if (!jsonOutput) console.error(`Failed to resolve: ${msg}`);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      comment_id: commentId,
      obj_token: objToken,
      replied: reply ? errors.length === 0 || !errors[0]?.includes('Reply') : false,
      resolved: !errors.some((e) => e.includes('feishuResolveComment')),
      errors: errors.length > 0 ? errors : undefined,
    }));
  }

  if (errors.some((e) => e.includes('feishuResolveComment'))) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// feishu urls
// ---------------------------------------------------------------------------
async function runFeishuUrls(engine: BrainEngine, args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json') || args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';
  const allFlag = args.includes('--all');

  // Parse positional slug args (exclude flags and their values)
  const slugArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' || arg === '--all') continue;
    if (arg === '--format') {
      i++; // skip the format value
      continue;
    }
    if (!arg.startsWith('--')) {
      slugArgs.push(arg);
    }
  }

  let slugs: string[] = [];

  if (allFlag) {
    // Query all slugs from feishu_sync
    try {
      const rows = await rawQuery(engine,
        `SELECT slug FROM feishu_sync WHERE node_type = 'origin'`,
        []
      );
      slugs = rows.map(r => r.slug as string);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        console.log(JSON.stringify({ error: `Could not query feishu_sync: ${msg}` }));
        process.exit(1);
      }
      console.error(`feishu urls: could not query feishu_sync: ${msg}`);
      process.exit(1);
    }
  } else if (slugArgs.length > 0) {
    // Use provided slug arguments
    slugs = slugArgs;
  } else {
    // Read from stdin
    try {
      const stdinContent = await new Promise<string>((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);

        // Handle case where stdin is not piped
        if (process.stdin.isTTY) {
          resolve('');
        }
      });

      if (!stdinContent.trim()) {
        const msg = 'No slugs provided. Use: cfbrain feishu urls <slug1> <slug2> or --all';
        if (jsonOutput) {
          console.log(JSON.stringify({ error: msg }));
          process.exit(1);
        }
        console.error(msg);
        process.exit(1);
      }

      slugs = stdinContent.trim().split('\n').map(s => s.trim()).filter(s => s);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        console.log(JSON.stringify({ error: `Could not read from stdin: ${msg}` }));
        process.exit(1);
      }
      console.error(`feishu urls: could not read from stdin: ${msg}`);
      process.exit(1);
    }
  }

  if (slugs.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify([]));
      return;
    }
    console.log('No slugs to process.');
    return;
  }

  // Get config to read feishu domain (set via `feishu.domain` in config.json,
  // e.g. "your-org.feishu.cn"; falls back to the global Lark domain)
  const config = loadConfig();
  const feishuDomain = config?.feishu?.domain || process.env.FEISHU_DOMAIN || 'feishu.cn';

  // Query feishu_sync for node_tokens
  const results: Array<{ slug: string; url: string }> = [];

  for (const slug of slugs) {
    try {
      const rows = await rawQuery(engine,
        `SELECT node_token FROM feishu_sync WHERE slug = $1 AND node_type = 'origin' LIMIT 1`,
        [slug]
      );

      if (rows.length > 0) {
        const nodeToken = rows[0].node_token as string;
        const url = `https://${feishuDomain}/wiki/${nodeToken}`;
        results.push({ slug, url });
      }
    } catch {
      // Skip slugs that fail to query
      continue;
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const { slug, url } of results) {
      console.log(`${slug}\t${url}`);
    }
  }
}
export async function runFeishu(engine: BrainEngine, args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'init':
      await runFeishuInit(engine, subArgs);
      break;

    case 'status':
      await runFeishuStatus(engine, subArgs);
      break;

    case 'unlink':
      await runFeishuUnlink(engine, subArgs);
      break;

    case 'push':
      await runFeishuPush(engine, subArgs);
      break;

    case 'poll':
      await runFeishuPoll(engine, subArgs);
      break;

    case 'resolve-comment':
      await runFeishuResolveComment(engine, subArgs);
      break;

    case 'urls':
      await runFeishuUrls(engine, subArgs);
      break;

    default:
      console.log('Usage:');
      console.log('  cfbrain feishu init [--space-id ID]       Configure Feishu integration and create root nodes');
      console.log('  cfbrain feishu status [--json]            Show Feishu sync status');
      console.log('  cfbrain feishu unlink [--json]            Disconnect Feishu (keeps docs, disables sync)');
      console.log('  cfbrain feishu push                       Push changed brain pages to Feishu (idempotent)');
      console.log('  cfbrain feishu push --all                 Push all pages + cleanup stale Feishu pages');
      console.log('  cfbrain feishu push --cleanup             Only cleanup stale pages, no push');
      console.log('  cfbrain feishu poll [--json]              Collect pending Feishu comments (no modification)');
      console.log('  cfbrain feishu resolve-comment             Reply to and resolve a Feishu comment');
      console.log('    --comment-id <id> --obj-token <token> [--reply "msg"]');
      console.log('  cfbrain feishu urls [slug1 slug2 ...] [--all] [--format json]');
      console.log('                                             Get Feishu URLs for slugs');
      if (subcommand && subcommand !== '--help' && subcommand !== '-h') {
        console.error(`\nUnknown feishu subcommand: ${subcommand}`);
        process.exit(1);
      }
      break;
  }
}
