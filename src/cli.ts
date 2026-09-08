#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from 'fs';
import { loadConfig, toEngineConfig } from './core/config.ts';
import type { BrainEngine } from './core/engine.ts';
import type { Page, SearchResult, BrainStats, BrainHealth, PageVersion } from './core/types.ts';
import { operations, OperationError } from './core/operations.ts';
import type { Operation, OperationContext } from './core/operations.ts';
import { serializeMarkdown } from './core/markdown.ts';
import { VERSION } from './version.ts';

// Build CLI name -> operation lookup
const cliOps = new Map<string, Operation>();
for (const op of operations) {
  const name = op.cliHints?.name;
  if (name && !op.cliHints?.hidden) {
    cliOps.set(name, op);
  }
}

// CLI-only commands that bypass the operation layer
const CLI_ONLY = new Set(['init', 'upgrade', 'post-upgrade', 'check-update', 'integrations', 'import', 'export', 'files', 'embed', 'serve', 'call', 'config', 'doctor', 'migrate', 'feishu', 'ingest', 'ingest-minutes', 'analyze-file', 'repair', 'fetch-merge-forward', 'types', 'briefing', 'diff', 'mail']);

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === 'version') {
    console.log(`cfbrain ${VERSION}`);
    return;
  }

  if (command === '--tools-json') {
    const { printToolsJson } = await import('./commands/tools-json.ts');
    printToolsJson();
    return;
  }

  const subArgs = args.slice(1);

  // Per-command --help
  if (subArgs.includes('--help') || subArgs.includes('-h')) {
    const op = cliOps.get(command);
    if (op) {
      printOpHelp(op);
      return;
    }
  }

  // CLI-only commands
  if (CLI_ONLY.has(command)) {
    await handleCliOnly(command, subArgs);
    return;
  }

  // Shared operations
  const op = cliOps.get(command);
  if (!op) {
    console.error(`Unknown command: ${command}`);
    console.error('Run cfbrain --help for available commands.');
    process.exit(1);
  }

  const engine = await connectEngine();
  try {
    const params = parseOpArgs(op, subArgs);

    // Validate required params before calling handler
    for (const [key, def] of Object.entries(op.params)) {
      if (def.required && params[key] === undefined) {
        const cliName = op.cliHints?.name || op.name;
        const positional = op.cliHints?.positional || [];
        const usage = positional.map(p => `<${p}>`).join(' ');
        console.error(`Usage: cfbrain ${cliName} ${usage}`);
        process.exit(1);
      }
    }

    const ctx = makeContext(engine, params);
    const result = await op.handler(ctx, params);
    const output = formatResult(op.name, result);
    if (output) process.stdout.write(output);
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      console.error(`Error [${e.code}]: ${e.message}`);
      if (e.suggestion) console.error(`  Fix: ${e.suggestion}`);
      process.exit(1);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  } finally {
    await engine.disconnect();
    process.exit(0);
  }
}

function parseOpArgs(op: Operation, args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const positional = op.cliHints?.positional || [];
  let posIdx = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const paramDef = op.params[key];
      if (paramDef?.type === 'boolean') {
        params[key] = true;
      } else if (i + 1 < args.length) {
        const val = args[++i];
        const coerced = paramDef?.type === 'number' ? Number(val) : val;
        // Support repeated flags (e.g. --raw file1 --raw file2) → array
        if (params[key] !== undefined) {
          params[key] = Array.isArray(params[key])
            ? [...(params[key] as unknown[]), coerced]
            : [params[key], coerced];
        } else {
          params[key] = coerced;
        }
      }
    } else if (posIdx < positional.length) {
      const key = positional[posIdx++];
      const paramDef = op.params[key];
      params[key] = paramDef?.type === 'number' ? Number(arg) : arg;
    }
  }

  // Read stdin for content params — skip if --raw has a large PDF (auto-analyze generates content)
  if (op.cliHints?.stdin && !params[op.cliHints.stdin] && !process.stdin.isTTY) {
    if (!hasLargePdfRaw(params)) {
      params[op.cliHints.stdin] = readFileSync('/dev/stdin', 'utf-8');
    }
  }

  // Spec 44: Auto-detect file paths in --content (safety net)
  if (typeof params.content === 'string' && !params.content_file) {
    const val = params.content as string;
    if (/^(\/|\.\/|~\/)/.test(val) && /\.(md|txt|markdown)$/i.test(val)) {
      const resolved = val.startsWith('~/') ? val.replace('~', process.env.HOME || '') : val;
      try {
        if (existsSync(resolved)) {
          console.error(`Warning: detected file path in --content, reading file. Use --content-file for explicit file input.`);
          params.content = readFileSync(resolved, 'utf-8');
        }
      } catch { /* ignore — treat as literal text */ }
    }
  }

  return params;
}

