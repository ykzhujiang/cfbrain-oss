/**
 * Spec 32: Feishu Minutes (妙记) as input source tests
 *
 * Tests cover:
 * - T151: Minutes extraction (parseMinuteToken, compileMinutesPage)
 * - T152: Raw storage (URL + transcript files)
 * - T153: Page compilation format
 * - T154: Integration tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { parseMinuteToken, compileMinutesPage, type MinutesContent } from '../src/core/extractors/minutes.ts';
import { writeRawText } from '../src/core/raw-files.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const TEST_ROOT = join(tmpdir(), `cfbrain-spec32-${Date.now()}`);
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

// ── T151: Minutes extraction ──

describe('T151: Minutes extraction', () => {
  test('parseMinuteToken extracts token from feishu.cn URL', () => {
    expect(parseMinuteToken('https://xxx.feishu.cn/minutes/obcn1234567890')).toBe('obcn1234567890');
  });

  test('parseMinuteToken extracts token from larksuite URL', () => {
    expect(parseMinuteToken('https://app.larksuite.com/minutes/obcnABCDEF')).toBe('obcnABCDEF');
  });

  test('parseMinuteToken handles direct token input', () => {
    expect(parseMinuteToken('obcn1234567890')).toBe('obcn1234567890');
  });

  test('parseMinuteToken handles URL with trailing path', () => {
    expect(parseMinuteToken('https://xxx.feishu.cn/minutes/obcnXYZ?from=share')).toBe('obcnXYZ');
  });

  test('parseMinuteToken trims whitespace from direct token', () => {
    expect(parseMinuteToken('  obcn123  ')).toBe('obcn123');
  });
});

// ── T152: Raw storage for minutes ──

describe('T152: Raw storage for minutes', () => {
  test('saves minutes URL as .url file', () => {
    const url = 'https://xxx.feishu.cn/minutes/obcn123';
    const result = writeRawText(config, 'weekly-standup', '.url', url);
    expect(result).toMatch(/\.url$/);
    expect(readFileSync(join(brainDir, result), 'utf-8')).toBe(url);
  });

  test('saves transcript as -transcript.txt file', () => {
    const transcript = '张三: 大家好\n李四: 好的，我们开始吧\n张三: 首先讨论第一个议题';
    const result = writeRawText(config, 'weekly-standup', '.txt', transcript, '-transcript');
    expect(result).toMatch(/-transcript\.txt$/);
    expect(readFileSync(join(brainDir, result), 'utf-8')).toBe(transcript);
  });

  test('both .url and transcript files created for same slug', () => {
    const url = 'https://xxx.feishu.cn/minutes/obcn456';
    const transcript = 'Speaker A: Hello\nSpeaker B: Hi';

    const urlPath = writeRawText(config, 'meeting', '.url', url);
    const txtPath = writeRawText(config, 'meeting', '.txt', transcript, '-transcript');

    expect(existsSync(join(brainDir, urlPath))).toBe(true);
    expect(existsSync(join(brainDir, txtPath))).toBe(true);
    expect(urlPath).not.toBe(txtPath);
  });
});

// ── T153: Page compilation ──

describe('T153: Page compilation format', () => {
  const sampleMinutes: MinutesContent = {
    title: '每周站会 2026-04-15',
    duration: 1800,
    createTime: 1744675200, // 2025-04-15 00:00:00 UTC
    owner: { name: '张三' },
    summary: '本周讨论了新功能开发进度和Bug修复计划。',
    todos: [
      { content: '完成API文档', assignee: '李四', done: false },
      { content: '修复登录Bug', assignee: '王五', done: true },
    ],
    chapters: [
      { title: '开发进度', content: '各组汇报了本周进度。' },
      { title: '下周计划', content: '确定了下周的主要任务。' },
    ],
    transcript: '张三: 开始今天的站会\n李四: 好的',
  };

  test('compiles to valid markdown with frontmatter', () => {
    const md = compileMinutesPage(sampleMinutes, 'https://feishu.cn/minutes/obcn123');
    const parsed = parseMarkdown(md);

    expect(parsed.types).toContain('meeting');
    expect(parsed.title).toBe('每周站会 2026-04-15');
    expect(parsed.frontmatter.source_url).toBe('https://feishu.cn/minutes/obcn123');
  });

  test('includes summary section', () => {
    const md = compileMinutesPage(sampleMinutes, 'https://feishu.cn/minutes/obcn123');
    expect(md).toContain('## 摘要');
    expect(md).toContain('本周讨论了新功能开发进度和Bug修复计划。');
  });

  test('includes todos with checkboxes', () => {
    const md = compileMinutesPage(sampleMinutes, 'https://feishu.cn/minutes/obcn123');
    expect(md).toContain('## 待办事项');
    expect(md).toContain('- [ ] 完成API文档 (@李四)');
    expect(md).toContain('- [x] 修复登录Bug (@王五)');
  });

  test('includes chapters', () => {
    const md = compileMinutesPage(sampleMinutes, 'https://feishu.cn/minutes/obcn123');
    expect(md).toContain('## 章节');
    expect(md).toContain('### 开发进度');
    expect(md).toContain('### 下周计划');
  });

  test('includes transcript', () => {
    const md = compileMinutesPage(sampleMinutes, 'https://feishu.cn/minutes/obcn123');
    expect(md).toContain('## 逐字稿');
    expect(md).toContain('张三: 开始今天的站会');
  });

  test('handles minimal minutes (no optional fields)', () => {
    const minimal: MinutesContent = {
      title: 'Quick Call',
    };
    const md = compileMinutesPage(minimal, 'https://feishu.cn/minutes/obcn789');
    const parsed = parseMarkdown(md);

    expect(parsed.types).toContain('meeting');
    expect(parsed.title).toBe('Quick Call');
    // No summary/todos/chapters/transcript sections
    expect(md).not.toContain('## 摘要');
    expect(md).not.toContain('## 待办事项');
    expect(md).not.toContain('## 章节');
    expect(md).not.toContain('## 逐字稿');
  });

  test('handles title with special characters', () => {
    const minutes: MinutesContent = {
      title: 'Meeting: "Q2 Review" & Planning',
      summary: 'Reviewed Q2.',
    };
    const md = compileMinutesPage(minutes, 'https://feishu.cn/minutes/obcn000');
    // Should not break YAML parsing
    const parsed = parseMarkdown(md);
    expect(parsed.title).toBe('Meeting: "Q2 Review" & Planning');
  });

  test('date field derived from createTime', () => {
    const minutes: MinutesContent = {
      title: 'Test',
      createTime: 1744675200,
    };
    const md = compileMinutesPage(minutes, 'https://feishu.cn/minutes/obcn111');
    expect(md).toContain('date:');
  });
});

// ── T154: Integration (minutes extraction + raw + page format) ──

describe('T154: Integration tests', () => {
  test('full minutes → raw + page flow', () => {
    const minutes: MinutesContent = {
      title: '产品评审会',
      summary: '评审了3个新需求。',
      todos: [
        { content: '提交设计稿', assignee: '设计师', done: false },
      ],
      transcript: '主持人: 我们开始评审第一个需求',
    };

    const sourceUrl = 'https://xxx.feishu.cn/minutes/obcnPRODUCT';
    const slug = 'product-review';

    // 1. Compile page
    const content = compileMinutesPage(minutes, sourceUrl);

    // 2. Save raw files
    const urlRaw = writeRawText(config, slug, '.url', sourceUrl);
    const transcriptRaw = writeRawText(config, slug, '.txt', minutes.transcript!, '-transcript');

    // 3. Inject raw_source
    const parsed = parseMarkdown(content);
    parsed.frontmatter.raw_source = [urlRaw, transcriptRaw];

    // Verify
    expect(parsed.types).toContain('meeting');
    expect(parsed.title).toBe('产品评审会');
    expect(parsed.frontmatter.source_url).toBe(sourceUrl);
    expect(parsed.frontmatter.raw_source).toHaveLength(2);
    expect(existsSync(join(brainDir, urlRaw))).toBe(true);
    expect(existsSync(join(brainDir, transcriptRaw))).toBe(true);
  });
});
