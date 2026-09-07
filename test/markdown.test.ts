import { describe, test, expect } from 'bun:test';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';

describe('Markdown Parser', () => {
  test('parses frontmatter + compiled_truth', () => {
    const md = `---
type: concept
title: Do Things That Don't Scale
tags: [startups, growth]
---

Paul Graham argues that startups should do unscalable things early on.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.types).toContain('concept');
    expect(parsed.title).toBe("Do Things That Don't Scale");
    expect(parsed.tags).toEqual(['startups', 'growth']);
    expect(parsed.compiled_truth).toContain('unscalable things');
  });

  test('handles body with no separator', () => {
    const md = `---
type: concept
title: Superlinear Returns
---

Returns in many fields are superlinear.
Performance compounds over time.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toContain('superlinear');
  });

  test('handles empty body', () => {
    const md = `---
type: concept
title: Empty Page
---
`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toBe('');
  });

  test('removes type, title, tags from frontmatter object', () => {
    const md = `---
type: concept
title: Test
tags: [a, b]
custom_field: hello
---

Content
`;
    const parsed = parseMarkdown(md);
    expect(parsed.frontmatter).not.toHaveProperty('type');
    expect(parsed.frontmatter).not.toHaveProperty('title');
    expect(parsed.frontmatter).not.toHaveProperty('tags');
    expect(parsed.frontmatter).toHaveProperty('custom_field', 'hello');
  });

  test('infers type from file path', () => {
    const md = `---
title: Someone
---
Content
`;
    const parsed = parseMarkdown(md, 'people/someone.md');
    expect(parsed.types).toContain('person');
  });

  test('infers slug from file path', () => {
    const md = `---
type: concept
title: Test
---
Content
`;
    const parsed = parseMarkdown(md, 'concepts/do-things-that-dont-scale.md');
    expect(parsed.slug).toBe('concepts/do-things-that-dont-scale');
  });
});

describe('serializeMarkdown', () => {
  test('round-trips through parse and serialize', () => {
    const original = `---
type: concept
title: Do Things That Don't Scale
tags:
  - startups
  - growth
custom: value
---

Paul Graham argues that startups should do unscalable things early on.
`;
    const parsed = parseMarkdown(original);
    const serialized = serializeMarkdown(
      parsed.frontmatter,
      parsed.compiled_truth,
      { types: parsed.types, title: parsed.title, tags: parsed.tags },
    );

    // Re-parse the serialized version
    const reparsed = parseMarkdown(serialized);
    expect(reparsed.types).toEqual(parsed.types);
    expect(reparsed.title).toBe(parsed.title);
    expect(reparsed.compiled_truth).toBe(parsed.compiled_truth);
    expect(reparsed.frontmatter.custom).toBe('value');
  });
});

describe('parseMarkdown edge cases', () => {
  test('handles frontmatter without type or title', () => {
    const md = `---
custom_field: hello
---

Some content.`;
    const parsed = parseMarkdown(md);
    expect(parsed.types.length).toBeGreaterThan(0); // should have a default
    expect(parsed.compiled_truth.trim()).toBe('Some content.');
    expect(parsed.frontmatter.custom_field).toBe('hello');
  });

  test('handles content with no frontmatter at all', () => {
    const md = `Just plain text with no YAML.`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toContain('Just plain text');
  });

  test('handles empty string', () => {
    const parsed = parseMarkdown('');
    expect(parsed.compiled_truth).toBe('');
  });

  test('infers type from various directory paths', () => {
    expect(parseMarkdown('', 'people/someone.md').types).toContain('person');
    expect(parseMarkdown('', 'concepts/thing.md').types).toContain('concept');
    expect(parseMarkdown('', 'companies/acme.md').types).toContain('company');
  });
});
