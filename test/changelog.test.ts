import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { appendChangelog, type ChangelogEntry } from '../src/core/changelog.ts';

const TMP_DIR = join(import.meta.dir, '__changelog_tmp__');

const sampleEntry: ChangelogEntry = {
  action: 'updated',
  slug: 'people/alice',
  reason: 'Annual review update',
  source: 'cli',
};

beforeEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe('appendChangelog() format (Spec 10 R2)', () => {
  test('writes the Brain Changelog header on first write', async () => {
    await appendChangelog(TMP_DIR, sampleEntry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toStartWith('# Brain Changelog\n\n');
  });

  test('includes ISO 8601 timestamp as level-2 header', async () => {
    await appendChangelog(TMP_DIR, sampleEntry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    // Should match ISO 8601 format with local timezone: ## 2026-04-13T12:50:00+08:00
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('timestamp uses local timezone offset, not UTC Z suffix (Spec 10)', async () => {
    await appendChangelog(TMP_DIR, sampleEntry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    // Must have timezone offset like +08:00 or -05:00, NOT .000Z
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    expect(content).not.toMatch(/## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  test('does NOT include version headers (### vN)', async () => {
    await appendChangelog(TMP_DIR, sampleEntry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).not.toMatch(/### v\d+/);
  });

  test('uses compact format: - **Action** `slug` — reason', async () => {
    await appendChangelog(TMP_DIR, sampleEntry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('- **Updated** `people/alice` — Annual review update');
  });

  test('capitalizes the action word', async () => {
    const entry: ChangelogEntry = { action: 'created', slug: 'test/page', reason: 'New page' };
    await appendChangelog(TMP_DIR, entry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('- **Created** `test/page` — New page');
  });

  test('handles deleted action', async () => {
    const entry: ChangelogEntry = { action: 'deleted', slug: 'old/page', reason: 'Page deleted via delete_page' };
    await appendChangelog(TMP_DIR, entry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('- **Deleted** `old/page` — Page deleted via delete_page');
  });
});

describe('append-only / newest-first behavior', () => {
  test('second entry appears before first entry in the file', async () => {
    const firstEntry: ChangelogEntry = { action: 'created', slug: 'first', reason: 'first-reason' };
    const secondEntry: ChangelogEntry = { action: 'updated', slug: 'second', reason: 'second-reason' };

    await appendChangelog(TMP_DIR, firstEntry);
    await appendChangelog(TMP_DIR, secondEntry);

    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    const posFirst = content.indexOf('first-reason');
    const posSecond = content.indexOf('second-reason');
    expect(posSecond).toBeLessThan(posFirst);
  });

  test('earlier entries are preserved after a second append', async () => {
    await appendChangelog(TMP_DIR, sampleEntry);
    const secondEntry: ChangelogEntry = { action: 'created', slug: 'new/page', reason: 'brand new' };
    await appendChangelog(TMP_DIR, secondEntry);

    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('Annual review update');   // original
    expect(content).toContain('brand new');               // new
  });

  test('file contains exactly one Brain Changelog header after multiple appends', async () => {
    await appendChangelog(TMP_DIR, sampleEntry);
    await appendChangelog(TMP_DIR, sampleEntry);
    await appendChangelog(TMP_DIR, sampleEntry);

    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    const headerCount = (content.match(/^# Brain Changelog/gm) ?? []).length;
    expect(headerCount).toBe(1);
  });

  test('each entry has its own ISO 8601 timestamp header', async () => {
    await appendChangelog(TMP_DIR, sampleEntry);
    await appendChangelog(TMP_DIR, { ...sampleEntry, slug: 'other/page' });

    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    const timestamps = content.match(/^## \d{4}-\d{2}-\d{2}T/gm) ?? [];
    expect(timestamps.length).toBe(2);
  });
});

describe('empty file behavior', () => {
  test('creates CHANGELOG.md when it does not exist', async () => {
    expect(existsSync(join(TMP_DIR, 'CHANGELOG.md'))).toBe(false);
    await appendChangelog(TMP_DIR, sampleEntry);
    expect(existsSync(join(TMP_DIR, 'CHANGELOG.md'))).toBe(true);
  });

  test('creates parent directory when it does not exist', async () => {
    const nestedDir = join(TMP_DIR, 'deeply', 'nested', 'brain');
    await appendChangelog(nestedDir, sampleEntry);
    expect(existsSync(join(nestedDir, 'CHANGELOG.md'))).toBe(true);
  });

  test('produces a valid document starting with the main header', async () => {
    await appendChangelog(TMP_DIR, sampleEntry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toStartWith('# Brain Changelog\n\n');
  });

  test('writing to an empty existing file (zero bytes) works correctly', async () => {
    writeFileSync(join(TMP_DIR, 'CHANGELOG.md'), '');
    await appendChangelog(TMP_DIR, sampleEntry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toStartWith('# Brain Changelog\n\n');
    expect(content).toContain('**Updated**');
  });
});

describe('ChangelogEntry interface', () => {
  test('supports optional source field', async () => {
    const entry: ChangelogEntry = { action: 'created', slug: 'test', reason: 'test' };
    await appendChangelog(TMP_DIR, entry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('**Created**');
  });

  test('entry has action, slug, reason fields', () => {
    const entry: ChangelogEntry = {
      action: 'updated',
      slug: 'my-page',
      reason: 'Updated content',
      source: 'mcp',
    };
    expect(entry.action).toBe('updated');
    expect(entry.slug).toBe('my-page');
    expect(entry.reason).toBe('Updated content');
    expect(entry.source).toBe('mcp');
  });

  test('entry supports optional triggered_by field', () => {
    const entry: ChangelogEntry = {
      action: 'created',
      slug: 'test',
      reason: 'test',
      triggered_by: 'CLI (cfbrain Agent)',
    };
    expect(entry.triggered_by).toBe('CLI (cfbrain Agent)');
  });
});

describe('triggered_by field (Spec 16 R1-R2)', () => {
  test('includes triggered_by suffix when provided', async () => {
    const entry: ChangelogEntry = {
      action: 'created',
      slug: 'dario-amodei',
      reason: 'Page created via put_page',
      triggered_by: 'CLI (cfbrain Agent)',
    };
    await appendChangelog(TMP_DIR, entry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('- **Created** `dario-amodei` — Page created via put_page | triggered by: CLI (cfbrain Agent)');
  });

  test('omits triggered_by suffix when not provided (backward compat)', async () => {
    const entry: ChangelogEntry = {
      action: 'updated',
      slug: 'people/alice',
      reason: 'Annual review update',
    };
    await appendChangelog(TMP_DIR, entry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('- **Updated** `people/alice` — Annual review update');
    expect(content).not.toContain('triggered by');
  });

  test('handles Chinese characters in triggered_by', async () => {
    const entry: ChangelogEntry = {
      action: 'deleted',
      slug: 'anthropic',
      reason: 'Page deleted via delete_page',
      triggered_by: '飞书评论 (owner)',
    };
    await appendChangelog(TMP_DIR, entry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('| triggered by: 飞书评论 (owner)');
  });

  test('handles empty string triggered_by as absent', async () => {
    const entry: ChangelogEntry = {
      action: 'created',
      slug: 'test-page',
      reason: 'test',
      triggered_by: '',
    };
    await appendChangelog(TMP_DIR, entry);
    const content = readFileSync(join(TMP_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).not.toContain('triggered by');
  });
});