/**
 * Check if params.raw contains a large PDF (>10MB).
 * Used to skip stdin read when auto-analyze will generate content.
 */
function hasLargePdfRaw(params: Record<string, unknown>): boolean {
  const raw = params.raw;
  if (!raw) return false;
  const paths = Array.isArray(raw) ? (raw as string[]) : [raw as string];
  for (const p of paths) {
    if (typeof p === 'string' && p.toLowerCase().endsWith('.pdf')) {
      try {
        if (statSync(p).size > 10 * 1024 * 1024) return true;
      } catch { /* file not found — ignore */ }
    }
  }
  return false;
}

function makeContext(engine: BrainEngine, params: Record<string, unknown>): OperationContext {
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: (params.dry_run as boolean) || false,
  };
}

function formatResult(opName: string, result: unknown): string {
  switch (opName) {
    case 'get_page': {
      const r = result as Page & { error?: string; candidates?: string[]; tags?: string[] };
      if (r.error === 'ambiguous_slug') {
        return `Ambiguous slug. Did you mean:\n${(r.candidates || []).map((c: string) => `  ${c}`).join('\n')}\n`;
      }
      return serializeMarkdown(r.frontmatter || {}, r.compiled_truth || '', {
        types: r.types || [], title: r.title, tags: r.tags || [],
      });
    }
    case 'list_pages': {
      const pages = result as Page[];
      if (pages.length === 0) return 'No pages found.\n';
      return pages.map(p =>
        `${p.slug}\t${(p.types || []).join(',')}\t${p.updated_at?.toString().slice(0, 10) || '?'}\t${p.title}`,
      ).join('\n') + '\n';
    }
    case 'search':
    case 'query': {
      const results = result as SearchResult[];
      if (results.length === 0) return 'No results.\n';
      return results.map(r =>
        `[${r.score?.toFixed(4) || '?'}] ${r.slug} -- ${r.chunk_text?.slice(0, 100) || ''}${r.stale ? ' (stale)' : ''}`,
      ).join('\n') + '\n';
    }
    case 'get_tags': {
      const tags = result as string[];
      return tags.length > 0 ? tags.join(', ') + '\n' : 'No tags.\n';
    }
    case 'get_stats': {
      const s = result as BrainStats;
      const lines = [
        `Pages:     ${s.page_count}`,
        `Chunks:    ${s.chunk_count}`,
        `Embedded:  ${s.embedded_count}`,
        `Links:     ${s.link_count}`,
        `Tags:      ${s.tag_count}`,
      ];
      if (s.pages_by_type) {
        lines.push('', 'By type:');
        for (const [k, v] of Object.entries(s.pages_by_type)) {
          lines.push(`  ${k}: ${v}`);
        }
      }
      return lines.join('\n') + '\n';
    }
    case 'get_health': {
      const h = result as BrainHealth;
      const score = Math.max(0, 10
        - (h.missing_embeddings > 0 ? 2 : 0)
        - (h.stale_pages > 0 ? 1 : 0)
        - (h.dead_links > 0 ? 1 : 0)
        - (h.orphan_pages > 0 ? 1 : 0));
      return [
        `Health score: ${score}/10`,
        `Embed coverage: ${(h.embed_coverage * 100).toFixed(1)}%`,
        `Missing embeddings: ${h.missing_embeddings}`,
        `Stale pages: ${h.stale_pages}`,
        `Orphan pages: ${h.orphan_pages}`,
        `Dead links: ${h.dead_links}`,
      ].join('\n') + '\n';
    }
    case 'get_versions': {
      const versions = result as PageVersion[];
      if (versions.length === 0) return 'No versions.\n';
      return versions.map(v =>
        `#${v.id}  ${v.snapshot_at?.toString().slice(0, 19) || '?'}  ${v.compiled_truth?.slice(0, 60) || ''}...`,
      ).join('\n') + '\n';
    }
    default:
      return JSON.stringify(result, null, 2) + '\n';
  }
}

