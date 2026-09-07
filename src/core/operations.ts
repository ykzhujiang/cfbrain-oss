/**
 * Contract-first operation definitions. Single source of truth for CLI, MCP, and tools-json.
 * Each operation defines its schema, handler, and optional CLI hints.
 */

import type { BrainEngine } from './engine.ts';
import { loadConfig, saveConfig, type GBrainConfig, type FeishuConfig } from './config.ts';
import { feishuMoveNode, feishuListNodes, feishuCreateNode } from './feishu.ts';
import { importFromContent } from './import-file.ts';
import { hybridSearch } from './search/hybrid.ts';
import { expandQuery } from './search/expansion.ts';
import { appendChangelog, type ChangelogEntry } from './changelog.ts';
import { lintUnattributed, lintStale } from './lint.ts';
import { writePageFile, deletePageFile, gitAutoCommit, getBrainDir } from './pages-fs.ts';
import { serializeMarkdown, parseMarkdown } from './markdown.ts';
import { copyToRaw, normalizeRawSource, writeRawText } from './raw-files.ts';
import { getConfiguredTypes } from './config-types.ts';

// ---------------------------------------------------------------------------
// Wiki-link extraction (Phase A / T202)
// ---------------------------------------------------------------------------

/** Extract all [[slug]] references from markdown content. */
export function extractWikiLinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  const slugs = new Set<string>();
  for (const m of matches) {
    const slug = m.slice(2, -2).trim();
    if (slug) slugs.add(slug);
  }
  return Array.from(slugs);
}

/** Reconcile wiki-links: add new, remove stale. */
async function reconcileWikiLinks(
  engine: BrainEngine,
  slug: string,
  compiledTruth: string,
): Promise<void> {
  const newSlugs = extractWikiLinks(compiledTruth);

  // Get existing wiki-links from this page
  const existingLinks = await engine.getLinks(slug);
  const existingWikiTargets = new Set(
    existingLinks
      .filter((l: any) => l.link_type === 'wiki-link')
      .map((l: any) => l.to_slug as string),
  );

  // Add new wiki-links (only for target slugs that exist in DB)
  for (const target of newSlugs) {
    if (target === slug) continue; // no self-links
    if (existingWikiTargets.has(target)) {
      existingWikiTargets.delete(target); // still present, don't remove
      continue;
    }
    // Check if target page exists
    const targetPage = await engine.getPage(target).catch(() => null);
    if (targetPage) {
      await engine.addLink(slug, target, '', 'wiki-link');
    }
  }

  // Remove stale wiki-links (were in old content but not in new)
  for (const staleTarget of existingWikiTargets) {
    await engine.removeLink(slug, staleTarget);
  }
}

// ---------------------------------------------------------------------------
// Put safety check (Spec 43 / T209) — prevent accidental content wipe
// ---------------------------------------------------------------------------

/** Minimum existing content length (chars) below which the check is skipped. */
export const PUT_SAFETY_MIN_EXISTING_LENGTH = 100;
/** New content must be at least this fraction of existing length. */
export const PUT_SAFETY_MIN_RATIO = 0.2;

/**
 * Guards against accidental content wipes. If the existing page has non-trivial
 * content (> PUT_SAFETY_MIN_EXISTING_LENGTH chars) and the incoming content is
 * less than PUT_SAFETY_MIN_RATIO of that size, throw unless `force` is true.
 * Returns silently when the check doesn't apply (new page, short existing page,
 * force flag, or new content is large enough).
 */
export function checkPutSafety(
  existingBody: string | null | undefined,
  newBody: string,
  force: boolean,
): void {
  if (force) return;
  if (!existingBody) return;
  const existingLen = existingBody.length;
  if (existingLen <= PUT_SAFETY_MIN_EXISTING_LENGTH) return;
  const newLen = newBody.length;
  if (newLen >= existingLen * PUT_SAFETY_MIN_RATIO) return;
  throw new OperationError(
    'safety_check_failed',
    `Safety check failed: new content (${newLen} chars) is less than 20% of existing content (${existingLen} chars). Use --force to override.`,
    'Pass --force to overwrite intentionally, or double-check the content argument for truncation/shell-escaping issues.',
  );
}

