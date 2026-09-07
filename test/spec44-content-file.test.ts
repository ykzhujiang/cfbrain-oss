import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const put = operations.find(o => o.name === 'put_page')!;
const get = operations.find(o => o.name === 'get_page')!;
const del = operations.find(o => o.name === 'delete_page')!;

describe('Spec 44: --content-file parameter', () => {
  let engine: PGLiteEngine;
  let config: GBrainConfig;
  const tmpDir = '/tmp/spec44-test-brain';
  const tmpFile = '/tmp/spec44-test-content.md';
  const tmpContent = `---
types: [note]
title: Spec 44 Test
---
This is content from a file.`;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // Create a mock config with a temp database_path so getBrainDir() works
    mkdirSync(tmpDir, { recursive: true });
    config = {
      engine: 'pglite',
      database_path: join(tmpDir, 'brain.pglite'),
    };
    writeFileSync(tmpFile, tmpContent, 'utf-8');
  });

  afterAll(async () => {
    try { unlinkSync(tmpFile); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { await del.handler({ engine, config, dryRun: false }, { slug: 'spec44-test' }); } catch {}
    await engine.disconnect();
  });

  it('reads content from --content-file', async () => {
    const result = await put.handler(
      { engine, config, dryRun: false },
      { slug: 'spec44-test', content_file: tmpFile, no_embed: true }
    );
    expect(result).toMatchObject({ slug: 'spec44-test', status: 'created_or_updated' });

    const page = await get.handler(
      { engine, config, dryRun: false },
      { slug: 'spec44-test' }
    );
    expect((page as any).compiled_truth).toContain('This is content from a file.');
  });

  it('throws for non-existent --content-file', async () => {
    expect(() =>
      put.handler(
        { engine, config, dryRun: false },
        { slug: 'spec44-fail', content_file: '/tmp/nonexistent-spec44.md', no_embed: true }
      )
    ).toThrow('Content file not found');
  });

  it('--content-file overrides --content', async () => {
    await put.handler(
      { engine, config, dryRun: false },
      { slug: 'spec44-test', content: 'should be ignored', content_file: tmpFile, no_embed: true }
    );
    const page = await get.handler(
      { engine, config, dryRun: false },
      { slug: 'spec44-test' }
    );
    expect((page as any).compiled_truth).toContain('This is content from a file.');
    expect((page as any).compiled_truth).not.toContain('should be ignored');
  });

  it('plain --content text is unchanged', async () => {
    await put.handler(
      { engine, config, dryRun: false },
      { slug: 'spec44-test', content: '---\ntypes: [note]\ntitle: Plain\n---\nPlain text content', no_embed: true }
    );
    const page = await get.handler(
      { engine, config, dryRun: false },
      { slug: 'spec44-test' }
    );
    expect((page as any).compiled_truth).toContain('Plain text content');
  });
});
