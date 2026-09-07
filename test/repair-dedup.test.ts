import { describe, test, expect } from 'bun:test';

describe('repair --dedup', () => {
  /**
   * Helper: create a mock engine that simulates PGLite responses for dedup testing.
   */
  function createMockEngine(options: {
    pagesExist?: boolean;
    chunksExist?: boolean;
    dupPages?: Array<{ slug: string; cnt: number }>;
    dupChunks?: Array<{ page_id: number; chunk_index: number; cnt: number }>;
  } = {}) {
    const {
      pagesExist = true,
      chunksExist = true,
      dupPages = [],
      dupChunks = [],
    } = options;

    const executedSql: string[] = [];
    let pagesDeduped = false;
    let chunksDeduped = false;

    const mockEngine = {
      executedSql,
      executeRaw: async (sql: string, _params?: unknown[]) => {
        executedSql.push(sql);

        // Table existence checks
        if (sql.includes("to_regclass('pages')")) {
          return [{ exists: pagesExist }];
        }
        if (sql.includes("to_regclass('content_chunks')")) {
          return [{ exists: chunksExist }];
        }
        // Generic to_regclass for other tables (for --index path)
        if (sql.includes('to_regclass')) {
          return [{ exists: true }];
        }

        // Pages duplicate check
        if (sql.includes('FROM pages GROUP BY slug HAVING')) {
          if (pagesDeduped) return [];
          return dupPages.map(d => ({ slug: d.slug, cnt: d.cnt }));
        }

        // Content chunks duplicate check
        if (sql.includes('FROM content_chunks GROUP BY page_id, chunk_index HAVING')) {
          if (chunksDeduped) return [];
          return dupChunks.map(d => ({
            page_id: d.page_id,
            chunk_index: d.chunk_index,
            cnt: d.cnt,
          }));
        }

        // DELETE operations (dedup)
        if (sql.includes('DELETE FROM pages')) {
          pagesDeduped = true;
          return [];
        }
        if (sql.includes('DELETE FROM content_chunks')) {
          chunksDeduped = true;
          return [];
        }

        // REINDEX
        if (sql.startsWith('REINDEX')) {
          return [];
        }

        // pg_indexes query (for --index path)
        if (sql.includes('pg_indexes')) {
          return [];
        }

        return [];
      },
      disconnect: async () => {},
    };

    return mockEngine;
  }

  test('repair --dedup is idempotent when no duplicates exist', async () => {
    const mockEngine = createMockEngine({
      dupPages: [],
      dupChunks: [],
    });

    // Mock process.exit to prevent test from exiting
    const originalExit = process.exit;
    (process as any).exit = (_code?: number) => {};

    try {
      const { runRepair } = await import('../src/commands/repair.ts');
      await runRepair(mockEngine as any, ['--dedup']);
    } catch {
      // May throw due to incomplete mock
    } finally {
      (process as any).exit = originalExit;
    }

    // Should NOT execute any DELETE statements when no duplicates found
    const deleteCalls = mockEngine.executedSql.filter(s => s.includes('DELETE FROM'));
    expect(deleteCalls.length).toBe(0);

    // Should still check both tables
    const pagesCheck = mockEngine.executedSql.some(s => s.includes('FROM pages GROUP BY slug'));
    const chunksCheck = mockEngine.executedSql.some(s =>
      s.includes('FROM content_chunks GROUP BY page_id, chunk_index'),
    );
    expect(pagesCheck).toBe(true);
    expect(chunksCheck).toBe(true);
  });

  test('repair --dedup deletes duplicate pages rows', async () => {
    const mockEngine = createMockEngine({
      dupPages: [
        { slug: 'person-alice', cnt: 3 },
        { slug: 'company-acme', cnt: 2 },
      ],
      dupChunks: [],
    });

    const originalExit = process.exit;
    (process as any).exit = (_code?: number) => {};

    try {
      const { runRepair } = await import('../src/commands/repair.ts');
      await runRepair(mockEngine as any, ['--dedup']);
    } catch {
      // Expected
    } finally {
      (process as any).exit = originalExit;
    }

    // Should execute DELETE for pages
    const pagesDelete = mockEngine.executedSql.some(
      s => s.includes('DELETE FROM pages') && s.includes('ROW_NUMBER'),
    );
    expect(pagesDelete).toBe(true);

    // Should REINDEX pages after dedup
    const pagesReindex = mockEngine.executedSql.some(s => s === 'REINDEX TABLE pages');
    expect(pagesReindex).toBe(true);
  });

  test('repair --dedup deletes duplicate content_chunks rows', async () => {
    const mockEngine = createMockEngine({
      dupPages: [],
      dupChunks: [
        { page_id: 1, chunk_index: 0, cnt: 2 },
        { page_id: 1, chunk_index: 1, cnt: 3 },
      ],
    });

    const originalExit = process.exit;
    (process as any).exit = (_code?: number) => {};

    try {
      const { runRepair } = await import('../src/commands/repair.ts');
      await runRepair(mockEngine as any, ['--dedup']);
    } catch {
      // Expected
    } finally {
      (process as any).exit = originalExit;
    }

    // Should execute DELETE for content_chunks
    const chunksDelete = mockEngine.executedSql.some(
      s => s.includes('DELETE FROM content_chunks') && s.includes('ROW_NUMBER'),
    );
    expect(chunksDelete).toBe(true);

    // Should REINDEX content_chunks after dedup
    const chunksReindex = mockEngine.executedSql.some(s => s === 'REINDEX TABLE content_chunks');
    expect(chunksReindex).toBe(true);
  });

  test('repair --all includes dedup behavior', async () => {
    const mockEngine = createMockEngine({
      dupPages: [{ slug: 'test-slug', cnt: 2 }],
      dupChunks: [],
    });

    // Need listPages for --all (which includes --links)
    (mockEngine as any).listPages = async () => [];

    const originalExit = process.exit;
    (process as any).exit = (_code?: number) => {};

    try {
      const { runRepair } = await import('../src/commands/repair.ts');
      await runRepair(mockEngine as any, ['--all']);
    } catch {
      // Expected: embed import may fail
    } finally {
      (process as any).exit = originalExit;
    }

    // --all should trigger dedup (DELETE on pages)
    const pagesDelete = mockEngine.executedSql.some(
      s => s.includes('DELETE FROM pages') && s.includes('ROW_NUMBER'),
    );
    expect(pagesDelete).toBe(true);
  });

  test('repair --dedup skips tables that do not exist', async () => {
    const mockEngine = createMockEngine({
      pagesExist: false,
      chunksExist: false,
    });

    const originalExit = process.exit;
    (process as any).exit = (_code?: number) => {};

    try {
      const { runRepair } = await import('../src/commands/repair.ts');
      await runRepair(mockEngine as any, ['--dedup']);
    } catch {
      // Expected
    } finally {
      (process as any).exit = originalExit;
    }

    // Should NOT execute any DELETE or GROUP BY statements
    const deleteCalls = mockEngine.executedSql.filter(s => s.includes('DELETE FROM'));
    expect(deleteCalls.length).toBe(0);
    const groupByCalls = mockEngine.executedSql.filter(s => s.includes('GROUP BY'));
    expect(groupByCalls.length).toBe(0);
  });

  test('usage message includes --dedup', async () => {
    const { runRepair } = await import('../src/commands/repair.ts');

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
    expect(errors.some(e => e.includes('--dedup'))).toBe(true);
  });
});
