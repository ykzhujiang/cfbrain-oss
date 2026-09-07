/**
 * Spec 37: Incremental document update — preserve comments on push.
 *
 * Tests cover:
 * - T172: feishuFetchDocBlocks (export existence, API call structure)
 * - T173: diff engine (extractBlockText, lcsBlocks, diffDocBlocks)
 * - T174: incremental update wiring (feishuIncrementalUpdateDocBlocks in push flow)
 * - T175: fallback >80% threshold
 * - T176: edge cases (empty doc, identical doc, single block change)
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import {
  extractBlockText,
  lcsBlocks,
  diffDocBlocks,
  type FeishuDocBlock,
  type FeishuBlock,
} from '../src/core/feishu.ts';

// ---------------------------------------------------------------------------
// T172: feishuFetchDocBlocks — export existence and API structure
// ---------------------------------------------------------------------------

describe('Spec 37 T172: feishuFetchDocBlocks', () => {
  test('feishuFetchDocBlocks is exported as async function', async () => {
    const mod = await import('../src/core/feishu.ts');
    expect(typeof mod.feishuFetchDocBlocks).toBe('function');
  });

  test('feishuFetchDocBlocks calls correct API endpoint', () => {
    const code = readFileSync(
      new URL('../src/core/feishu.ts', import.meta.url),
      'utf-8',
    );
    // Should call GET children with document_revision_id: -1
    const fnStart = code.indexOf('async function feishuFetchDocBlocks');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = code.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('/open-apis/docx/v1/documents/');
    expect(fnBody).toContain('/children');
    expect(fnBody).toContain('document_revision_id');
  });

  test('FeishuDocBlock interface includes block_id', async () => {
    // Verify the interface is usable
    const block: FeishuDocBlock = {
      block_id: 'test123',
      block_type: 2,
      text: { elements: [{ text_run: { content: 'hello' } }] },
    };
    expect(block.block_id).toBe('test123');
    expect(block.block_type).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T173: Diff engine — extractBlockText, lcsBlocks, diffDocBlocks
// ---------------------------------------------------------------------------

describe('Spec 37 T173: extractBlockText', () => {
  test('extracts text from TEXT block', () => {
    const block: FeishuBlock = {
      block_type: 2,
      text: { elements: [{ text_run: { content: 'Hello world' } }] },
    };
    expect(extractBlockText(block)).toBe('2:Hello world');
  });

  test('extracts text from heading block', () => {
    const block: FeishuBlock = {
      block_type: 3,
      heading1: { elements: [{ text_run: { content: 'Title' } }] },
    };
    expect(extractBlockText(block)).toBe('3:Title');
  });

  test('extracts text from bullet block', () => {
    const block: FeishuBlock = {
      block_type: 12,
      bullet: { elements: [{ text_run: { content: 'Item' } }] },
    };
    expect(extractBlockText(block)).toBe('12:Item');
  });

  test('extracts text from code block', () => {
    const block: FeishuBlock = {
      block_type: 14,
      code: { elements: [{ text_run: { content: 'const x = 1;' } }] },
    };
    expect(extractBlockText(block)).toBe('14:const x = 1;');
  });

  test('returns sentinel for divider', () => {
    const block: FeishuBlock = {
      block_type: 22,
      divider: {},
    };
    expect(extractBlockText(block)).toBe('\x00DIVIDER');
  });

  test('concatenates multiple text_run elements', () => {
    const block: FeishuBlock = {
      block_type: 2,
      text: {
        elements: [
          { text_run: { content: 'Hello ' } },
          { text_run: { content: 'world' } },
        ],
      },
    };
    expect(extractBlockText(block)).toBe('2:Hello world');
  });

  test('differentiates by block_type', () => {
    const text: FeishuBlock = {
      block_type: 2,
      text: { elements: [{ text_run: { content: 'Same text' } }] },
    };
    const heading: FeishuBlock = {
      block_type: 3,
      heading1: { elements: [{ text_run: { content: 'Same text' } }] },
    };
    expect(extractBlockText(text)).not.toBe(extractBlockText(heading));
  });

  test('works with FeishuDocBlock (API response format)', () => {
    const block: FeishuDocBlock = {
      block_id: 'blk_123',
      block_type: 2,
      text: { elements: [{ text_run: { content: 'API block' } }] },
    };
    expect(extractBlockText(block)).toBe('2:API block');
  });
});

describe('Spec 37 T173: lcsBlocks', () => {
  test('empty arrays return empty LCS', () => {
    expect(lcsBlocks([], ['a'])).toEqual([]);
    expect(lcsBlocks(['a'], [])).toEqual([]);
    expect(lcsBlocks([], [])).toEqual([]);
  });

  test('identical arrays return full match', () => {
    const result = lcsBlocks(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(result).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  test('completely different arrays return empty', () => {
    const result = lcsBlocks(['a', 'b', 'c'], ['x', 'y', 'z']);
    expect(result).toEqual([]);
  });

  test('finds common subsequence with insertions', () => {
    // old: A B C, new: A X B C
    const result = lcsBlocks(['A', 'B', 'C'], ['A', 'X', 'B', 'C']);
    expect(result).toEqual([[0, 0], [1, 2], [2, 3]]);
  });

  test('finds common subsequence with deletions', () => {
    // old: A B C D, new: A C D
    const result = lcsBlocks(['A', 'B', 'C', 'D'], ['A', 'C', 'D']);
    expect(result).toEqual([[0, 0], [2, 1], [3, 2]]);
  });

  test('finds common subsequence with mixed changes', () => {
    // old: A B C D E, new: A F B D G E
    const result = lcsBlocks(
      ['A', 'B', 'C', 'D', 'E'],
      ['A', 'F', 'B', 'D', 'G', 'E'],
    );
    expect(result).toEqual([[0, 0], [1, 2], [3, 3], [4, 5]]);
  });
});

describe('Spec 37 T173: diffDocBlocks', () => {
  function makeOldBlock(type: number, text: string, id: string): FeishuDocBlock {
    const key = type === 2 ? 'text' : type === 3 ? 'heading1' : type === 12 ? 'bullet' : 'text';
    return {
      block_id: id,
      block_type: type,
      [key]: { elements: [{ text_run: { content: text } }] },
    };
  }

  function makeNewBlock(type: number, text: string): FeishuBlock {
    const key = type === 2 ? 'text' : type === 3 ? 'heading1' : type === 12 ? 'bullet' : 'text';
    return {
      block_type: type,
      [key]: { elements: [{ text_run: { content: text } }] },
    };
  }

  test('identical blocks: zero change ratio, no gaps', () => {
    const old = [
      makeOldBlock(2, 'Hello', 'b1'),
      makeOldBlock(2, 'World', 'b2'),
    ];
    const newB = [
      makeNewBlock(2, 'Hello'),
      makeNewBlock(2, 'World'),
    ];
    const result = diffDocBlocks(old, newB);
    expect(result.changeRatio).toBe(0);
    expect(result.kept).toBe(2);
    expect(result.gaps).toHaveLength(0);
  });

  test('one block modified: partial change', () => {
    const old = [
      makeOldBlock(2, 'Line A', 'b1'),
      makeOldBlock(2, 'Line B', 'b2'),
      makeOldBlock(2, 'Line C', 'b3'),
    ];
    const newB = [
      makeNewBlock(2, 'Line A'),
      makeNewBlock(2, 'Line B modified'),
      makeNewBlock(2, 'Line C'),
    ];
    const result = diffDocBlocks(old, newB);
    expect(result.kept).toBe(2); // A and C kept
    expect(result.changeRatio).toBeGreaterThan(0);
    expect(result.changeRatio).toBeLessThanOrEqual(0.5);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  test('block added: gap with insertBlocks', () => {
    const old = [
      makeOldBlock(2, 'A', 'b1'),
      makeOldBlock(2, 'B', 'b2'),
    ];
    const newB = [
      makeNewBlock(2, 'A'),
      makeNewBlock(2, 'NEW'),
      makeNewBlock(2, 'B'),
    ];
    const result = diffDocBlocks(old, newB);
    expect(result.kept).toBe(2);
    // Should have a gap with insertBlocks containing 'NEW'
    const insertGap = result.gaps.find(g => g.insertBlocks.length > 0);
    expect(insertGap).toBeDefined();
    expect(insertGap!.insertBlocks).toHaveLength(1);
  });

  test('block removed: gap with deleteStart < deleteEnd', () => {
    const old = [
      makeOldBlock(2, 'A', 'b1'),
      makeOldBlock(2, 'REMOVED', 'b2'),
      makeOldBlock(2, 'B', 'b3'),
    ];
    const newB = [
      makeNewBlock(2, 'A'),
      makeNewBlock(2, 'B'),
    ];
    const result = diffDocBlocks(old, newB);
    expect(result.kept).toBe(2);
    const deleteGap = result.gaps.find(g => g.deleteEnd > g.deleteStart);
    expect(deleteGap).toBeDefined();
    expect(deleteGap!.deleteEnd - deleteGap!.deleteStart).toBe(1);
  });

  test('completely different: high change ratio', () => {
    const old = [
      makeOldBlock(2, 'Old1', 'b1'),
      makeOldBlock(2, 'Old2', 'b2'),
      makeOldBlock(2, 'Old3', 'b3'),
      makeOldBlock(2, 'Old4', 'b4'),
      makeOldBlock(2, 'Old5', 'b5'),
    ];
    const newB = [
      makeNewBlock(2, 'New1'),
      makeNewBlock(2, 'New2'),
      makeNewBlock(2, 'New3'),
      makeNewBlock(2, 'New4'),
      makeNewBlock(2, 'New5'),
    ];
    const result = diffDocBlocks(old, newB);
    expect(result.changeRatio).toBe(1);
    expect(result.kept).toBe(0);
  });

  test('empty old doc: all blocks are new', () => {
    const newB = [
      makeNewBlock(2, 'A'),
      makeNewBlock(2, 'B'),
    ];
    const result = diffDocBlocks([], newB);
    expect(result.changeRatio).toBe(1);
    expect(result.kept).toBe(0);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].insertBlocks).toHaveLength(2);
  });

  test('empty new doc: all blocks removed', () => {
    const old = [
      makeOldBlock(2, 'A', 'b1'),
      makeOldBlock(2, 'B', 'b2'),
    ];
    const result = diffDocBlocks(old, []);
    expect(result.changeRatio).toBe(1);
    expect(result.kept).toBe(0);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].deleteEnd - result.gaps[0].deleteStart).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T174: Incremental update wiring in push flow
// ---------------------------------------------------------------------------

describe('Spec 37 T174: Incremental update in push flow', () => {
  test('feishuIncrementalUpdateDocBlocks is exported', async () => {
    const mod = await import('../src/core/feishu.ts');
    expect(typeof mod.feishuIncrementalUpdateDocBlocks).toBe('function');
  });

  test('push flow uses feishuIncrementalUpdateDocBlocks for content writes', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    expect(code).toContain('feishuIncrementalUpdateDocBlocks');
    // Should import from feishu.ts
    expect(code).toContain("feishuIncrementalUpdateDocBlocks,");
  });

  test('single-slug push uses incremental update', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    // Find the single-slug content write section
    const singleSlugWriteIdx = code.indexOf('e. For single-slug mode (Spec 12 R2)');
    expect(singleSlugWriteIdx).toBeGreaterThan(-1);
    const singleSlugSection = code.slice(singleSlugWriteIdx, singleSlugWriteIdx + 2500);
    expect(singleSlugSection).toContain('feishuIncrementalUpdateDocBlocks');
  });

  test('pass 2 (multi-slug) uses incremental update', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    const pass2Idx = code.indexOf('PASS 2');
    expect(pass2Idx).toBeGreaterThan(-1);
    const pass2Section = code.slice(pass2Idx, pass2Idx + 3000);
    expect(pass2Section).toContain('feishuIncrementalUpdateDocBlocks');
  });

  test('recovery path still uses full feishuUpdateDocBlocks', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    // Recovery (after 404) should still use full rewrite since the node is freshly created
    const recoverIdx = code.indexOf('Feishu node lost, recreating');
    expect(recoverIdx).toBeGreaterThan(-1);
    const recoverSection = code.slice(recoverIdx, recoverIdx + 800);
    expect(recoverSection).toContain('feishuUpdateDocBlocks');
  });

  test('changelog push still uses full feishuUpdateDocBlocks', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    const changelogIdx = code.indexOf('pushChangelogToFeishu');
    expect(changelogIdx).toBeGreaterThan(-1);
    // Find the function definition, not just a call
    const fnDefIdx = code.indexOf('async function pushChangelogToFeishu');
    expect(fnDefIdx).toBeGreaterThan(-1);
    const fnBody = code.slice(fnDefIdx, fnDefIdx + 2000);
    expect(fnBody).toContain('feishuUpdateDocBlocks');
    // Changelog should NOT use incremental (no user comments to preserve)
    expect(fnBody).not.toContain('feishuIncrementalUpdateDocBlocks');
  });
});

// ---------------------------------------------------------------------------
// T175: Fallback — >80% changed triggers full rewrite
// ---------------------------------------------------------------------------

describe('Spec 37 T175: Fallback threshold', () => {
  test('feishuIncrementalUpdateDocBlocks has 0.8 threshold', () => {
    const code = readFileSync(
      new URL('../src/core/feishu.ts', import.meta.url),
      'utf-8',
    );
    const fnIdx = code.indexOf('async function feishuIncrementalUpdateDocBlocks');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = code.slice(fnIdx, fnIdx + 2000);
    expect(fnBody).toContain('0.8');
    expect(fnBody).toContain('feishuUpdateDocBlocks');
    expect(fnBody).toContain('falling back to full rewrite');
  });

  test('diffDocBlocks returns changeRatio > 0.8 for mostly changed doc', () => {
    function makeOld(text: string, id: string): FeishuDocBlock {
      return { block_id: id, block_type: 2, text: { elements: [{ text_run: { content: text } }] } };
    }
    function makeNew(text: string): FeishuBlock {
      return { block_type: 2, text: { elements: [{ text_run: { content: text } }] } };
    }

    // 10 blocks, 9 different = 90% changed
    const old = Array.from({ length: 10 }, (_, i) => makeOld(`Old${i}`, `b${i}`));
    const newB = [
      makeNew('Old0'), // only one kept
      ...Array.from({ length: 9 }, (_, i) => makeNew(`New${i}`)),
    ];
    const result = diffDocBlocks(old, newB);
    expect(result.changeRatio).toBeGreaterThan(0.8);
  });

  test('incremental update error fallback uses full rewrite', () => {
    const code = readFileSync(
      new URL('../src/core/feishu.ts', import.meta.url),
      'utf-8',
    );
    const fnIdx = code.indexOf('async function feishuIncrementalUpdateDocBlocks');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = code.slice(fnIdx, fnIdx + 4000);
    // Should catch errors and fall back
    expect(fnBody).toContain('catch');
    expect(fnBody).toContain('incremental update failed');
    expect(fnBody).toContain('feishuUpdateDocBlocks');
  });
});

// ---------------------------------------------------------------------------
// T176: Edge cases
// ---------------------------------------------------------------------------

describe('Spec 37 T176: Edge cases', () => {
  test('diffDocBlocks handles single block unchanged', () => {
    const old: FeishuDocBlock[] = [{
      block_id: 'b1', block_type: 2,
      text: { elements: [{ text_run: { content: 'Only line' } }] },
    }];
    const newB: FeishuBlock[] = [{
      block_type: 2,
      text: { elements: [{ text_run: { content: 'Only line' } }] },
    }];
    const result = diffDocBlocks(old, newB);
    expect(result.changeRatio).toBe(0);
    expect(result.kept).toBe(1);
    expect(result.gaps).toHaveLength(0);
  });

  test('diffDocBlocks handles divider blocks', () => {
    const old: FeishuDocBlock[] = [
      { block_id: 'b1', block_type: 22, divider: {} },
      { block_id: 'b2', block_type: 2, text: { elements: [{ text_run: { content: 'After' } }] } },
    ];
    const newB: FeishuBlock[] = [
      { block_type: 22, divider: {} },
      { block_type: 2, text: { elements: [{ text_run: { content: 'After' } }] } },
    ];
    const result = diffDocBlocks(old, newB);
    expect(result.changeRatio).toBe(0);
    expect(result.kept).toBe(2);
  });

  test('incremental update processes gaps right-to-left', () => {
    const code = readFileSync(
      new URL('../src/core/feishu.ts', import.meta.url),
      'utf-8',
    );
    const fnIdx = code.indexOf('async function feishuIncrementalUpdateDocBlocks');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = code.slice(fnIdx, fnIdx + 3000);
    // Should process from end to start (gap index goes from length-1 down to 0)
    expect(fnBody).toContain('diff.gaps.length - 1');
    expect(fnBody).toContain('g >= 0');
    expect(fnBody).toContain('g--');
  });

  test('incremental update returns stats object', () => {
    const code = readFileSync(
      new URL('../src/core/feishu.ts', import.meta.url),
      'utf-8',
    );
    const fnIdx = code.indexOf('async function feishuIncrementalUpdateDocBlocks');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = code.slice(fnIdx, fnIdx + 3000);
    expect(fnBody).toContain('incremental:');
    expect(fnBody).toContain('kept:');
    expect(fnBody).toContain('deleted:');
    expect(fnBody).toContain('inserted:');
  });

  test('content hash skip still works (not broken by incremental)', () => {
    const code = readFileSync(
      new URL('../src/commands/feishu.ts', import.meta.url),
      'utf-8',
    );
    // In Pass 2, hash check should be before the incremental update call
    const pass2Idx = code.indexOf('PASS 2');
    expect(pass2Idx).toBeGreaterThan(-1);
    const pass2Code = code.slice(pass2Idx);
    const hashCheckIdx = pass2Code.indexOf('storedHash === page.content_hash');
    const incrementalIdx = pass2Code.indexOf('feishuIncrementalUpdateDocBlocks');
    expect(hashCheckIdx).toBeGreaterThan(-1);
    expect(incrementalIdx).toBeGreaterThan(-1);
    expect(hashCheckIdx).toBeLessThan(incrementalIdx);
  });
});
