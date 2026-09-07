import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { LATEST_VERSION } from '../src/core/migrate.ts';

const migrateEngineSource = readFileSync(
  new URL('../src/commands/migrate-engine.ts', import.meta.url),
  'utf-8'
);

describe('migrate', () => {
  test('LATEST_VERSION is a number >= 1', () => {
    expect(typeof LATEST_VERSION).toBe('number');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(1);
  });

  test('runMigrations is exported and callable', async () => {
    const { runMigrations } = await import('../src/core/migrate.ts');
    expect(typeof runMigrations).toBe('function');
  });

  // Integration tests for actual migration execution require DATABASE_URL
  // and are covered in the E2E suite (test/e2e/mechanical.test.ts)
});

describe('migrate-engine structural checks (T79/T80)', () => {
  test('manifest path uses .cfbrain', () => {
    expect(migrateEngineSource).toContain('.cfbrain');
    expect(migrateEngineSource).toContain('migrate-manifest.json');
  });

  test('PGLite target path uses .cfbrain', () => {
    expect(migrateEngineSource).toContain("'.cfbrain'");
    expect(migrateEngineSource).toContain('brain.pglite');
  });

  test('CFBRAIN_DATABASE_URL env var is checked', () => {
    expect(migrateEngineSource).toContain('CFBRAIN_DATABASE_URL');
  });

  test('backward compat checks .gbrain', () => {
    expect(migrateEngineSource).toContain('.gbrain');
  });

  test('version migration is attempted via createVersion', () => {
    expect(migrateEngineSource).toContain('createVersion');
  });
});
