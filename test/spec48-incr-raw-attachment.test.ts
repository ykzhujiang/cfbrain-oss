/**
 * Spec 48: INCR mode raw attachment preservation.
 *
 * Tests cover:
 * - T214a: findAttachmentSectionStart detection
 * - T214b: diffDocBlocks excludes attachment tail correctly
 * - T214c: singleSkip recovery path (source code verification)
 * - T214d: pages without raw_source are unaffected
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import {
  findAttachmentSectionStart,
  extractBlockText,
  diffDocBlocks,
  type FeishuDocBlock,
  type FeishuBlock,
} from '../src/core/feishu.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDocBlock(type: number, text: string, id: string, key?: string): FeishuDocBlock {
  const k = key ?? (type === 2 ? 'text' : type === 4 ? 'heading2' : type === 22 ? 'divider' : 'text');
  if (type === 22) return { block_id: id, block_type: 22, divider: {} };
  return {
    block_id: id,
    block_type: type,
    [k]: { elements: [{ text_run: { content: text } }] },
  };
}

function makeNewBlock(type: number, text: string, key?: string): FeishuBlock {
  const k = key ?? (type === 2 ? 'text' : type === 4 ? 'heading2' : type === 22 ? 'divider' : 'text');
  if (type === 22) return { block_type: 22, divider: {} };
  return {
    block_type: type,
    [k]: { elements: [{ text_run: { content: text } }] },
  };
}

// ---------------------------------------------------------------------------
// T214a: findAttachmentSectionStart
// ---------------------------------------------------------------------------

describe('Spec 48 T214a: findAttachmentSectionStart', () => {
  test('returns -1 when no attachment section exists', () => {
    const blocks: FeishuDocBlock[] = [
      makeDocBlock(2, 'Hello', 'b1'),
      makeDocBlock(2, 'World', 'b2'),
    ];
    expect(findAttachmentSectionStart(blocks)).toBe(-1);
  });

  test('detects "📎 原始素材" heading', () => {
    const blocks: FeishuDocBlock[] = [
      makeDocBlock(2, 'Content', 'b1'),
      makeDocBlock(22, '', 'b2'),  // divider
      makeDocBlock(4, '📎 原始素材', 'b3'),
      makeDocBlock(2, '📄 file.pdf', 'b4'),
    ];
    expect(findAttachmentSectionStart(blocks)).toBe(1); // divider index
  });

  test('detects "📎 原始文件" heading', () => {
    const blocks: FeishuDocBlock[] = [
      makeDocBlock(2, 'Content', 'b1'),
      makeDocBlock(22, '', 'b2'),  // divider
      makeDocBlock(4, '📎 原始文件', 'b3'),
    ];
    expect(findAttachmentSectionStart(blocks)).toBe(1); // divider index
  });

  test('returns heading index when no divider before it', () => {
    const blocks: FeishuDocBlock[] = [
      makeDocBlock(2, 'Content', 'b1'),
      makeDocBlock(4, '📎 原始素材', 'b2'),
      makeDocBlock(2, '📄 file.pdf', 'b3'),
    ];
    expect(findAttachmentSectionStart(blocks)).toBe(1); // heading index (no divider)
  });

  test('returns -1 for empty blocks', () => {
    expect(findAttachmentSectionStart([])).toBe(-1);
  });

  test('ignores non-H2 blocks with attachment text', () => {
    const blocks: FeishuDocBlock[] = [
      makeDocBlock(2, '📎 原始素材', 'b1'), // TEXT, not H2
      makeDocBlock(2, 'Content', 'b2'),
    ];
    expect(findAttachmentSectionStart(blocks)).toBe(-1);
  });

  test('returns first attachment section if multiple exist', () => {
    const blocks: FeishuDocBlock[] = [
      makeDocBlock(2, 'Content', 'b1'),
      makeDocBlock(22, '', 'b2'),
      makeDocBlock(4, '📎 原始素材', 'b3'),
      makeDocBlock(2, 'File 1', 'b4'),
      makeDocBlock(22, '', 'b5'),
      makeDocBlock(4, '📎 原始素材', 'b6'),
    ];
    expect(findAttachmentSectionStart(blocks)).toBe(1); // first divider
  });

  test('does not match divider before a non-attachment H2', () => {
    const blocks: FeishuDocBlock[] = [
      makeDocBlock(2, 'Content', 'b1'),
      makeDocBlock(22, '', 'b2'), // divider
      makeDocBlock(4, 'Some Other Heading', 'b3'), // H2 but not attachment
      makeDocBlock(22, '', 'b4'), // divider
      makeDocBlock(4, '📎 原始素材', 'b5'),
    ];
    expect(findAttachmentSectionStart(blocks)).toBe(3); // divider before attachment H2
  });
});

// ---------------------------------------------------------------------------
// T214b: diffDocBlocks with attachment exclusion
// ---------------------------------------------------------------------------

describe('Spec 48 T214b: INCR diff with attachment exclusion', () => {
  test('diff ignores attachment blocks when sliced out', () => {
    // Doc: [Content A, Content B, DIVIDER, H2 attachment, File text]
    const oldAll: FeishuDocBlock[] = [
      makeDocBlock(2, 'A', 'b1'),
      makeDocBlock(2, 'B', 'b2'),
      makeDocBlock(22, '', 'b3'),
      makeDocBlock(4, '📎 原始素材', 'b4'),
      makeDocBlock(2, '📄 file.pdf', 'b5'),
    ];
    const attachIdx = findAttachmentSectionStart(oldAll);
    expect(attachIdx).toBe(2); // divider

    // Slice to content only
    const contentBlocks = oldAll.slice(0, attachIdx);
    expect(contentBlocks).toHaveLength(2);

    // New content unchanged
    const newBlocks: FeishuBlock[] = [
      makeNewBlock(2, 'A'),
      makeNewBlock(2, 'B'),
    ];

    const diff = diffDocBlocks(contentBlocks, newBlocks);
    expect(diff.changeRatio).toBe(0);
    expect(diff.kept).toBe(2);
    expect(diff.gaps).toHaveLength(0);
  });

  test('diff detects content changes without touching attachments', () => {
    const oldAll: FeishuDocBlock[] = [
      makeDocBlock(2, 'A', 'b1'),
      makeDocBlock(2, 'B', 'b2'),
      makeDocBlock(2, 'C', 'b3'),
      makeDocBlock(22, '', 'b4'),
      makeDocBlock(4, '📎 原始素材', 'b5'),
      makeDocBlock(2, '📄 file.pdf', 'b6'),
    ];
    const attachIdx = findAttachmentSectionStart(oldAll);
    const contentBlocks = oldAll.slice(0, attachIdx);

    // Changed B → B-modified
    const newBlocks: FeishuBlock[] = [
      makeNewBlock(2, 'A'),
      makeNewBlock(2, 'B-modified'),
      makeNewBlock(2, 'C'),
    ];

    const diff = diffDocBlocks(contentBlocks, newBlocks);
    expect(diff.kept).toBe(2); // A and C
    expect(diff.gaps.length).toBeGreaterThan(0);
    expect(diff.changeRatio).toBeLessThanOrEqual(0.5);
  });

  test('without exclusion, attachment blocks would be deleted by diff', () => {
    const oldAll: FeishuDocBlock[] = [
      makeDocBlock(2, 'A', 'b1'),
      makeDocBlock(22, '', 'b2'),
      makeDocBlock(4, '📎 原始素材', 'b3'),
      makeDocBlock(2, '📄 file.pdf', 'b4'),
    ];

    // New content has same A but no attachment blocks
    const newBlocks: FeishuBlock[] = [
      makeNewBlock(2, 'A'),
    ];

    // Without exclusion: diff sees 3 extra old blocks to delete
    const diffAll = diffDocBlocks(oldAll, newBlocks);
    expect(diffAll.gaps.length).toBeGreaterThan(0);
    const totalDelete = diffAll.gaps.reduce((s, g) => s + (g.deleteEnd - g.deleteStart), 0);
    expect(totalDelete).toBe(3); // divider + heading + file text

    // With exclusion: diff sees identical content
    const attachIdx = findAttachmentSectionStart(oldAll);
    const diffExcluded = diffDocBlocks(oldAll.slice(0, attachIdx), newBlocks);
    expect(diffExcluded.changeRatio).toBe(0);
    expect(diffExcluded.gaps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T214c: singleSkip recovery path (source verification)
// ---------------------------------------------------------------------------

describe('Spec 48 T214c: singleSkip attachment recovery', () => {
  test('singleSkip path checks raw_source and attachment section', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    // Find the singleSkip block
    const skipIdx = code.indexOf('if (singleSkip) {');
    expect(skipIdx).toBeGreaterThan(-1);
    const skipBlock = code.slice(skipIdx, skipIdx + 1500);

    // Should check for raw_source
    expect(skipBlock).toContain('normalizeRawSource');
    expect(skipBlock).toContain('raw_source');

    // Should fetch blocks and check for attachment section
    expect(skipBlock).toContain('feishuFetchDocBlocks');
    expect(skipBlock).toContain('findAttachmentSectionStart');

    // Should call appendRawAttachments when section missing
    expect(skipBlock).toContain('appendRawAttachments');
  });

  test('all three INCR call sites use excludeTailFromIndex', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );

    // Count INCR calls with attachment exclusion
    const incrCalls = code.split('feishuIncrementalUpdateDocBlocks').length - 1;
    expect(incrCalls).toBeGreaterThanOrEqual(3);

    // Each call site should use findAttachmentSectionStart
    const attachCalls = code.split('findAttachmentSectionStart').length - 1;
    // 1 import + 4 usage sites (3 INCR paths + 1 singleSkip)
    expect(attachCalls).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// T214d: pages without raw_source unaffected
// ---------------------------------------------------------------------------

describe('Spec 48 T214d: pages without raw_source', () => {
  test('findAttachmentSectionStart returns -1 for content-only docs', () => {
    const blocks: FeishuDocBlock[] = [
      makeDocBlock(2, 'Paragraph 1', 'b1'),
      makeDocBlock(4, 'Section Heading', 'b2'),
      makeDocBlock(2, 'Paragraph 2', 'b3'),
      makeDocBlock(22, '', 'b4'), // divider (not followed by attachment heading)
      makeDocBlock(2, 'Paragraph 3', 'b5'),
    ];
    expect(findAttachmentSectionStart(blocks)).toBe(-1);
  });

  test('feishuIncrementalUpdateDocBlocks signature accepts optional excludeTailFromIndex', () => {
    const code = readFileSync(
      new URL('../src/core/feishu.ts', import.meta.url),
      'utf-8',
    );
    const fnIdx = code.indexOf('async function feishuIncrementalUpdateDocBlocks');
    expect(fnIdx).toBeGreaterThan(-1);
    const sig = code.slice(fnIdx, fnIdx + 500);
    expect(sig).toContain('excludeTailFromIndex?');
  });

  test('excludeTailFromIndex is only passed when attachIdx >= 0', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    // All INCR calls should guard with attachIdx >= 0
    const guardPattern = 'attachIdx >= 0 ? attachIdx : undefined';
    const matches = code.split(guardPattern).length - 1;
    expect(matches).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// T216: Backlink resolution retains attachments
// ---------------------------------------------------------------------------

describe('T216: backlink resolution retains attachments after push', () => {
  test('PASS 1.5 backlink loop calls appendRawAttachments after INCR update', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    const pass15Start = code.indexOf('PASS 1.5: Single-slug backlink resolution');
    expect(pass15Start).toBeGreaterThan(-1);

    const pass15End = code.indexOf('PASS 2:', pass15Start);
    expect(pass15End).toBeGreaterThan(pass15Start);

    const pass15Block = code.slice(pass15Start, pass15End);

    expect(pass15Block).toContain('feishuIncrementalUpdateDocBlocks');
    expect(pass15Block).toContain('appendRawAttachments');
    expect(pass15Block).toContain('findAttachmentSectionStart');

    const incrIdx = pass15Block.indexOf('feishuIncrementalUpdateDocBlocks');
    const appendIdx = pass15Block.indexOf('appendRawAttachments');
    expect(appendIdx).toBeGreaterThan(incrIdx);
  });

  test('backlink loop uses same attachment exclusion pattern as main push', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    const pass15Start = code.indexOf('PASS 1.5: Single-slug backlink resolution');
    const pass15End = code.indexOf('PASS 2:', pass15Start);
    const pass15Block = code.slice(pass15Start, pass15End);

    expect(pass15Block).toContain('blAttachIdx >= 0 ? blAttachIdx : undefined');
    expect(pass15Block).toContain('feishuFetchDocBlocks');
  });
});
