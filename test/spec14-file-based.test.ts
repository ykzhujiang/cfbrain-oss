import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { initBrainDirs } from '../src/commands/init.ts';
import { writePageFile, deletePageFile, gitAutoCommit, getBrainDir, getPagesDir } from '../src/core/pages-fs.ts';
import { withoutSandbox } from './helpers/sandbox.ts';
import type { GBrainConfig } from '../src/core/config.ts';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `cfbrain-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(brainDir: string): GBrainConfig {
  return {
    engine: 'pglite',
    database_path: join(brainDir, 'brain.pglite'),
  };
}

describe('Spec 14: File-Based Brain', () => {
  let brainDir: string;
  let config: GBrainConfig;

  beforeEach(() => {
    brainDir = makeTmpDir();
    config = makeConfig(brainDir);
  });

  afterEach(() => {
    try { rmSync(brainDir, { recursive: true, force: true }); } catch {}
  });

  // ── T37: init creates pages/ and raw/ ──

  describe('T37: initBrainDirs', () => {
    test('creates pages/ and raw/ directories', () => {
      initBrainDirs(brainDir);
      expect(existsSync(join(brainDir, 'pages'))).toBe(true);
      expect(existsSync(join(brainDir, 'raw'))).toBe(true);
    });

    test('git init at brain dir level', () => {
      initBrainDirs(brainDir);
      expect(existsSync(join(brainDir, '.git'))).toBe(true);
    });

    test('idempotent — re-running does not break anything', () => {
      initBrainDirs(brainDir);
      initBrainDirs(brainDir); // second call
      expect(existsSync(join(brainDir, '.git'))).toBe(true);
      expect(existsSync(join(brainDir, 'raw'))).toBe(true);
    });
  });

  // ── T38: put_page writes pages/<slug>.md ──

  describe('T38: writePageFile', () => {
    test('writes file to pages/<slug>.md', () => {
      initBrainDirs(brainDir);
      const content = '---\ntypes:\n  - person\ntitle: Test Page\n---\n\nHello world\n';
      writePageFile(config, 'test-page', content);

      const filePath = join(brainDir, 'pages', 'test-page.md');
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toBe(content);
    });

    test('creates intermediate directories for nested slugs', () => {
      initBrainDirs(brainDir);
      writePageFile(config, 'people/john-doe', 'content');
      expect(existsSync(join(brainDir, 'pages', 'people', 'john-doe.md'))).toBe(true);
    });

    test('overwrites existing file', () => {
      initBrainDirs(brainDir);
      writePageFile(config, 'test', 'v1');
      writePageFile(config, 'test', 'v2');
      expect(readFileSync(join(brainDir, 'pages', 'test.md'), 'utf-8')).toBe('v2');
    });
  });

  // ── T39: delete_page removes pages/<slug>.md ──

  describe('T39: deletePageFile', () => {
    test('moves file to .trash/', () => {
      initBrainDirs(brainDir);
      writePageFile(config, 'doomed', 'content');
      deletePageFile(config, 'doomed');

      expect(existsSync(join(brainDir, 'pages', 'doomed.md'))).toBe(false);
      expect(existsSync(join(brainDir, 'pages', '.trash', 'doomed.md'))).toBe(true);
    });

    test('no error if file does not exist', () => {
      initBrainDirs(brainDir);
      expect(() => deletePageFile(config, 'nonexistent')).not.toThrow();
    });

    test('trash preserves content', () => {
      initBrainDirs(brainDir);
      writePageFile(config, 'precious', 'important data');
      deletePageFile(config, 'precious');
      expect(readFileSync(join(brainDir, 'pages', '.trash', 'precious.md'), 'utf-8')).toBe('important data');
    });
  });

  // ── T40: git auto-commit ──

  // These three assert gitAutoCommit's own production behaviour, so they opt out of
  // the test sandbox. Safe because `brainDir` is a fresh $TMPDIR repo, never the
  // production brain.
  describe('T40: gitAutoCommit', () => {
    test('creates git commit after file write', () => {
      initBrainDirs(brainDir);
      // Configure git user for test commits (git is now at brain dir level)
      execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: brainDir, stdio: 'pipe' });

      writePageFile(config, 'test-page', 'content');
      withoutSandbox(() => gitAutoCommit(config, 'put: test-page — created'));

      const log = execSync('git log --oneline', { cwd: brainDir, encoding: 'utf-8' });
      expect(log).toContain('put: test-page');
    });

    test('no-op if no git repo', () => {
      mkdirSync(join(brainDir, 'pages'), { recursive: true });
      // No git init — should not throw
      writePageFile(config, 'test', 'content');
      expect(() => withoutSandbox(() => gitAutoCommit(config, 'test'))).not.toThrow();
    });

    test('no-op if nothing changed', () => {
      initBrainDirs(brainDir);
      execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: brainDir, stdio: 'pipe' });

      // First commit
      writePageFile(config, 'test', 'content');
      withoutSandbox(() => gitAutoCommit(config, 'first'));

      // Second commit with no changes — should not create a new commit
      withoutSandbox(() => gitAutoCommit(config, 'second'));

      const log = execSync('git log --oneline', { cwd: brainDir, encoding: 'utf-8' });
      const lines = log.trim().split('\n');
      expect(lines.length).toBe(1);
    });
  });

  // ── T41: export targets pages/ ──

  describe('T41: getPagesDir', () => {
    test('returns pages/ under brain dir for PGLite config', () => {
      const dir = getPagesDir(config);
      expect(dir).toBe(join(brainDir, 'pages'));
    });

    test('export defaults to pages/ dir when config is available (R5)', async () => {
      const { readFileSync } = await import('fs');
      const code = readFileSync(new URL('../src/commands/export.ts', import.meta.url), 'utf-8');
      // Must default to getPagesDir(config) instead of ./export when config is present
      expect(code).toContain('getPagesDir(config)');
      // ./export should only be the last fallback when no config
      const exportIdx = code.indexOf("'./export'");
      const configIdx = code.indexOf('getPagesDir(config)');
      expect(configIdx).toBeGreaterThan(-1);
      expect(configIdx).toBeLessThan(exportIdx); // pages/ dir checked before ./export fallback
    });
  });

  // ── helpers ──

  describe('getBrainDir', () => {
    test('returns parent of database_path for PGLite', () => {
      expect(getBrainDir(config)).toBe(brainDir);
    });

    test('returns ~/.cfbrain for postgres config', () => {
      const pgConfig: GBrainConfig = { engine: 'postgres', database_url: 'postgresql://...' };
      // Asserts the production fallback, which the sandbox guard turns into a throw.
      const dir = withoutSandbox(() => getBrainDir(pgConfig));
      expect(dir).toContain('.cfbrain');
    });
  });

  // ── T42: rebuild (operation-level, tested via the operation contract) ──

  describe('T42: rebuild operation exists', () => {
    test('rebuild is in the operations list', async () => {
      const { operations } = await import('../src/core/operations.ts');
      const rebuild = operations.find(op => op.name === 'rebuild');
      expect(rebuild).toBeDefined();
      expect(rebuild!.description).toContain('Rebuild');
    });
  });
});
