import { describe, test, expect } from 'bun:test';
import {
  isLarkCliAvailable,
  convertWikiLinks,
  serializeForFeishu,
  LarkCliError,
  parseInlineElements,
  convertMarkdownToBlocks,
  type FeishuTextElement,
  type FeishuBlock,
} from '../src/core/feishu.ts';

describe('isLarkCliAvailable', () => {
  test('returns a boolean', async () => {
    const result = await isLarkCliAvailable();
    expect(typeof result).toBe('boolean');
  });
});

describe('convertWikiLinks', () => {
  test('converts known wiki links to Feishu URLs', () => {
    const map = new Map([['john-doe', 'abc123']]);
    const result = convertWikiLinks('See [[john-doe]] for details', map);
    expect(result).toBe('See [john-doe](https://feishu.cn/docx/abc123) for details');
  });

  test('marks unknown links with [?]', () => {
    const map = new Map<string, string>();
    const result = convertWikiLinks('See [[unknown-person]] here', map);
    expect(result).toBe('See [[unknown-person]][?] here');
  });

  test('handles multiple links in same line', () => {
    const map = new Map([['alice', 'tok1'], ['bob', 'tok2']]);
    const result = convertWikiLinks('[[alice]] and [[bob]]', map);
    expect(result).toBe('[alice](https://feishu.cn/docx/tok1) and [bob](https://feishu.cn/docx/tok2)');
  });

  test('handles mix of known and unknown links', () => {
    const map = new Map([['alice', 'tok1']]);
    const result = convertWikiLinks('[[alice]] and [[unknown]]', map);
    expect(result).toBe('[alice](https://feishu.cn/docx/tok1) and [[unknown]][?]');
  });

  test('returns unchanged text when no wiki links', () => {
    const map = new Map<string, string>();
    const result = convertWikiLinks('No links here', map);
    expect(result).toBe('No links here');
  });

  test('handles empty string', () => {
    const map = new Map<string, string>();
    expect(convertWikiLinks('', map)).toBe('');
  });
});

describe('LarkCliError', () => {
  test('constructs with all fields', () => {
    const err = new LarkCliError('test error', 1, 'stderr output', ['wiki', 'list']);
    expect(err.message).toBe('test error');
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toBe('stderr output');
    expect(err.args).toEqual(['wiki', 'list']);
    expect(err.name).toBe('LarkCliError');
    expect(err instanceof Error).toBe(true);
  });

  test('handles null exit code', () => {
    const err = new LarkCliError('killed', null, '', []);
    expect(err.exitCode).toBeNull();
  });
});

describe('feishu module exports', () => {
  test('exports all expected functions including feishuMoveNode and serializeForFeishu', async () => {
    const mod = await import('../src/core/feishu.ts');
    expect(typeof mod.isLarkCliAvailable).toBe('function');
    expect(typeof mod.feishuCreateNode).toBe('function');
    expect(typeof mod.feishuListNodes).toBe('function');
    expect(typeof mod.feishuUpdateDoc).toBe('function');
    expect(typeof mod.feishuFetchDoc).toBe('function');
    expect(typeof mod.feishuListComments).toBe('function');
    expect(typeof mod.feishuReplyComment).toBe('function');
    expect(typeof mod.feishuResolveComment).toBe('function');
    expect(typeof mod.convertWikiLinks).toBe('function');
    expect(typeof mod.runLarkCli).toBe('function');
    // Spec 06: feishuMoveNode for trash directory support
    expect(typeof mod.feishuMoveNode).toBe('function');
    // Spec 07: serializeForFeishu (no frontmatter)
    expect(typeof mod.serializeForFeishu).toBe('function');
    
    // Spec 11: block API functions
    expect(typeof mod.parseInlineElements).toBe('function');
    expect(typeof mod.convertMarkdownToBlocks).toBe('function');
    expect(typeof mod.feishuUpdateDocBlocks).toBe('function');
    // Spec 38: document title update
    expect(typeof mod.feishuUpdateDocTitle).toBe('function');
  });
});

describe('feishu commands module exports', () => {
  test('exports runFeishu entry point', async () => {
    const mod = await import('../src/commands/feishu.ts');
    expect(typeof mod.runFeishu).toBe('function');
  });
});

describe('FeishuConfig type support', () => {
  test('config interface includes trash_node_token and root_node_tokens', async () => {
    // Verify the FeishuConfig type accepts these fields at runtime
    const testConfig = {
      enabled: true,
      space_id: 'test-space',
      auto_push: false,
      type_labels: { person: '人物' },
      root_node_tokens: { person: 'node-token-123' },
      trash_node_token: 'trash-token-456',
    } satisfies import('../src/core/config.ts').FeishuConfig;
    expect(testConfig.trash_node_token).toBe('trash-token-456');
    expect(testConfig.root_node_tokens?.person).toBe('node-token-123');
  });
});

// ---------------------------------------------------------------------------
// Spec 06 push logic tests (unit-testable without lark-cli)
// These test the logic paths by verifying the code structure and types
// ---------------------------------------------------------------------------

describe('Spec 06: Push Idempotency + Trash', () => {
  test('R1: feishu_sync query includes node_type column', async () => {
    // Verify the push code queries node_type to distinguish origin vs archived
    const { readFileSync } = await import('fs');
    const pushCode = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The SELECT should include node_type
    expect(pushCode).toContain('node_type');
    expect(pushCode).toContain("existingNodeType === 'archived'");
  });

  test('R2: transaction safety — moves failed new nodes to trash', async () => {
    const { readFileSync } = await import('fs');
    const pushCode = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Should have ensureTrashNode + feishuMoveNode for rollback
    expect(pushCode).toContain('ensureTrashNode');
    expect(pushCode).toContain('feishuMoveNode');
    // Should check isNewNode before deciding to rollback
    expect(pushCode).toContain('isNewNode');
  });

  test('R3: feishu init creates trash directory node', async () => {
    const { readFileSync } = await import('fs');
    const initCode = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(initCode).toContain('🗑️ 废弃');
    expect(initCode).toContain('trash_node_token');
  });

  test('R4: cleanup flow archives stale feishu_sync records', async () => {
    const { readFileSync } = await import('fs');
    const pushCode = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(pushCode).toContain('runCleanupFlow');
    expect(pushCode).toContain("node_type = 'archived'");
    // Cleanup should diff brain pages vs feishu_sync
    expect(pushCode).toContain('LEFT JOIN pages p ON p.slug = fs.slug');
    expect(pushCode).toContain('p.slug IS NULL');
  });

  test('R5: auto-recovery recreates node on 404', async () => {
    const { readFileSync } = await import('fs');
    const pushCode = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Should detect 404 errors
    expect(pushCode).toContain("is404");
    expect(pushCode).toContain("'404'");
    expect(pushCode).toContain("'not found'");
    // Should recreate on 404
    expect(pushCode).toContain('RECOVER');
  });

  test('R6: feishuMoveNode function exists with correct API path', async () => {
    const { readFileSync } = await import('fs');
    const feishuCode = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    expect(feishuCode).toContain('feishuMoveNode');
    expect(feishuCode).toContain('/open-apis/wiki/v2/spaces/');
    expect(feishuCode).toContain('/move');
    expect(feishuCode).toContain('target_parent_token');
  });

  test('R7: --cleanup flag is supported', async () => {
    const { readFileSync } = await import('fs');
    const pushCode = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(pushCode).toContain("'--cleanup'");
    expect(pushCode).toContain('cleanupOnly');
  });

  test('help text documents --cleanup and --all flags', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('push --all');
    expect(code).toContain('push --cleanup');
  });
});

// ---------------------------------------------------------------------------
// Spec 07: serializeForFeishu (no frontmatter)
// ---------------------------------------------------------------------------