// ---------------------------------------------------------------------------
// Feishu helpers (mirrors rawQuery + ensureTrashNode from commands/feishu.ts)
// ---------------------------------------------------------------------------

async function rawQuery(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return engine.executeRaw(sql, params);
}

async function ensureTrashNode(spaceId: string, config: GBrainConfig): Promise<string | null> {
  const feishuCfg = config.feishu as FeishuConfig | undefined;
  if (feishuCfg?.trash_node_token) return feishuCfg.trash_node_token;
  try {
    const nodes = await feishuListNodes(spaceId);
    const trashNode = nodes.find((n: any) => n.title === '🗑️ 废弃');
    if (trashNode) {
      const freshConfig = loadConfig();
      if (freshConfig?.feishu) {
        freshConfig.feishu.trash_node_token = trashNode.node_token;
        saveConfig(freshConfig);
      }
      return trashNode.node_token;
    }
  } catch { /* fall through */ }
  try {
    const trashNode = await feishuCreateNode(spaceId, '', '🗑️ 废弃');
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

/**
 * Archive Feishu wiki nodes linked to a page being deleted.
 * Fire-and-forget: errors are swallowed so delete_page never fails due to Feishu.
 */
async function archiveFeishuNodes(engine: BrainEngine, config: GBrainConfig, slug: string): Promise<void> {
  const spaceId = (config.feishu as FeishuConfig | undefined)?.space_id;
  if (!spaceId) return; // Feishu not configured

  try {
    // Check if feishu_sync table exists
    const existsRows = await rawQuery(engine, `SELECT to_regclass('feishu_sync') IS NOT NULL AS exists`, []);
    if (!existsRows[0]?.exists) return;

    // Find non-archived records for this slug
    const rows = await rawQuery(
      engine,
      `SELECT node_token FROM feishu_sync WHERE slug = $1 AND space_id = $2 AND node_type != 'archived'`,
      [slug, spaceId],
    );
    if (rows.length === 0) return;

    const trashToken = await ensureTrashNode(spaceId, loadConfig() ?? config);

    for (const row of rows) {
      const nodeToken = row.node_token as string;
      try {
        if (trashToken) {
          await feishuMoveNode(spaceId, nodeToken, trashToken);
        }
      } catch (err) {
        // Node already gone (404) or Feishu unreachable — continue to mark as archived
      }
      // Mark as archived regardless of move outcome
      try {
        await rawQuery(
          engine,
          `UPDATE feishu_sync SET node_type = 'archived' WHERE slug = $1 AND node_token = $2`,
          [slug, nodeToken],
        );
      } catch { /* silent */ }
    }
  } catch {
    // Fire-and-forget: never break delete_page
  }
}

// --- Types ---

export type ErrorCode =
  | 'page_not_found'
  | 'invalid_params'
  | 'embedding_failed'
  | 'storage_error'
  | 'bucket_not_found'
  | 'database_error'
  | 'safety_check_failed';

export class OperationError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string,
    public docs?: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      suggestion: this.suggestion,
      docs: this.docs,
    };
  }
}

export interface ParamDef {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  items?: ParamDef;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface OperationContext {
  engine: BrainEngine;
  config: GBrainConfig;
  logger: Logger;
  dryRun: boolean;
}

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
  cliHints?: {
    name?: string;
    positional?: string[];
    stdin?: string;
    hidden?: boolean;
  };
}

// --- Page CRUD ---

