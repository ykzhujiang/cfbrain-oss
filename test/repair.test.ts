import { describe, test, expect } from 'bun:test';

describe('repair command', () => {
  test('repair module exports runRepair', async () => {
    const { runRepair } = await import('../src/commands/repair.ts');
    expect(typeof runRepair).toBe('function');
  });

  test('CLI registers repair command', async () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('repair');
  });

  test('repair --index requires no other flags', async () => {
    // Verify that --index is accepted as a valid option
    // (This test validates the argument parsing, not the actual REINDEX execution
    // which requires a live database connection)
    const { runRepair } = await import('../src/commands/repair.ts');

    // Create a mock engine that tracks executeRaw calls
    const executedSql: string[] = [];
    const mockEngine = {
      executeRaw: async (sql: string, _params?: unknown[]) => {
        executedSql.push(sql);
        // Simulate pg_indexes query
        if (sql.includes('pg_indexes')) {
          return [{ indexname: 'idx_feishu_sync_origin_unique' }];
        }
        // Simulate to_regclass check
        if (sql.includes('to_regclass')) {
          return [{ exists: true }];
        }
        // Simulate REINDEX
        if (sql.startsWith('REINDEX')) {
          return [];
        }
        return [];
      },
      disconnect: async () => {},
    };

    // Mock process.exit to prevent test from exiting
    const originalExit = process.exit;
    let exitCalled = false;
    (process as any).exit = (code?: number) => {
      exitCalled = true;
      // Don't actually exit in tests
    };

    try {
      await runRepair(mockEngine as any, ['--index']);
    } catch {
      // Expected: may throw due to incomplete mock
    } finally {
      (process as any).exit = originalExit;
    }

    // Verify that REINDEX SQL was executed
    const reindexCalls = executedSql.filter(s => s.startsWith('REINDEX'));
    expect(reindexCalls.length).toBeGreaterThan(0);
  });

  test('repair --all includes index repair', async () => {
    const { runRepair } = await import('../src/commands/repair.ts');

    const executedSql: string[] = [];
    const mockEngine = {
      executeRaw: async (sql: string, _params?: unknown[]) => {
        executedSql.push(sql);
        if (sql.includes('pg_indexes')) {
          return [{ indexname: 'idx_feishu_sync_origin_unique' }];
        }
        if (sql.includes('to_regclass')) {
          return [{ exists: true }];
        }
        if (sql.startsWith('REINDEX')) {
          return [];
        }
        return [];
      },
      listPages: async () => [],
      disconnect: async () => {},
    };

    const originalExit = process.exit;
    (process as any).exit = (_code?: number) => {};

    try {
      await runRepair(mockEngine as any, ['--all']);
    } catch {
      // Expected: may throw due to incomplete mock (embed import, etc.)
    } finally {
      (process as any).exit = originalExit;
    }

    // Verify that REINDEX SQL was executed (--all should include --index behavior)
    const reindexCalls = executedSql.filter(s => s.startsWith('REINDEX'));
    expect(reindexCalls.length).toBeGreaterThan(0);
  });

  test('repair without flags shows usage', async () => {
    const { runRepair } = await import('../src/commands/repair.ts');

    // Mock console.error to capture output
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => errors.push(args.join(' '));

    const originalExit = process.exit;
    let exitCode: number | undefined;
    (process as any).exit = (code?: number) => {
      exitCode = code;
      throw new Error('EXIT');
    };

    try {
      await runRepair({} as any, []);
    } catch (e: any) {
      if (e.message !== 'EXIT') throw e;
    } finally {
      console.error = originalError;
      (process as any).exit = originalExit;
    }

    expect(exitCode).toBe(1);
    expect(errors.some(e => e.includes('--index'))).toBe(true);
  });
});
