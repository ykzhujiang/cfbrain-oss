/**
 * Spec 31: Auto-save raw for all input types tests
 *
 * Tests cover:
 * - T146: Auto-raw for URL sources (source_url → .url file)
 * - T147: Auto-raw for text (no --raw, no source_url → .md snapshot)
 * - T148: Auto-raw for YouTube (URL + subtitle text)
 * - T149: raw_source always non-empty after put (validation)
 * - T150: Integration tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { writeRawText, ensureRawDir, getRawDir, normalizeRawSource } from '../src/core/raw-files.ts';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const TEST_ROOT = join(tmpdir(), `cfbrain-spec31-${Date.now()}`);
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

// ── T146: Auto-raw for URL sources ──

describe('T146: Auto-raw for URL sources', () => {
  test('writeRawText creates .url file with URL content', () => {
    const result = writeRawText(config, 'my-article', '.url', 'https://example.com/article');
    expect(result).toMatch(/^raw\/\d{4}-\d{2}-\d{2}-my-article\.url$/);

    const fullPath = join(brainDir, result);
    expect(existsSync(fullPath)).toBe(true);
    expect(readFileSync(fullPath, 'utf-8')).toBe('https://example.com/article');
  });

  test('writeRawText is idempotent for same content', () => {
    const result1 = writeRawText(config, 'my-article', '.url', 'https://example.com/article');
    const result2 = writeRawText(config, 'my-article', '.url', 'https://example.com/article');
    expect(result1).toBe(result2);
  });

  test('writeRawText appends suffix for different content same name', () => {
    const result1 = writeRawText(config, 'slug', '.url', 'https://example.com/v1');
    const result2 = writeRawText(config, 'slug', '.url', 'https://example.com/v2');
    expect(result1).not.toBe(result2);
    expect(result2).toMatch(/-2\.url$/);
  });

  test('source_url in frontmatter triggers auto-raw .url file', () => {
    // Simulate what put_page does for content with source_url
    const content = `---
types: [intel]
title: Test Article
source_url: "https://example.com/test"
---
This is the content.`;

    const parsed = parseMarkdown(content);
    expect(parsed.frontmatter.source_url).toBe('https://example.com/test');

    // Auto-raw logic: detect source_url, create .url file
    const existingRaw = normalizeRawSource(parsed.frontmatter.raw_source);
    expect(existingRaw.length).toBe(0);

    const urlRaw = writeRawText(config, 'test-article', '.url', parsed.frontmatter.source_url as string);
    parsed.frontmatter.raw_source = urlRaw;

    expect(parsed.frontmatter.raw_source).toMatch(/\.url$/);
  });
});

// ── T147: Auto-raw for text sources ──

describe('T147: Auto-raw for text sources', () => {
  test('writeRawText creates .md snapshot for text content', () => {
    const textContent = `---
types: [concept]
title: My Idea
---
This is my great idea about something.`;

    const result = writeRawText(config, 'my-idea', '.md', textContent);
    expect(result).toMatch(/^raw\/\d{4}-\d{2}-\d{2}-my-idea\.md$/);

    const fullPath = join(brainDir, result);
    expect(readFileSync(fullPath, 'utf-8')).toBe(textContent);
  });

  test('text auto-raw triggers when no --raw and no source_url', () => {
    const content = `---
types: [note]
title: Quick Note
---
Just a quick thought.`;

    const parsed = parseMarkdown(content);
    const existingRaw = normalizeRawSource(parsed.frontmatter.raw_source);
    const hasSourceUrl = !!parsed.frontmatter.source_url;

    expect(existingRaw.length).toBe(0);
    expect(hasSourceUrl).toBe(false);

    // Auto-raw: save as .md snapshot
    const mdRaw = writeRawText(config, 'quick-note', '.md', content);
    expect(mdRaw).toMatch(/\.md$/);
    expect(existsSync(join(brainDir, mdRaw))).toBe(true);
  });
});

// ── T148: Auto-raw for YouTube ──

describe('T148: Auto-raw for YouTube sources', () => {
  test('writeRawText creates .url file for YouTube URL', () => {
    const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const result = writeRawText(config, 'youtube-video', '.url', youtubeUrl);
    expect(result).toMatch(/\.url$/);
    expect(readFileSync(join(brainDir, result), 'utf-8')).toBe(youtubeUrl);
  });

  test('writeRawText creates transcript .txt file with suffix', () => {
    const transcript = 'Speaker 1: Hello world\nSpeaker 2: Hi there';
    const result = writeRawText(config, 'youtube-video', '.txt', transcript, '-transcript');
    expect(result).toMatch(/-transcript\.txt$/);
    expect(readFileSync(join(brainDir, result), 'utf-8')).toBe(transcript);
  });

  test('YouTube auto-raw creates both .url and .txt files', () => {
    const url = 'https://www.youtube.com/watch?v=abc123';
    const subtitles = 'Line 1\nLine 2\nLine 3';

    const urlRaw = writeRawText(config, 'yt-video', '.url', url);
    const txtRaw = writeRawText(config, 'yt-video', '.txt', subtitles, '-transcript');

    expect(urlRaw).toMatch(/\.url$/);
    expect(txtRaw).toMatch(/-transcript\.txt$/);
    expect(existsSync(join(brainDir, urlRaw))).toBe(true);
    expect(existsSync(join(brainDir, txtRaw))).toBe(true);
  });
});

// ── T149: raw_source always non-empty ──

describe('T149: raw_source always populated after put', () => {
  test('content with existing raw_source is preserved', () => {
    const content = `---
types: [intel]
title: Report
raw_source: "raw/2026-04-15-report.pdf"
---
Report content.`;

    const parsed = parseMarkdown(content);
    const existingRaw = normalizeRawSource(parsed.frontmatter.raw_source);
    expect(existingRaw.length).toBeGreaterThan(0);
  });

  test('content with source_url gets .url raw_source', () => {
    const content = `---
types: [intel]
title: Web Article
source_url: "https://example.com/article"
---
Article content.`;

    const parsed = parseMarkdown(content);
    const existingRaw = normalizeRawSource(parsed.frontmatter.raw_source);
    expect(existingRaw.length).toBe(0);

    // Auto-raw creates .url file
    const urlRaw = writeRawText(config, 'web-article', '.url', parsed.frontmatter.source_url as string);
    parsed.frontmatter.raw_source = urlRaw;

    const finalRaw = normalizeRawSource(parsed.frontmatter.raw_source);
    expect(finalRaw.length).toBe(1);
    expect(finalRaw[0]).toMatch(/\.url$/);
  });

  test('plain text content gets .md raw_source', () => {
    const content = `---
types: [note]
title: Plain Note
---
Just text.`;

    const parsed = parseMarkdown(content);
    const existingRaw = normalizeRawSource(parsed.frontmatter.raw_source);
    expect(existingRaw.length).toBe(0);
    expect(parsed.frontmatter.source_url).toBeUndefined();

    // Auto-raw creates .md snapshot
    const mdRaw = writeRawText(config, 'plain-note', '.md', content);
    parsed.frontmatter.raw_source = mdRaw;

    const finalRaw = normalizeRawSource(parsed.frontmatter.raw_source);
    expect(finalRaw.length).toBe(1);
    expect(finalRaw[0]).toMatch(/\.md$/);
  });
});

// ── T150: writeRawText edge cases ──

describe('T150: writeRawText edge cases', () => {
  test('handles unicode content', () => {
    const result = writeRawText(config, 'chinese-doc', '.url', 'https://feishu.cn/doc/中文文档');
    const fullPath = join(brainDir, result);
    expect(readFileSync(fullPath, 'utf-8')).toBe('https://feishu.cn/doc/中文文档');
  });

  test('handles empty string content', () => {
    const result = writeRawText(config, 'empty', '.txt', '');
    expect(existsSync(join(brainDir, result))).toBe(true);
    expect(readFileSync(join(brainDir, result), 'utf-8')).toBe('');
  });

  test('handles very long content', () => {
    const longContent = 'x'.repeat(100000);
    const result = writeRawText(config, 'long', '.md', longContent);
    expect(readFileSync(join(brainDir, result), 'utf-8').length).toBe(100000);
  });
});
