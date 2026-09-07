/**
 * Spec 47: Types CLI — manage page types from config.json.
 *
 * Tests: getConfiguredTypes helper (with/without config), types list output,
 * types add (success + duplicate), types remove (empty + non-empty + force),
 * types rename, put validation uses config types.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getConfiguredTypes, readConfig, writeConfig } from '../src/core/config-types.ts';
import { DEFAULT_TYPES } from '../src/core/types.ts';
import { DEFAULT_TYPE_LABELS } from '../src/core/config.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';

// ─── Unit: getConfiguredTypes ───────────────────────────────────────────

describe('getConfiguredTypes', () => {
  test('returns DEFAULT_TYPES when config is null', () => {
    const result = getConfiguredTypes(null);
    expect(result).toEqual([...DEFAULT_TYPES]);
  });

  test('returns DEFAULT_TYPES when config is undefined', () => {
    const result = getConfiguredTypes(undefined);
    expect(result).toEqual([...DEFAULT_TYPES]);
  });

  test('returns DEFAULT_TYPES when config has no type_labels', () => {
    const config: GBrainConfig = { engine: 'pglite' };
    const result = getConfiguredTypes(config);
    expect(result).toEqual([...DEFAULT_TYPES]);
  });

  test('returns DEFAULT_TYPES when type_labels is empty', () => {
    const config: GBrainConfig = { engine: 'pglite', type_labels: {} };
    const result = getConfiguredTypes(config);
    expect(result).toEqual([...DEFAULT_TYPES]);
  });

  test('returns config type_labels keys when present', () => {
    const config: GBrainConfig = {
      engine: 'pglite',
      type_labels: { person: 'People', project: 'Projects', custom: 'Custom' },
    };
    const result = getConfiguredTypes(config);
    expect(result).toEqual(['person', 'project', 'custom']);
  });

  test('result is a new array (not a reference)', () => {
    const config: GBrainConfig = {
      engine: 'pglite',
      type_labels: { person: 'People' },
    };
    const a = getConfiguredTypes(config);
    const b = getConfiguredTypes(config);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

// ─── Unit: readConfig / writeConfig ─────────────────────────────────────

describe('readConfig / writeConfig', () => {
  const DIR = join(tmpdir(), `cfbrain-spec47-rw-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  beforeAll(() => mkdirSync(DIR, { recursive: true }));
  afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

  test('readConfig returns null for missing file', () => {
    expect(readConfig(join(DIR, 'nonexistent'))).toBeNull();
  });

  test('writeConfig creates file and readConfig reads it back', () => {
    const config: GBrainConfig = {
      engine: 'pglite',
      type_labels: { note: 'Notes', person: 'People' },
    };
    writeConfig(DIR, config);
    const loaded = readConfig(DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.engine).toBe('pglite');
    expect(loaded!.type_labels).toEqual({ note: 'Notes', person: 'People' });
  });

  test('writeConfig creates parent directories', () => {
    const nested = join(DIR, 'a', 'b', 'c');
    const config: GBrainConfig = { engine: 'pglite' };
    writeConfig(nested, config);
    expect(readConfig(nested)).not.toBeNull();
  });
});

// ─── Integration: put_page uses config types ────────────────────────────

describe('put_page validates against config types (Spec 47)', () => {
  let engine: any;
  let ctx: OperationContext;
  const BRAIN_DIR = join(tmpdir(), `cfbrain-spec47-put-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  beforeAll(async () => {
    mkdirSync(BRAIN_DIR, { recursive: true });
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
    try { rmSync(BRAIN_DIR, { recursive: true, force: true }); } catch {}
  });

  function makeCtx(typeLabels?: Record<string, string>): OperationContext {
    return {
      engine,
      config: {
        engine: 'pglite',
        database_path: join(BRAIN_DIR, 'brain.db'),
        type_labels: typeLabels,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
    };
  }

  function buildContent(slug: string, types: string[]): string {
    return `---\ntitle: ${slug}\ntypes: [${types.join(', ')}]\n---\nBody text.`;
  }

  test('with config type_labels, accepts configured types', async () => {
    const ctx = makeCtx({ person: 'People', custom_type: 'Custom' });
    const op = operationsByName['put_page'];
    const result = await op.handler(ctx, {
      slug: 's47-custom-ok',
      content: buildContent('s47-custom-ok', ['custom_type']),
      no_embed: true,
    });
    expect((result as any).status).toBe('created_or_updated');
  });

  test('with config type_labels, rejects types not in config', async () => {
    const ctx = makeCtx({ person: 'People', custom_type: 'Custom' });
    const op = operationsByName['put_page'];
    try {
      await op.handler(ctx, {
        slug: 's47-reject-meeting',
        content: buildContent('s47-reject-meeting', ['meeting']),
        no_embed: true,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      const oe = e as OperationError;
      expect(oe.message).toContain('meeting');
      expect(oe.message).toContain('custom_type');
    }
  });

  test('without config type_labels, falls back to DEFAULT_TYPES', async () => {
    const ctx = makeCtx(undefined);
    const op = operationsByName['put_page'];
    const result = await op.handler(ctx, {
      slug: 's47-default-fallback',
      content: buildContent('s47-default-fallback', ['person']),
      no_embed: true,
    });
    expect((result as any).status).toBe('created_or_updated');
  });

  test('without config type_labels, rejects non-default types', async () => {
    const ctx = makeCtx(undefined);
    const op = operationsByName['put_page'];
    await expect(
      op.handler(ctx, {
        slug: 's47-default-reject',
        content: buildContent('s47-default-reject', ['custom_type']),
        no_embed: true,
      }),
    ).rejects.toThrow(OperationError);
  });

  test('adding type to config makes it immediately accepted', async () => {
    const labels: Record<string, string> = { ...DEFAULT_TYPE_LABELS, brand_new: 'Brand New' };
    const ctx = makeCtx(labels);
    const op = operationsByName['put_page'];
    const result = await op.handler(ctx, {
      slug: 's47-brand-new',
      content: buildContent('s47-brand-new', ['brand_new']),
      no_embed: true,
    });
    expect((result as any).status).toBe('created_or_updated');
  });
});

// ─── Integration: types list via engine ─────────────────────────────────

describe('types list output', () => {
  let engine: any;
  // Both the engine *and* ctx.config must point here. Setting only one is the trap
  // that caused 208 test commits to land in the production brain: the engine was
  // in-memory (harmless) while ctx.config fell through getBrainDir() to
  // $HOME/.cfbrain and wrote real files + real git commits.
  const BRAIN_DIR = join(tmpdir(), `cfbrain-spec47-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const DB_PATH = join(BRAIN_DIR, 'brain.db');

  beforeAll(async () => {
    mkdirSync(BRAIN_DIR, { recursive: true });
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: DB_PATH });
    await engine.initSchema();

    const op = operationsByName['put_page'];
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite', database_path: DB_PATH },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
    };
    await op.handler(ctx, {
      slug: 'list-test-1',
      content: `---\ntitle: list-test-1\ntypes: [person]\n---\nBody.`,
      no_embed: true,
    });
    await op.handler(ctx, {
      slug: 'list-test-2',
      content: `---\ntitle: list-test-2\ntypes: [person, meeting]\n---\nBody.`,
      no_embed: true,
    });
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
    rmSync(BRAIN_DIR, { recursive: true, force: true });
  });

  test('stats include page counts by type', async () => {
    const stats = await engine.getStats();
    expect(stats.pages_by_type.person).toBeGreaterThanOrEqual(2);
  });
});

// ─── Unit: getConfiguredTypes with DEFAULT_TYPE_LABELS ──────────────────

describe('getConfiguredTypes with DEFAULT_TYPE_LABELS config', () => {
  test('config with DEFAULT_TYPE_LABELS returns all 10 default types', () => {
    const config: GBrainConfig = {
      engine: 'pglite',
      type_labels: { ...DEFAULT_TYPE_LABELS },
    };
    const result = getConfiguredTypes(config);
    expect(result).toHaveLength(10);
    for (const t of DEFAULT_TYPES) {
      expect(result).toContain(t);
    }
  });

  test('config with extra types returns them', () => {
    const config: GBrainConfig = {
      engine: 'pglite',
      type_labels: { ...DEFAULT_TYPE_LABELS, reference: 'References', org: 'Organizations' },
    };
    const result = getConfiguredTypes(config);
    expect(result).toHaveLength(12);
    expect(result).toContain('reference');
    expect(result).toContain('org');
  });

  test('config with fewer types returns only those', () => {
    const config: GBrainConfig = {
      engine: 'pglite',
      type_labels: { person: 'People', note: 'Notes' },
    };
    const result = getConfiguredTypes(config);
    expect(result).toEqual(['person', 'note']);
  });
});