const get_page: Operation = {
  name: 'get_page',
  description: 'Read a page by slug (supports optional fuzzy matching)',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    fuzzy: { type: 'boolean', description: 'Enable fuzzy slug resolution (default: false)' },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const fuzzy = (p.fuzzy as boolean) || false;

    let page = await ctx.engine.getPage(slug);
    let resolved_slug: string | undefined;

    if (!page && fuzzy) {
      const candidates = await ctx.engine.resolveSlugs(slug);
      if (candidates.length === 1) {
        page = await ctx.engine.getPage(candidates[0]);
        resolved_slug = candidates[0];
      } else if (candidates.length > 1) {
        return { error: 'ambiguous_slug', candidates };
      }
    }

    if (!page) {
      throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug or use fuzzy: true');
    }

    const tags = await ctx.engine.getTags(page.slug);
    return { ...page, tags, ...(resolved_slug ? { resolved_slug } : {}) };
  },
  cliHints: { name: 'get', positional: ['slug'] },
};

const put_page: Operation = {
  name: 'put_page',
  description: 'Write/update a page (markdown with frontmatter). Chunks, embeds, and reconciles tags.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    content: { type: 'string', description: 'Full markdown content with YAML frontmatter (auto-generated from --raw PDF >10MB if omitted)' },
    content_file: { type: 'string', description: 'Path to a file containing the markdown content (alternative to --content for long text)' },
    no_embed: { type: 'boolean', description: 'Skip embedding generation' },
    no_vision: { type: 'boolean', description: 'Skip vision analysis for large PDF auto-analysis' },
    triggered_by: { type: 'string', description: 'Who triggered the change (e.g. CLI, MCP, 飞书评论)' },
    raw: { type: 'string', description: 'Path(s) to raw source file(s) to copy into raw/' },
    force: { type: 'boolean', description: 'Bypass the content-length safety check (Spec 43) and type validation (Spec 46)' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'put_page', slug: p.slug };

    const slug = p.slug as string;

    // Spec 44: --content-file reads file content
    if (p.content_file) {
      const filePath = p.content_file as string;
      const { readFileSync, existsSync } = await import('fs');
      if (!existsSync(filePath)) {
        throw new OperationError('invalid_params', `Content file not found: ${filePath}`);
      }
      if (p.content) {
        console.error(`Warning: both --content and --content-file provided; using --content-file`);
      }
      p.content = readFileSync(filePath, 'utf-8');
    }

    // Spec 33: Auto-analyze large PDF when --raw is a PDF >10MB and no content provided
    if (p.raw && !p.content) {
      const rawPaths = Array.isArray(p.raw) ? (p.raw as string[]) : [p.raw as string];
      const largePdf = await (async () => {
        const { isLargeFile } = await import('./large-file-pipeline.ts');
        return rawPaths.find(rp => rp.toLowerCase().endsWith('.pdf') && isLargeFile(rp));
      })();
      if (largePdf) {
        const { processLargeFile } = await import('./large-file-pipeline.ts');
        const result = await processLargeFile(largePdf, {
          noVision: (p.no_vision as boolean) || false,
        });
        // Build page content from analysis with frontmatter
        const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const fm: Record<string, unknown> = {
          title,
          types: ['note'],
          source_file: largePdf.split('/').pop(),
          ingested_at: new Date().toISOString(),
        };
        p.content = serializeMarkdown(fm, result.markdown, {
          types: ['note'], title, tags: [],
        });
      }
    }

    if (!p.content) {
      throw new OperationError('invalid_params', 'content is required (provide via stdin, or use --raw with a PDF >10MB for auto-analysis)');
    }

    // Spec: Reject content with missing or default title in frontmatter
    // Spec 46: Validate types against allowed list
    {
      const preCheck = parseMarkdown(p.content as string);
      if (!preCheck.title || preCheck.title === 'Untitled') {
        throw new OperationError('invalid_params',
          'Content must include a frontmatter title (got "Untitled" or empty). Add a `title:` field in the YAML frontmatter block.');
      }
      if (!(p.force as boolean) && preCheck.types.length > 0) {
        const allowedTypes = getConfiguredTypes(ctx.config);
        const invalidTypes = preCheck.types.filter(t => !allowedTypes.includes(t));
        if (invalidTypes.length > 0) {
          throw new OperationError('invalid_params',
            `Invalid type(s): ${invalidTypes.join(', ')}. Allowed types: ${allowedTypes.join(', ')}. Use --force to bypass.`);
        }
      }
    }

    // Handle --raw: copy files to raw/ and inject raw_source into frontmatter
    let content = p.content as string;
    if (p.raw) {
      const rawPaths = Array.isArray(p.raw) ? (p.raw as string[]) : [p.raw as string];
      const rawSources: string[] = [];
      for (const rawPath of rawPaths) {
        const relPath = copyToRaw(ctx.config, rawPath, slug);
        rawSources.push(relPath);
      }
      // Parse content to inject raw_source into frontmatter
      const parsed = parseMarkdown(content);
      // --raw is authoritative: replaces any existing raw_source in content frontmatter
      parsed.frontmatter.raw_source = rawSources.length === 1 ? rawSources[0] : rawSources;
      content = serializeMarkdown(parsed.frontmatter, parsed.compiled_truth, {
        types: parsed.types, title: parsed.title, tags: parsed.tags,
      });
    } else {
      // Auto-raw: ensure raw_source is always populated (Spec 31)
      const parsed = parseMarkdown(content);
      const existingRaw = normalizeRawSource(parsed.frontmatter.raw_source);
      if (existingRaw.length === 0) {
        const sourceUrl = parsed.frontmatter.source_url as string | undefined;
        if (sourceUrl) {
          // R1: URL-based source → save .url file
          const urlRaw = writeRawText(ctx.config, slug, '.url', sourceUrl);
          parsed.frontmatter.raw_source = urlRaw;
        } else {
          // R2: Text-based source → save content snapshot as .md
          const mdRaw = writeRawText(ctx.config, slug, '.md', content);
          parsed.frontmatter.raw_source = mdRaw;
        }
        content = serializeMarkdown(parsed.frontmatter, parsed.compiled_truth, {
          types: parsed.types, title: parsed.title, tags: parsed.tags,
        });
      }
    }

    // Check existence before import to distinguish create vs. update for changelog
    const existing = await ctx.engine.getPage(slug).catch(() => null);

    // Spec 43 / T209: Guard against accidental content wipe — reject if new
    // content is drastically shorter than existing (unless --force).
    if (existing) {
      const newBody = parseMarkdown(content).compiled_truth;
      checkPutSafety(existing.compiled_truth, newBody, (p.force as boolean) || false);
    }

    const result = await importFromContent(ctx.engine, slug, content, {
      noEmbed: (p.no_embed as boolean) || false,
    });

    // Phase A / T202: Auto-extract and reconcile [[wiki-links]]
    if (result.status === 'imported') {
      try {
        const page = await ctx.engine.getPage(result.slug);
        if (page) {
          await reconcileWikiLinks(ctx.engine, result.slug, page.compiled_truth);
        }
      } catch { /* wiki-link extraction must never break put_page */ }
    }

    if (result.status === 'imported') {
      const brainDir = getBrainDir(ctx.config);

      const isCreate = !existing;
      const entry: ChangelogEntry = {
        action: isCreate ? 'created' : 'updated',
        slug: result.slug,
        reason: `Page ${isCreate ? 'created' : 'updated'} via put_page`,
        source: 'cli',
        triggered_by: (p.triggered_by as string) || 'CLI',
      };

      // Fire-and-forget — changelog write must never break the main operation
      appendChangelog(brainDir, entry).catch(() => { /* silent */ });

      // Write pages/<slug>.md — pages/ is the truth source (Spec 14 R1)
      try {
        const page = await ctx.engine.getPage(result.slug);
        const tags = await ctx.engine.getTags(result.slug);
        const md = serializeMarkdown(
          page.frontmatter,
          page.compiled_truth,
          { types: page.types, title: page.title, tags },
        );
        writePageFile(ctx.config, result.slug, md);
        gitAutoCommit(ctx.config, `${isCreate ? 'put' : 'update'}: ${result.slug} — Page ${isCreate ? 'created' : 'updated'} via put_page`);
      } catch { /* silent — file write must never break the main operation */ }
    }

    return { slug: result.slug, status: result.status === 'imported' ? 'created_or_updated' : result.status, chunks: result.chunks };
  },
  cliHints: { name: 'put', positional: ['slug'], stdin: 'content' },
};

