/**
 * Spec 49: Test-sandbox guard — the regression net for the production-brain leak.
 *
 * Between 2026-04-20 and 2026-08-29, `bun test` wrote 208 commits (21% of all
 * commits) into the production knowledge base at $HOME/.cfbrain and
 * pushed them to the cfbrain-data GitHub remote. Root cause chain: tests passed
 * `config: { engine: 'pglite' }` with no `database_path`, getBrainDir() fell back
 * to `$HOME/.cfbrain`, run_all_tests.sh set HOME to the data dir, and put_page's
 * `catch { /* silent *\/ }` hid the whole thing.
 *
 * These are **negative** assertions on purpose: they fail if the guard silently
 * stops guarding. A test that only checks "the happy path still passes" would go
 * green even if the guard were deleted outright.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir, homedir } from 'os';
import {
  getBrainDir,
  getPagesDir,
  gitAutoCommit,
  isTestSandbox,
  writePageFile,
} from '../src/core/pages-fs.ts';
import { getRawDir } from '../src/core/raw-files.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withoutSandbox } from './helpers/sandbox.ts';

let brainDir: string;
let config: GBrainConfig;

beforeEach(() => {
  brainDir = join(tmpdir(), `cfbrain-spec49-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(brainDir, { recursive: true });
  config = { engine: 'pglite', database_path: join(brainDir, 'brain.db') };
});

afterEach(() => {
  try { rmSync(brainDir, { recursive: true, force: true }); } catch {}
});

// ── The switch itself ──

describe('T49-0: sandbox switch is active during bun test', () => {
  test('bunfig.toml preload turned the sandbox on', () => {
    // If this fails, bunfig.toml's [test] preload is not being honoured and every
    // other assertion in this file is vacuous.
    expect(isTestSandbox()).toBe(true);
  });

  test('withoutSandbox() restores the previous value even when fn throws', () => {
    expect(() => withoutSandbox(() => { throw new Error('boom'); })).toThrow('boom');
    expect(isTestSandbox()).toBe(true);
  });

  test('respects an explicit CFBRAIN_TEST_SANDBOX=0 opt-out', () => {
    const previous = process.env.CFBRAIN_TEST_SANDBOX;
    process.env.CFBRAIN_TEST_SANDBOX = '0';
    try {
      expect(isTestSandbox()).toBe(false);
    } finally {
      process.env.CFBRAIN_TEST_SANDBOX = previous;
    }
  });
});

// ── Negative assertion 1: gitAutoCommit produces no commit ──

describe('T49-1: gitAutoCommit is a no-op under sandbox', () => {
  function initRepo(dir: string): string {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    execSync('git init -q && git config user.email "t@t.com" && git config user.name "T"', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -q --allow-empty -m baseline', { cwd: dir, stdio: 'pipe' });
    return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
  }

  test('HEAD is unchanged after a write + gitAutoCommit', () => {
    const before = initRepo(brainDir);

    writePageFile(config, 'sandbox-probe', 'content that must never be committed');
    gitAutoCommit(config, 'put: sandbox-probe — Page created via put_page');

    const after = execSync('git rev-parse HEAD', { cwd: brainDir, encoding: 'utf-8' }).trim();
    expect(after).toBe(before);

    // And the commit count did not grow either.
    const count = execSync('git rev-list --count HEAD', { cwd: brainDir, encoding: 'utf-8' }).trim();
    expect(count).toBe('1');
  });

  test('the file is left uncommitted rather than silently staged+committed', () => {
    initRepo(brainDir);
    writePageFile(config, 'sandbox-probe', 'content');
    gitAutoCommit(config, 'put: sandbox-probe');

    // Proves the no-op happened before `git add -A`, not after.
    // -uall so untracked files are listed individually instead of collapsing to "?? pages/".
    const porcelain = execSync('git status --porcelain -uall', { cwd: brainDir, encoding: 'utf-8' });
    expect(porcelain).toContain('sandbox-probe.md');
    expect(porcelain).toMatch(/^\?\? /m); // untracked, i.e. never staged
  });

  test('control: the same call DOES commit when the sandbox is off', () => {
    // Guards against the guard being unconditional — if gitAutoCommit were broken
    // outright (always a no-op), production would silently stop committing.
    const before = initRepo(brainDir);
    writePageFile(config, 'sandbox-probe', 'content');
    withoutSandbox(() => gitAutoCommit(config, 'put: sandbox-probe'));

    const after = execSync('git rev-parse HEAD', { cwd: brainDir, encoding: 'utf-8' }).trim();
    expect(after).not.toBe(before);
  });
});

// ── Negative assertion 2: getBrainDir throws instead of returning $HOME/.cfbrain ──

describe('T49-2: getBrainDir refuses the $HOME/.cfbrain fallback under sandbox', () => {
  const noPathConfig: GBrainConfig = { engine: 'pglite' };

  test('throws for a pglite config with no database_path', () => {
    expect(() => getBrainDir(noPathConfig)).toThrow(/CFBRAIN_TEST_SANDBOX/);
  });

  test('does not return $HOME/.cfbrain', () => {
    let returned: string | undefined;
    try { returned = getBrainDir(noPathConfig); } catch { /* expected */ }
    expect(returned).toBeUndefined();
    // Spelled out explicitly: this exact path is the production brain under
    // `HOME=$HOME/.cfbrain-data bun test`.
    expect(returned).not.toBe(join(homedir(), '.cfbrain'));
  });

  test('the throw propagates through every derived path helper', () => {
    // These are the three side-effect families the guard has to cover.
    expect(() => getPagesDir(noPathConfig)).toThrow(/CFBRAIN_TEST_SANDBOX/);
    expect(() => getRawDir(noPathConfig)).toThrow(/CFBRAIN_TEST_SANDBOX/);
    expect(() => writePageFile(noPathConfig, 'leak', 'body')).toThrow(/CFBRAIN_TEST_SANDBOX/);
  });

  test('a config WITH database_path is unaffected', () => {
    expect(getBrainDir(config)).toBe(brainDir);
  });

  test('control: falls back to $HOME/.cfbrain when the sandbox is off', () => {
    expect(withoutSandbox(() => getBrainDir(noPathConfig))).toBe(join(homedir(), '.cfbrain'));
  });
});

