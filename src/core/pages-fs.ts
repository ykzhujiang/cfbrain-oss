/**
 * File-system operations for pages/ directory.
 * pages/ is the authoritative truth source — database is just a search index.
 */

import { writeFileSync, unlinkSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { execSync, spawn } from 'child_process';
import { homedir } from 'os';
import type { GBrainConfig } from './config.ts';

/**
 * Test-sandbox switch — the single chokepoint that keeps `bun test` from writing
 * into the real knowledge base.
 *
 * Enabled by the `CFBRAIN_TEST_SANDBOX` env var, which `bunfig.toml`'s
 * `[test] preload` sets for the whole `bun test` run (see test/preload-sandbox.ts).
 * **Default is OFF**: production `cfbrain put` behaviour is byte-for-byte unchanged.
 *
 * When ON, the two guards below block every irreversible side effect:
 *
 *  - `gitAutoCommit()` becomes a no-op. This is the critical one: it auto-pushes
 *    to the `cfbrain-data` remote, and remote history cannot be un-written without
 *    a force-push (a hard guardrail violation).
 *  - `getBrainDir()` throws instead of silently falling back to `$HOME/.cfbrain`
 *    when `config.database_path` is absent. Because *every* filesystem side effect
 *    resolves its target through `getBrainDir()` — `writePageFile()`, `getPagesDir()`,
 *    `getRawDir()`/`copyToRaw()`/`writeRawText()`, and `appendChangelog()` — one guard
 *    here covers all three side-effect families the PRD requires (pages / raw / git).
 *
 * Set `CFBRAIN_TEST_SANDBOX=0` to deliberately disable it (used to build the
 * TC-32 counter-example, which must FAIL when the guard is off).
 */
export function isTestSandbox(): boolean {
  const v = process.env.CFBRAIN_TEST_SANDBOX;
  if (v === undefined || v === '') return false;
  return v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * Resolve the brain directory from config.
 * PGLite: parent of database_path. Postgres: ~/.cfbrain.
 *
 * In test-sandbox mode the `$HOME/.cfbrain` fallback is refused loudly — see
 * isTestSandbox(). The throw is deliberate and must stay *un*swallowed at the
 * put_page call site (operations.ts reads brainDir outside its try/catch), so a
 * leaking test goes red instead of quietly writing to the production brain.
 */
export function getBrainDir(config: GBrainConfig): string {
  if (config.database_path) {
    return dirname(config.database_path);
  }
  if (isTestSandbox()) {
    throw new Error(
      'CFBRAIN_TEST_SANDBOX is on and config.database_path is missing — refusing to ' +
      'fall back to $HOME/.cfbrain, which under `bun test` resolves to the production ' +
      'knowledge base. Give this config a database_path inside a temp dir (see ' +
      'test/spec47-types-cli.test.ts for the pattern), or wrap the call in ' +
      'withoutSandbox() from test/helpers/sandbox.ts if you are intentionally ' +
      'asserting production fallback behaviour.'
    );
  }
  return join(homedir(), '.cfbrain');
}

/**
 * Get the pages/ directory path.
 */
export function getPagesDir(config: GBrainConfig): string {
  return join(getBrainDir(config), 'pages');
}

/**
 * Write a page file to pages/<slug>.md.
 * Creates intermediate directories if needed.
 * Fire-and-forget safe — errors are thrown but callers should catch.
 */
export function writePageFile(config: GBrainConfig, slug: string, content: string): void {
  const filePath = join(getPagesDir(config), slug + '.md');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * Delete a page file. Moves to pages/.trash/ for safety.
 * No error if the file doesn't exist.
 */
export function deletePageFile(config: GBrainConfig, slug: string): void {
  const pagesDir = getPagesDir(config);
  const filePath = join(pagesDir, slug + '.md');

  if (!existsSync(filePath)) return;

  // Move to .trash/ for safety instead of hard delete
  const trashDir = join(pagesDir, '.trash');
  const trashPath = join(trashDir, slug + '.md');
  mkdirSync(dirname(trashPath), { recursive: true });
  renameSync(filePath, trashPath);
}

/**
 * Auto-commit changes in the brain's git repo.
 * Fire-and-forget — failures are silently ignored.
 * Checks brain dir first (new layout), falls back to pages/ (legacy).
 */
export function gitAutoCommit(config: GBrainConfig, message: string): void {
  // Must be the very first statement: this function auto-pushes, and pushed
  // history is the one side effect that cannot be undone without a force-push.
  if (isTestSandbox()) return;

  const brainDir = getBrainDir(config);
  const pagesDir = getPagesDir(config);

  // Determine git root: prefer brain dir (new), fall back to pages/ (legacy)
  let gitRoot: string;
  if (existsSync(join(brainDir, '.git'))) {
    gitRoot = brainDir;
  } else if (existsSync(join(pagesDir, '.git'))) {
    gitRoot = pagesDir;
  } else {
    return; // No git repo
  }

  try {
    execSync('git add -A && git checkout HEAD -- .gitattributes .gitignore 2>/dev/null; git diff --cached --quiet || git commit -m ' + JSON.stringify(message), {
      cwd: gitRoot,
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch {
    // Non-fatal — git failures must never break brain operations
  }

  // Auto-push if remote is configured (fire-and-forget, background)
  try {
    const hasRemote = execSync('git remote get-url origin 2>/dev/null', {
      cwd: gitRoot, stdio: 'pipe', timeout: 5_000,
    }).toString().trim();
    if (hasRemote) {
      spawn('git', ['push'], { cwd: gitRoot, stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // No remote configured or push failed — silent
  }
}
