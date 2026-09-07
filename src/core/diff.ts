/**
 * Git diff utilities for pages/ directory.
 * Extracts structured change information from git history.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface DiffStat {
  additions: number;
  deletions: number;
}

export interface PageDiff {
  slug: string;
  title: string;
  action: 'created' | 'updated' | 'deleted';
  diff_summary: string;
  diff_stat: DiffStat;
  updated_at: string;
}

/**
 * Check if a directory is inside a git repo.
 */
function findGitRoot(pagesDir: string): string | null {
  // Check if pagesDir itself or its parent has .git
  const brainDir = join(pagesDir, '..');
  if (existsSync(join(brainDir, '.git'))) return brainDir;
  if (existsSync(join(pagesDir, '.git'))) return pagesDir;
  return null;
}

function git(gitRoot: string, args: string): string {
  return execSync(`git -C ${JSON.stringify(gitRoot)} ${args}`, {
    stdio: 'pipe',
    timeout: 30_000,
  }).toString();
}

/**
 * Extract title from a markdown file's frontmatter or first heading.
 */
function extractTitle(content: string): string {
  // Try frontmatter title
  const fmMatch = content.match(/^---\n[\s\S]*?^title:\s*(.+)$/m);
  if (fmMatch) return fmMatch[1].trim().replace(/^["']|["']$/g, '');
  // Try first heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();
  return '';
}

/**
 * Get diffs for all changed *.md files in a time range.
 */
export function getPageDiffs(pagesDir: string, since: string, until: string): PageDiff[] {
  const gitRoot = findGitRoot(pagesDir);
  if (!gitRoot) return [];

  // Determine relative path of pages dir from git root
  const relPages = pagesDir.startsWith(gitRoot)
    ? pagesDir.slice(gitRoot.length + 1)
    : 'pages';

  try {
    // Get all commits in range with their changed files
    const logOutput = git(gitRoot,
      `log --since="${since}" --until="${until}" --name-status --pretty=format:"COMMIT %H %aI" --diff-filter=AMDRT -- "${relPages}/*.md"`
    );

    if (!logOutput.trim()) return [];

    // Parse: collect per-file the latest action and commit info
    const fileActions = new Map<string, { action: string; commitHash: string; date: string }>();

    let currentHash = '';
    let currentDate = '';

    for (const line of logOutput.split('\n')) {
      const commitMatch = line.match(/^COMMIT (\w+) (.+)$/);
      if (commitMatch) {
        currentHash = commitMatch[1];
        currentDate = commitMatch[2];
        continue;
      }
      const statusMatch = line.match(/^([AMDRT])\d*\t(.+?)(?:\t(.+))?$/);
      if (statusMatch && currentHash) {
        const [, status, filePath, renamedTo] = statusMatch;
        // Use the target file for renames
        const targetFile = renamedTo || filePath;
        if (!targetFile.endsWith('.md')) continue;

        // Only keep the most recent action per file (first seen = newest due to git log order)
        if (!fileActions.has(targetFile)) {
          let action = status;
          if (status.startsWith('R')) action = 'M'; // Treat rename as update
          fileActions.set(targetFile, { action, commitHash: currentHash, date: currentDate });
        }
      }
    }

    // Build diffs for each file
    const diffs: PageDiff[] = [];

    for (const [filePath, info] of fileActions) {
      const slug = filePath.replace(/^.*\//, '').replace(/\.md$/, '');
      const absPath = join(gitRoot, filePath);

      let action: 'created' | 'updated' | 'deleted';
      if (info.action === 'A') action = 'created';
      else if (info.action === 'D') action = 'deleted';
      else action = 'updated';

      let title = slug;
      let diffSummary = '';
      let diffStat: DiffStat = { additions: 0, deletions: 0 };

      if (action === 'created') {
        // Read current file, first 500 chars
        try {
          const content = readFileSync(absPath, 'utf-8');
          title = extractTitle(content) || slug;
          const clean = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
          diffSummary = `新建词条。内容：${clean.slice(0, 500)}`;
          diffStat.additions = content.split('\n').length;
        } catch {
          diffSummary = 'New page (file not readable)';
        }
      } else if (action === 'deleted') {
        diffSummary = 'Deleted';
        // Try to get stats from git
        try {
          const stat = git(gitRoot, `diff --stat ${info.commitHash}^..${info.commitHash} -- "${filePath}"`);
          const m = stat.match(/(\d+) insertion.+?(\d+) deletion/);
          if (m) diffStat = { additions: parseInt(m[1]), deletions: parseInt(m[2]) };
          else {
            const d = stat.match(/(\d+) deletion/);
            if (d) diffStat.deletions = parseInt(d[1]);
          }
        } catch { /* ignore */ }
      } else {
        // updated — get diff content
        try {
          const content = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
          title = extractTitle(content) || slug;

          // Get unified diff across the time range for this file
          const diffOutput = git(gitRoot,
            `log --since="${since}" --until="${until}" -p --pretty=format:"" -- "${filePath}"`
          );

          // Extract added/removed lines
          const addedLines: string[] = [];
          const removedLines: string[] = [];
          for (const dl of diffOutput.split('\n')) {
            if (dl.startsWith('+') && !dl.startsWith('+++')) {
              addedLines.push(dl.slice(1));
            } else if (dl.startsWith('-') && !dl.startsWith('---')) {
              removedLines.push(dl.slice(1));
            }
          }

          // Build summary from significant lines (skip frontmatter noise)
          const significantAdded = addedLines.filter(l => l.trim() && !l.startsWith('updated_at'));
          const significantRemoved = removedLines.filter(l => l.trim() && !l.startsWith('updated_at'));

          const summaryParts: string[] = [];
          for (const l of significantAdded.slice(0, 20)) {
            summaryParts.push(`+${l.trim()}`);
          }
          for (const l of significantRemoved.slice(0, 10)) {
            summaryParts.push(`-${l.trim()}`);
          }
          diffSummary = summaryParts.join('\n') || '(minor changes)';

          diffStat = { additions: addedLines.length, deletions: removedLines.length };
        } catch {
          diffSummary = '(diff unavailable)';
        }
      }

      diffs.push({
        slug,
        title,
        action,
        diff_summary: diffSummary,
        diff_stat: diffStat,
        updated_at: new Date(info.date).toISOString(),
      });
    }

    // Sort by updated_at descending
    diffs.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return diffs;
  } catch {
    return [];
  }
}

/**
 * Get diff for a single slug.
 */
export function getSlugDiff(pagesDir: string, slug: string, since: string): PageDiff | null {
  const gitRoot = findGitRoot(pagesDir);
  if (!gitRoot) return null;

  const relPages = pagesDir.startsWith(gitRoot)
    ? pagesDir.slice(gitRoot.length + 1)
    : 'pages';
  const filePath = `${relPages}/${slug}.md`;

  try {
    const logOutput = git(gitRoot,
      `log --since="${since}" --name-status --pretty=format:"COMMIT %H %aI" -- "${filePath}"`
    );

    if (!logOutput.trim()) return null;

    // Get the most recent commit info
    let commitHash = '';
    let date = '';
    let action: 'created' | 'updated' | 'deleted' = 'updated';

    for (const line of logOutput.split('\n')) {
      const commitMatch = line.match(/^COMMIT (\w+) (.+)$/);
      if (commitMatch && !commitHash) {
        commitHash = commitMatch[1];
        date = commitMatch[2];
        continue;
      }
      const statusMatch = line.match(/^([AMDRT])\d*\t/);
      if (statusMatch && commitHash && !date) continue; // already have date
      if (statusMatch) {
        if (statusMatch[1] === 'A') action = 'created';
        else if (statusMatch[1] === 'D') action = 'deleted';
        break; // first status line after first commit
      }
    }

    // Re-parse to find action from most recent commit
    for (const line of logOutput.split('\n')) {
      const cm = line.match(/^COMMIT (\w+) (.+)$/);
      if (cm) { commitHash = cm[1]; date = cm[2]; continue; }
      const sm = line.match(/^([AMDRT])\d*\t/);
      if (sm) {
        if (sm[1] === 'A') action = 'created';
        else if (sm[1] === 'D') action = 'deleted';
        else action = 'updated';
        break;
      }
    }

    if (!commitHash) return null;

    // Build the diff using getPageDiffs logic for this single file
    const absPath = join(gitRoot, filePath);
    let title = slug;
    let diffSummary = '';
    let diffStat: DiffStat = { additions: 0, deletions: 0 };

    if (action === 'created') {
      try {
        const content = readFileSync(absPath, 'utf-8');
        title = extractTitle(content) || slug;
        const clean = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
        diffSummary = `新建词条。内容：${clean.slice(0, 500)}`;
        diffStat.additions = content.split('\n').length;
      } catch { diffSummary = 'New page'; }
    } else if (action === 'deleted') {
      diffSummary = 'Deleted';
    } else {
      try {
        const content = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
        title = extractTitle(content) || slug;

        const diffOutput = git(gitRoot, `log --since="${since}" -p --pretty=format:"" -- "${filePath}"`);
        const addedLines: string[] = [];
        const removedLines: string[] = [];
        for (const dl of diffOutput.split('\n')) {
          if (dl.startsWith('+') && !dl.startsWith('+++')) addedLines.push(dl.slice(1));
          else if (dl.startsWith('-') && !dl.startsWith('---')) removedLines.push(dl.slice(1));
        }

        const significantAdded = addedLines.filter(l => l.trim() && !l.startsWith('updated_at'));
        const significantRemoved = removedLines.filter(l => l.trim() && !l.startsWith('updated_at'));
        const parts: string[] = [];
        for (const l of significantAdded.slice(0, 20)) parts.push(`+${l.trim()}`);
        for (const l of significantRemoved.slice(0, 10)) parts.push(`-${l.trim()}`);
        diffSummary = parts.join('\n') || '(minor changes)';
        diffStat = { additions: addedLines.length, deletions: removedLines.length };
      } catch { diffSummary = '(diff unavailable)'; }
    }

    return { slug, title, action, diff_summary: diffSummary, diff_stat: diffStat, updated_at: new Date(date).toISOString() };
  } catch {
    return null;
  }
}
