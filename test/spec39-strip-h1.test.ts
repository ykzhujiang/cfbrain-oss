import { describe, expect, it } from 'bun:test';
import { serializeForFeishu, h1TitleMatches } from '../src/core/feishu';

describe('Spec 39: Strip H1 title from content on Feishu push', () => {
  describe('T181: serializeForFeishu strips matching H1', () => {
    it('strips H1 that matches page title exactly', () => {
      const content = '# My Page Title\n\nSome body text here.';
      const result = serializeForFeishu(content, 'My Page Title');
      expect(result).toBe('Some body text here.');
    });

    it('strips H1 with case-insensitive match', () => {
      const content = '# my page title\n\nBody text.';
      const result = serializeForFeishu(content, 'My Page Title');
      expect(result).toBe('Body text.');
    });

    it('strips H1 with extra whitespace in title', () => {
      const content = '#  My Page Title \n\nBody.';
      const result = serializeForFeishu(content, '  My Page Title  ');
      expect(result).toBe('Body.');
    });

    it('strips H1 and removes immediately following blank line', () => {
      const content = '# Title\n\nParagraph 1\n\nParagraph 2';
      const result = serializeForFeishu(content, 'Title');
      expect(result).toBe('Paragraph 1\n\nParagraph 2');
    });

    it('strips H1 when no blank line follows', () => {
      const content = '# Title\nParagraph directly after.';
      const result = serializeForFeishu(content, 'Title');
      expect(result).toBe('Paragraph directly after.');
    });
  });

  describe('T182: Non-matching and non-H1 headings are preserved', () => {
    it('keeps H1 that does not match page title', () => {
      const content = '# Different Heading\n\nBody text.';
      const result = serializeForFeishu(content, 'My Page Title');
      expect(result).toBe('# Different Heading\n\nBody text.');
    });

    it('keeps H2 even if it matches page title', () => {
      const content = '## My Page Title\n\nBody text.';
      const result = serializeForFeishu(content, 'My Page Title');
      expect(result).toBe('## My Page Title\n\nBody text.');
    });

    it('keeps H3 even if it matches page title', () => {
      const content = '### My Page Title\n\nBody text.';
      const result = serializeForFeishu(content, 'My Page Title');
      expect(result).toBe('### My Page Title\n\nBody text.');
    });

    it('returns content unchanged when no title provided', () => {
      const content = '# Some Title\n\nBody.';
      const result = serializeForFeishu(content);
      expect(result).toBe('# Some Title\n\nBody.');
    });

    it('returns content unchanged when content has no heading', () => {
      const content = 'Just a paragraph.\n\nAnother paragraph.';
      const result = serializeForFeishu(content, 'My Page Title');
      expect(result).toBe('Just a paragraph.\n\nAnother paragraph.');
    });

    it('returns empty string unchanged', () => {
      const result = serializeForFeishu('', 'Title');
      expect(result).toBe('');
    });

    it('handles content that is only an H1 matching title', () => {
      const content = '# Title';
      const result = serializeForFeishu(content, 'Title');
      expect(result).toBe('');
    });
  });

  describe('T183: Fuzzy H1 title matching', () => {
    it('strips H1 when title is prefix of H1 text', () => {
      // Title: "AI研究" but H1: "AI研究报告2024"
      const content = '# AI研究报告2024\n\nBody text.';
      const result = serializeForFeishu(content, 'AI研究');
      expect(result).toBe('Body text.');
    });

    it('strips H1 when H1 text is prefix of title', () => {
      // H1 is shorter than title
      const content = '# Machine Learning\n\nBody.';
      const result = serializeForFeishu(content, 'Machine Learning Research Notes');
      expect(result).toBe('Body.');
    });

    it('strips H1 with >80% similarity (small typo)', () => {
      // "Machine Learning Notes" vs "Machine Learning Note" — 1 char diff in 22/21 chars
      const content = '# Machine Learning Notes\n\nBody.';
      const result = serializeForFeishu(content, 'Machine Learning Note');
      expect(result).toBe('Body.');
    });

    it('strips H1 with >80% similarity (minor wording difference)', () => {
      // "Quarterly Report Q1" vs "Quarterly Report Q2" — 1 char diff in 19 chars
      const content = '# Quarterly Report Q1\n\nBody.';
      const result = serializeForFeishu(content, 'Quarterly Report Q2');
      expect(result).toBe('Body.');
    });

    it('keeps H1 when similarity is below 80%', () => {
      // Completely different titles
      const content = '# Introduction to Biology\n\nBody.';
      const result = serializeForFeishu(content, 'Advanced Chemistry');
      expect(result).toBe('# Introduction to Biology\n\nBody.');
    });

    it('keeps H1 when titles are somewhat similar but below threshold', () => {
      // "Hello World" vs "Goodbye Moon" — very different
      const content = '# Hello World\n\nBody.';
      const result = serializeForFeishu(content, 'Goodbye Moon');
      expect(result).toBe('# Hello World\n\nBody.');
    });

    it('strips H1 with prefix match case-insensitive', () => {
      const content = '# my research paper\n\nBody.';
      const result = serializeForFeishu(content, 'My Research Paper - Extended Version');
      expect(result).toBe('Body.');
    });
  });

  describe('T183: h1TitleMatches unit tests', () => {
    it('returns true for exact match', () => {
      expect(h1TitleMatches('Hello', 'Hello')).toBe(true);
    });

    it('returns true for case-insensitive exact match', () => {
      expect(h1TitleMatches('Hello World', 'hello world')).toBe(true);
    });

    it('returns true when h1 is prefix of title', () => {
      expect(h1TitleMatches('Research', 'Research Paper 2024')).toBe(true);
    });

    it('returns true when title is prefix of h1', () => {
      expect(h1TitleMatches('Research Paper 2024', 'Research')).toBe(true);
    });

    it('returns true for >80% similarity', () => {
      // "abcdefghij" vs "abcdefghik" — 1 char diff in 10 chars = 90% similarity
      expect(h1TitleMatches('abcdefghij', 'abcdefghik')).toBe(true);
    });

    it('returns false for <80% similarity', () => {
      // Very different strings
      expect(h1TitleMatches('abcde', 'vwxyz')).toBe(false);
    });

    it('returns false for empty h1', () => {
      expect(h1TitleMatches('', 'Title')).toBe(false);
    });

    it('returns false for empty title', () => {
      expect(h1TitleMatches('Title', '')).toBe(false);
    });

    it('handles whitespace-only strings', () => {
      expect(h1TitleMatches('   ', '  ')).toBe(false);
    });
  });
});