describe('serializeForFeishu', () => {
  test('outputs compiled_truth without frontmatter', () => {
    const result = serializeForFeishu('## Summary\n- Key insight');
    expect(result).toBe('## Summary\n- Key insight');
    // Must NOT contain YAML frontmatter markers
    expect(result).not.toContain('types:');
    expect(result).not.toContain('title:');
    expect(result).not.toContain('tags:');
  });

  test('returns compiled_truth as-is', () => {
    const result = serializeForFeishu('## Main content');
    expect(result).toBe('## Main content');
  });

  test('handles empty compiled_truth', () => {
    const result = serializeForFeishu('');
    expect(result).toBe('');
  });

  test('preserves executive summary blockquote format', () => {
    const truth = '> Executive summary of the person.\n\n## Background\n- Detail';
    const result = serializeForFeishu(truth);
    expect(result).toContain('> Executive summary');
    expect(result).toContain('## Background');
  });
});

// ---------------------------------------------------------------------------
// Spec 07: Duplicate trash directory prevention
// ---------------------------------------------------------------------------

describe('Spec 07: Trash directory dedup', () => {
  test('ensureTrashNode checks existing nodes via feishuListNodes', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // ensureTrashNode should call feishuListNodes before creating
    expect(code).toContain('feishuListNodes');
    // Should search for existing trash title
    expect(code).toMatch(/nodes\.find.*🗑️ 废弃/s);
  });

  test('feishu init checks for existing trash before creating', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The init code should also check existing nodes for trash
    expect(code).toContain('Reusing existing "🗑️ 废弃"');
  });

  test('push does NOT use serializeMarkdown (no frontmatter leak)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Should NOT import or use serializeMarkdown
    expect(code).not.toContain('serializeMarkdown');
    // Should use serializeForFeishu instead
    expect(code).toContain('serializeForFeishu');
  });
});

// ---------------------------------------------------------------------------
// Spec 12: Two-pass push for complete wiki-links
// ---------------------------------------------------------------------------

describe('Spec 12: Two-pass push', () => {
  test('multi-page push has Pass 1 (node creation) and Pass 2 (content write)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('Pass 1');
    expect(code).toContain('Pass 2');
  });

  test('Pass 1 upserts feishu_sync before content write for multi-page', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // feishu_sync upsert happens in Pass 1, before Pass 2 content write
    const pass1Idx = code.indexOf('PASS 1');
    const pass2Idx = code.indexOf('PASS 2');
    expect(pass1Idx).toBeGreaterThan(-1);
    expect(pass2Idx).toBeGreaterThan(pass1Idx);
    // The upsert in Pass 1 should be between Pass 1 and Pass 2
    const betweenPasses = code.slice(pass1Idx, pass2Idx);
    expect(betweenPasses).toContain('INSERT INTO feishu_sync');
  });

  test('Pass 2 rebuilds feishuSyncMap from DB for complete resolution', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const pass2Idx = code.indexOf('PASS 2');
    const afterPass2 = code.slice(pass2Idx);
    // Pass 2 should re-query feishu_sync to get complete map
    expect(afterPass2).toContain('feishuSyncMap.clear()');
    expect(afterPass2).toContain('freshSyncRows');
  });

  test('single-slug push does NOT use two-pass (Spec 12 R2)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Single-slug mode writes content immediately in Pass 1
    expect(code).toContain('single-pass');
    expect(code).toContain('singleSlug');
  });

  test('nodeInfo map tracks pass 1 results for pass 2', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('nodeInfo');
    expect(code).toContain('nodeInfo.set(slug');
    expect(code).toContain('nodeInfo.get(slug)');
  });
});

// ---------------------------------------------------------------------------
// Spec 11: parseInlineElements — inline markdown → Feishu text_run elements
// ---------------------------------------------------------------------------

describe('Spec 11: parseInlineElements', () => {
  const emptyMap = new Map<string, string>();

  test('plain text → single text_run', () => {
    const elements = parseInlineElements('Hello world', emptyMap);
    expect(elements).toHaveLength(1);
    expect(elements[0].text_run.content).toBe('Hello world');
    expect(elements[0].text_run.text_element_style).toEqual({});
  });

  test('[[wiki-link]] resolved → text_run with link', () => {
    const map = new Map([['anthropic', 'obj123']]);
    const elements = parseInlineElements('See [[anthropic]] here', map);
    expect(elements).toHaveLength(3);
    // "See "
    expect(elements[0].text_run.content).toBe('See ');
    // "anthropic" with hyperlink
    expect(elements[1].text_run.content).toBe('anthropic');
    expect(elements[1].text_run.text_element_style?.link?.url).toBe('https://feishu.cn/docx/obj123');
    // " here"
    expect(elements[2].text_run.content).toBe(' here');
  });

  test('[[wiki-link]] unresolved → plain text with [?] marker (Spec 11 R4)', () => {
    const elements = parseInlineElements('See [[missing-page]] here', emptyMap);
    expect(elements).toHaveLength(3);
    expect(elements[1].text_run.content).toBe('missing-page[?]');
    expect(elements[1].text_run.text_element_style).toEqual({});
  });

  test('[text](url) markdown link → text_run with link', () => {
    const elements = parseInlineElements('Visit [Google](https://google.com) now', emptyMap);
    expect(elements).toHaveLength(3);
    expect(elements[1].text_run.content).toBe('Google');
    expect(elements[1].text_run.text_element_style?.link?.url).toBe('https://google.com');
  });

  test('**bold** → text_run with bold style', () => {
    const elements = parseInlineElements('This is **important** text', emptyMap);
    expect(elements).toHaveLength(3);
    expect(elements[1].text_run.content).toBe('important');
    expect(elements[1].text_run.text_element_style?.bold).toBe(true);
  });

  test('*italic* → text_run with italic style', () => {
    const elements = parseInlineElements('This is *emphasis* text', emptyMap);
    expect(elements).toHaveLength(3);
    expect(elements[1].text_run.content).toBe('emphasis');
    expect(elements[1].text_run.text_element_style?.italic).toBe(true);
  });

  test('`code` → text_run with inline_code style', () => {
    const elements = parseInlineElements('Use `const x` here', emptyMap);
    expect(elements).toHaveLength(3);
    expect(elements[1].text_run.content).toBe('const x');
    expect(elements[1].text_run.text_element_style?.inline_code).toBe(true);
  });

  test('multiple inline formats in one line', () => {
    const map = new Map([['alice', 'tokA']]);
    const elements = parseInlineElements('**Bold** and [[alice]] plus `code`', map);
    // Should have: "Bold"(bold), " and ", "alice"(link), " plus ", "code"(code)
    expect(elements.length).toBeGreaterThanOrEqual(5);
    expect(elements[0].text_run.content).toBe('Bold');
    expect(elements[0].text_run.text_element_style?.bold).toBe(true);
    const linkEl = elements.find(e => e.text_run.text_element_style?.link);
    expect(linkEl).toBeDefined();
    expect(linkEl!.text_run.content).toBe('alice');
    const codeEl = elements.find(e => e.text_run.text_element_style?.inline_code);
    expect(codeEl).toBeDefined();
    expect(codeEl!.text_run.content).toBe('code');
  });

  test('empty string → single space element', () => {
    const elements = parseInlineElements('', emptyMap);
    expect(elements).toHaveLength(1);
    expect(elements[0].text_run.content).toBe(' ');
  });
});

// ---------------------------------------------------------------------------
// Spec 11: convertMarkdownToBlocks — full markdown → Feishu blocks
// ---------------------------------------------------------------------------

