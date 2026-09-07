import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export interface ChangelogEntry {
  action: string;   // created | updated | deleted
  slug: string;
  reason: string;
  source?: string;  // e.g. 'cli', 'mcp', 'sync', 'feishu-comment'
  triggered_by?: string; // WHO triggered: "CLI (cfbrain Agent)", "飞书评论 (owner)", "cron (评论poll)"
}

/**
 * Append a changelog entry to the brain's CHANGELOG.md.
 * Format per Spec 10 R2: ISO 8601 timestamp header, compact action lines.
 * Entries are prepended (newest first).
 */
export async function appendChangelog(brainDir: string, entry: ChangelogEntry): Promise<void> {
  const changelogPath = join(brainDir, 'CHANGELOG.md');

  // Ensure directory exists
  const dir = dirname(changelogPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const timestamp = localISOTimestamp();
  const newEntry = [
    `## ${timestamp}`,
    `- **${capitalize(entry.action)}** \`${entry.slug}\` — ${entry.reason}${entry.triggered_by ? ` | triggered by: ${entry.triggered_by}` : ''}`,
    '',
  ].join('\n');

  let existing = '';
  if (existsSync(changelogPath)) {
    existing = readFileSync(changelogPath, 'utf-8');
  }

  const header = '# Brain Changelog\n\n';
  if (!existing) {
    writeFileSync(changelogPath, header + newEntry);
  } else if (existing.startsWith(header)) {
    writeFileSync(changelogPath, header + newEntry + existing.slice(header.length));
  } else {
    writeFileSync(changelogPath, header + newEntry + existing);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Produce an ISO 8601 timestamp with local timezone offset (e.g. 2026-04-13T12:50:00+08:00). */
function localISOTimestamp(): string {
  const now = new Date();
  const off = now.getTimezoneOffset(); // minutes, negative = east of UTC
  const sign = off <= 0 ? '+' : '-';
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, '0');
  const mm = String(absOff % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${hh}:${mm}`;
}