const delete_page: Operation = {
  name: 'delete_page',
  description: 'Delete a page',
  params: {
    slug: { type: 'string', required: true },
    triggered_by: { type: 'string', description: 'Who triggered the change (e.g. CLI, MCP, 飞书评论)' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'delete_page', slug: p.slug };
    const slug = p.slug as string;

    // Log deletion to CHANGELOG before deleting
    const brainDir = getBrainDir(ctx.config);
    const entry: ChangelogEntry = {
      action: 'deleted',
      slug,
      reason: 'Page deleted via delete_page',
      source: 'cli',
      triggered_by: (p.triggered_by as string) || 'CLI',
    };
    appendChangelog(brainDir, entry).catch(() => { /* silent */ });

    // Archive any Feishu wiki nodes linked to this page (fire-and-forget) — T47
    await archiveFeishuNodes(ctx.engine, ctx.config, slug).catch(() => { /* silent */ });

    // Remove pages/<slug>.md (moves to .trash/) — Spec 14 R2
    try {
      deletePageFile(ctx.config, slug);
      gitAutoCommit(ctx.config, `delete: ${slug} — Page deleted via delete_page`);
    } catch { /* silent — file ops must never break the main operation */ }

    await ctx.engine.deletePage(slug);
    return { status: 'deleted' };
  },
  cliHints: { name: 'delete', positional: ['slug'] },
};

