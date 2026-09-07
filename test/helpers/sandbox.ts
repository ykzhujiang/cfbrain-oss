/**
 * Escape hatch for tests that deliberately assert *production* behaviour of the
 * side-effect paths guarded by CFBRAIN_TEST_SANDBOX (see src/core/pages-fs.ts).
 *
 * Two legitimate cases exist:
 *   - spec14/spec25 exercise gitAutoCommit() itself, against a throwaway git repo
 *     under $TMPDIR. They need real commits to assert on.
 *   - spec14 asserts that a postgres config (no database_path) falls back to
 *     `~/.cfbrain`, which the sandbox guard otherwise turns into a throw.
 *
 * Restores the previous value in a `finally`, so a failing assertion inside `fn`
 * cannot leak an unguarded env var into the rest of the file.
 */
export function withoutSandbox<T>(fn: () => T): T {
  const previous = process.env.CFBRAIN_TEST_SANDBOX;
  delete process.env.CFBRAIN_TEST_SANDBOX;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CFBRAIN_TEST_SANDBOX;
    } else {
      process.env.CFBRAIN_TEST_SANDBOX = previous;
    }
  }
}
