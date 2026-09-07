/**
 * Phase A — Embedding config tests (T204)
 *
 * Tests that embedding.ts reads env vars for model/dimensions and
 * that the PGLite schema uses the configured dimensions.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

describe('Phase A: Embedding Configuration', () => {
  // Save original env
  let origModel: string | undefined;
  let origDim: string | undefined;

  beforeEach(() => {
    origModel = process.env.CFBRAIN_EMBEDDING_MODEL;
    origDim = process.env.CFBRAIN_EMBEDDING_DIMENSIONS;
    // Clear to test defaults
    delete process.env.CFBRAIN_EMBEDDING_MODEL;
    delete process.env.CFBRAIN_EMBEDDING_DIMENSIONS;
  });

  afterEach(() => {
    // Restore
    if (origModel !== undefined) process.env.CFBRAIN_EMBEDDING_MODEL = origModel;
    else delete process.env.CFBRAIN_EMBEDDING_MODEL;
    if (origDim !== undefined) process.env.CFBRAIN_EMBEDDING_DIMENSIONS = origDim;
    else delete process.env.CFBRAIN_EMBEDDING_DIMENSIONS;
  });

  test('EMBEDDING_MODEL defaults to text-embedding-3-small', async () => {
    const { EMBEDDING_MODEL } = await import('../src/core/embedding.ts');
    expect(EMBEDDING_MODEL()).toBe('text-embedding-3-small');
  });

  test('EMBEDDING_DIMENSIONS defaults to 1536 for text-embedding-3-small', async () => {
    const { EMBEDDING_DIMENSIONS } = await import('../src/core/embedding.ts');
    expect(EMBEDDING_DIMENSIONS()).toBe(1536);
  });

  test('CFBRAIN_EMBEDDING_MODEL env var overrides default', async () => {
    process.env.CFBRAIN_EMBEDDING_MODEL = 'text-embedding-3-large';
    const { EMBEDDING_MODEL } = await import('../src/core/embedding.ts');
    expect(EMBEDDING_MODEL()).toBe('text-embedding-3-large');
  });

  test('CFBRAIN_EMBEDDING_DIMENSIONS env var overrides auto dimension', async () => {
    process.env.CFBRAIN_EMBEDDING_DIMENSIONS = '768';
    const { EMBEDDING_DIMENSIONS } = await import('../src/core/embedding.ts');
    expect(EMBEDDING_DIMENSIONS()).toBe(768);
  });

  test('text-embedding-3-large defaults to 3072 dimensions', async () => {
    process.env.CFBRAIN_EMBEDDING_MODEL = 'text-embedding-3-large';
    const { EMBEDDING_DIMENSIONS } = await import('../src/core/embedding.ts');
    expect(EMBEDDING_DIMENSIONS()).toBe(3072);
  });

  test('unknown model defaults to 1536 dimensions', async () => {
    process.env.CFBRAIN_EMBEDDING_MODEL = 'some-custom-model';
    const { EMBEDDING_DIMENSIONS } = await import('../src/core/embedding.ts');
    expect(EMBEDDING_DIMENSIONS()).toBe(1536);
  });

  test('invalid CFBRAIN_EMBEDDING_DIMENSIONS falls back to auto', async () => {
    process.env.CFBRAIN_EMBEDDING_DIMENSIONS = 'not-a-number';
    const { EMBEDDING_DIMENSIONS } = await import('../src/core/embedding.ts');
    expect(EMBEDDING_DIMENSIONS()).toBe(1536);
  });
});

describe('Phase A: PGLite Schema — Configurable Dimensions', () => {
  let origModel: string | undefined;
  let origDim: string | undefined;

  beforeEach(() => {
    origModel = process.env.CFBRAIN_EMBEDDING_MODEL;
    origDim = process.env.CFBRAIN_EMBEDDING_DIMENSIONS;
  });

  afterEach(() => {
    if (origModel !== undefined) process.env.CFBRAIN_EMBEDDING_MODEL = origModel;
    else delete process.env.CFBRAIN_EMBEDDING_MODEL;
    if (origDim !== undefined) process.env.CFBRAIN_EMBEDDING_DIMENSIONS = origDim;
    else delete process.env.CFBRAIN_EMBEDDING_DIMENSIONS;
  });

  test('getPgliteSchemaSql uses configured dimensions', async () => {
    process.env.CFBRAIN_EMBEDDING_MODEL = 'text-embedding-3-large';
    process.env.CFBRAIN_EMBEDDING_DIMENSIONS = '3072';
    const { getPgliteSchemaSql } = await import('../src/core/pglite-schema.ts');
    const sql = getPgliteSchemaSql();
    expect(sql).toContain('vector(3072)');
    expect(sql).toContain("'text-embedding-3-large'");
  });

  test('getPgliteSchemaSql defaults to 1536 for text-embedding-3-small', async () => {
    delete process.env.CFBRAIN_EMBEDDING_MODEL;
    delete process.env.CFBRAIN_EMBEDDING_DIMENSIONS;
    const { getPgliteSchemaSql } = await import('../src/core/pglite-schema.ts');
    const sql = getPgliteSchemaSql();
    expect(sql).toContain('vector(1536)');
    expect(sql).toContain("'text-embedding-3-small'");
  });

  test('PGLITE_SCHEMA_SQL backward-compat constant still exists', async () => {
    const { PGLITE_SCHEMA_SQL } = await import('../src/core/pglite-schema.ts');
    expect(PGLITE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS files');
    expect(PGLITE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS pages');
  });
});
