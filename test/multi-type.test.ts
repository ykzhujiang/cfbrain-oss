/**
 * Multi-Type Unit Tests — verifies multi-type page functionality using PGLite engine.
 *
 * No Docker, no DATABASE_URL, no external dependencies. Runs instantly in CI.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown, inferTypes } from '../src/core/markdown.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  const tables = [
    'content_chunks', 'links', 'tags', 'raw_data',
    'page_versions', 'ingest_log', 'pages',
  ];
  for (const t of tables) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// putPage with multiple types
// ─────────────────────────────────────────────────────────────────
describe('Multi-type: putPage', () => {
  beforeAll(truncateAll);

  test('putPage with types: [person, founder] stores both types', async () => {
    const input: PageInput = {
      types: ['person', 'founder'],
      title: 'Jane Doe',
      compiled_truth: 'Jane Doe is a founder and investor.',
    };
    const page = await engine.putPage('people/jane-doe', input);
    expect(page.slug).toBe('people/jane-doe');
    expect(page.types).toContain('person');
    expect(page.types).toContain('founder');
    expect(page.types).toHaveLength(2);
  });

  test('getPage round-trips multiple types faithfully', async () => {
    const fetched = await engine.getPage('people/jane-doe');
    expect(fetched).not.toBeNull();
    expect(fetched!.types).toContain('person');
    expect(fetched!.types).toContain('founder');
    expect(fetched!.types).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// listPages types filter matches multi-type pages
// ─────────────────────────────────────────────────────────────────
describe('Multi-type: listPages filter', () => {
  beforeAll(async () => {
    await truncateAll();
    // Page with two types — should appear in both filtered lists
    await engine.putPage('people/alice', {
      types: ['person', 'founder'],
      title: 'Alice',
      compiled_truth: 'Alice is both a person and a founder.',
    });
    // Page with only 'company' type — should not appear in person filter
    await engine.putPage('companies/acme', {
      types: ['company'],
      title: 'ACME',
      compiled_truth: 'ACME Corp.',
    });
    // Page with only 'person' type — should appear in person filter
    await engine.putPage('people/bob', {
      types: ['person'],
      title: 'Bob',
      compiled_truth: 'Bob is a person.',
    });
  });

  test('filtering by person returns multi-type page [person, founder]', async () => {
    const results = await engine.listPages({ types: ['person'] });
    const slugs = results.map(p => p.slug);
    expect(slugs).toContain('people/alice');
  });

  test('filtering by founder returns multi-type page [person, founder]', async () => {
    const results = await engine.listPages({ types: ['founder'] });
    const slugs = results.map(p => p.slug);
    expect(slugs).toContain('people/alice');
  });

  test('filtering by person excludes company-only page', async () => {
    const results = await engine.listPages({ types: ['person'] });
    const slugs = results.map(p => p.slug);
    expect(slugs).not.toContain('companies/acme');
  });

  test('filtering by person returns both person-only and multi-type pages', async () => {
    const results = await engine.listPages({ types: ['person'] });
    const slugs = results.map(p => p.slug);
    expect(slugs).toContain('people/alice');
    expect(slugs).toContain('people/bob');
    expect(results.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// getStats multi-counts correctly
// ─────────────────────────────────────────────────────────────────
describe('Multi-type: getStats', () => {
  beforeAll(async () => {
    await truncateAll();
    // One page with two types — must count in both buckets
    await engine.putPage('people/multi-stat', {
      types: ['person', 'founder'],
      title: 'Multi Stat Person',
      compiled_truth: 'Counts in both buckets.',
    });
    // One page with a single type
    await engine.putPage('companies/single-stat', {
      types: ['company'],
      title: 'Single Stat Company',
      compiled_truth: 'Counts once.',
    });
  });

  test('pages_by_type counts person for a [person, founder] page', async () => {
    const stats = await engine.getStats();
    expect(stats.pages_by_type['person']).toBe(1);
  });

  test('pages_by_type counts founder for a [person, founder] page', async () => {
    const stats = await engine.getStats();
    expect(stats.pages_by_type['founder']).toBe(1);
  });

  test('pages_by_type counts company separately', async () => {
    const stats = await engine.getStats();
    expect(stats.pages_by_type['company']).toBe(1);
  });

  test('page_count reflects total pages, not total type memberships', async () => {
    const stats = await engine.getStats();
    expect(stats.page_count).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// Backward compat: single-element array
// ─────────────────────────────────────────────────────────────────
describe('Multi-type: backward compat single-element array', () => {
  beforeAll(truncateAll);

  test('types: [person] (single element array) stores and retrieves correctly', async () => {
    const input: PageInput = {
      types: ['person'],
      title: 'Solo Type Person',
      compiled_truth: 'This page has exactly one type.',
    };
    const page = await engine.putPage('people/solo', input);
    expect(page.types).toEqual(['person']);
    expect(page.types).toHaveLength(1);
  });

  test('single-type page appears in listPages filter', async () => {
    const results = await engine.listPages({ types: ['person'] });
    const slugs = results.map(p => p.slug);
    expect(slugs).toContain('people/solo');
  });

  test('single-type page counted correctly in getStats', async () => {
    const stats = await engine.getStats();
    expect(stats.pages_by_type['person']).toBe(1);
    expect(stats.page_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// inferTypes path-based inference
// ─────────────────────────────────────────────────────────────────
describe('Multi-type: inferTypes path inference', () => {
  test('returns [concept] when no filePath provided', () => {
    expect(inferTypes()).toEqual(['concept']);
  });

  test('people/ directory infers person', () => {
    expect(inferTypes('people/jane-doe.md')).toEqual(['person']);
  });

  test('person/ directory infers person', () => {
    expect(inferTypes('person/john.md')).toEqual(['person']);
  });

  test('companies/ directory infers company', () => {
    expect(inferTypes('companies/acme.md')).toEqual(['company']);
  });

  test('company/ directory infers company', () => {
    expect(inferTypes('company/startup.md')).toEqual(['company']);
  });

  test('deals/ directory infers deal', () => {
    expect(inferTypes('deals/series-a.md')).toEqual(['deal']);
  });

  test('projects/ directory infers project', () => {
    expect(inferTypes('projects/brain.md')).toEqual(['project']);
  });

  test('meetings/ directory infers meeting', () => {
    expect(inferTypes('meetings/2024-01-15.md')).toEqual(['meeting']);
  });

  test('decisions/ directory infers decision', () => {
    expect(inferTypes('decisions/pricing.md')).toEqual(['decision']);
  });

  test('intel/ directory infers intel', () => {
    expect(inferTypes('intel/competitive.md')).toEqual(['intel']);
  });

  test('notes/ directory infers note', () => {
    expect(inferTypes('notes/scratch.md')).toEqual(['note']);
  });

  test('concepts/ directory infers concept', () => {
    expect(inferTypes('concepts/rag.md')).toEqual(['concept']);
  });

  test('unrecognized path falls back to concept', () => {
    expect(inferTypes('random/unknown/path.md')).toEqual(['concept']);
  });

  test('path matching is case-insensitive', () => {
    expect(inferTypes('PEOPLE/Jane.md')).toEqual(['person']);
    expect(inferTypes('Companies/Acme.md')).toEqual(['company']);
  });

  test('nested path still matches directory segment', () => {
    expect(inferTypes('brain/people/nested-person.md')).toEqual(['person']);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseMarkdown multi-type frontmatter parsing
// ─────────────────────────────────────────────────────────────────
describe('Multi-type: parseMarkdown types frontmatter', () => {
  test('types: array in frontmatter parses all types', () => {
    const md = `---
types:
  - person
  - founder
title: Alice
---
Alice is a founder.
`;
    const parsed = parseMarkdown(md, 'people/alice.md');
    expect(parsed.types).toContain('person');
    expect(parsed.types).toContain('founder');
    expect(parsed.types).toHaveLength(2);
  });

  test('singular type: in frontmatter is backward-compat (coerced to array)', () => {
    const md = `---
type: person
title: Bob
---
Bob is a person.
`;
    const parsed = parseMarkdown(md, 'people/bob.md');
    expect(parsed.types).toEqual(['person']);
    expect(parsed.types).toHaveLength(1);
  });

  test('no type in frontmatter falls back to path inference', () => {
    const md = `---
title: Inferred
---
No type specified.
`;
    const parsed = parseMarkdown(md, 'companies/inferred.md');
    expect(parsed.types).toEqual(['company']);
  });

  test('frontmatter types overrides path inference', () => {
    // Even if the path says "companies/", the explicit types: wins
    const md = `---
types:
  - person
  - investor
title: Hybrid
---
Hybrid entity.
`;
    const parsed = parseMarkdown(md, 'companies/hybrid.md');
    expect(parsed.types).toContain('person');
    expect(parsed.types).toContain('investor');
    expect(parsed.types).not.toContain('company');
  });
});