describe('Spec 11: convertMarkdownToBlocks', () => {
  const emptyMap = new Map<string, string>();

  test('paragraph → text block (type 2)', () => {
    const blocks = convertMarkdownToBlocks('Hello world', emptyMap);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(2);
    expect((blocks[0].text as any).elements[0].text_run.content).toBe('Hello world');
  });

  test('heading levels 1-6 → heading blocks (types 3-8)', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
    const blocks = convertMarkdownToBlocks(md, emptyMap);
    expect(blocks).toHaveLength(6);
    expect(blocks[0].block_type).toBe(3);
    expect((blocks[0].heading1 as any).elements[0].text_run.content).toBe('H1');
    expect(blocks[1].block_type).toBe(4);
    expect((blocks[1].heading2 as any).elements[0].text_run.content).toBe('H2');
    expect(blocks[2].block_type).toBe(5);
    expect(blocks[3].block_type).toBe(6);
    expect(blocks[4].block_type).toBe(7);
    expect(blocks[5].block_type).toBe(8);
  });

  test('bullet list items → bullet blocks (type 12)', () => {
    const md = '- First item\n- Second item\n* Third item';
    const blocks = convertMarkdownToBlocks(md, emptyMap);
    expect(blocks).toHaveLength(3);
    blocks.forEach(b => expect(b.block_type).toBe(12));
    expect((blocks[0].bullet as any).elements[0].text_run.content).toBe('First item');
  });

  test('ordered list items → ordered blocks (type 13)', () => {
    const md = '1. First\n2. Second\n3. Third';
    const blocks = convertMarkdownToBlocks(md, emptyMap);
    expect(blocks).toHaveLength(3);
    blocks.forEach(b => expect(b.block_type).toBe(13));
  });

  test('code block → code block (type 14)', () => {
    const md = '```\nconst x = 1;\nconst y = 2;\n```';
    const blocks = convertMarkdownToBlocks(md, emptyMap);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(14);
    expect((blocks[0].code as any).elements[0].text_run.content).toBe('const x = 1;\nconst y = 2;');
  });

  test('horizontal rule → divider block (type 22)', () => {
    const md = 'Before\n---\nAfter';
    const blocks = convertMarkdownToBlocks(md, emptyMap);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].block_type).toBe(22);
  });

  test('empty lines are skipped', () => {
    const md = 'Line 1\n\n\nLine 2';
    const blocks = convertMarkdownToBlocks(md, emptyMap);
    expect(blocks).toHaveLength(2);
  });

  test('wiki-links in paragraphs → text_run with hyperlink (Spec 11 R1)', () => {
    const map = new Map([['anthropic', 'obj123']]);
    const md = 'Founded by [[anthropic]] team';
    const blocks = convertMarkdownToBlocks(md, map);
    expect(blocks).toHaveLength(1);
    const elements = (blocks[0].text as any).elements;
    const linkEl = elements.find((e: any) => e.text_run.text_element_style?.link);
    expect(linkEl).toBeDefined();
    expect(linkEl.text_run.content).toBe('anthropic');
    expect(linkEl.text_run.text_element_style.link.url).toBe('https://feishu.cn/docx/obj123');
  });

  test('wiki-links in headings → clickable heading links', () => {
    const map = new Map([['openai', 'tok456']]);
    const md = '## About [[openai]]';
    const blocks = convertMarkdownToBlocks(md, map);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(4); // heading2
    const elements = (blocks[0].heading2 as any).elements;
    const linkEl = elements.find((e: any) => e.text_run.text_element_style?.link);
    expect(linkEl).toBeDefined();
    expect(linkEl.text_run.content).toBe('openai');
  });

  test('wiki-links in bullet lists → clickable list item links', () => {
    const map = new Map([['alice', 'tokA']]);
    const md = '- Contact: [[alice]]';
    const blocks = convertMarkdownToBlocks(md, map);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(12); // bullet
    const elements = (blocks[0].bullet as any).elements;
    const linkEl = elements.find((e: any) => e.text_run.text_element_style?.link);
    expect(linkEl).toBeDefined();
  });

  test('unresolved wiki-links → plain text with [?] (Spec 11 R4)', () => {
    const md = 'See [[unknown-company]] for details';
    const blocks = convertMarkdownToBlocks(md, emptyMap);
    const elements = (blocks[0].text as any).elements;
    const markerEl = elements.find((e: any) => e.text_run.content.includes('[?]'));
    expect(markerEl).toBeDefined();
    expect(markerEl.text_run.content).toBe('unknown-company[?]');
  });

  test('mixed content: headings, paragraphs, lists, links', () => {
    const map = new Map([['alice', 'tokA'], ['bob', 'tokB']]);
    const md = [
      '# Team Overview',
      '',
      'Our team includes **key members**:',
      '',
      '- [[alice]] — Lead engineer',
      '- [[bob]] — Product manager',
      '- [[charlie]] — Designer (not yet on Feishu)',
      '',
      '## Next Steps',
      '1. Review proposals',
      '2. Schedule meetings',
    ].join('\n');
    const blocks = convertMarkdownToBlocks(md, map);

    // heading1 + paragraph + 3 bullets + heading2 + 2 ordered = 8 blocks
    expect(blocks).toHaveLength(8);
    expect(blocks[0].block_type).toBe(3); // heading1
    expect(blocks[1].block_type).toBe(2); // text paragraph
    expect(blocks[2].block_type).toBe(12); // bullet
    expect(blocks[3].block_type).toBe(12); // bullet
    expect(blocks[4].block_type).toBe(12); // bullet
    expect(blocks[5].block_type).toBe(4); // heading2
    expect(blocks[6].block_type).toBe(13); // ordered
    expect(blocks[7].block_type).toBe(13); // ordered

    // Verify alice link is clickable
    const aliceBullet = (blocks[2].bullet as any).elements;
    const aliceLink = aliceBullet.find((e: any) => e.text_run.text_element_style?.link);
    expect(aliceLink).toBeDefined();
    expect(aliceLink.text_run.content).toBe('alice');

    // Verify charlie is unresolved with [?]
    const charlieBullet = (blocks[4].bullet as any).elements;
    const charlieMarker = charlieBullet.find((e: any) => e.text_run.content.includes('[?]'));
    expect(charlieMarker).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Spec 11: Push flow uses block API
// ---------------------------------------------------------------------------

describe('Spec 11: Push uses block API for hyperlinks', () => {
  test('push flow imports and uses convertMarkdownToBlocks', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('convertMarkdownToBlocks');
    expect(code).toContain('feishuUpdateDocBlocks');
  });

  test('push Pass 2 uses block API (not markdown mode) for content write', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const pass2Idx = code.indexOf('PASS 2');
    const afterPass2 = code.slice(pass2Idx);
    // Pass 2 content write should use block API
    expect(afterPass2).toContain('convertMarkdownToBlocks');
    expect(afterPass2).toContain('feishuUpdateDocBlocks');
  });

  test('single-slug push also uses block API', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Find the single-slug section (between "single-pass" comment and "Pass 2")
    const singlePassIdx = code.indexOf('single-pass');
    const pass2Idx = code.indexOf('PASS 2');
    const singleSection = code.slice(singlePassIdx, pass2Idx);
    expect(singleSection).toContain('convertMarkdownToBlocks');
    expect(singleSection).toContain('feishuUpdateDocBlocks');
  });

  test('feishuUpdateDocBlocks uses Feishu DocX block API endpoints', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    // Should use the DocX children API
    expect(code).toContain('/open-apis/docx/v1/documents/');
    expect(code).toContain('/children');
    expect(code).toContain('batch_delete');
  });

  test('data layer unchanged — brain keeps [[slug]] syntax (Spec 11 R2)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // serializeForFeishu returns compiled_truth as-is (no wiki-link conversion in data layer)
    expect(code).toContain('serializeForFeishu(page.compiled_truth, page.title)');
    // Conversion happens at block-creation time, not in the data
    expect(code).toContain('convertMarkdownToBlocks');
  });
});

// ---------------------------------------------------------------------------
// Spec 15: Fix Duplicate Nodes and Stale Sync Records
// ---------------------------------------------------------------------------

