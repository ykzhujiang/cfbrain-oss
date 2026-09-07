import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { extractWikiLinks } from '../src/core/operations.ts';

const code = readFileSync(new URL('../src/commands/feishu.ts', import.meta.url), 'utf-8');

describe('Spec 41: stale wiki-link rewrite on push', () => {
  // ----------------------------------------------------------------
  // T205: hasNewlyAvailableWikiLinks helper exists and is correct
  // ----------------------------------------------------------------
  describe('hasNewlyAvailableWikiLinks helper', () => {
    test('helper function exists in feishu.ts', () => {
      expect(code).toContain('async function hasNewlyAvailableWikiLinks');
    });

    test('extracts wiki-links from compiled_truth using extractWikiLinks', () => {
      expect(code).toContain('extractWikiLinks');
      // The import should be at the top
      const importSection = code.slice(0, 2000);
      expect(importSection).toContain("import { extractWikiLinks } from '../core/operations.ts'");
    });

    test('queries page last_push_at from feishu_sync', () => {
      const helperIdx = code.indexOf('async function hasNewlyAvailableWikiLinks');
      expect(helperIdx).toBeGreaterThan(-1);
      const helperCode = code.slice(helperIdx, helperIdx + 2000);
      expect(helperCode).toContain('last_push_at');
      expect(helperCode).toContain('feishu_sync');
    });

    test('compares referenced slug push time against page push time', () => {
      const helperIdx = code.indexOf('async function hasNewlyAvailableWikiLinks');
      const helperCode = code.slice(helperIdx, helperIdx + 2000);
      // Should compare timestamps: refPushAt >= selfPushAt (T206: >= catches same-batch pushes)
      expect(helperCode).toContain('selfPushAt');
      expect(helperCode).toContain('refPushAt');
    });

    test('returns false when no wiki-links present', () => {
      const helperIdx = code.indexOf('async function hasNewlyAvailableWikiLinks');
      const helperCode = code.slice(helperIdx, helperIdx + 2000);
      // Early return for empty wiki-links
      expect(helperCode).toContain('wikiSlugs.length === 0');
      expect(helperCode).toContain('return false');
    });

    test('skips self-references', () => {
      const helperIdx = code.indexOf('async function hasNewlyAvailableWikiLinks');
      const helperCode = code.slice(helperIdx, helperIdx + 2000);
      expect(helperCode).toContain('refSlug === slug');
    });

    // T206: >= comparison catches same-batch pushes
    test('uses >= comparison for timestamp check (T206: same-batch push fix)', () => {
      const helperIdx = code.indexOf('async function hasNewlyAvailableWikiLinks');
      const helperCode = code.slice(helperIdx, helperIdx + 2000);
      // Must use >= not > to catch pages pushed in the same second
      expect(helperCode).toContain('refPushAt >= selfPushAt');
      // Must NOT use strict > (which misses same-timestamp)
      expect(helperCode).not.toMatch(/refPushAt > selfPushAt[^=]/);
    });
  });

  // ----------------------------------------------------------------
  // Single-slug mode: Spec 41 R4 (bypass content_hash skip)
  // ----------------------------------------------------------------
  describe('single-slug mode bypass', () => {
    test('Spec 41 comment is present in single-slug skip block', () => {
      const singleSlugIdx = code.indexOf('// e. For single-slug mode');
      expect(singleSlugIdx).toBeGreaterThan(-1);
      const singleSection = code.slice(singleSlugIdx, singleSlugIdx + 2000);
      expect(singleSection).toContain('Spec 41');
    });

    test('calls hasNewlyAvailableWikiLinks before skipping in single-slug mode', () => {
      const singleSlugIdx = code.indexOf('// e. For single-slug mode');
      const singleSection = code.slice(singleSlugIdx, singleSlugIdx + 2000);
      // The hash check should precede the wiki-link check
      const hashCheckIdx = singleSection.indexOf('storedSingleHash === page.content_hash');
      const wikiLinkCheckIdx = singleSection.indexOf('hasNewlyAvailableWikiLinks');
      expect(hashCheckIdx).toBeGreaterThan(-1);
      expect(wikiLinkCheckIdx).toBeGreaterThan(-1);
      // Wiki-link check happens only after hash check determines a skip
      expect(wikiLinkCheckIdx).toBeGreaterThan(hashCheckIdx);
    });

    test('uses singleSkip variable to allow bypass', () => {
      const singleSlugIdx = code.indexOf('// e. For single-slug mode');
      const singleSection = code.slice(singleSlugIdx, singleSlugIdx + 2000);
      expect(singleSection).toContain('singleSkip');
      // singleSkip = false when stale links detected
      expect(singleSection).toContain('singleSkip = false');
    });

    test('logs REWRITE message when wiki-link targets updated', () => {
      const singleSlugIdx = code.indexOf('// e. For single-slug mode');
      const singleSection = code.slice(singleSlugIdx, singleSlugIdx + 2000);
      expect(singleSection).toContain('REWRITE');
      expect(singleSection).toContain('wiki-link targets updated');
    });
  });

  // ----------------------------------------------------------------
  // Multi-page Pass 2 mode: Spec 41 R4 (bypass content_hash skip)
  // ----------------------------------------------------------------
  describe('multi-page Pass 2 bypass', () => {
    test('Spec 41 comment is present in Pass 2 skip block', () => {
      const pass2Idx = code.indexOf('Pass 2: Writing content');
      expect(pass2Idx).toBeGreaterThan(-1);
      const pass2Section = code.slice(pass2Idx, pass2Idx + 3000);
      expect(pass2Section).toContain('Spec 41');
    });

    test('calls hasNewlyAvailableWikiLinks before skipping in Pass 2', () => {
      const pass2Idx = code.indexOf('Pass 2: Writing content');
      const pass2Section = code.slice(pass2Idx, pass2Idx + 3000);
      const hashCheckIdx = pass2Section.indexOf('storedHash === page.content_hash');
      const wikiLinkCheckIdx = pass2Section.indexOf('hasNewlyAvailableWikiLinks');
      expect(hashCheckIdx).toBeGreaterThan(-1);
      expect(wikiLinkCheckIdx).toBeGreaterThan(-1);
      expect(wikiLinkCheckIdx).toBeGreaterThan(hashCheckIdx);
    });

    test('uses pass2Skip variable to allow bypass', () => {
      const pass2Idx = code.indexOf('Pass 2: Writing content');
      const pass2Section = code.slice(pass2Idx, pass2Idx + 3000);
      expect(pass2Section).toContain('pass2Skip');
      expect(pass2Section).toContain('pass2Skip = false');
    });

    test('logs REWRITE message when wiki-link targets updated in Pass 2', () => {
      const pass2Idx = code.indexOf('Pass 2: Writing content');
      const pass2Section = code.slice(pass2Idx, pass2Idx + 3000);
      expect(pass2Section).toContain('REWRITE');
      expect(pass2Section).toContain('wiki-link targets updated');
    });
  });

  // ----------------------------------------------------------------
  // extractWikiLinks unit tests (behavioral, not source inspection)
  // ----------------------------------------------------------------
  describe('extractWikiLinks integration with stale detection', () => {
    test('extracts wiki-links from content', () => {
      const links = extractWikiLinks('See [[page-b]] and [[page-c]] for details.');
      expect(links).toContain('page-b');
      expect(links).toContain('page-c');
      expect(links).toHaveLength(2);
    });

    test('returns empty for content without wiki-links', () => {
      const links = extractWikiLinks('No links here, just plain text.');
      expect(links).toHaveLength(0);
    });

    test('deduplicates repeated wiki-links', () => {
      const links = extractWikiLinks('See [[page-b]] and again [[page-b]].');
      expect(links).toHaveLength(1);
      expect(links[0]).toBe('page-b');
    });

    test('handles multiple different wiki-links', () => {
      const links = extractWikiLinks('Links: [[a]], [[b]], [[c]]');
      expect(links).toHaveLength(3);
    });
  });

  // ----------------------------------------------------------------
  // R3: No overhead for pages without wiki-links
  // ----------------------------------------------------------------
  describe('R3: efficiency — no overhead for non-wiki-link pages', () => {
    test('hasNewlyAvailableWikiLinks returns early on empty wiki-links', () => {
      const helperIdx = code.indexOf('async function hasNewlyAvailableWikiLinks');
      const helperCode = code.slice(helperIdx, helperIdx + 500);
      // First check is for empty wiki-links
      const earlyReturnIdx = helperCode.indexOf('wikiSlugs.length === 0');
      expect(earlyReturnIdx).toBeGreaterThan(-1);
      // Early return should be before any DB query
      const dbQueryIdx = helperCode.indexOf('rawQuery');
      expect(earlyReturnIdx).toBeLessThan(dbQueryIdx);
    });
  });
});