const list_pages: Operation = {
  name: 'list_pages',
  description: 'List pages with optional filters',
  params: {
    types: { type: 'string', description: 'Filter by page type(s), comma-separated' },
    tag: { type: 'string', description: 'Filter by tag' },
    limit: { type: 'number', description: 'Max results (default 500)' },
  },
  handler: async (ctx, p) => {
    const typesRaw = p.types as string | undefined;
    const typesArr = typesRaw ? typesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const pages = await ctx.engine.listPages({
      types: typesArr,
      tag: p.tag as string,
      limit: (p.limit as number) || 500,
    });
    return pages.map(pg => ({
      slug: pg.slug,
      types: pg.types,
      title: pg.title,
      updated_at: pg.updated_at,
    }));
  },
  cliHints: { name: 'list' },
};

// --- Search ---

const search: Operation = {
  name: 'search',
  description: 'Keyword search using full-text search',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.searchKeyword(p.query as string, { limit: (p.limit as number) || 20 });
  },
  cliHints: { name: 'search', positional: ['query'] },
};

const query: Operation = {
  name: 'query',
  description: 'Hybrid search with vector + keyword + multi-query expansion',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
    expand: { type: 'boolean', description: 'Enable multi-query expansion (default: true)' },
  },
  handler: async (ctx, p) => {
    const expand = p.expand !== false;
    return hybridSearch(ctx.engine, p.query as string, {
      limit: (p.limit as number) || 20,
      expansion: expand,
      expandFn: expand ? expandQuery : undefined,
    });
  },
  cliHints: { name: 'query', positional: ['query'] },
};

// --- Tags ---

const add_tag: Operation = {
  name: 'add_tag',
  description: 'Add tag to page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_tag', slug: p.slug, tag: p.tag };
    await ctx.engine.addTag(p.slug as string, p.tag as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'tag', positional: ['slug', 'tag'] },
};

const remove_tag: Operation = {
  name: 'remove_tag',
  description: 'Remove tag from page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_tag', slug: p.slug, tag: p.tag };
    await ctx.engine.removeTag(p.slug as string, p.tag as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'untag', positional: ['slug', 'tag'] },
};

