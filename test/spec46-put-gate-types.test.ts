/**
 * Spec 46: Put Gate — Enforce allowed page types on put.
 *
 * Validates that put_page rejects non-standard frontmatter types with a clear
 * error message listing invalid types and the allowed list. --force bypasses.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { DEFAULT_TYPES } from '../src/core/types.ts';

// ─── Unit: DEFAULT_TYPES list ────────────────────────────────────────────

describe('DEFAULT_TYPES constant', () => {
  test('contains exactly 10 types', () => {
    expect(DEFAULT_TYPES).toHaveLength(10);
  });

  test('includes all expected types', () => {
    const expected = ['person', 'company', 'meeting', 'project', 'decision', 'concept', 'intel', 'deal', 'note', 'recruit'];
    for (const t of expected) {
      expect((DEFAULT_TYPES as readonly string[]).includes(t)).toBe(true);
    }
  });
});

// ─── Integration: put_page type validation via PGLite ────────────────────

describe('put_page type validation — integration (PGLite)', () => {
  let engine: any;
  let ctx: OperationContext;
  const BRAIN_DIR = join(tmpdir(), `cfbrain-spec46-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  beforeAll(async () => {
    mkdirSync(BRAIN_DIR, { recursive: true });
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();
    ctx = {
      engine,
      config: { engine: 'pglite', database_path: join(BRAIN_DIR, 'brain.db') },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
    };
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
    try { rmSync(BRAIN_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function buildContent(title: string, types: string[], body: string): string {
    return `---\ntitle: ${title}\ntypes: [${types.join(', ')}]\n---\n${body}`;
  }

  function buildContentNoTypes(title: string, body: string): string {
    return `---\ntitle: ${title}\n---\n${body}`;
  }

  async function put(slug: string, types: string[], params: Record<string, unknown> = {}) {
    const op = operationsByName['put_page'];
    return op.handler(ctx, { slug, content: buildContent(slug, types, 'Test body content.'), no_embed: true, ...params });
  }

  async function putNoTypes(slug: string, params: Record<string, unknown> = {}) {
    const op = operationsByName['put_page'];
    return op.handler(ctx, { slug, content: buildContentNoTypes(slug, 'Test body content.'), no_embed: true, ...params });
  }

  test('put with valid types passes', async () => {
    const result = await put('valid-person', ['person']);
    expect((result as any).status).toBe('created_or_updated');
  });

  test('put with multiple valid types passes', async () => {
    const result = await put('valid-multi', ['person', 'intel']);
    expect((result as any).status).toBe('created_or_updated');
  });

  test('put with all 10 valid types passes', async () => {
    const result = await put('valid-all-types', [...DEFAULT_TYPES]);
    expect((result as any).status).toBe('created_or_updated');
  });

  test('put with invalid type rejects with OperationError', async () => {
    await expect(put('bad-reference', ['reference'])).rejects.toThrow(OperationError);
  });

  test('error message lists the invalid type', async () => {
    try {
      await put('bad-org', ['org']);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      const oe = e as OperationError;
      expect(oe.code).toBe('invalid_params');
      expect(oe.message).toContain('org');
    }
  });

  test('error message lists allowed types', async () => {
    try {
      await put('bad-foo', ['foo']);
      throw new Error('should have thrown');
    } catch (e) {
      const oe = e as OperationError;
      expect(oe.message).toContain('person');
      expect(oe.message).toContain('recruit');
      expect(oe.message).toContain('--force');
    }
  });

  test('multiple invalid types are all listed in error', async () => {
    try {
      await put('bad-multi', ['reference', 'org', 'person']);
      throw new Error('should have thrown');
    } catch (e) {
      const oe = e as OperationError;
      expect(oe.message).toContain('reference');
      expect(oe.message).toContain('org');
    }
  });

  test('put with --force bypasses type validation', async () => {
    const result = await put('force-bypass', ['reference'], { force: true });
    expect((result as any).status).toBe('created_or_updated');
  });

  test('put with empty types (no types in frontmatter) passes', async () => {
    const result = await putNoTypes('no-types');
    expect((result as any).status).toBe('created_or_updated');
  });

  test('put with mix of valid and invalid types rejects', async () => {
    await expect(put('mix-types', ['person', 'reference'])).rejects.toThrow(/Invalid type/);
  });

  test('error carries code=invalid_params', async () => {
    try {
      await put('bad-code-check', ['banana']);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_params');
    }
  });
});

// ─── CLI plumbing: force param description updated ───────────────────────

describe('put_page operation force param includes type validation', () => {
  test('force param description mentions Spec 46', () => {
    const op = operationsByName['put_page'];
    expect(op.params.force?.description).toContain('type validation');
  });
});
