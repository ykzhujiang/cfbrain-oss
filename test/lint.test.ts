import { describe, test, expect } from 'bun:test';
import { lintUnattributed, lintStale } from '../src/core/lint.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a date string that is `days` days before today (UTC). */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// lintUnattributed
// ---------------------------------------------------------------------------

describe('lintUnattributed', () => {
  test('flags a plain bullet line with no source tag', () => {
    const text = '- This person works at Acme Corp as a senior engineer.';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].rule).toBe('unattributed-claim');
    expect(warnings[0].line).toBe(1);
  });

  test('flags a plain paragraph line with no source tag', () => {
    const text = 'She is known for her work on distributed systems and databases.';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].rule).toBe('unattributed-claim');
  });

  test('does not flag a line carrying [observed: ...] tag', () => {
    const text = '- Works at Acme Corp as a senior engineer. [observed: LinkedIn, 2024-01-15]';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(0);
  });

  test('does not flag a line carrying [self-described: ...] tag', () => {
    const text = '- Describes herself as a "people-first leader". [self-described: Twitter bio, 2024-03-01]';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(0);
  });

  test('does not flag a line carrying [reported: ...] tag', () => {
    const text = '- Was promoted to VP of Engineering in Q2. [reported: TechCrunch, 2024-06-10]';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(0);
  });

  test('does not flag a line carrying [inferred: ...] tag', () => {
    const text = '- Likely manages a team of 20+ engineers. [inferred: org chart depth, 2024-05-01]';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(0);
  });

  test('skips short lines (< 20 chars)', () => {
    const text = '- Short line.';
    expect(text.trim().length).toBeLessThan(20);
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(0);
  });

  test('skips markdown headers', () => {
    const text = '## Background\n### Professional history';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(0);
  });

  test('skips blank lines', () => {
    const text = '\n\n   \n';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(0);
  });

  test('skips blockquote lines (starting with >)', () => {
    const text = '> This is a blockquote that is definitely longer than twenty characters.';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(0);
  });

  test('skips table rows (starting with |)', () => {
    const text = '| Column A | Column B | Column C | more content here |';
    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(0);
  });

  test('reports correct line numbers in multi-line input', () => {
    const text = [
      '## Professional Background',
      '',
      '- Works at Acme Corp as a senior engineer.',        // line 3 — flagged
      '- Leads the platform team. [observed: bio, 2024-01-01]', // line 4 — fine
      'She is known for distributed systems work here.',   // line 5 — flagged
    ].join('\n');

    const warnings = lintUnattributed(text);
    expect(warnings).toHaveLength(2);
    expect(warnings[0].line).toBe(3);
    expect(warnings[1].line).toBe(5);
  });

  test('includes suggestion in each warning', () => {
    const text = '- This person is based in San Francisco and works remotely.';
    const warnings = lintUnattributed(text);
    expect(warnings[0].suggestion).toMatch(/\[observed:/);
  });

  test('returns empty array for fully attributed content', () => {
    const text = [
      '## Summary',
      '',
      '- Works at Acme Corp. [observed: LinkedIn, 2024-01-01]',
      '- Self-described innovator. [self-described: Twitter, 2024-02-01]',
    ].join('\n');
    expect(lintUnattributed(text)).toHaveLength(0);
  });

  test('returns empty array for empty string', () => {
    expect(lintUnattributed('')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// lintStale
// ---------------------------------------------------------------------------

describe('lintStale', () => {
  test('flags a claim whose date is older than 90 days (default threshold)', () => {
    const staleDate = daysAgo(100);
    const text = `- Works at Acme Corp as a senior engineer. [observed: LinkedIn, ${staleDate}]`;
    const warnings = lintStale(text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].rule).toBe('stale-claim');
    expect(warnings[0].suggestion).toContain(staleDate);
  });

  test('does not flag a claim whose date is within 90 days', () => {
    const recentDate = daysAgo(30);
    const text = `- Works at Acme Corp as a senior engineer. [observed: LinkedIn, ${recentDate}]`;
    const warnings = lintStale(text);
    expect(warnings).toHaveLength(0);
  });

  test('does not flag a claim whose date is exactly at the threshold boundary', () => {
    // Exactly 90 days ago is NOT stale (> not >=)
    const boundaryDate = daysAgo(90);
    const text = `- Works at Acme Corp as a senior engineer. [observed: LinkedIn, ${boundaryDate}]`;
    const warnings = lintStale(text);
    expect(warnings).toHaveLength(0);
  });

  test('custom threshold of 30 days flags a 45-day-old claim', () => {
    const date = daysAgo(45);
    const text = `- Works at Acme Corp as a senior engineer. [observed: LinkedIn, ${date}]`;
    const warnings = lintStale(text, 30);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].suggestion).toContain('30 days');
  });

  test('custom threshold of 180 days does not flag a 100-day-old claim', () => {
    const date = daysAgo(100);
    const text = `- Works at Acme Corp as a senior engineer. [observed: LinkedIn, ${date}]`;
    const warnings = lintStale(text, 180);
    expect(warnings).toHaveLength(0);
  });

  test('a line with no date in source tag is not flagged as stale', () => {
    // Tag present but no YYYY-MM-DD date → lintUnattributed's concern, not lintStale
    const text = '- Works at Acme Corp as a senior engineer. [observed: LinkedIn profile]';
    const warnings = lintStale(text);
    expect(warnings).toHaveLength(0);
  });

  test('a line with no source tag at all is not flagged as stale', () => {
    const text = '- Works at Acme Corp as a senior engineer with no attribution at all here.';
    const warnings = lintStale(text);
    expect(warnings).toHaveLength(0);
  });

  test('multiple dated source tags on one line — only one warning emitted', () => {
    const staleDate = daysAgo(100);
    const alsoStaleDate = daysAgo(200);
    const text = `- Dual-sourced claim here. [observed: source-a, ${staleDate}] [reported: source-b, ${alsoStaleDate}]`;
    const warnings = lintStale(text);
    // Implementation breaks after the first stale match per line
    expect(warnings).toHaveLength(1);
    expect(warnings[0].line).toBe(1);
  });

  test('only the stale tag on a line with mixed stale/fresh tags triggers a warning', () => {
    const staleDate = daysAgo(120);
    const freshDate = daysAgo(10);
    // stale tag appears first → one warning
    const text = `- Mixed claim here. [observed: old-source, ${staleDate}] [reported: new-source, ${freshDate}]`;
    const warnings = lintStale(text);
    expect(warnings).toHaveLength(1);
  });

  test('skips blank lines', () => {
    const warnings = lintStale('\n\n   \n');
    expect(warnings).toHaveLength(0);
  });

  test('skips markdown headers', () => {
    const staleDate = daysAgo(100);
    const text = `## Header with date ${staleDate} inside it, [observed: src, ${staleDate}]`;
    const warnings = lintStale(text);
    expect(warnings).toHaveLength(0);
  });

  test('skips very short lines (< 20 chars)', () => {
    // Contrived but ensures the guard fires before date scanning
    const warnings = lintStale('Short.');
    expect(warnings).toHaveLength(0);
  });

  test('reports correct line number in multi-line input', () => {
    const staleDate = daysAgo(150);
    const freshDate = daysAgo(5);
    const text = [
      `- Fresh claim. [observed: src, ${freshDate}]`,
      '',
      `- Stale claim here. [observed: src, ${staleDate}]`,
    ].join('\n');

    const warnings = lintStale(text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].line).toBe(3);
  });

  test('returns empty array for content with no dated tags', () => {
    const text = [
      '## Summary',
      '- Some claim without any attribution at all.',
      '- Another claim, also no attribution tag.',
    ].join('\n');
    expect(lintStale(text)).toHaveLength(0);
  });

  test('returns empty array for empty string', () => {
    expect(lintStale('')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Threshold configuration
// ---------------------------------------------------------------------------

describe('threshold configuration', () => {
  test('default threshold is 90 days — claim at 89 days is not stale', () => {
    const date = daysAgo(89);
    const text = `- Works at Acme Corp as a senior engineer here. [observed: src, ${date}]`;
    expect(lintStale(text)).toHaveLength(0);
  });

  test('default threshold is 90 days — claim at 91 days is stale', () => {
    const date = daysAgo(91);
    const text = `- Works at Acme Corp as a senior engineer here. [observed: src, ${date}]`;
    expect(lintStale(text)).toHaveLength(1);
  });

  test('custom threshold 30 days — claim at 29 days is not stale', () => {
    const date = daysAgo(29);
    const text = `- Works at Acme Corp as a senior engineer here. [observed: src, ${date}]`;
    expect(lintStale(text, 30)).toHaveLength(0);
  });

  test('custom threshold 30 days — claim at 31 days is stale', () => {
    const date = daysAgo(31);
    const text = `- Works at Acme Corp as a senior engineer here. [observed: src, ${date}]`;
    const warnings = lintStale(text, 30);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].suggestion).toContain('30 days');
  });

  test('custom threshold 180 days — claim at 179 days is not stale', () => {
    const date = daysAgo(179);
    const text = `- Works at Acme Corp as a senior engineer here. [observed: src, ${date}]`;
    expect(lintStale(text, 180)).toHaveLength(0);
  });

  test('custom threshold 180 days — claim at 181 days is stale', () => {
    const date = daysAgo(181);
    const text = `- Works at Acme Corp as a senior engineer here. [observed: src, ${date}]`;
    const warnings = lintStale(text, 180);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].suggestion).toContain('180 days');
  });
});

// ---------------------------------------------------------------------------
// Per-type threshold defaults (Spec 04 R5)
// ---------------------------------------------------------------------------

describe('per-type staleness thresholds', () => {
  test('company page uses 180-day threshold by default', () => {
    const date = daysAgo(100); // stale at 90 default, not at 180
    const text = `- This company was founded in San Francisco and is growing fast. [observed: src, ${date}]`;
    // With pageTypes=['company'], 100 days < 180 threshold → not stale
    expect(lintStale(text, undefined, ['company'])).toHaveLength(0);
  });

  test('company page flags claims older than 180 days', () => {
    const date = daysAgo(200);
    const text = `- This company was founded in San Francisco and is growing fast. [observed: src, ${date}]`;
    const warnings = lintStale(text, undefined, ['company']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].suggestion).toContain('180 days');
  });

  test('person page uses 90-day threshold by default', () => {
    const date = daysAgo(100);
    const text = `- Works at Acme Corp as a senior engineer here. [observed: src, ${date}]`;
    const warnings = lintStale(text, undefined, ['person']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].suggestion).toContain('90 days');
  });

  test('multi-type page uses the maximum per-type threshold', () => {
    const date = daysAgo(100); // stale at 90 (person), not at 180 (company)
    const text = `- This person runs a company and is quite notable here. [observed: src, ${date}]`;
    // ['person', 'company'] → max(90, 180) = 180 → 100 < 180 → not stale
    expect(lintStale(text, undefined, ['person', 'company'])).toHaveLength(0);
  });

  test('explicit threshold_days overrides per-type default', () => {
    const date = daysAgo(50);
    const text = `- This company was founded in San Francisco and is growing fast. [observed: src, ${date}]`;
    // company default is 180, but explicit 30 overrides → 50 > 30 → stale
    const warnings = lintStale(text, 30, ['company']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].suggestion).toContain('30 days');
  });

  test('unknown page type falls back to 90-day default', () => {
    const date = daysAgo(100);
    const text = `- This concept is fundamental to the field of study here. [observed: src, ${date}]`;
    const warnings = lintStale(text, undefined, ['concept']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].suggestion).toContain('90 days');
  });

  test('empty page types falls back to 90-day default', () => {
    const date = daysAgo(100);
    const text = `- Works at Acme Corp as a senior engineer here. [observed: src, ${date}]`;
    const warnings = lintStale(text, undefined, []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].suggestion).toContain('90 days');
  });
});
