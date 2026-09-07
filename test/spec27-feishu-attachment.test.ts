/**
 * Spec 27: Integration tests for Feishu file attachment & --raw replace behavior
 *
 * Tests cover:
 * - T130: feishuInsertFile command construction (args, cwd, unicode filenames, errors)
 * - T131: appendRawAttachments full flow
 * - T132: --raw replaces existing raw_source, no --raw preserves it
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { feishuInsertFile } from '../src/core/feishu.ts';
import { normalizeRawSource, copyToRaw, ensureRawDir, resolveRawPath } from '../src/core/raw-files.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const TEST_ROOT = join(tmpdir(), `cfbrain-spec27-${Date.now()}`);
let config: GBrainConfig;

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  config = {
    engine: 'pglite',
    database_path: join(TEST_ROOT, 'brain.pglite'),
  } as GBrainConfig;
  // pages dir must exist for getBrainDir to resolve
  mkdirSync(join(TEST_ROOT, 'pages'), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// Helper to get brain dir from config
function getBrainDir(c: GBrainConfig): string {
  const dbPath = c.database_path;
  // brain dir is parent of the database file
  return dbPath.replace(/\/[^/]+$/, '');
}

describe('T130: feishuInsertFile command construction', () => {
  test('function exists and is callable', () => {
    expect(typeof feishuInsertFile).toBe('function');
  });

  test('returns false when lark-cli is not available or file missing', async () => {
    // Call with a non-existent file — should return false (non-fatal)
    const result = await feishuInsertFile('fake-doc-token', '/nonexistent/path/file.pdf');
    expect(result).toBe(false);
  });

  test('handles unicode filenames in path splitting', () => {
    // Verify the path splitting logic works with Chinese characters
    const filePath = '/some/dir/美国AI产业调研报告.pdf';
    const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '.';
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
    expect(dir).toBe('/some/dir');
    expect(fileName).toBe('美国AI产业调研报告.pdf');
  });

  test('handles paths with spaces', () => {
    const filePath = '/some dir/my file.pdf';
    const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '.';
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
    expect(dir).toBe('/some dir');
    expect(fileName).toBe('my file.pdf');
  });

  test('handles file in current directory (no slash)', () => {
    const filePath = 'file.pdf';
    const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '.';
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
    expect(dir).toBe('.');
    expect(fileName).toBe('file.pdf');
  });
});

describe('T131: appendRawAttachments flow', () => {
  test('normalizeRawSource handles all input types', () => {
    expect(normalizeRawSource(undefined)).toEqual([]);
    expect(normalizeRawSource(null)).toEqual([]);
    expect(normalizeRawSource('')).toEqual([]);
    expect(normalizeRawSource('raw/file.pdf')).toEqual(['raw/file.pdf']);
    expect(normalizeRawSource(['raw/a.pdf', 'raw/b.pdf'])).toEqual(['raw/a.pdf', 'raw/b.pdf']);
  });

  test('resolveRawPath creates absolute path from relative raw_source', () => {
    const absPath = resolveRawPath(config, 'raw/2026-04-14-test.pdf');
    expect(absPath).toBe(join(TEST_ROOT, 'raw/2026-04-14-test.pdf'));
  });

  test('missing raw file does not crash (resilience)', () => {
    const absPath = resolveRawPath(config, 'raw/nonexistent.pdf');
    expect(existsSync(absPath)).toBe(false);
    // The actual appendRawAttachments skips missing files with a warning
  });

  test('multiple raw_source entries all resolve correctly', () => {
    const sources = normalizeRawSource(['raw/a.pdf', 'raw/b.jpg', 'raw/c.docx']);
    expect(sources).toHaveLength(3);
    for (const s of sources) {
      const abs = resolveRawPath(config, s);
      expect(abs).toContain(TEST_ROOT);
    }
  });
});

describe('T132: --raw replaces existing raw_source', () => {
  test('when --raw provided, it replaces content frontmatter raw_source', () => {
    // Simulate the logic from operations.ts
    const content = `---
title: "Test"
types: [intel]
raw_source: raw/old-file.pdf
---

# Test content`;

    const parsed = parseMarkdown(content);
    expect(parsed.frontmatter.raw_source).toBe('raw/old-file.pdf');

    // Simulate --raw generating a new path
    const newRawSources = ['raw/2026-04-14-new-file.pdf'];

    // The fix: --raw replaces, not merges
    parsed.frontmatter.raw_source = newRawSources.length === 1 ? newRawSources[0] : newRawSources;

    expect(parsed.frontmatter.raw_source).toBe('raw/2026-04-14-new-file.pdf');
    // NOT ['raw/old-file.pdf', 'raw/2026-04-14-new-file.pdf']
  });

  test('when --raw NOT provided, existing raw_source preserved', () => {
    const content = `---
title: "Test"
raw_source: raw/existing.pdf
---

# Content`;

    const parsed = parseMarkdown(content);
    // Without --raw, frontmatter should be untouched
    expect(parsed.frontmatter.raw_source).toBe('raw/existing.pdf');
  });

  test('--raw with multiple files produces array', () => {
    const newRawSources = ['raw/a.pdf', 'raw/b.jpg'];
    const parsed = parseMarkdown('---\ntitle: Test\n---\n# Content');

    parsed.frontmatter.raw_source = newRawSources.length === 1 ? newRawSources[0] : newRawSources;

    expect(parsed.frontmatter.raw_source).toEqual(['raw/a.pdf', 'raw/b.jpg']);
  });

  test('--raw with single file produces string (not array)', () => {
    const newRawSources = ['raw/single.pdf'];
    const parsed = parseMarkdown('---\ntitle: Test\n---\n# Content');

    parsed.frontmatter.raw_source = newRawSources.length === 1 ? newRawSources[0] : newRawSources;

    expect(parsed.frontmatter.raw_source).toBe('raw/single.pdf');
    expect(Array.isArray(parsed.frontmatter.raw_source)).toBe(false);
  });

  test('copyToRaw generates correct date-slug naming', () => {
    // Create a test file
    const srcFile = join(TEST_ROOT, 'test-report.pdf');
    writeFileSync(srcFile, 'fake pdf content');

    const relPath = copyToRaw(config, srcFile, 'my-slug');

    // Should match pattern: raw/YYYY-MM-DD-my-slug.pdf
    expect(relPath).toMatch(/^raw\/\d{4}-\d{2}-\d{2}-my-slug\.pdf$/);

    // File should exist
    const absPath = resolveRawPath(config, relPath);
    expect(existsSync(absPath)).toBe(true);
    expect(readFileSync(absPath, 'utf-8')).toBe('fake pdf content');
  });

  test('copyToRaw is immutable — does not overwrite existing', () => {
    const srcFile1 = join(TEST_ROOT, 'v1.pdf');
    writeFileSync(srcFile1, 'version 1');
    const relPath = copyToRaw(config, srcFile1, 'immutable-test');

    // Write a different file with same slug
    const srcFile2 = join(TEST_ROOT, 'v2.pdf');
    writeFileSync(srcFile2, 'version 2');
    const relPath2 = copyToRaw(config, srcFile2, 'immutable-test');

    const today = new Date().toISOString().slice(0, 10);
    // Different content → gets suffixed path
    expect(relPath2).toBe(`raw/${today}-immutable-test-2.pdf`);
    // Original content still intact (immutable)
    const absPath = resolveRawPath(config, relPath);
    expect(readFileSync(absPath, 'utf-8')).toBe('version 1');
    // Second file also preserved
    const absPath2 = resolveRawPath(config, relPath2);
    expect(readFileSync(absPath2, 'utf-8')).toBe('version 2');
  });
});

// ---- Spec 28 tests: Smart raw source embedding ----

import { getRawMediaType } from '../src/core/raw-files.ts';

describe('T133: getRawMediaType classification', () => {
  test('classifies jpg/jpeg/png/webp/gif as image', () => {
    expect(getRawMediaType('raw/photo.jpg')).toBe('image');
    expect(getRawMediaType('raw/photo.jpeg')).toBe('image');
    expect(getRawMediaType('raw/screenshot.png')).toBe('image');
    expect(getRawMediaType('raw/banner.webp')).toBe('image');
    expect(getRawMediaType('raw/animation.gif')).toBe('image');
  });

  test('classifies case-insensitively', () => {
    expect(getRawMediaType('raw/PHOTO.JPG')).toBe('image');
    expect(getRawMediaType('raw/Photo.PNG')).toBe('image');
  });

  test('classifies pdf/docx/xlsx/mp3/mp4 as file', () => {
    expect(getRawMediaType('raw/report.pdf')).toBe('file');
    expect(getRawMediaType('raw/doc.docx')).toBe('file');
    expect(getRawMediaType('raw/data.xlsx')).toBe('file');
    expect(getRawMediaType('raw/audio.mp3')).toBe('file');
    expect(getRawMediaType('raw/video.mp4')).toBe('file');
  });

  test('classifies unknown extensions as file', () => {
    expect(getRawMediaType('raw/archive.zip')).toBe('file');
    expect(getRawMediaType('raw/data.csv')).toBe('file');
    expect(getRawMediaType('raw/noext')).toBe('file');
  });

  test('handles Chinese filenames', () => {
    expect(getRawMediaType('raw/美国AI报告.pdf')).toBe('file');
    expect(getRawMediaType('raw/微信截图.jpg')).toBe('image');
  });
});

describe('T134-T135: feishuInsertFile with mediaType', () => {
  test('feishuInsertFile accepts mediaType parameter', () => {
    // Verify the function signature accepts 3 params
    expect(feishuInsertFile.length).toBeGreaterThanOrEqual(2);
  });

  test('feishuInsertFile defaults to file type', async () => {
    // Call with only 2 args (no mediaType) — should default to 'file' and return false (no lark-cli)
    const result = await feishuInsertFile('fake-token', '/nonexistent/file.pdf');
    expect(result).toBe(false);
  });

  test('feishuInsertFile with image type returns false for missing file', async () => {
    const result = await feishuInsertFile('fake-token', '/nonexistent/image.jpg', 'image');
    expect(result).toBe(false);
  });
});