describe('Spec 15 R1: delete_page archives Feishu nodes', () => {
  test('delete_page handler calls archiveFeishuNodes', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/operations.ts', import.meta.url), 'utf-8');
    // archiveFeishuNodes must be called in delete_page handler
    expect(code).toContain('archiveFeishuNodes');
  });

  test('archiveFeishuNodes is fire-and-forget (catch block)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/operations.ts', import.meta.url), 'utf-8');
    // The call must be wrapped in .catch() to never break delete_page
    expect(code).toContain('archiveFeishuNodes(ctx.engine, ctx.config, slug).catch');
  });

  test('archiveFeishuNodes queries feishu_sync for non-archived records', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/operations.ts', import.meta.url), 'utf-8');
    // Must query feishu_sync filtering out archived records
    expect(code).toContain("node_type != 'archived'");
  });

  test('archiveFeishuNodes moves nodes to trash via feishuMoveNode', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/operations.ts', import.meta.url), 'utf-8');
    expect(code).toContain('feishuMoveNode');
  });

  test('archiveFeishuNodes marks records as archived after move', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/operations.ts', import.meta.url), 'utf-8');
    expect(code).toContain("SET node_type = 'archived'");
  });

  test('archiveFeishuNodes skips when feishu not configured (no space_id)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/operations.ts', import.meta.url), 'utf-8');
    // Must early return when no space_id
    expect(code).toContain('if (!spaceId) return');
  });

  test('delete_page without feishu_sync records does not error', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/operations.ts', import.meta.url), 'utf-8');
    // archiveFeishuNodes returns early when no rows found
    expect(code).toContain('if (rows.length === 0) return');
  });
});

describe('Spec 15 R2: Pass 1 validates Feishu node existence', () => {
  test('feishuValidateNode is exported from feishu.ts', async () => {
    const mod = await import('../src/core/feishu.ts');
    expect(typeof mod.feishuValidateNode).toBe('function');
  });

  test('feishuValidateNode uses lark-cli api GET wiki node endpoint', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    // Extract the feishuValidateNode function body
    const fnIdx = code.indexOf('feishuValidateNode');
    const fnBody = code.slice(fnIdx, fnIdx + 400);
    expect(fnBody).toContain('/open-apis/wiki/v2/spaces');
    expect(fnBody).toContain('api');
    expect(fnBody).toContain('GET');
  });

  test('Pass 1 calls feishuValidateNode before trusting existing records', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('feishuValidateNode');
  });

  test('Pass 1 deletes stale feishu_sync record when node is invalid', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // After validation fails, stale record should be deleted
    // Find the validation call in the push flow (not imports)
    const pass1Idx = code.indexOf('PASS 1');
    const pass1Code = code.slice(pass1Idx);
    expect(pass1Code).toContain('DELETE FROM feishu_sync');
  });

  test('Pass 1 creates new node when stale record detected', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // After deleting stale record, should create a new node in the same pass
    const pass1Idx = code.indexOf('PASS 1');
    const pass1Code = code.slice(pass1Idx);
    // Spec 22: The stale-record handling path must create a new node via createNodeChecked (duplicate prevention)
    expect(pass1Code).toContain('createNodeChecked');
    expect(pass1Code).toContain('isNewNode');
  });
});

describe('Spec 15 R3: Stale cleanup on every multi-page push', () => {
  test('cleanup runs on all multi-page pushes, not just --all', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Cleanup condition should check !singleSlug, not just forceAll
    expect(code).toContain('!singleSlug && !noCleanup');
  });

  test('--no-cleanup flag is parsed', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain("args.includes('--no-cleanup')");
  });

  test('single-slug push does NOT run cleanup', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The condition !singleSlug means single-slug pushes skip cleanup
    expect(code).toContain('!singleSlug && !noCleanup');
  });

  test('runCleanupFlow archives feishu_sync records with no corresponding pages', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The cleanup flow should LEFT JOIN pages to find orphaned feishu_sync records
    expect(code).toContain('LEFT JOIN pages p ON p.slug = fs.slug');
    expect(code).toContain('WHERE p.slug IS NULL');
  });
});

// ===================================================================
// Spec 17: Fix RECOVER loop + Multi-Type Shortcuts + Root Pinning
// ===================================================================

describe('Spec 17 R1: Content hash skip — avoid unnecessary writes', () => {
  test('Pass 2 builds syncHashMap from content_hash in feishu_sync', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Pass 2 must query content_hash alongside obj_token
    expect(code).toContain('content_hash FROM feishu_sync');
    expect(code).toContain('syncHashMap');
  });

  test('Pass 2 skips content write when hash matches', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Must check storedHash === page.content_hash and skip write
    expect(code).toContain('syncHashMap.get(slug)');
    expect(code).toContain('(unchanged)');
  });

  test('Single-slug mode also checks content hash before write', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Single-slug path must have its own hash check
    expect(code).toContain('storedSingleHash');
    expect(code).toContain('storedSingleHash === page.content_hash');
  });

  test('feishuUpdateDocBlocks batch_delete failure retries with fresh child list (Spec 24 R3)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    // batch_delete step must NOT continue to block creation on failure
    expect(code).toContain('batch_delete failed');
    expect(code).not.toContain('continuing with block creation');
    // Spec 24 R3: retry with re-listed children, no markdown overwrite fallback
    expect(code).toContain('re-listing children and retrying');
    expect(code).toContain('batch_delete failed after retry');
  });

  test('Pass 1 query includes content_hash for single-slug hash check', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The existing-rows query must select content_hash
    expect(code).toContain('content_hash FROM feishu_sync');
  });
});

describe('Spec 17 R2: Multi-type shortcut creation', () => {
  test('feishuCreateNode accepts originNodeToken parameter', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    // Must accept originNodeToken for shortcut creation
    expect(code).toContain('originNodeToken');
    expect(code).toContain('--origin-node-token');
  });

  test('Push loop iterates page.types.slice(1) for shortcuts', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Must iterate secondary types
    expect(code).toContain('page.types');
    expect(code).toContain('.slice(1)');
    expect(code).toContain('secondaryTypes');
  });

  test('feishu_sync upserted with node_type=shortcut for secondary types', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Must record shortcuts in feishu_sync
    expect(code).toContain("'shortcut'");
    expect(code).toContain('secType');
    expect(code).toContain("node_type = 'shortcut'");
  });

  test('Shortcut creation is idempotent (validates before create)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Must check existing shortcuts and validate them before recreating
    expect(code).toContain('existingShortcutsByType');
    expect(code).toContain('feishuValidateNode');
    expect(code).toContain('SHORTCUT');
    expect(code).toContain('(exists)');
  });

  test('Shortcuts skip content write — no feishuUpdateDocBlocks for shortcuts', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Pass 2 only writes content for entries in nodeInfo (origin nodes)
    // Shortcuts are not added to nodeInfo, so they're naturally skipped
    expect(code).toContain('nodeInfo.get(slug)');
    expect(code).toContain('if (!info) continue');
  });
});

describe('Spec 17 R3: Root pinning via pin_to_root frontmatter', () => {
  test('pin_to_root check exists in Push Pass 1', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('pin_to_root');
    expect(code).toContain('PIN-ROOT');
  });

  test('root shortcut created with empty parent token (wiki root)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Spec 22: Creating at root means empty parent token, now via createNodeChecked
    expect(code).toContain("createNodeChecked('', page.title, 'shortcut', nodeToken)");
  });

  test('root shortcut recorded in feishu_sync with parent_type=__root__ (Spec 19 R3)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain("parent_type = '__root__'");
    expect(code).toContain("'shortcut', '__root__'");
    // Must NOT use bare 'root' as parent_type
    expect(code).not.toContain("parent_type = 'root'");
    expect(code).not.toContain("'shortcut', 'root'");
  });

  test('removing pin_to_root archives existing root shortcut', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // When pin_to_root is false/absent and a root shortcut exists, archive it
    expect(code).toContain('UNPIN-ROOT');
    expect(code).toContain('existingRootShortcut');
    expect(code).toContain("node_type = 'archived'");
  });
});

