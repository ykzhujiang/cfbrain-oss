/**
 * Spec 43: Put safety check — prevent accidental content wipe.
 *
 * T209 adds a guard in put_page: if the slug already exists with non-trivial
 * content (> 100 chars), reject writes where the new content is < 20% of the
 * existing length, unless --force is passed.
 *
 * Why it exists: on 2026-04-17 a cron agent overwrote a long meeting-notes page
 * with a single dash, destroying 119 lines. These tests lock in the guard plus
 * the --force escape hatch.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkPutSafety,
  OperationError,
  operationsByName,
  PUT_SAFETY_MIN_EXISTING_LENGTH,
  PUT_SAFETY_MIN_RATIO,
  type OperationContext,
} from '../src/core/operations.ts';

// ─── Unit tests: checkPutSafety ───────────────────────────────────────────

describe('checkPutSafety — unit', () => {
  test('constants match spec (100 char floor, 20% ratio)', () => {
    expect(PUT_SAFETY_MIN_EXISTING_LENGTH).toBe(100);
    expect(PUT_SAFETY_MIN_RATIO).toBe(0.2);
  });

  test('no existing content → no-op (creates pass through)', () => {
    expect(() => checkPutSafety(null, 'x', false)).not.toThrow();
    expect(() => checkPutSafety(undefined, 'x', false)).not.toThrow();
    expect(() => checkPutSafety('', 'x', false)).not.toThrow();
  });

  test('existing ≤ 100 chars → no-op (page already short)', () => {
    const short = 'a'.repeat(100);
    expect(() => checkPutSafety(short, '', false)).not.toThrow();
    const shorter = 'a'.repeat(50);
    expect(() => checkPutSafety(shorter, 'x', false)).not.toThrow();
  });

  test('long existing + tiny new content → throws OperationError', () => {
    const existing = 'a'.repeat(500);
    expect(() => checkPutSafety(existing, '-', false)).toThrow(OperationError);
    try {
      checkPutSafety(existing, '-', false);
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      const oe = e as OperationError;
      expect(oe.code).toBe('safety_check_failed');
      expect(oe.message).toContain('1 chars');
      expect(oe.message).toContain('500 chars');
      expect(oe.message).toContain('--force');
    }
  });

  test('force=true bypasses even catastrophic shrink', () => {
    const existing = 'a'.repeat(500);
    expect(() => checkPutSafety(existing, '-', true)).not.toThrow();
    expect(() => checkPutSafety(existing, '', true)).not.toThrow();
  });

  test('new content ≥ 20% of existing → pass', () => {
    const existing = 'a'.repeat(500);
    // 20% of 500 = 100 → exactly at threshold passes
    expect(() => checkPutSafety(existing, 'a'.repeat(100), false)).not.toThrow();
    expect(() => checkPutSafety(existing, 'a'.repeat(101), false)).not.toThrow();
    expect(() => checkPutSafety(existing, 'a'.repeat(400), false)).not.toThrow();
  });

  test('new content just below 20% → rejected', () => {
    const existing = 'a'.repeat(500);
    // 99 chars is < 100 (20% of 500)
    expect(() => checkPutSafety(existing, 'a'.repeat(99), false)).toThrow(OperationError);
  });

  test('boundary: existing = 101 chars (just over floor)', () => {
    const existing = 'a'.repeat(101);
    // 20% of 101 ≈ 20.2 → 20 chars should fail, 21 should pass
    expect(() => checkPutSafety(existing, 'a'.repeat(20), false)).toThrow(OperationError);
    expect(() => checkPutSafety(existing, 'a'.repeat(21), false)).not.toThrow();
  });

  test('error message mentions --force as the override', () => {
    const existing = 'a'.repeat(500);
    try {
      checkPutSafety(existing, '-', false);
      throw new Error('should have thrown');
    } catch (e) {
      const oe = e as OperationError;
      expect(oe.message).toMatch(/Use --force/);
    }
  });
});

// ─── Integration tests: put_page handler via PGLite ───────────────────────

describe('put_page safety check — integration (PGLite)', () => {
  let engine: any;
  let ctx: OperationContext;
  const BRAIN_DIR = join(tmpdir(), `cfbrain-spec43-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const LONG_BODY = 'This is a long, detailed meeting note. '.repeat(20); // > 100 chars

  beforeAll(async () => {
    mkdirSync(BRAIN_DIR, { recursive: true });
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' }); // in-memory DB
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

  function buildContent(title: string, body: string): string {
    return `---\ntitle: ${title}\ntypes: [note]\n---\n${body}`;
  }

  async function putRaw(slug: string, body: string, params: Record<string, unknown> = {}) {
    const op = operationsByName['put_page'];
    return op.handler(ctx, { slug, content: buildContent(slug, body), no_embed: true, ...params });
  }

  test('scenario 1: tiny overwrite on long page → rejected', async () => {
    const slug = 'safety-long-page';
    await putRaw(slug, LONG_BODY);

    // Attempt catastrophic shrink
    await expect(putRaw(slug, '-')).rejects.toThrow(/Safety check failed/);

    // Original content still intact
    const page = await engine.getPage(slug);
    expect(page.compiled_truth.length).toBeGreaterThan(PUT_SAFETY_MIN_EXISTING_LENGTH);
    expect(page.compiled_truth).not.toBe('-');
  });

  test('scenario 2: --force bypasses the safety check', async () => {
    const slug = 'safety-force-bypass';
    await putRaw(slug, LONG_BODY);

    const result = await putRaw(slug, '-', { force: true });
    expect((result as any).status).toBe('created_or_updated');

    const page = await engine.getPage(slug);
    expect(page.compiled_truth.trim()).toBe('-');
  });

  test('scenario 3: normal update (≥ 20%) passes', async () => {
    const slug = 'safety-normal-update';
    await putRaw(slug, LONG_BODY);

    // New body at least 20% of old — actually nearly equal
    const newBody = LONG_BODY.replace('meeting', 'standup');
    const result = await putRaw(slug, newBody);
    expect((result as any).status).toBe('created_or_updated');

    const page = await engine.getPage(slug);
    expect(page.compiled_truth).toContain('standup');
  });

  test('scenario 4: creating a brand-new page with short content passes', async () => {
    const slug = 'safety-new-short-page';
    // No existing page → safety check must not block creation even with tiny body.
    const result = await putRaw(slug, '-');
    expect((result as any).status).toBe('created_or_updated');

    const page = await engine.getPage(slug);
    expect(page.compiled_truth.trim()).toBe('-');
  });

  test('scenario 5: updating a short (≤100 char) existing page allows any size', async () => {
    const slug = 'safety-short-existing';
    // First put with a short body (well under 100 chars)
    await putRaw(slug, 'tiny');

    // Replace with something even shorter — should NOT trigger safety check
    const result = await putRaw(slug, 'x');
    expect((result as any).status).toBe('created_or_updated');
  });

  test('error carries code=safety_check_failed', async () => {
    const slug = 'safety-error-code';
    await putRaw(slug, LONG_BODY);
    try {
      await putRaw(slug, 'x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('safety_check_failed');
    }
  });
});

// ─── CLI plumbing: --force flag is parseable by parseOpArgs ──────────────

describe('put_page operation declares force param', () => {
  test('force is declared as a boolean param so --force parses correctly', () => {
    const op = operationsByName['put_page'];
    expect(op.params.force).toBeDefined();
    expect(op.params.force?.type).toBe('boolean');
  });
});
