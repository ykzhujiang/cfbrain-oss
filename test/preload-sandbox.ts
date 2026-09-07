/**
 * Test-sandbox preload — runs once before any test file.
 *
 * Wired up via `bunfig.toml`'s `[test] preload`, so it applies to *every* way of
 * invoking the suite, including a developer typing a bare `bun test` locally.
 * That is why the switch lives here rather than in run_all_tests.sh: an
 * env var exported by the CI script only protects the CI path and silently
 * leaves local runs unguarded.
 *
 * Why this is needed: `bun test` runs with HOME=$HOME/.cfbrain-data,
 * so any config without a `database_path` makes getBrainDir() resolve to
 * `$HOME/.cfbrain` — the production knowledge base. Between
 * 2026-04-20 and 2026-08-29 that leaked 208 test commits (21% of all commits)
 * into the cfbrain-data git repo and its GitHub remote.
 *
 * `??=` is used so an explicit `CFBRAIN_TEST_SANDBOX=0` from the environment wins.
 * That escape hatch is what lets TC-32's counter-example reproduce the old
 * leaking behaviour on demand.
 */
process.env.CFBRAIN_TEST_SANDBOX ??= '1';