describe('Spec 17 R4: Stale shortcut cleanup on type change', () => {
  test('shortcuts for removed types get archived', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Must compare existing shortcuts against current types and archive removed ones
    expect(code).toContain('expectedShortcutTypes');
    expect(code).toContain('!expectedShortcutTypes.has(parentType)');
    expect(code).toContain('CLEANUP  shortcut');
    expect(code).toContain('type removed');
  });

  test('shortcuts for remaining types are preserved', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Only archive shortcuts NOT in expectedShortcutTypes
    expect(code).toContain('!expectedShortcutTypes.has(parentType)');
    // expectedShortcutTypes is built from page.types.slice(1) so remaining types are kept
    expect(code).toContain('new Set(secondaryTypes)');
  });

  test('root shortcuts are handled separately from type shortcuts', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Root shortcuts skip the type-change cleanup loop (handled by pin_to_root logic)
    expect(code).toContain("parentType === '__root__') continue");
  });

  test('runCleanupFlow archives shortcuts for deleted pages', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // runCleanupFlow uses node_type != 'archived' which catches both origin and shortcut
    expect(code).toContain("fs.node_type != 'archived'");
    expect(code).toContain('LEFT JOIN pages p ON p.slug = fs.slug');
  });
});

// ---------------------------------------------------------------------------
// Spec 18 R1: Shortcut 131001 error recovery
// ---------------------------------------------------------------------------
describe('Spec 18 R1: Shortcut 131001 error recovery', () => {
  test('catch block detects 131001 error code', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Must check for 131001 error code in the catch block
    expect(code).toContain('131001');
    expect(code).toContain('SHORTCUT-RECOVERED');
  });

  test('recovery path calls feishuListNodes to find existing shortcut', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // After 131001, must list nodes to find the existing shortcut
    const idx131001 = code.indexOf("msg.includes('131001')");
    expect(idx131001).toBeGreaterThan(-1);
    const recoveryBlock = code.slice(idx131001, idx131001 + 1500);
    expect(recoveryBlock).toContain('wiki');
    expect(recoveryBlock).toContain('parent_node_token') || expect(recoveryBlock).toContain('space_id');
    expect(recoveryBlock).toContain("'shortcut'");
  });

  test('recovered node_token is upserted into feishu_sync', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const idx131001 = code.indexOf("msg.includes('131001')");
    expect(idx131001).toBeGreaterThan(-1);
    const recoveryBlock = code.slice(idx131001, idx131001 + 1500);
    // Must upsert the recovered node's tokens into feishu_sync
    expect(recoveryBlock).toContain('INSERT INTO feishu_sync');
    expect(recoveryBlock).toContain('node_token');
    expect(recoveryBlock).toContain('obj_token');
  });

  test('non-131001 errors still propagate as SHORTCUT-FAIL', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The else branch for non-131001 errors should still log SHORTCUT-FAIL
    const idx131001 = code.indexOf("msg.includes('131001')");
    expect(idx131001).toBeGreaterThan(-1);
    const catchBlock = code.slice(idx131001 - 200, idx131001 + 6000);
    expect(catchBlock).toContain('SHORTCUT-FAIL');
  });
});

// ---------------------------------------------------------------------------
// Spec 18 R2: CHANGELOG stale exclusion
// ---------------------------------------------------------------------------
describe('Spec 18 R2: CHANGELOG stale exclusion from cleanup', () => {
  test('stale detection SQL excludes synthetic slugs (double-underscore pattern)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The stale detection query must exclude __changelog__ and other synthetic slugs
    expect(code).toContain("slug NOT LIKE '__%__'");
  });

  test('__changelog__ slug is excluded by the pattern', () => {
    // Verify the SQL LIKE pattern '__%__' matches __changelog__
    // In SQL, _ matches any single char, % matches any sequence
    // '__%__' means: at least 1 char + at least 0 chars + at least 2 chars at the end
    // __changelog__ starts with __ and ends with __ — should match
    const slug = '__changelog__';
    // Simulate the SQL LIKE pattern: starts with at least 2 underscores, ends with at least 2 underscores
    const matchesSyntheticPattern = /^__.+__$/.test(slug);
    expect(matchesSyntheticPattern).toBe(true);
  });

  test('real page slugs are NOT excluded by the pattern', () => {
    // Regular slugs should not match the __%__ pattern
    const regularSlugs = ['my-page', 'john-doe', 'project_alpha', 'meeting-notes'];
    for (const slug of regularSlugs) {
      const matchesSyntheticPattern = /^__.+__$/.test(slug);
      expect(matchesSyntheticPattern).toBe(false);
    }
  });

  test('stale detection still works for real deleted pages', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Core stale logic is preserved: LEFT JOIN + p.slug IS NULL
    expect(code).toContain('LEFT JOIN pages p ON p.slug = fs.slug');
    expect(code).toContain('p.slug IS NULL');
    expect(code).toContain("fs.node_type != 'archived'");
  });
});

// ---------------------------------------------------------------------------
// Spec 18: CHANGELOG node persistence across pushes
// ---------------------------------------------------------------------------
describe('Spec 18: CHANGELOG node persistence across multiple pushes', () => {
  test('pushChangelogToFeishu creates feishu_sync record with __changelog__ slug', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // pushChangelogToFeishu must create/update a feishu_sync record for __changelog__
    expect(code).toContain('__changelog__');
    expect(code).toContain('feishu_sync');
  });

  test('cleanup flow will not archive __changelog__ after stale exclusion fix', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Verify the stale detection SQL inside runCleanupFlow has the exclusion
    const funcIdx = code.indexOf('async function runCleanupFlow');
    expect(funcIdx).toBeGreaterThan(-1);
    const funcSection = code.slice(funcIdx, funcIdx + 600);
    expect(funcSection).toContain("NOT LIKE '__%__'");
  });
});

// ---------------------------------------------------------------------------
// Spec 08 T72: Commenter identity extraction
// ---------------------------------------------------------------------------
describe('Spec 08: Commenter identity in feishuListComments', () => {
  test('CommentItem interface includes user_id field', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const commentItemIdx = code.indexOf('interface CommentItem');
    expect(commentItemIdx).toBeGreaterThan(-1);
    const interfaceBlock = code.slice(commentItemIdx, commentItemIdx + 500);
    expect(interfaceBlock).toContain('user_id?:');
  });

  test('feishuListComments returns commenter field', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const funcIdx = code.indexOf('async function feishuListComments');
    expect(funcIdx).toBeGreaterThan(-1);
    const funcBlock = code.slice(funcIdx, funcIdx + 1200);
    expect(funcBlock).toContain('commenter');
    expect(funcBlock).toContain('user_id');
  });
});

// ---------------------------------------------------------------------------
// Spec 11 T74: pushChangelogToFeishu uses block API
// ---------------------------------------------------------------------------
describe('Spec 11: pushChangelogToFeishu uses block API', () => {
  test('pushChangelogToFeishu calls feishuUpdateDocBlocks, not feishuUpdateDoc', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const funcIdx = code.indexOf('async function pushChangelogToFeishu');
    expect(funcIdx).toBeGreaterThan(-1);
    const funcBlock = code.slice(funcIdx, funcIdx + 2000);
    expect(funcBlock).toContain('feishuUpdateDocBlocks');
    expect(funcBlock).toContain('convertMarkdownToBlocks');
    expect(funcBlock).not.toContain('feishuUpdateDoc(');
  });
});

// ---------------------------------------------------------------------------
// Spec 16 T75: MCP server injects triggered_by
// ---------------------------------------------------------------------------
describe('Spec 16: MCP triggered_by injection', () => {
  test('MCP server injects triggered_by: MCP into params', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf-8');
    expect(code).toContain("triggered_by: 'MCP'");
  });

  test('explicit triggered_by from caller overrides MCP default', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf-8');
    // The spread pattern { triggered_by: 'MCP', ...params } means params wins
    expect(code).toContain("triggered_by: 'MCP'");
    expect(code).toContain('...(params');
  });
});