async function handleCliOnly(command: string, args: string[]) {
  // Commands that don't need a database connection
  if (command === 'init') {
    const { runInit } = await import('./commands/init.ts');
    await runInit(args);
    return;
  }
  if (command === 'upgrade') {
    const { runUpgrade } = await import('./commands/upgrade.ts');
    await runUpgrade(args);
    return;
  }
  if (command === 'post-upgrade') {
    const { runPostUpgrade } = await import('./commands/upgrade.ts');
    runPostUpgrade();
    return;
  }
  if (command === 'check-update') {
    const { runCheckUpdate } = await import('./commands/check-update.ts');
    await runCheckUpdate(args);
    return;
  }
  if (command === 'integrations') {
    const { runIntegrations } = await import('./commands/integrations.ts');
    await runIntegrations(args);
    return;
  }
  if (command === 'fetch-merge-forward') {
    const { fetchMergeForwardContent } = await import('./core/feishu-merge.ts');
    const messageId = args[0];
    if (!messageId) {
      console.error('Usage: cfbrain fetch-merge-forward <message_id> [--output-dir <dir>]');
      process.exit(1);
    }
    let outputDir: string | undefined;
    const odIdx = args.indexOf('--output-dir');
    if (odIdx !== -1 && args[odIdx + 1]) outputDir = args[odIdx + 1];
    const result = await fetchMergeForwardContent(messageId, { outputDir });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  // mail needs no DB: it moves messages between AgentMail and the mailbox queue.
  if (command === 'mail') {
    const { runMail } = await import('./commands/mail.ts');
    await runMail(args);
    return;
  }

  // All remaining CLI-only commands need a DB connection
  const engine = await connectEngine();
  try {
    switch (command) {
      case 'import': {
        const { runImport } = await import('./commands/import.ts');
        await runImport(engine, args);
        break;
      }
      case 'export': {
        const { runExport } = await import('./commands/export.ts');
        await runExport(engine, args, loadConfig() || undefined);
        break;
      }
      case 'files': {
        const { runFiles } = await import('./commands/files.ts');
        await runFiles(engine, args);
        break;
      }
      case 'embed': {
        const { runEmbed } = await import('./commands/embed.ts');
        await runEmbed(engine, args);
        break;
      }
      case 'serve': {
        const { runServe } = await import('./commands/serve.ts');
        await runServe(engine);
        return; // serve doesn't disconnect
      }
      case 'call': {
        const { runCall } = await import('./commands/call.ts');
        await runCall(engine, args);
        break;
      }
      case 'config': {
        const { runConfig } = await import('./commands/config.ts');
        await runConfig(engine, args);
        break;
      }
      case 'doctor': {
        const { runDoctor } = await import('./commands/doctor.ts');
        await runDoctor(engine, args);
        break;
      }
      case 'migrate': {
        const { runMigrateEngine } = await import('./commands/migrate-engine.ts');
        await runMigrateEngine(engine, args);
        break;
      }
      case 'feishu': {
        const { runFeishu } = await import('./commands/feishu.ts');
        await runFeishu(engine, args);
        break;
      }
      case 'types': {
        const { runTypes } = await import('./commands/types.ts');
        await runTypes(engine, args);
        break;
      }
      case 'briefing': {
        const { runBriefing } = await import('./commands/briefing.ts');
        await runBriefing(engine, args);
        break;
      }
      case 'diff': {
        const { runDiff } = await import('./commands/diff.ts');
        await runDiff(engine, args);
        break;
      }
      case 'ingest': {
        const { runIngest } = await import('./commands/ingest.ts');
        await runIngest(engine, args);
        break;
      }
      case 'ingest-minutes': {
        const { runIngestMinutes } = await import('./commands/ingest-minutes.ts');
        await runIngestMinutes(engine, args);
        break;
      }
      case 'analyze-file': {
        const { runAnalyzeFile } = await import('./commands/analyze-file.ts');
        await runAnalyzeFile(args);
        break;
      }
      case 'repair': {
        const { runRepair } = await import('./commands/repair.ts');
        await runRepair(engine, args);
        break;
      }
    }
  } finally {
    if (command !== 'serve') await engine.disconnect();
  }
}

async function connectEngine(): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: cfbrain init');
    process.exit(1);
  }
  const { createEngine } = await import('./core/engine-factory.ts');
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));
  return engine;
}

function printOpHelp(op: Operation) {
  const positional = (op.cliHints?.positional || []).map(p => `<${p}>`).join(' ');
  const name = op.cliHints?.name || op.name;
  console.log(`Usage: cfbrain ${name} ${positional} [options]\n`);
  console.log(op.description + '\n');
  const entries = Object.entries(op.params);
  if (entries.length > 0) {
    console.log('Options:');
    for (const [key, def] of entries) {
      const isPos = op.cliHints?.positional?.includes(key);
      const req = def.required ? ' (required)' : '';
      const prefix = isPos ? `  <${key}>` : `  --${key.replace(/_/g, '-')}`;
      console.log(`${prefix.padEnd(28)} ${def.description || ''}${req}`);
    }
  }
}