const get_tags: Operation = {
  name: 'get_tags',
  description: 'List tags for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getTags(p.slug as string);
  },
  cliHints: { name: 'tags', positional: ['slug'] },
};

// --- Links ---

const add_link: Operation = {
  name: 'add_link',
  description: 'Create link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    link_type: { type: 'string', description: 'Link type (e.g., invested_in, works_at)' },
    context: { type: 'string', description: 'Context for the link' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_link', from: p.from, to: p.to };
    await ctx.engine.addLink(
      p.from as string, p.to as string,
      (p.context as string) || '', (p.link_type as string) || '',
    );
    return { status: 'ok' };
  },
  cliHints: { name: 'link', positional: ['from', 'to'] },
};

const remove_link: Operation = {
  name: 'remove_link',
  description: 'Remove link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_link', from: p.from, to: p.to };
    await ctx.engine.removeLink(p.from as string, p.to as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'unlink', positional: ['from', 'to'] },
};

const get_links: Operation = {
  name: 'get_links',
  description: 'List outgoing links from a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getLinks(p.slug as string);
  },
};

const get_backlinks: Operation = {
  name: 'get_backlinks',
  description: 'List incoming links to a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getBacklinks(p.slug as string);
  },
  cliHints: { name: 'backlinks', positional: ['slug'] },
};

const traverse_graph: Operation = {
  name: 'traverse_graph',
  description: 'Traverse link graph from a page',
  params: {
    slug: { type: 'string', required: true },
    depth: { type: 'number', description: 'Max traversal depth (default 5)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.traverseGraph(p.slug as string, (p.depth as number) || 5);
  },
  cliHints: { name: 'graph', positional: ['slug'] },
};

// --- Admin ---

const get_stats: Operation = {
  name: 'get_stats',
  description: 'Brain statistics (page count, chunk count, etc.)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getStats();
  },
  cliHints: { name: 'stats' },
};

const get_health: Operation = {
  name: 'get_health',
  description: 'Brain health dashboard (embed coverage, stale pages, orphans)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getHealth();
  },
  cliHints: { name: 'health' },
};

const get_versions: Operation = {
  name: 'get_versions',
  description: 'Page version history',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getVersions(p.slug as string);
  },
  cliHints: { name: 'history', positional: ['slug'] },
};

const revert_version: Operation = {
  name: 'revert_version',
  description: 'Revert page to a previous version',
  params: {
    slug: { type: 'string', required: true },
    version_id: { type: 'number', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'revert_version', slug: p.slug, version_id: p.version_id };
    await ctx.engine.createVersion(p.slug as string);
    await ctx.engine.revertToVersion(p.slug as string, p.version_id as number);
    return { status: 'reverted' };
  },
  cliHints: { name: 'revert', positional: ['slug', 'version_id'] },
};

// --- Sync ---

const sync_brain: Operation = {
  name: 'sync_brain',
  description: 'Sync git repo to brain (incremental)',
  params: {
    repo: { type: 'string', description: 'Path to git repo (optional if configured)' },
    dry_run: { type: 'boolean', description: 'Preview changes without applying' },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: { type: 'boolean', description: 'Skip embedding generation' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const { performSync } = await import('../commands/sync.ts');
    return performSync(ctx.engine, {
      repoPath: p.repo as string | undefined,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      noEmbed: (p.no_embed as boolean) || false,
      noPull: (p.no_pull as boolean) || false,
      full: (p.full as boolean) || false,
    });
  },
  cliHints: { name: 'sync' },
};

// --- Raw Data ---

const put_raw_data: Operation = {
  name: 'put_raw_data',
  description: 'Store raw API response data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: { type: 'string', required: true, description: 'Data source (e.g., crustdata, happenstance)' },
    data: { type: 'object', required: true, description: 'Raw data object' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'put_raw_data', slug: p.slug, source: p.source };
    await ctx.engine.putRawData(p.slug as string, p.source as string, p.data as object);
    return { status: 'ok' };
  },
};