// ---------------------------------------------------------------------------
// Spec 05 T68: CFBrain rebrand — no gbrain in user-visible output
// ---------------------------------------------------------------------------
describe('Spec 05: CFBrain rebrand completeness', () => {
  test('types.ts error class is CFBrainError', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/types.ts', import.meta.url), 'utf-8');
    expect(code).toContain('class CFBrainError');
    expect(code).toContain("this.name = 'CFBrainError'");
    expect(code).not.toContain('class GBrainError');
  });

  test('MCP server name is cfbrain', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf-8');
    expect(code).toContain("name: 'cfbrain'");
    expect(code).not.toContain("name: 'gbrain'");
  });

  test('auth.ts token prefix is cfbrain_', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/auth.ts', import.meta.url), 'utf-8');
    expect(code).toContain("'cfbrain_'");
    expect(code).not.toContain("'gbrain_'");
  });

  test('no user-visible gbrain strings in key command files', async () => {
    const { readFileSync } = await import('fs');
    const filesToCheck = [
      new URL('../src/commands/config.ts', import.meta.url),
      new URL('../src/commands/doctor.ts', import.meta.url),
      new URL('../src/commands/call.ts', import.meta.url),
    ];
    for (const file of filesToCheck) {
      const code = readFileSync(file, 'utf-8');
      // Filter out ~/.gbrain paths and comments
      const lines = code.split('\n').filter(l =>
        !l.includes('.gbrain') && !l.startsWith('//') && !l.startsWith(' *')
      );
      const userVisible = lines.join('\n');
      expect(userVisible).not.toMatch(/['"].*gbrain(?!\.)/i);
    }
  });
});

// ---------------------------------------------------------------------------
// T83: feishuRenameNode wiring
// ---------------------------------------------------------------------------
describe('T78: feishuRenameNode wiring', () => {
  test('feishuRenameNode is imported in commands/feishu.ts', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('feishuRenameNode');
  });

  test('Pass 1 selects title from feishu_sync', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The SELECT query for existing records must include the title column
    expect(code).toContain('title FROM feishu_sync');
  });

  test('title comparison triggers rename', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The push flow must call feishuRenameNode when the title changes
    expect(code).toContain('feishuRenameNode(spaceId');
  });

  test('feishu_sync upsert includes title', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The main origin upsert must include the title column
    expect(code).toContain('content_hash, title)');
  });
});

// ---------------------------------------------------------------------------
// T91: Origin uniqueness index
// ---------------------------------------------------------------------------
describe('T91: Origin uniqueness index', () => {
  test('origin uniqueness index exists in PGLite schema', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/pglite-schema.ts', import.meta.url), 'utf-8');
    expect(code).toContain('idx_feishu_sync_origin_unique');
  });

  test('origin uniqueness index exists in schema.sql', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf-8');
    expect(code).toContain('idx_feishu_sync_origin_unique');
  });

  test('migration 9 cleans duplicate origins', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/migrate.ts', import.meta.url), 'utf-8');
    // Migration 9 must use ROW_NUMBER() to deduplicate origin records
    expect(code).toContain('ROW_NUMBER()');
    expect(code).toContain("node_type = 'origin'");
  });
});

// ---------------------------------------------------------------------------
// Spec 21: Content duplication prevention
// ---------------------------------------------------------------------------
describe('Spec 21: Content duplication prevention', () => {
  test('feishuUpdateDocBlocks accepts fallbackMarkdown parameter', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const funcIdx = code.indexOf('export async function feishuUpdateDocBlocks');
    const funcSig = code.slice(funcIdx, funcIdx + 200);
    expect(funcSig).toContain('fallbackMarkdown');
  });

  test('batch_delete uses document_revision_id=-1 (Spec 24 R2)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const funcIdx = code.indexOf('export async function feishuUpdateDocBlocks');
    const funcBlock = code.slice(funcIdx, funcIdx + 3000);
    // batch_delete must include document_revision_id: -1
    expect(funcBlock).toContain('document_revision_id: -1');
    // Must appear in the batch_delete call, not just the list children call
    const batchDeleteIdx = funcBlock.indexOf('batch_delete');
    const afterBatchDelete = funcBlock.slice(batchDeleteIdx, batchDeleteIdx + 300);
    expect(afterBatchDelete).toContain('document_revision_id: -1');
  });

  test('batch_delete failure does NOT fall back to markdown overwrite (Spec 24 R3)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const funcIdx = code.indexOf('export async function feishuUpdateDocBlocks');
    const funcBlock = code.slice(funcIdx, funcIdx + 3000);
    // The old overwrite fallback must be gone
    expect(funcBlock).not.toContain('feishuUpdateDoc(objToken, fallbackMarkdown)');
    // Must NOT contain the old "overwrite fallback" path
    expect(funcBlock).not.toContain('overwrite fallback');
    // Must contain retry logic instead
    expect(funcBlock).toContain('re-listing children and retrying');
  });

  test('error propagation when batch_delete retry fails', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const funcIdx = code.indexOf('export async function feishuUpdateDocBlocks');
    const funcBlock = code.slice(funcIdx, funcIdx + 3000);
    // Must throw LarkCliError when retry fails
    expect(funcBlock).toContain('batch_delete failed after retry');
    expect(funcBlock).toContain('throw new LarkCliError');
  });

  test('all callers pass fallbackMarkdown to feishuUpdateDocBlocks', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Spec 37: main content writes use feishuIncrementalUpdateDocBlocks.
    // feishuUpdateDocBlocks is still used for recovery paths and changelog.
    // Every remaining call to feishuUpdateDocBlocks should have 3 args (objToken, blocks, markdown)
    const calls = code.match(/feishuUpdateDocBlocks\([^)]+\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      // Each call should have at least 2 commas (3 args)
      const commaCount = (call.match(/,/g) ?? []).length;
      expect(commaCount).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Spec 20: Zero errors on second push — origin resolution
// ---------------------------------------------------------------------------
describe('Spec 20: Origin resolution in feishu_sync lookup', () => {
  test('initial feishu_sync lookup filters by node_type=origin', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The main lookup query must filter for origin records
    const lookupIdx = code.indexOf('Check for existing feishu_sync record');
    expect(lookupIdx).toBeGreaterThan(-1);
    const lookupCode = code.slice(lookupIdx, lookupIdx + 400);
    expect(lookupCode).toContain("node_type = 'origin'");
  });

  test('LIMIT 1 query cannot return shortcut rows', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Find the main LIMIT 1 query and verify it has node_type filter
    const limitIdx = code.indexOf('LIMIT 1');
    expect(limitIdx).toBeGreaterThan(-1);
    const queryBlock = code.slice(Math.max(0, limitIdx - 300), limitIdx + 10);
    expect(queryBlock).toContain("node_type = 'origin'");
  });
});

// ---------------------------------------------------------------------------
// Spec 19: Shortcut idempotency — __root__ parent_type
// ---------------------------------------------------------------------------
describe('Spec 19: Shortcut idempotency', () => {
  test('no bare root parent_type in feishu.ts push flow', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The literal string 'root' should not appear as a parent_type value
    expect(code).not.toMatch(/parent_type\s*=\s*'root'/);
    expect(code).not.toMatch(/'shortcut',\s*'root'/);
  });

  test('cleanup loop skips __root__ shortcuts', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain("parentType === '__root__') continue");
  });

  test('migration 10 renames root to __root__', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/migrate.ts', import.meta.url), 'utf-8');
    expect(code).toContain("version: 10");
    expect(code).toContain("parent_type = '__root__'");
    expect(code).toContain("parent_type = 'root'");
    expect(code).toContain("node_type = 'shortcut'");
  });
});

// ---------------------------------------------------------------------------
// Spec 22: Duplicate Node Prevention — Check Before Create
// ---------------------------------------------------------------------------

