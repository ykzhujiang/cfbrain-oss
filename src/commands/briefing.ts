import type { BrainEngine } from '../core/engine.ts';
import type { Page } from '../core/types.ts';
import { loadConfig } from '../core/config.ts';
import { getPagesDir } from '../core/pages-fs.ts';
import { getPageDiffs } from '../core/diff.ts';
import type { PageDiff, DiffStat } from '../core/diff.ts';

interface BriefingArgs {
  days: number;
  since: string | null;
  until: string | null;
  format: 'text' | 'json';
}

interface BriefingChange {
  slug: string;
  title: string;
  types: string[];
  updated_at: string;
  summary?: string;
  action?: 'created' | 'updated' | 'deleted';
  diff_summary?: string;
  diff_stat?: DiffStat;
}

interface BriefingResult {
  period: { since: string; until: string };
  changes: BriefingChange[];
}

function parseArgs(args: string[]): BriefingArgs {
  const result: BriefingArgs = {
    days: 1,
    since: null,
    until: null,
    format: 'text',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--days' && args[i + 1]) {
      result.days = parseInt(args[++i], 10);
    } else if (arg === '--since' && args[i + 1]) {
      result.since = args[++i];
    } else if (arg === '--until' && args[i + 1]) {
      result.until = args[++i];
    } else if (arg === '--format' && args[i + 1]) {
      const fmt = args[++i];
      if (fmt === 'json' || fmt === 'text') result.format = fmt;
    }
  }

  return result;
}

function computeTimeRange(args: BriefingArgs): { since: Date; until: Date } {
  const until = args.until ? new Date(args.until + 'T23:59:59.999Z') : new Date();
  let since: Date;

  if (args.since) {
    since = new Date(args.since + 'T00:00:00.000Z');
  } else {
    since = new Date(until.getTime() - args.days * 24 * 60 * 60 * 1000);
  }

  return { since, until };
}

async function filterByTimeRange(
  engine: BrainEngine,
  pages: Page[],
  since: Date,
  until: Date
): Promise<BriefingChange[]> {
  const filteredPages = pages
    .filter(p => {
      const t = new Date(p.updated_at);
      return t >= since && t <= until;
    })
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  // For each page, extract summary from content
  const changes: BriefingChange[] = [];
  for (const p of filteredPages) {
    let summary = '';
    try {
      const fullPage = await engine.getPage(p.slug);
      if (fullPage?.compiled_truth) {
        const content = fullPage.compiled_truth;
        const cleanContent = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
        summary = cleanContent.slice(0, 200);
      }
    } catch {
      // If we can't get the page content, just use empty summary
    }

    changes.push({
      slug: p.slug,
      title: p.title,
      types: p.types || [],
      updated_at: new Date(p.updated_at).toISOString(),
      summary,
    });
  }

  return changes;
}

/**
 * Enrich briefing changes with diff data from git.
 * Gracefully degrades if git is unavailable.
 */
function enrichWithDiffs(changes: BriefingChange[], sinceISO: string, untilISO: string): void {
  let diffMap: Map<string, PageDiff>;
  try {
    const config = loadConfig();
    if (!config) return;
    const pagesDir = getPagesDir(config);
    const diffs = getPageDiffs(pagesDir, sinceISO, untilISO);
    diffMap = new Map(diffs.map(d => [d.slug, d]));
  } catch {
    // Git unavailable — graceful degradation
    return;
  }

  for (const change of changes) {
    const diff = diffMap.get(change.slug);
    if (diff) {
      change.action = diff.action;
      change.diff_summary = diff.diff_summary;
      change.diff_stat = diff.diff_stat;
    }
  }
}

function formatText(result: BriefingResult): string {
  const lines: string[] = [];
  lines.push(`# CFBrain Briefing`);
  lines.push(`Period: ${result.period.since} → ${result.period.until}`);
  lines.push(`Changes: ${result.changes.length}`);
  lines.push('');

  if (result.changes.length === 0) {
    lines.push('No changes in this period.');
  } else {
    // Group changes by primary type
    const typeGroups = new Map<string, BriefingChange[]>();
    for (const change of result.changes) {
      const primaryType = change.types[0] || 'note';
      if (!typeGroups.has(primaryType)) {
        typeGroups.set(primaryType, []);
      }
      typeGroups.get(primaryType)!.push(change);
    }

    // Sort type groups by name
    const sortedTypes = Array.from(typeGroups.keys()).sort();

    for (const type of sortedTypes) {
      const changes = typeGroups.get(type)!;
      lines.push(`## ${type} (${changes.length})`);
      lines.push('');

      for (const c of changes) {
        const date = c.updated_at.slice(0, 10);
        const actionTag = c.action ? ` [${c.action}]` : '';
        lines.push(`- **${c.title}** (${c.slug}) — ${date}${actionTag}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}

function formatJson(result: BriefingResult): string {
  return JSON.stringify(result, null, 2) + '\n';
}

export async function runBriefing(engine: BrainEngine, args: string[]) {
  const parsed = parseArgs(args);
  const { since, until } = computeTimeRange(parsed);

  const allPages = await engine.listPages({ limit: 10000 });
  const changes = await filterByTimeRange(engine, allPages as Page[], since, until);

  // Enrich with diff data
  enrichWithDiffs(changes, since.toISOString(), until.toISOString());

  const result: BriefingResult = {
    period: {
      since: since.toISOString().slice(0, 10),
      until: until.toISOString().slice(0, 10),
    },
    changes,
  };

  if (parsed.format === 'json') {
    process.stdout.write(formatJson(result));
  } else {
    process.stdout.write(formatText(result));
  }
}