const get_raw_data: Operation = {
  name: 'get_raw_data',
  description: 'Retrieve raw data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: { type: 'string', description: 'Filter by source' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getRawData(p.slug as string, p.source as string | undefined);
  },
};

// --- Resolution & Chunks ---

const resolve_slugs: Operation = {
  name: 'resolve_slugs',
  description: 'Fuzzy-resolve a partial slug to matching page slugs',
  params: {
    partial: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.resolveSlugs(p.partial as string);
  },
};

const get_chunks: Operation = {
  name: 'get_chunks',
  description: 'Get content chunks for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getChunks(p.slug as string);
  },
};

// --- Ingest Log ---

const log_ingest: Operation = {
  name: 'log_ingest',
  description: 'Log an ingestion event',
  params: {
    source_type: { type: 'string', required: true },
    source_ref: { type: 'string', required: true },
    pages_updated: { type: 'array', required: true, items: { type: 'string' } },
    summary: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'log_ingest' };
    await ctx.engine.logIngest({
      source_type: p.source_type as string,
      source_ref: p.source_ref as string,
      pages_updated: p.pages_updated as string[],
      summary: p.summary as string,
    });
    return { status: 'ok' };
  },
};

const get_ingest_log: Operation = {
  name: 'get_ingest_log',
  description: 'Get recent ingestion log entries',
  params: {
    limit: { type: 'number', description: 'Max entries (default 20)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getIngestLog({ limit: (p.limit as number) || 20 });
  },
};

// --- Lint ---

const lint: Operation = {
  name: 'lint',
  description: 'Lint a page\'s compiled_truth for epistemology issues: unattributed claims and stale dated sources (Spec 04)',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug to lint' },
    threshold_days: { type: 'number', description: 'Days before a dated source is considered stale (default 90)' },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const page = await ctx.engine.getPage(slug);
    if (!page) {
      throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug');
    }
    const compiledTruth: string = page.compiled_truth ?? '';
    const thresholdDays = p.threshold_days as number | undefined;
    const unattributedWarnings = lintUnattributed(compiledTruth);
    const staleWarnings = lintStale(compiledTruth, thresholdDays, page.types);
    const warnings = [...unattributedWarnings, ...staleWarnings].sort((a, b) => a.line - b.line);
    return {
      slug,
      warnings,
      warning_count: warnings.length,
      clean: warnings.length === 0,
    };
  },
  cliHints: { name: 'lint', positional: ['slug'] },
};

// --- File Operations ---

const file_list: Operation = {
  name: 'file_list',
  description: 'List stored files',
  params: {
    slug: { type: 'string', description: 'Filter by page slug' },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string | undefined;
    return ctx.engine.listFiles(slug);
  },
};