describe('Spec 22: Duplicate node prevention', () => {
  test('findExistingChildByTitle is exported from feishu.ts', async () => {
    const mod = await import('../src/core/feishu.ts');
    expect(typeof mod.findExistingChildByTitle).toBe('function');
  });

  test('findExistingChildByTitle queries parent directory children via wiki nodes list', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync('src/core/feishu.ts', 'utf-8');
    const fnIdx = code.indexOf('findExistingChildByTitle');
    const fnBody = code.slice(fnIdx, fnIdx + 800);
    // Must query with parent_node_token parameter (not root-level feishuListNodes)
    expect(fnBody).toContain('parent_node_token');
    expect(fnBody).toContain('wiki');
    expect(fnBody).toContain('nodes');
    expect(fnBody).toContain('list');
    expect(fnBody).toContain('title');
  });

  test('push flow builds node cache from feishuListNodes', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('allNodesCache = await feishuListNodes(spaceId)');
  });

  test('createNodeChecked wrapper checks before creating', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('createNodeChecked');
    expect(code).toContain('findExistingChildByTitle');
  });

  test('all origin creation paths use createNodeChecked', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const pass1Idx = code.indexOf('PASS 1');
    const pass1Code = code.slice(pass1Idx);
    // Three origin creation paths (archived, stale, no record) should all use createNodeChecked
    const matches = pass1Code.match(/createNodeChecked\(parentToken, page\.title\)/g);
    expect(matches?.length).toBeGreaterThanOrEqual(3);
  });

  test('RECOVER paths use createNodeChecked', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Both RECOVER paths (pass-1 and pass-2) should use createNodeChecked
    const recoverMatches = code.match(/RECOVER.*Feishu node lost, recreating/g);
    expect(recoverMatches?.length).toBe(2);
    // Both paths should be followed by createNodeChecked within the next few lines
    const indices = [];
    let searchFrom = 0;
    while (true) {
      const idx = code.indexOf('RECOVER', searchFrom);
      if (idx === -1) break;
      if (code.slice(idx, idx + 50).includes('Feishu node lost')) {
        indices.push(idx);
      }
      searchFrom = idx + 1;
    }
    expect(indices.length).toBe(2);
    for (const idx of indices) {
      const nextChunk = code.slice(idx, idx + 500);
      expect(nextChunk).toContain('createNodeChecked');
    }
  });

  test('resolveParentToken checks for existing directory before creating', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const resolveIdx = code.indexOf('async function resolveParentToken');
    const resolveCode = code.slice(resolveIdx, resolveIdx + 1000);
    expect(resolveCode).toContain('findExistingChildByTitle');
  });

  test('changelog node creation checks before creating', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const changelogIdx = code.indexOf('pushChangelogToFeishu');
    const changelogCode = code.slice(changelogIdx, changelogIdx + 2000);
    expect(changelogCode).toContain('findExistingChildByTitle');
  });

  test('dead allRecords query removed', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).not.toContain('allRecords');
  });
});

// ---------------------------------------------------------------------------
// Spec 23: Line Break Rendering
// ---------------------------------------------------------------------------

describe('Spec 23: Line break rendering', () => {
  test('consecutive plain text lines become separate blocks', () => {
    const md = '来源：51CTO技术栈（林芯），2026-04-13\n原文：https://example.com\n引用：https://ref.com';
    const blocks = convertMarkdownToBlocks(md, new Map());
    // Each non-blank line should be its own text block
    expect(blocks).toHaveLength(3);
    blocks.forEach(b => expect(b.block_type).toBe(2)); // TEXT
    expect((blocks[0].text as any).elements[0].text_run.content).toContain('来源');
    expect((blocks[1].text as any).elements[0].text_run.content).toContain('原文');
    expect((blocks[2].text as any).elements[0].text_run.content).toContain('引用');
  });

  test('bold metadata lines become separate blocks', () => {
    const md = '**时间**：2026-04-13 10:00\n**参会人**：Alice, Bob';
    const blocks = convertMarkdownToBlocks(md, new Map());
    expect(blocks).toHaveLength(2);
    blocks.forEach(b => expect(b.block_type).toBe(2)); // TEXT
  });
});

// ---------------------------------------------------------------------------
// Spec 24: REUSE node_type fix + batch_delete improvement
// ---------------------------------------------------------------------------

describe('Spec 24: REUSE node_type fix + batch_delete', () => {
  test('R1: REUSE path uses UPSERT with node_type=origin (not UPDATE-only)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Find the REUSE/existing node branch (the else branch of isNewNode check)
    const reuseBranchIdx = code.indexOf('Spec 24 R1');
    expect(reuseBranchIdx).toBeGreaterThan(-1);
    const reuseBranch = code.slice(reuseBranchIdx, reuseBranchIdx + 600);
    // Must use INSERT ... ON CONFLICT, not just UPDATE
    expect(reuseBranch).toContain('INSERT INTO feishu_sync');
    expect(reuseBranch).toContain('ON CONFLICT');
    expect(reuseBranch).toContain("node_type    = 'origin'");
  });

  test('R1: REUSE path does NOT use plain UPDATE for feishu_sync', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The old pattern: "Existing node — UPDATE only" must be gone
    expect(code).not.toContain('UPDATE only (avoid unique index conflict)');
  });

  test('R2: batch_delete includes document_revision_id=-1', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const funcIdx = code.indexOf('export async function feishuUpdateDocBlocks');
    const funcBlock = code.slice(funcIdx, funcIdx + 3000);
    // Both batch_delete calls must include document_revision_id: -1
    const batchDeleteCalls = funcBlock.match(/batch_delete.*?document_revision_id:\s*-1/gs) ?? [];
    expect(batchDeleteCalls.length).toBeGreaterThanOrEqual(2); // initial + retry
  });

  test('R3: no feishuUpdateDoc fallback in feishuUpdateDocBlocks', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const funcIdx = code.indexOf('export async function feishuUpdateDocBlocks');
    const funcBlock = code.slice(funcIdx, funcIdx + 3000);
    // feishuUpdateDoc must NOT appear as a fallback in this function
    expect(funcBlock).not.toContain('feishuUpdateDoc(');
  });

  test('R3: batch_delete retry re-lists children before second attempt', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const funcIdx = code.indexOf('export async function feishuUpdateDocBlocks');
    const funcBlock = code.slice(funcIdx, funcIdx + 3000);
    // Must re-list children count before retry
    expect(funcBlock).toContain('re-listing children and retrying');
    // The listChildCount helper should be called in the catch block
    const catchIdx = funcBlock.indexOf('batchDeleteErr');
    expect(catchIdx).toBeGreaterThan(-1);
    const afterCatch = funcBlock.slice(catchIdx, catchIdx + 500);
    expect(afterCatch).toContain('listChildCount');
  });
});

// ── Spec 30: Move origin node when primary type changes ──
describe('Spec 30 — Move origin on type change', () => {
  test('T136: Push detects primary type change by comparing parent_type with types[0]', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Must read parent_type from existing record
    expect(code).toContain('existingParentType');
    expect(code).toContain('parent_type');
    // Must compare existing parent_type with current primaryType
    expect(code).toContain('existingParentType !== primaryType');
  });

  test('T137: Moves origin node to new type directory via feishuMoveNode', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The move block must resolve a new parent token and call feishuMoveNode
    const moveIdx = code.indexOf('existingParentType !== primaryType');
    expect(moveIdx).toBeGreaterThan(-1);
    const moveBlock = code.slice(moveIdx, moveIdx + 600);
    expect(moveBlock).toContain('resolveParentToken');
    expect(moveBlock).toContain('feishuMoveNode');
    expect(moveBlock).toContain('MOVED');
  });

  test('T137: Move is guarded by try-catch for error resilience', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const moveIdx = code.indexOf('existingParentType !== primaryType');
    expect(moveIdx).toBeGreaterThan(-1);
    const moveBlock = code.slice(moveIdx, moveIdx + 600);
    expect(moveBlock).toContain('catch');
    expect(moveBlock).toContain('move failed');
  });

  test('T138: parent_type is updated in feishu_sync after move (via existing upsert)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The existing upsert for non-new nodes writes primaryType as parent_type
    // Both INSERT branches use primaryType as the parent_type value
    const upsertIdx = code.indexOf("node_type    = 'origin',");
    expect(upsertIdx).toBeGreaterThan(-1);
    const afterUpsert = code.slice(upsertIdx, upsertIdx + 200);
    expect(afterUpsert).toContain('parent_type  = EXCLUDED.parent_type');
  });

  test('T136: Move only triggers when parent_type differs (no-op when same)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const moveIdx = code.indexOf('existingParentType !== primaryType');
    expect(moveIdx).toBeGreaterThan(-1);
    // The condition must be inside an if-block, ensuring no move when types match
    const beforeMove = code.slice(Math.max(0, moveIdx - 50), moveIdx);
    expect(beforeMove).toContain('if');
  });

  test('T136: Move block appears before title rename in Pass 1 flow', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Both blocks are in the nodeExists branch — move must precede rename
    const moveIdx = code.indexOf('existingParentType !== primaryType');
    const renameIdx = code.indexOf('feishuRenameNode(spaceId, nodeToken');
    expect(moveIdx).toBeGreaterThan(-1);
    expect(renameIdx).toBeGreaterThan(-1);
    // Move should happen before rename call in the push flow
    expect(moveIdx).toBeLessThan(renameIdx);
  });

  test('T136: Logs the type transition with arrow notation', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const moveIdx = code.indexOf('MOVED');
    expect(moveIdx).toBeGreaterThan(-1);
    const logLine = code.slice(moveIdx, moveIdx + 200);
    // Log should show source and destination types
    expect(logLine).toContain('existingParentType');
    expect(logLine).toContain('primaryType');
  });
});