function printHelp() {
  // Gather shared operations grouped by category
  const cliNames = Array.from(cliOps.entries())
    .map(([name, op]) => ({ name, desc: op.description }));

  console.log(`cfbrain ${VERSION} -- personal knowledge brain

USAGE
  cfbrain <command> [options]

SETUP
  init [--pglite|--supabase|--url]   Create brain (PGLite default, no server)
  migrate --to <supabase|pglite>     Transfer brain between engines
  upgrade                            Self-update
  check-update [--json]              Check for new versions
  doctor [--json]                    Health check (pgvector, RLS, schema, embeddings)
  integrations [subcommand]          Manage integration recipes (senses + reflexes)

PAGES
  get <slug>                         Read a page
  put <slug> [< file.md] [--raw F]  Write/update a page (--raw copies source file)
                                     Large PDF (>10MB) auto-analyzed if no content
                                     --force bypasses content-shrink safety check
  delete <slug>                      Delete a page
  list [--types T] [--tag T] [-n N]   List pages

SEARCH
  search <query>                     Keyword search (tsvector)
  query <question> [--no-expand]     Hybrid search (RRF + expansion)

IMPORT/EXPORT
  import <dir> [--no-embed]          Import markdown directory
  ingest <file> [--types T] [--slug S] [--no-embed]  Ingest PDF/PPTX file
  ingest-minutes <url> [--slug S] [--no-embed]       Ingest Feishu Minutes
  sync [--repo <path>] [flags]       Git-to-brain incremental sync
  export [--dir ./out/]              Export to markdown

FILES
  files list [slug]                  List stored files
  files upload <file> --page <slug>  Upload file to storage
  files sync <dir>                   Bulk upload directory
  files verify                       Verify all uploads

EMBEDDINGS
  embed [<slug>|--all|--stale]       Generate/refresh embeddings

REPAIR
  repair [--links|--embed|--all]     Bulk reconcile wiki-links and/or embeddings

LINKS
  link <from> <to> [--type T]        Create typed link
  unlink <from> <to>                 Remove link
  backlinks <slug>                   Incoming links
  graph <slug> [--depth N]           Traverse link graph

TAGS
  tags <slug>                        List tags
  tag <slug> <tag>                   Add tag
  untag <slug> <tag>                 Remove tag

FEISHU
  feishu init [--create-space NAME]  Configure Feishu; creates a new wiki space,
             [--space-id ID]          or wires up an existing one, then builds
                                      one root folder per page type
  feishu status [--json]             Feishu sync status (pages, last push, pending)
  feishu unlink [--json]             Disconnect Feishu (keeps docs, disables sync)
  feishu push [--slug S] [--all]     Push brain pages to Feishu wiki
  feishu push --cleanup              Cleanup stale Feishu pages only
  feishu poll [--json]               Collect unresolved Feishu comments (JSON)
  feishu resolve-comment             Resolve a Feishu comment after processing
  feishu urls [slug1 slug2 ...] [--all] [--format json]  Get Feishu URLs for slugs
  fetch-merge-forward <msg_id>       Extract content from merged-and-forwarded message
                                     [--output-dir <dir>] Save media to dir (default ~/.gbrain/raw/)

TYPES
  types list [--json]                Show all types with labels + feishu tokens + page counts
  types add <type> --label "Label"   Add a new page type (+ Feishu folder if enabled)
  types remove <type> [--force]      Remove a page type (--force strips from existing pages)
  types rename <type> --label "New"  Rename a type's display label

ADMIN
  stats                              Brain statistics
  health                             Brain health dashboard
  briefing [--days N] [--since D]    Recent changes briefing grouped by type
                                     [--until D] [--format json|text] (JSON includes summaries)
  mail fetch [--limit N]             Pull new AgentMail messages into shared/mailbox/new (append-only)
  mail send --to <a> --subject <s>   Send mail; requires --confirmed-by-human
           --body-file <p>
  mail registry [show|set]           Recipient roster (backed up before every change)
  history <slug>                     Page version history
  revert <slug> <version-id>         Revert to version
  config [show|get|set] <key> [val]  Brain config
  serve                              MCP server (stdio)
  call <tool> '<json>'               Raw tool invocation
  version                            Version info
  --tools-json                       Tool discovery (JSON)

Run cfbrain <command> --help for command-specific help.
`);
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
