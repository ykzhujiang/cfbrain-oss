/**
 * CLI command: diff
 * Show git-based diffs for brain pages.
 */

import { loadConfig } from '../core/config.ts';
import { getPagesDir } from '../core/pages-fs.ts';
import { getPageDiffs, getSlugDiff } from '../core/diff.ts';
import type { PageDiff } from '../core/diff.ts';

interface DiffArgs {
  slug: string | null;
  all: boolean;
  days: number;
  since: string | null;
  until: string | null;
  format: 'text' | 'json';
}

function parseArgs(args: string[]): DiffArgs {
  const result: DiffArgs = {
    slug: null,
    all: false,
    days: 7,
    since: null,
    until: null,
    format: 'text',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      result.all = true;
    } else if (arg === '--days' && args[i + 1]) {
      result.days = parseInt(args[++i], 10);
    } else if (arg === '--since' && args[i + 1]) {
      result.since = args[++i];
    } else if (arg === '--until' && args[i + 1]) {
      result.until = args[++i];
    } else if (arg === '--format' && args[i + 1]) {
      const fmt = args[++i];
      if (fmt === 'json' || fmt === 'text') result.format = fmt;
    } else if (!arg.startsWith('--') && !result.slug) {
      result.slug = arg;
    }
  }

  return result;
}

function computeRange(args: DiffArgs): { since: string; until: string } {
  const untilDate = args.until ? new Date(args.until + 'T23:59:59.999Z') : new Date();
  const sinceDate = args.since
    ? new Date(args.since + 'T00:00:00.000Z')
    : new Date(untilDate.getTime() - args.days * 24 * 60 * 60 * 1000);
  return {
    since: sinceDate.toISOString(),
    until: untilDate.toISOString(),
  };
}

function formatText(diffs: PageDiff[], since: string, until: string): string {
  const lines: string[] = [];
  lines.push(`Period: ${since.slice(0, 10)} → ${until.slice(0, 10)}`);
  lines.push(`Changes: ${diffs.length}`);
  lines.push('');

  if (diffs.length === 0) {
    lines.push('No changes in this period.');
    return lines.join('\n') + '\n';
  }

  for (const d of diffs) {
    const statStr = d.action === 'created'
      ? ''
      : `, +${d.diff_stat.additions}/-${d.diff_stat.deletions}`;
    lines.push(`=== ${d.slug} (${d.action}${statStr}) ===`);
    lines.push(d.title);

    if (d.action === 'updated') {
      lines.push('Changes:');
      for (const line of d.diff_summary.split('\n').slice(0, 30)) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(d.diff_summary);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function formatJson(diffs: PageDiff[], since: string, until: string): string {
  return JSON.stringify({
    period: { since: since.slice(0, 10), until: until.slice(0, 10) },
    diffs,
  }, null, 2) + '\n';
}

export async function runDiff(_engine: unknown, args: string[]) {
  const parsed = parseArgs(args);
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: cfbrain init');
    process.exit(1);
  }

  const pagesDir = getPagesDir(config);
  const { since, until } = computeRange(parsed);

  let diffs: PageDiff[];

  if (parsed.slug && !parsed.all) {
    const result = getSlugDiff(pagesDir, parsed.slug, since);
    diffs = result ? [result] : [];
  } else {
    diffs = getPageDiffs(pagesDir, since, until);
  }

  if (parsed.format === 'json') {
    process.stdout.write(formatJson(diffs, since, until));
  } else {
    process.stdout.write(formatText(diffs, since, until));
  }
}