// ── Negative assertion 3: put_page writes stay inside the temp dir ──

describe('T49-3: put_page confines all writes to the temp brain dir', () => {
  test('every written file lands under database_path, and $HOME/.cfbrain is untouched', async () => {
    const homeBrain = join(homedir(), '.cfbrain');
    const homeBrainExistedBefore = existsSync(homeBrain);
    const homePagesBefore = homeBrainExistedBefore && existsSync(join(homeBrain, 'pages'))
      ? readdirSync(join(homeBrain, 'pages')).length
      : -1;

    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: config.database_path });
    await engine.initSchema();

    try {
      const ctx: OperationContext = {
        engine,
        config,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        dryRun: false,
      };
      const result = await operationsByName['put_page'].handler(ctx, {
        slug: 'spec49-confined',
        content: `---\ntitle: spec49-confined\ntypes: [note]\n---\nBody.`,
        no_embed: true,
      });
      expect((result as any).status).toBe('created_or_updated');

      // Landed in the temp dir…
      expect(existsSync(join(brainDir, 'pages', 'spec49-confined.md'))).toBe(true);

      // …and nowhere near the production brain.
      expect(existsSync(homeBrain)).toBe(homeBrainExistedBefore);
      const homePagesAfter = existsSync(join(homeBrain, 'pages'))
        ? readdirSync(join(homeBrain, 'pages')).length
        : -1;
      expect(homePagesAfter).toBe(homePagesBefore);
      expect(existsSync(join(homeBrain, 'pages', 'spec49-confined.md'))).toBe(false);
    } finally {
      await engine.disconnect();
    }
  });
});
