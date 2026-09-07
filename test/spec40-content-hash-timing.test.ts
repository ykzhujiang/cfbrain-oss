import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');

describe('Spec 40: content_hash timing — only store after confirmed write', () => {
  // ----------------------------------------------------------------
  // T185: content_hash update must come AFTER successful write
  // ----------------------------------------------------------------
  describe('T185: hash set only after successful write', () => {
    test('Pass 1 new-node INSERT does NOT set content_hash (uses NULL)', () => {
      // Find the new-node INSERT block in Pass 1 (before single-slug content write)
      const singleSlugIdx = code.indexOf('// e. For single-slug mode');
      const pass1Section = code.slice(0, singleSlugIdx);
      // Find the Spec 40 comment about not setting content_hash
      expect(pass1Section).toContain('Spec 40: Do NOT set content_hash here');
      // The INSERT should use NULL for content_hash
      const spec40Idx = pass1Section.indexOf('Spec 40: Do NOT set content_hash');
      const insertBlock = pass1Section.slice(spec40Idx, spec40Idx + 600);
      expect(insertBlock).toContain('NULL');
    });

    test('single-slug path updates content_hash AFTER write call', () => {
      // Find the single-slug section
      const singleSlugIdx = code.indexOf('// e. For single-slug mode');
      // Get a generous slice that includes both the write and the hash update
      const singleSection = code.slice(singleSlugIdx, singleSlugIdx + 5000);

      // The write call must come BEFORE the hash update
      const writeIdx = singleSection.indexOf('feishuIncrementalUpdateDocBlocks');
      const hashUpdateIdx = singleSection.indexOf('Spec 40: Update content_hash AFTER');
      expect(writeIdx).toBeGreaterThan(-1);
      expect(hashUpdateIdx).toBeGreaterThan(-1);
      expect(writeIdx).toBeLessThan(hashUpdateIdx);
    });

    test('Pass 2 updates content_hash AFTER write call', () => {
      // Find Pass 2 section
      const pass2Marker = code.indexOf('Pass 2: Writing content');
      expect(pass2Marker).toBeGreaterThan(-1);
      const pass2Code = code.slice(pass2Marker);

      const writeIdx = pass2Code.indexOf('feishuIncrementalUpdateDocBlocks');
      const hashUpdateIdx = pass2Code.indexOf('SET content_hash = $1');
      expect(writeIdx).toBeGreaterThan(-1);
      expect(hashUpdateIdx).toBeGreaterThan(-1);
      expect(writeIdx).toBeLessThan(hashUpdateIdx);
    });

    test('Pass 2 404-recovery INSERT does NOT set content_hash', () => {
      // Find the 404 recovery path in Pass 2
      const pass2Marker = code.indexOf('Pass 2: Writing content');
      const pass2Code = code.slice(pass2Marker);
      const recoveryIdx = pass2Code.indexOf('RECOVER');
      expect(recoveryIdx).toBeGreaterThan(-1);

      // Find the recovery INSERT
      const recoverySection = pass2Code.slice(recoveryIdx, recoveryIdx + 800);
      expect(recoverySection).toContain('Spec 40: Do NOT set content_hash');
      const insertIdx = recoverySection.indexOf('INSERT INTO feishu_sync');
      if (insertIdx > -1) {
        const insertBlock = recoverySection.slice(insertIdx, insertIdx + 500);
        expect(insertBlock).toContain('NULL');
      }
    });
  });

  // ----------------------------------------------------------------
  // T186: content_hash cleared on write failure
  // ----------------------------------------------------------------
  describe('T186: hash cleared on failure', () => {
    test('single-slug catch block clears content_hash on failure', () => {
      // The outer catch for single-slug push should clear content_hash
      const singleSlugIdx = code.indexOf('// e. For single-slug mode');
      const outerCatchSearch = code.slice(singleSlugIdx);
      // Find the first FAIL log (the outer catch)
      const failIdx = outerCatchSearch.indexOf('FAIL');
      expect(failIdx).toBeGreaterThan(-1);
      const catchSection = outerCatchSearch.slice(failIdx - 300, failIdx + 500);
      expect(catchSection).toContain('content_hash = NULL');
    });

    test('Pass 2 catch block clears content_hash on failure', () => {
      const pass2Marker = code.indexOf('Pass 2: Writing content');
      expect(pass2Marker).toBeGreaterThan(-1);
      const pass2Code = code.slice(pass2Marker);
      // Find FAIL in pass 2 catch block
      const failIdx = pass2Code.indexOf('FAIL');
      expect(failIdx).toBeGreaterThan(-1);
      const catchSection = pass2Code.slice(failIdx - 300, failIdx + 500);
      expect(catchSection).toContain('content_hash = NULL');
    });

    test('content_hash clearing is best-effort (wrapped in try/catch)', () => {
      // Both clear operations should be best-effort so they don't mask the original error
      const matches = code.match(/content_hash = NULL.*?best-effort/gs);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ----------------------------------------------------------------
  // Retry behavior — empty doc gets content on next push
  // ----------------------------------------------------------------
  describe('retry behavior — empty doc gets content on next push', () => {
    test('slugsToPush uses IS DISTINCT FROM for null-safe comparison', () => {
      expect(code).toContain('IS DISTINCT FROM');
    });

    test('single-slug skip guard requires non-null storedSingleHash', () => {
      // When storedSingleHash is null (after failure cleared it),
      // the skip guard should NOT skip — it should push
      expect(code).toContain('storedSingleHash && page.content_hash && storedSingleHash === page.content_hash');
    });

    test('Spec 40 comment markers are present for auditability', () => {
      const spec40Matches = code.match(/Spec 40/g);
      expect(spec40Matches).not.toBeNull();
      // At least 4 markers: 2 × "do not set hash" + 2 × "clear on failure" + 1 × "update after write"
      expect(spec40Matches!.length).toBeGreaterThanOrEqual(4);
    });
  });
});