const file_upload: Operation = {
  name: 'file_upload',
  description: 'Upload a file to storage',
  params: {
    path: { type: 'string', required: true, description: 'Local file path' },
    page_slug: { type: 'string', description: 'Associate with page' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload', path: p.path };

    const { readFileSync, statSync } = await import('fs');
    const { basename, extname } = await import('path');
    const { createHash } = await import('crypto');

    const filePath = p.path as string;
    const pageSlug = (p.page_slug as string) || null;
    const stat = statSync(filePath);
    const content = readFileSync(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    const filename = basename(filePath);
    const storagePath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;

    const MIME_TYPES: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const mimeType = MIME_TYPES[extname(filePath).toLowerCase()] || null;

    // Check for existing file via engine
    const existingResult = await ctx.engine.getFileUrl(storagePath);
    if (existingResult) {
      return { status: 'already_exists', storage_path: storagePath };
    }

    // Upload to storage backend if configured
    if (ctx.config.storage) {
      const { createStorage } = await import('./storage.ts');
      const storage = await createStorage(ctx.config.storage);
      try {
        await storage.upload(storagePath, content, mimeType || undefined);
      } catch (uploadErr) {
        throw new OperationError('storage_error', `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
      }
    }

    try {
      await ctx.engine.uploadFile({
        page_slug: pageSlug ?? undefined,
        filename,
        storage_path: storagePath,
        mime_type: mimeType ?? undefined,
        size_bytes: stat.size,
        content_hash: hash,
        metadata: {},
      });
    } catch (dbErr) {
      // Rollback: clean up storage if DB write failed
      if (ctx.config.storage) {
        try {
          const { createStorage } = await import('./storage.ts');
          const storage = await createStorage(ctx.config.storage);
          await storage.delete(storagePath);
        } catch { /* best effort cleanup */ }
      }
      throw dbErr;
    }

    return { status: 'uploaded', storage_path: storagePath, size_bytes: stat.size };
  },
};

const file_url: Operation = {
  name: 'file_url',
  description: 'Get a URL for a stored file',
  params: {
    storage_path: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    const row = await ctx.engine.getFileUrl(p.storage_path as string);
    if (!row) {
      throw new OperationError('storage_error', `File not found: ${p.storage_path}`);
    }
    // TODO: generate signed URL from Supabase Storage
    return { storage_path: row.storage_path, url: `cfbrain:files/${row.storage_path}` };
  },
};

// --- Rebuild: reconstruct DB from pages/ files (Spec 14 R4) ---

const rebuild: Operation = {
  name: 'rebuild',
  description: 'Rebuild the database from pages/ markdown files. Disaster recovery path.',
  params: {
    dry_run: { type: 'boolean', description: 'Preview what would be imported without making changes' },
    no_embed: { type: 'boolean', description: 'Skip embedding generation during rebuild' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const { readdirSync, readFileSync, statSync } = await import('fs');
    const { join: pathJoin } = await import('path');
    const pagesDir = (await import('./pages-fs.ts')).getPagesDir(ctx.config);

    let files: string[];
    try {
      files = readdirSync(pagesDir).filter(f => f.endsWith('.md'));
    } catch {
      throw new OperationError('storage_error', `pages/ directory not found at ${pagesDir}. Run cfbrain init first.`);
    }

    if (files.length === 0) {
      return { status: 'empty', message: 'No .md files found in pages/', imported: 0 };
    }

    const isDryRun = (p.dry_run as boolean) || ctx.dryRun;
    const results: { slug: string; status: string }[] = [];

    for (const file of files) {
      const slug = file.replace(/\.md$/, '');
      const filePath = pathJoin(pagesDir, file);
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;

      if (isDryRun) {
        results.push({ slug, status: 'would_import' });
        continue;
      }

      const content = readFileSync(filePath, 'utf-8');
      const result = await importFromContent(ctx.engine, slug, content, {
        noEmbed: (p.no_embed as boolean) || false,
      });
      results.push({ slug: result.slug, status: result.status });
    }

    return {
      status: isDryRun ? 'dry_run' : 'rebuilt',
      total: files.length,
      imported: results.filter(r => r.status === 'imported').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      pages: results,
    };
  },
  cliHints: { name: 'rebuild' },
};

// --- Exports ---

export const operations: Operation[] = [
  // Page CRUD
  get_page, put_page, delete_page, list_pages,
  // Search
  search, query,
  // Tags
  add_tag, remove_tag, get_tags,
  // Links
  add_link, remove_link, get_links, get_backlinks, traverse_graph,
  // Admin
  get_stats, get_health, get_versions, revert_version,
  // Sync
  sync_brain,
  // Raw data
  put_raw_data, get_raw_data,
  // Resolution & chunks
  resolve_slugs, get_chunks,
  // Ingest log
  log_ingest, get_ingest_log,
  // Files
  file_list, file_upload, file_url,
  // Lint
  lint,
  // Rebuild
  rebuild,
];

export const operationsByName = Object.fromEntries(
  operations.map(op => [op.name, op]),
) as Record<string, Operation>;