// ---------------------------------------------------------------------------
// Spec 38: Fix document title update on push
// ---------------------------------------------------------------------------
describe('Spec 38: feishuRenameNode uses correct API endpoint', () => {
  test('T177: uses POST /update_title endpoint instead of PUT', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    // Must use POST method
    const fnStart = code.indexOf('async function feishuRenameNode');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = code.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain("'POST'");
    // Must use /update_title path
    expect(fnBody).toContain('/update_title');
    // Must NOT use the old PUT endpoint without /update_title
    expect(fnBody).not.toContain("'PUT'");
  });

  test('T177: passes title in request body', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const fnStart = code.indexOf('async function feishuRenameNode');
    const fnBody = code.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('{ title: newTitle }');
  });
});

describe('Spec 38: feishuUpdateDocTitle function', () => {
  test('T178: feishuUpdateDocTitle exists and is exported', async () => {
    const mod = await import('../src/core/feishu.ts');
    expect(typeof mod.feishuUpdateDocTitle).toBe('function');
  });

  test('T178: uses PATCH on docx block API', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const fnStart = code.indexOf('async function feishuUpdateDocTitle');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = code.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain("'PATCH'");
    expect(fnBody).toContain('/open-apis/docx/v1/documents/');
    expect(fnBody).toContain('/blocks/');
  });

  test('T178: uses update_text_elements with text_run content', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const fnStart = code.indexOf('async function feishuUpdateDocTitle');
    const fnBody = code.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain('update_text_elements');
    expect(fnBody).toContain('text_run');
    expect(fnBody).toContain('content: newTitle');
  });

  test('T178: passes document_revision_id: -1 for latest revision', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const fnStart = code.indexOf('async function feishuUpdateDocTitle');
    const fnBody = code.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain('document_revision_id');
    expect(fnBody).toContain('-1');
  });

  test('T178: page block_id equals objToken (document_id)', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/core/feishu.ts', import.meta.url), 'utf-8');
    const fnStart = code.indexOf('async function feishuUpdateDocTitle');
    const fnBody = code.slice(fnStart, fnStart + 600);
    // The URL pattern must use objToken for both document and block IDs
    expect(fnBody).toContain('/documents/${objToken}/blocks/${objToken}');
  });
});

describe('Spec 38: push flow title change integration', () => {
  test('T179: feishuUpdateDocTitle is imported in commands/feishu.ts', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    expect(code).toContain('feishuUpdateDocTitle');
  });

  test('T179: title change triggers both rename and doc title update', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // Both functions must be called within the title-change guard
    const titleGuardIdx = code.indexOf('existingRows[0].title !== page.title');
    expect(titleGuardIdx).toBeGreaterThan(-1);
    const afterGuard = code.slice(titleGuardIdx, titleGuardIdx + 800);
    expect(afterGuard).toContain('feishuRenameNode(spaceId');
    expect(afterGuard).toContain('feishuUpdateDocTitle(objToken');
  });

  test('T179: rename runs before doc title update', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    const renameIdx = code.indexOf('feishuRenameNode(spaceId, nodeToken, page.title)');
    const docTitleIdx = code.indexOf('feishuUpdateDocTitle(objToken, page.title)');
    expect(renameIdx).toBeGreaterThan(-1);
    expect(docTitleIdx).toBeGreaterThan(-1);
    expect(renameIdx).toBeLessThan(docTitleIdx);
  });

  test('T179: doc title update failure is caught gracefully', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The feishuUpdateDocTitle call must be wrapped in try/catch
    const docTitleIdx = code.indexOf('feishuUpdateDocTitle(objToken');
    expect(docTitleIdx).toBeGreaterThan(-1);
    const beforeCall = code.slice(Math.max(0, docTitleIdx - 200), docTitleIdx);
    expect(beforeCall).toContain('try');
    const afterCall = code.slice(docTitleIdx, docTitleIdx + 200);
    expect(afterCall).toContain('catch');
    expect(afterCall).toContain('doc title update failed');
  });
});

// ---------------------------------------------------------------------------
// Spec 50: Push matches by slug (feishu_sync) before title fallback
// ---------------------------------------------------------------------------
describe('Spec 50: Push slug lookup — feishu_sync before title fallback', () => {
  test('T200: push queries feishu_sync by slug + space_id + origin before title search', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The push loop must query feishu_sync by slug BEFORE calling createNodeChecked
    const syncQuery = code.indexOf("FROM feishu_sync");
    const slugParam = code.indexOf("WHERE slug = $1 AND space_id = $2 AND node_type = 'origin'");
    expect(syncQuery).toBeGreaterThan(-1);
    expect(slugParam).toBeGreaterThan(-1);
    // The feishu_sync query must appear BEFORE createNodeChecked calls
    const firstCreateNodeChecked = code.indexOf('createNodeChecked(parentToken');
    expect(slugParam).toBeLessThan(firstCreateNodeChecked);
  });

  test('T201: slug-based reuse skips title search when feishu_sync has valid node', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // When existingRows.length > 0 and node validates, code uses existing tokens directly
    expect(code).toContain('existingRows.length > 0');
    expect(code).toContain('feishuValidateNode');
    // The validated path sets nodeToken/objToken from existing row, not from createNodeChecked
    const validateIdx = code.indexOf('feishuValidateNode(spaceId, existNodeToken)');
    expect(validateIdx).toBeGreaterThan(-1);
    const afterValidate = code.slice(validateIdx, validateIdx + 300);
    expect(afterValidate).toContain('nodeToken = existNodeToken');
    expect(afterValidate).toContain('objToken = existObjToken');
  });

  test('T202: title rename fires when slug reuse finds changed title', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // After reusing by slug, code checks if title changed and renames
    const renameCheck = code.indexOf('existingRows[0].title !== page.title');
    expect(renameCheck).toBeGreaterThan(-1);
    const afterCheck = code.slice(renameCheck, renameCheck + 800);
    expect(afterCheck).toContain('feishuRenameNode');
    expect(afterCheck).toContain('feishuUpdateDocTitle');
    expect(afterCheck).toContain('RENAMED');
  });

  test('T203: stale feishu_sync entry triggers fallback to new node creation', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // When feishuValidateNode returns false, code should delete stale record and create new
    const staleIdx = code.indexOf('STALE');
    expect(staleIdx).toBeGreaterThan(-1);
    const staleSection = code.slice(staleIdx, staleIdx + 800);
    expect(staleSection).toContain('DELETE FROM feishu_sync');
    expect(staleSection).toContain('createNodeChecked');
  });

  test('T204: no feishu_sync record falls back to title-based search via createNodeChecked', async () => {
    const { readFileSync } = await import('fs');
    const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');
    // The else branch (no existing rows) calls createNodeChecked which uses findExistingChildByTitle
    expect(code).toContain('// R1: no record');
    expect(code).toContain('createNodeChecked(parentToken, page.title)');
    // createNodeChecked internally calls findExistingChildByTitle
    expect(code).toContain('findExistingChildByTitle(spaceId, parentToken, title');
  });
});
