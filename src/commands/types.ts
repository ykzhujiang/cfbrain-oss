import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, saveConfig, DEFAULT_TYPE_LABELS, type GBrainConfig } from '../core/config.ts';
import { getConfiguredTypes } from '../core/config-types.ts';
import {
  feishuCreateNode,
  feishuMoveNode,
  feishuRenameNode,
  isLarkCliAvailable,
} from '../core/feishu.ts';

export async function runTypes(engine: BrainEngine, args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
      await runTypesList(engine, subArgs);
      break;
    case 'add':
      await runTypesAdd(engine, subArgs);
      break;
    case 'remove':
      await runTypesRemove(engine, subArgs);
      break;
    case 'rename':
      await runTypesRename(engine, subArgs);
      break;
    default:
      console.log(`Usage: cfbrain types <list|add|remove|rename> [options]

  list                              Show all types with labels + page counts
  add <type> --label "Label"        Add a new page type
  remove <type> [--force]           Remove a page type (must have 0 pages unless --force)
  rename <type> --label "New Label" Rename a type's display label
`);
      break;
  }
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function runTypesList(engine: BrainEngine, args: string[]): Promise<void> {
  const config = loadConfig();
  const { flags } = parseFlags(args);
  const isJson = flags.json === true;

  const configuredTypes = getConfiguredTypes(config);
  const typeLabels: Record<string, string> = config?.type_labels || DEFAULT_TYPE_LABELS;
  const feishuTokens: Record<string, string> = config?.feishu?.root_node_tokens || {};

  const stats = await engine.getStats();
  const pagesByType = stats.pages_by_type || {};

  const rows = configuredTypes.map(type => ({
    type,
    label: typeLabels[type] || '',
    feishu_token: feishuTokens[type] || '',
    page_count: pagesByType[type] || 0,
  }));

  if (isJson) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  const colWidths = {
    type: Math.max(4, ...rows.map(r => r.type.length)),
    label: Math.max(5, ...rows.map(r => r.label.length)),
    token: Math.max(12, ...rows.map(r => r.feishu_token.length)),
    count: Math.max(10, ...rows.map(r => String(r.page_count).length)),
  };

  const header = [
    'TYPE'.padEnd(colWidths.type),
    'LABEL'.padEnd(colWidths.label),
    'FEISHU_TOKEN'.padEnd(colWidths.token),
    'PAGE_COUNT'.padEnd(colWidths.count),
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of rows) {
    console.log([
      r.type.padEnd(colWidths.type),
      r.label.padEnd(colWidths.label),
      r.feishu_token.padEnd(colWidths.token),
      String(r.page_count).padEnd(colWidths.count),
    ].join('  '));
  }
}

async function runTypesAdd(_engine: BrainEngine, args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const type = positional[0];
  const label = flags.label as string | undefined;

  if (!type) {
    console.error('Usage: cfbrain types add <type> --label "Label"');
    process.exit(1);
  }
  if (!label) {
    console.error('--label is required');
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: cfbrain init');
    process.exit(1);
  }

  const existingTypes = getConfiguredTypes(config);
  if (existingTypes.includes(type)) {
    console.error(`Type "${type}" already exists.`);
    process.exit(1);
  }

  if (!config.type_labels) {
    config.type_labels = { ...DEFAULT_TYPE_LABELS };
  }
  config.type_labels[type] = label;

  if (config.feishu?.enabled) {
    if (!config.feishu.type_labels) {
      config.feishu.type_labels = { ...DEFAULT_TYPE_LABELS };
    }
    config.feishu.type_labels[type] = label;

    if (await isLarkCliAvailable()) {
      try {
        const spaceId = config.feishu.space_id;
        const result = await feishuCreateNode(spaceId, '', label);
        if (!config.feishu.root_node_tokens) {
          config.feishu.root_node_tokens = {};
        }
        config.feishu.root_node_tokens[type] = result.node_token;
        console.log(`Created Feishu wiki folder "${label}" (token: ${result.node_token})`);
      } catch (err) {
        console.error(`Warning: failed to create Feishu folder: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  saveConfig(config);
  console.log(`Added type "${type}" with label "${label}".`);
}

async function runTypesRemove(engine: BrainEngine, args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const type = positional[0];
  const force = flags.force === true;

  if (!type) {
    console.error('Usage: cfbrain types remove <type> [--force]');
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: cfbrain init');
    process.exit(1);
  }

  const existingTypes = getConfiguredTypes(config);
  if (!existingTypes.includes(type)) {
    console.error(`Type "${type}" does not exist.`);
    process.exit(1);
  }

  const pages = await engine.listPages({ types: [type], limit: 100 });
  if (pages.length > 0 && !force) {
    console.error(`Cannot remove type "${type}": ${pages.length} page(s) still use it.`);
    console.error('Pages: ' + pages.map(p => p.slug).join(', '));
    console.error('Use --force to remove anyway (strips type from affected pages).');
    process.exit(1);
  }

  if (pages.length > 0 && force) {
    for (const page of pages) {
      const newTypes = page.types.filter(t => t !== type);
      await engine.upsertPage(page.slug, {
        types: newTypes.length > 0 ? newTypes : ['note'],
        title: page.title,
        compiled_truth: page.compiled_truth,
        frontmatter: page.frontmatter,
        content_hash: page.content_hash,
      });
    }
    console.log(`Stripped type "${type}" from ${pages.length} page(s).`);
  }

  if (config.feishu?.enabled) {
    const nodeToken = config.feishu.root_node_tokens?.[type];
    const trashToken = config.feishu.trash_node_token;
    if (nodeToken && trashToken && await isLarkCliAvailable()) {
      try {
        await feishuMoveNode(config.feishu.space_id, nodeToken, trashToken);
        console.log(`Moved Feishu folder for "${type}" to trash.`);
      } catch (err) {
        console.error(`Warning: failed to move Feishu folder to trash: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    delete config.feishu.type_labels?.[type];
    delete config.feishu.root_node_tokens?.[type];
  }

  delete config.type_labels?.[type];
  saveConfig(config);
  console.log(`Removed type "${type}".`);
}

async function runTypesRename(_engine: BrainEngine, args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const type = positional[0];
  const label = flags.label as string | undefined;

  if (!type) {
    console.error('Usage: cfbrain types rename <type> --label "New Label"');
    process.exit(1);
  }
  if (!label) {
    console.error('--label is required');
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: cfbrain init');
    process.exit(1);
  }

  const existingTypes = getConfiguredTypes(config);
  if (!existingTypes.includes(type)) {
    console.error(`Type "${type}" does not exist.`);
    process.exit(1);
  }

  if (!config.type_labels) {
    config.type_labels = { ...DEFAULT_TYPE_LABELS };
  }
  config.type_labels[type] = label;

  if (config.feishu?.enabled) {
    if (!config.feishu.type_labels) {
      config.feishu.type_labels = { ...DEFAULT_TYPE_LABELS };
    }
    config.feishu.type_labels[type] = label;

    const nodeToken = config.feishu.root_node_tokens?.[type];
    if (nodeToken && await isLarkCliAvailable()) {
      try {
        await feishuRenameNode(config.feishu.space_id, nodeToken, label);
        console.log(`Renamed Feishu wiki folder to "${label}".`);
      } catch (err) {
        console.error(`Warning: failed to rename Feishu folder: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  saveConfig(config);
  console.log(`Renamed type "${type}" to "${label}".`);
}
