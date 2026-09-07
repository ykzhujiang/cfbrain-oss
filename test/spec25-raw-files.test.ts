/**
 * Spec 25: Raw File Storage & Source Linking tests
 *
 * Tests cover:
 * - T120: raw/ directory management utilities
 * - T121: raw_source frontmatter field preservation
 * - T122: put with --raw (single/multi), raw file immutability on re-put
 * - T123: git auto-commit includes raw/ directory
 * - T124: Feishu attachment block generation
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

import { ensureRawDir, getRawDir, copyToRaw, resolveRawPath, normalizeRawSource } from '../src/core/raw-files.ts';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';
import { buildAttachmentBlocks } from '../src/core/feishu.ts';
import { writePageFile, gitAutoCommit, getBrainDir } from '../src/core/pages-fs.ts';
import { withoutSandbox } from './helpers/sandbox.ts';
import { initBrainDirs } from '../src/commands/init.ts';
import type { GBrainConfig } from '../src/core/config.ts';

// Test isolation: unique temp dir per test run
const TEST_ROOT = join(tmpdir(), `cfbrain-spec25-${Date.now()}`);
let brainDir: string;
let config: GBrainConfig;

beforeEach(() => {
  brainDir = join(TEST_ROOT, `brain-${Math.random().toString(36).slice(2)}`);
  mkdirSync(brainDir, { recursive: true });
  config = {
    engine: 'pglite',
    database_path: join(brainDir, 'brain.db'),
  };
});

afterEach(() => {
  try { rmSync(brainDir, { recursive: true, force: true }); } catch {}
});

// ── T120: Raw directory management utilities ──

describe('T120: Raw directory utilities', () => {
  test('getRawDir returns raw/ under brain dir', () => {
    expect(getRawDir(config)).toBe(join(brainDir, 'raw'));
  });

  test('ensureRawDir creates raw/ if missing', () => {
    expect(existsSync(join(brainDir, 'raw'))).toBe(false);
    const rawDir = ensureRawDir(config);
    expect(existsSync(rawDir)).toBe(true);
    expect(rawDir).toBe(join(brainDir, 'raw'));
  });

  test('ensureRawDir is idempotent', () => {
    ensureRawDir(config);
    ensureRawDir(config); // second call
    expect(existsSync(join(brainDir, 'raw'))).toBe(true);
  });

  test('copyToRaw copies file with date-slug naming', () => {
    const srcFile = join(brainDir, 'report.pdf');
    writeFileSync(srcFile, 'fake-pdf-content');

    const relPath = copyToRaw(config, srcFile, 'intel-report');
    const today = new Date().toISOString().slice(0, 10);

    expect(relPath).toBe(`raw/${today}-intel-report.pdf`);
    expect(existsSync(join(brainDir, relPath))).toBe(true);
    expect(readFileSync(join(brainDir, relPath), 'utf-8')).toBe('fake-pdf-content');
  });

  test('copyToRaw preserves file extension', () => {
    const srcFile = join(brainDir, 'photo.jpg');
    writeFileSync(srcFile, 'fake-jpg');

    const relPath = copyToRaw(config, srcFile, 'meeting-photo');
    expect(relPath).toEndWith('.jpg');
  });

  test('copyToRaw is immutable — does not overwrite existing raw file', () => {
    const srcFile = join(brainDir, 'report.pdf');
    writeFileSync(srcFile, 'version-1');

    const relPath = copyToRaw(config, srcFile, 'my-report');

    // Overwrite source with different content
    writeFileSync(srcFile, 'version-2');
    copyToRaw(config, srcFile, 'my-report'); // same slug

    // Raw file should still have version-1 content
    expect(readFileSync(join(brainDir, relPath), 'utf-8')).toBe('version-1');
  });

  test('resolveRawPath returns absolute path', () => {
    const abs = resolveRawPath(config, 'raw/2026-04-14-report.pdf');
    expect(abs).toBe(join(brainDir, 'raw', '2026-04-14-report.pdf'));
  });

  test('normalizeRawSource handles various inputs', () => {
    expect(normalizeRawSource(undefined)).toEqual([]);
    expect(normalizeRawSource(null)).toEqual([]);
    expect(normalizeRawSource('')).toEqual([]);
    expect(normalizeRawSource('raw/file.pdf')).toEqual(['raw/file.pdf']);
    expect(normalizeRawSource(['raw/a.pdf', 'raw/b.jpg'])).toEqual(['raw/a.pdf', 'raw/b.jpg']);
  });
});

// ── T121: raw_source frontmatter preservation ──

describe('T121: raw_source in frontmatter', () => {
  test('parseMarkdown preserves raw_source in frontmatter', () => {
    const md = `---
types:
  - intel
title: My Report
raw_source: raw/2026-04-14-report.pdf
---

Report content here.`;

    const parsed = parseMarkdown(md);
    expect(parsed.frontmatter.raw_source).toBe('raw/2026-04-14-report.pdf');
    expect(parsed.types).toEqual(['intel']);
    expect(parsed.title).toBe('My Report');
  });

  test('parseMarkdown preserves raw_source array', () => {
    const md = `---
types:
  - intel
title: Combined Report
raw_source:
  - raw/2026-04-14-report.pdf
  - raw/2026-04-14-appendix.xlsx
---

Content.`;

    const parsed = parseMarkdown(md);
    expect(parsed.frontmatter.raw_source).toEqual([
      'raw/2026-04-14-report.pdf',
      'raw/2026-04-14-appendix.xlsx',
    ]);
  });

  test('serializeMarkdown round-trips raw_source', () => {
    const frontmatter = { raw_source: 'raw/2026-04-14-report.pdf' };
    const md = serializeMarkdown(frontmatter, 'Content here.', {
      types: ['intel'], title: 'Report', tags: [],
    });

    const reparsed = parseMarkdown(md);
    expect(reparsed.frontmatter.raw_source).toBe('raw/2026-04-14-report.pdf');
    expect(reparsed.compiled_truth).toBe('Content here.');
  });

  test('serializeMarkdown round-trips raw_source array', () => {
    const frontmatter = {
      raw_source: ['raw/a.pdf', 'raw/b.jpg'],
    };
    const md = serializeMarkdown(frontmatter, 'Body.', {
      types: ['note'], title: 'Multi', tags: [],
    });

    const reparsed = parseMarkdown(md);
    expect(reparsed.frontmatter.raw_source).toEqual(['raw/a.pdf', 'raw/b.jpg']);
  });
});

// ── T122: put with --raw integration ──

describe('T122: put with --raw', () => {
  test('copyToRaw + frontmatter injection for single file', () => {
    // Simulate what put_page handler does with --raw
    const srcFile = join(brainDir, 'quarterly.pdf');
    writeFileSync(srcFile, 'pdf-bytes');

    const relPath = copyToRaw(config, srcFile, 'q1-report');
    const content = `---
types:
  - intel
title: Q1 Report
---

Quarterly results summary.`;

    const parsed = parseMarkdown(content);
    const existingRaw = normalizeRawSource(parsed.frontmatter.raw_source);
    const merged = [...new Set([...existingRaw, relPath])];
    parsed.frontmatter.raw_source = merged.length === 1 ? merged[0] : merged;

    const serialized = serializeMarkdown(parsed.frontmatter, parsed.compiled_truth, {
      types: parsed.types, title: parsed.title, tags: parsed.tags,
    });

    const reparsed = parseMarkdown(serialized);
    expect(reparsed.frontmatter.raw_source).toBe(relPath);
    expect(reparsed.compiled_truth).toBe('Quarterly results summary.');
  });

  test('multiple --raw files produce array raw_source', () => {
    const pdf = join(brainDir, 'report.pdf');
    const img = join(brainDir, 'chart.png');
    writeFileSync(pdf, 'pdf');
    writeFileSync(img, 'png');

    const rel1 = copyToRaw(config, pdf, 'combined');
    const rel2 = copyToRaw(config, img, 'combined');

    const content = `---
types:
  - intel
title: Combined
---

Body.`;

    const parsed = parseMarkdown(content);
    const merged = [...new Set([rel1, rel2])];
    parsed.frontmatter.raw_source = merged;

    const serialized = serializeMarkdown(parsed.frontmatter, parsed.compiled_truth, {
      types: parsed.types, title: parsed.title, tags: parsed.tags,
    });

    const reparsed = parseMarkdown(serialized);
    expect(reparsed.frontmatter.raw_source).toEqual(merged);
  });

  test('raw file immutability on re-put', () => {
    const srcFile = join(brainDir, 'report.pdf');
    writeFileSync(srcFile, 'original-content');

    const relPath = copyToRaw(config, srcFile, 'my-report');

    // Simulate re-put with updated file
    writeFileSync(srcFile, 'updated-content');
    copyToRaw(config, srcFile, 'my-report');

    // Raw file should still have original content
    expect(readFileSync(join(brainDir, relPath), 'utf-8')).toBe('original-content');
  });

  test('supports various file types', () => {
    const types = [
      ['doc.pdf', 'pdf-content'],
      ['photo.jpg', 'jpg-bytes'],
      ['screenshot.png', 'png-bytes'],
      ['audio.mp3', 'mp3-bytes'],
      ['slides.docx', 'docx-bytes'],
    ];

    for (const [name, content] of types) {
      const src = join(brainDir, name);
      writeFileSync(src, content);
      const relPath = copyToRaw(config, src, name.split('.')[0]);
      expect(existsSync(join(brainDir, relPath))).toBe(true);
    }
  });
});

// ── T123: git auto-commit includes raw/ ──

describe('T123: git tracks raw/ alongside pages/', () => {
  test('git commit includes raw/ files', () => {
    initBrainDirs(brainDir);
    execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: brainDir, stdio: 'pipe' });

    // Write a page file
    writePageFile(config, 'test-page', '---\ntypes:\n  - note\ntitle: Test\n---\n\nContent.\n');

    // Write a raw file
    const rawFile = join(brainDir, 'raw', '2026-04-14-test-page.pdf');
    writeFileSync(rawFile, 'fake-pdf');

    // Auto-commit should pick up both
    // Opts out of the test sandbox to assert real commit behaviour; brainDir is a
    // throwaway $TMPDIR repo, never the production brain.
    withoutSandbox(() => gitAutoCommit(config, 'put: test-page with raw file'));

    const log = execSync('git log --oneline', { cwd: brainDir, encoding: 'utf-8' });
    expect(log).toContain('put: test-page with raw file');

    // Verify both files are tracked
    const tracked = execSync('git ls-files', { cwd: brainDir, encoding: 'utf-8' });
    expect(tracked).toContain('pages/test-page.md');
    expect(tracked).toContain('raw/2026-04-14-test-page.pdf');
  });

  test('legacy pages/.git still works for auto-commit', () => {
    // Simulate legacy layout: .git inside pages/ not brain dir
    const pagesDir = join(brainDir, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    execSync('git init', { cwd: pagesDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: pagesDir, stdio: 'pipe' });

    writePageFile(config, 'legacy-test', 'content');
    withoutSandbox(() => gitAutoCommit(config, 'legacy commit'));

    const log = execSync('git log --oneline', { cwd: pagesDir, encoding: 'utf-8' });
    expect(log).toContain('legacy commit');
  });
});

// ── T124: Feishu attachment blocks ──

describe('T124: Feishu attachment block generation', () => {
  test('buildAttachmentBlocks returns empty for no raw sources', () => {
    const blocks = buildAttachmentBlocks([], new Map());
    expect(blocks).toEqual([]);
  });

  test('buildAttachmentBlocks creates divider + heading + file blocks', () => {
    const fileTokenMap = new Map([
      ['raw/2026-04-14-report.pdf', 'file_token_123'],
    ]);

    const blocks = buildAttachmentBlocks(['raw/2026-04-14-report.pdf'], fileTokenMap);

    // Should have: divider, heading, file block
    expect(blocks.length).toBe(3);

    // Divider
    expect(blocks[0].block_type).toBe(22); // DIVIDER
    expect(blocks[0].divider).toEqual({});

    // Heading
    expect(blocks[1].block_type).toBe(4); // HEADING2
    expect((blocks[1] as any).heading2.elements[0].text_run.content).toBe('📎 原始文件');

    // File block
    expect(blocks[2].block_type).toBe(23); // FILE
    expect((blocks[2] as any).file.token).toBe('file_token_123');
  });

  test('buildAttachmentBlocks falls back to text for missing file token', () => {
    const blocks = buildAttachmentBlocks(['raw/2026-04-14-report.pdf'], new Map());

    // divider + heading + text fallback
    expect(blocks.length).toBe(3);

    // Fallback text block
    expect(blocks[2].block_type).toBe(2); // TEXT
    expect((blocks[2] as any).text.elements[0].text_run.content).toBe('📄 2026-04-14-report.pdf');
  });

  test('buildAttachmentBlocks handles multiple files', () => {
    const fileTokenMap = new Map([
      ['raw/a.pdf', 'token_a'],
      ['raw/b.jpg', 'token_b'],
    ]);

    const blocks = buildAttachmentBlocks(['raw/a.pdf', 'raw/b.jpg'], fileTokenMap);

    // divider + heading + 2 file blocks
    expect(blocks.length).toBe(4);
    expect((blocks[2] as any).file.token).toBe('token_a');
    expect((blocks[3] as any).file.token).toBe('token_b');
  });

  test('buildAttachmentBlocks handles mix of found and missing tokens', () => {
    const fileTokenMap = new Map([
      ['raw/a.pdf', 'token_a'],
    ]);

    const blocks = buildAttachmentBlocks(['raw/a.pdf', 'raw/b.jpg'], fileTokenMap);

    // divider + heading + file block + text fallback
    expect(blocks.length).toBe(4);
    expect(blocks[2].block_type).toBe(23); // FILE
    expect(blocks[3].block_type).toBe(2);  // TEXT (fallback)
  });
});

// ── Spec 29: Raw file naming collision fix ──

describe('Spec 29: copyToRaw naming collision', () => {
  test('same content same slug returns same path (no duplicate)', () => {
    const srcFile = join(brainDir, 'video.mp4');
    writeFileSync(srcFile, 'same-video-content');

    const path1 = copyToRaw(config, srcFile, 'my-video');
    const path2 = copyToRaw(config, srcFile, 'my-video');

    expect(path1).toBe(path2); // Immutable — same file, same path
  });

  test('different content same slug gets numeric suffix', () => {
    const file1 = join(brainDir, 'video1.mp4');
    const file2 = join(brainDir, 'video2.mp4');
    writeFileSync(file1, 'content-A');
    writeFileSync(file2, 'content-B');

    const today = new Date().toISOString().slice(0, 10);
    const path1 = copyToRaw(config, file1, 'demo');
    const path2 = copyToRaw(config, file2, 'demo');

    expect(path1).toBe(`raw/${today}-demo.mp4`);
    expect(path2).toBe(`raw/${today}-demo-2.mp4`);

    // Both files exist with correct content
    expect(readFileSync(join(brainDir, path1), 'utf-8')).toBe('content-A');
    expect(readFileSync(join(brainDir, path2), 'utf-8')).toBe('content-B');
  });

  test('three different files same slug get sequential suffixes', () => {
    const file1 = join(brainDir, 'a.pdf');
    const file2 = join(brainDir, 'b.pdf');
    const file3 = join(brainDir, 'c.pdf');
    writeFileSync(file1, 'pdf-1');
    writeFileSync(file2, 'pdf-2');
    writeFileSync(file3, 'pdf-3');

    const today = new Date().toISOString().slice(0, 10);
    const p1 = copyToRaw(config, file1, 'report');
    const p2 = copyToRaw(config, file2, 'report');
    const p3 = copyToRaw(config, file3, 'report');

    expect(p1).toBe(`raw/${today}-report.pdf`);
    expect(p2).toBe(`raw/${today}-report-2.pdf`);
    expect(p3).toBe(`raw/${today}-report-3.pdf`);
  });

  test('re-copying already-suffixed file returns existing path', () => {
    const file1 = join(brainDir, 'x.mp4');
    const file2 = join(brainDir, 'y.mp4');
    writeFileSync(file1, 'content-X');
    writeFileSync(file2, 'content-Y');

    const today = new Date().toISOString().slice(0, 10);
    copyToRaw(config, file1, 'clip');
    const path2 = copyToRaw(config, file2, 'clip');
    expect(path2).toBe(`raw/${today}-clip-2.mp4`);

    // Re-copy file2 — should return same suffixed path
    const path2again = copyToRaw(config, file2, 'clip');
    expect(path2again).toBe(path2);
  });

  test('different extensions dont collide', () => {
    const pdf = join(brainDir, 'doc.pdf');
    const pptx = join(brainDir, 'doc.pptx');
    writeFileSync(pdf, 'pdf-content');
    writeFileSync(pptx, 'pptx-content');

    const today = new Date().toISOString().slice(0, 10);
    const p1 = copyToRaw(config, pdf, 'doc');
    const p2 = copyToRaw(config, pptx, 'doc');

    expect(p1).toBe(`raw/${today}-doc.pdf`);
    expect(p2).toBe(`raw/${today}-doc.pptx`);
    // No suffix needed — different extensions
  });

  test('immutability preserved — original file not overwritten by collision', () => {
    const file1 = join(brainDir, 'v.mp4');
    const file2 = join(brainDir, 'w.mp4');
    writeFileSync(file1, 'original');
    writeFileSync(file2, 'different');

    const path1 = copyToRaw(config, file1, 'vid');
    copyToRaw(config, file2, 'vid');

    // Original raw file unchanged
    expect(readFileSync(join(brainDir, path1), 'utf-8')).toBe('original');
  });
});

// Cleanup test root after all tests
afterEach(() => {
  // Individual test cleanup handled above
});
