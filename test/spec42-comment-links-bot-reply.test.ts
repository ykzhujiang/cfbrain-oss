import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

import { extractElementText } from '../src/core/feishu.ts';

// ---------------------------------------------------------------------------
// T207: Link extraction from comment elements
// ---------------------------------------------------------------------------

describe('Spec 42 T207: extractElementText', () => {
  test('text_run without link → plain text', () => {
    expect(extractElementText({ text_run: { text: 'hello' } })).toBe('hello');
  });

  test('text_run with .content fallback', () => {
    expect(extractElementText({ text_run: { content: 'world' } })).toBe('world');
  });

  test('text_run with link → "text (url)"', () => {
    const out = extractElementText({
      text_run: { text: 'docs', link: { url: 'https://example.com' } },
    });
    expect(out).toBe('docs (https://example.com)');
  });

  test('text_run with link but empty text → URL only', () => {
    const out = extractElementText({
      text_run: { text: '', link: { url: 'https://example.com' } },
    });
    expect(out).toBe('https://example.com');
  });

  test('standalone link type → URL', () => {
    const out = extractElementText({
      type: 'link',
      link: { url: 'https://feishu.cn/x' },
    });
    expect(out).toBe('https://feishu.cn/x');
  });

  test('docs_link type → URL', () => {
    const out = extractElementText({
      type: 'docs_link',
      docs_link: { url: 'https://feishu.cn/docs/abc' },
    });
    expect(out).toBe('https://feishu.cn/docs/abc');
  });

  test('mention_user element → empty string (handled elsewhere)', () => {
    const out = extractElementText({
      type: 'mention_user',
      mention_user: { open_id: 'ou_bot' },
    });
    expect(out).toBe('');
  });

  test('unknown element → empty string', () => {
    expect(extractElementText({ type: 'unknown' } as Parameters<typeof extractElementText>[0])).toBe('');
  });
});

describe('Spec 42 T207: CommentElement interface', () => {
  test('source declares link/docs_link/text_run.link fields', () => {
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const idx = code.indexOf('interface CommentElement');
    expect(idx).toBeGreaterThan(-1);
    // Grab the next ~400 chars — enough to cover the full interface body
    const iface = code.slice(idx, idx + 400);
    expect(iface).toContain('link?:');
    expect(iface).toContain('docs_link?:');
    // text_run now has a link field
    const textRunIdx = iface.indexOf('text_run?:');
    const textRunBody = iface.slice(textRunIdx, iface.indexOf('};', textRunIdx));
    expect(textRunBody).toContain('link?:');
  });

  test('feishuListComments uses extractElementText for content assembly', () => {
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const fnStart = code.indexOf('async function feishuListComments');
    const fnBody = code.slice(fnStart, fnStart + 2500);
    expect(fnBody).toContain('extractElementText');
  });
});

// ---------------------------------------------------------------------------
// T208: Bot identity for comment replies
// ---------------------------------------------------------------------------

describe('Spec 42 T208: feishuReplyComment uses --as bot', () => {
  test('source passes --as bot to lark-cli args', () => {
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const fnStart = code.indexOf('async function feishuReplyComment');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = code.slice(fnStart, code.indexOf('\n}', fnStart));
    expect(fnBody).toContain("'--as'");
    expect(fnBody).toContain("'bot'");
  });

  test('--as bot precedes --params and --data in arg order', () => {
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const fnStart = code.indexOf('async function feishuReplyComment');
    const fnBody = code.slice(fnStart, code.indexOf('\n}', fnStart));
    const asIdx = fnBody.indexOf("'--as'");
    const paramsIdx = fnBody.indexOf("'--params'");
    const dataIdx = fnBody.indexOf("'--data'");
    expect(asIdx).toBeGreaterThan(-1);
    expect(asIdx).toBeLessThan(paramsIdx);
    expect(asIdx).toBeLessThan(dataIdx);
  });
});
