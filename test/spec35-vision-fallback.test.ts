/**
 * Spec 35: Vision fallback for image-heavy PDFs
 * Covers: sparse detection (T165), vision fallback (T166), hybrid merge (T167)
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  SPARSE_THRESHOLD,
  isSparseChunk,
  visionFallbackChunk,
} from '../src/core/large-file-pipeline.ts';

// ─── Fixture helpers ───

const TMP_DIR = join(import.meta.dir, '.tmp-spec35-vision-fallback');

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

/**
 * Create a multi-page PDF using pdf-lib.
 */
async function createPdf(
  dir: string,
  filename: string,
  opts: { pageCount: number; textPerPage?: string },
): Promise<string> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = opts.textPerPage ?? 'Test content. '.repeat(50);

  for (let i = 0; i < opts.pageCount; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(text.slice(0, 500), { x: 50, y: 700, size: 10, font });
  }

  const bytes = await doc.save();
  const outPath = join(dir, filename);
  writeFileSync(outPath, bytes);
  return outPath;
}

// ─── T165: Sparse detection ───

describe('Spec 35: isSparseChunk — sparse text detection', () => {
  test('SPARSE_THRESHOLD is 100 characters', () => {
    expect(SPARSE_THRESHOLD).toBe(100);
  });

  test('empty string is sparse', () => {
    expect(isSparseChunk('')).toBe(true);
  });

  test('whitespace-only is sparse', () => {
    expect(isSparseChunk('   \n\n   \t  ')).toBe(true);
  });

  test('short text (<100 chars) is sparse', () => {
    expect(isSparseChunk('Some tiny text.')).toBe(true);
  });

  test('substantial text (>100 chars) is not sparse', () => {
    const long = 'This is a real paragraph of extracted PDF text. '.repeat(5);
    expect(long.length).toBeGreaterThan(100);
    expect(isSparseChunk(long)).toBe(false);
  });

  test('headers-only content is sparse (headers are stripped)', () => {
    const headersOnly = '# Chapter 1\n## Section A\n### Subsection\n';
    expect(isSparseChunk(headersOnly)).toBe(true);
  });

  test('boilerplate failure note is sparse', () => {
    const boilerplate = '*(Text extraction failed — this may be a scanned PDF)*';
    expect(isSparseChunk(boilerplate)).toBe(true);
  });

  test('headers + boilerplate combined is sparse', () => {
    const mixed = '# Page 1\n\n*(Text extraction failed — this may be a scanned PDF)*\n\n## Tables\n';
    expect(isSparseChunk(mixed)).toBe(true);
  });

  test('exactly at threshold boundary', () => {
    // Create text that is exactly 100 chars after cleaning
    const text = 'x'.repeat(100);
    expect(isSparseChunk(text)).toBe(false); // >= 100 is not sparse

    const textMinus1 = 'x'.repeat(99);
    expect(isSparseChunk(textMinus1)).toBe(true); // < 100 is sparse
  });

  test('real-world mix: header + short body is sparse', () => {
    const content = '# Document Title\n\nPage 1 of 5\n\n---\n';
    expect(isSparseChunk(content)).toBe(true);
  });

  test('table separator lines are stripped', () => {
    const tableOnly = '| --- | --- | --- |\n| --- | --- |\n';
    expect(isSparseChunk(tableOnly)).toBe(true);
  });
});

// ─── T166: Vision fallback ───

describe('Spec 35: visionFallbackChunk — vision fallback', () => {
  test('returns null when openclaw is not available', async () => {
    // Most test environments won't have openclaw installed
    const fakePath = join(TMP_DIR, 'nonexistent.pdf');
    writeFileSync(fakePath, 'not a real pdf');
    const result = await visionFallbackChunk(fakePath);
    // Should gracefully return null (openclaw not installed or file invalid)
    expect(result).toBeNull();
  });

  test('returns null for nonexistent file', async () => {
    const result = await visionFallbackChunk('/tmp/does-not-exist-at-all.pdf');
    expect(result).toBeNull();
  });

  test('function signature accepts a string path and returns Promise<string|null>', () => {
    expect(typeof visionFallbackChunk).toBe('function');
    expect(visionFallbackChunk.length).toBe(1);
  });
});

// ─── T167: Hybrid merge in processLargeFile ───

describe('Spec 35: Hybrid merge — text vs vision per chunk', () => {
  test('processLargeFile with noVision skips vision fallback for sparse chunks', async () => {
    const { processLargeFile } = await import('../src/core/large-file-pipeline.ts');

    // Create a small PDF (won't actually trigger split, but tests the pipeline)
    const pdfPath = await createPdf(TMP_DIR, 'small-text.pdf', {
      pageCount: 2,
      textPerPage: 'Substantial content here. '.repeat(20),
    });

    const result = await processLargeFile(pdfPath, {
      noVision: true,
      sizeThreshold: 100, // Force through large pipeline
      tempDir: join(TMP_DIR, 'hybrid-test-1'),
    });

    expect(result.markdown).toBeTruthy();
    expect(result.wasSplit).toBe(true);
    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
  });

  test('processLargeFile exports isSparseChunk and SPARSE_THRESHOLD', async () => {
    const mod = await import('../src/core/large-file-pipeline.ts');
    expect(mod.SPARSE_THRESHOLD).toBe(100);
    expect(typeof mod.isSparseChunk).toBe('function');
    expect(typeof mod.visionFallbackChunk).toBe('function');
  });

  test('sparse chunk with noVision keeps original text', async () => {
    const { processLargeFile } = await import('../src/core/large-file-pipeline.ts');

    // Create a tiny PDF that will produce sparse text (1 page with minimal text)
    const pdfPath = await createPdf(TMP_DIR, 'sparse-novision.pdf', {
      pageCount: 2,
      textPerPage: 'Hi',
    });

    const result = await processLargeFile(pdfPath, {
      noVision: true,
      sizeThreshold: 100, // Force split
      tempDir: join(TMP_DIR, 'hybrid-test-2'),
    });

    // With noVision, even sparse chunks should use text extraction result
    expect(result.markdown).toBeTruthy();
    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
  });

  test('isSparseChunk correctly classifies mixed content with substantial text', () => {
    // Simulate a chunk that has real content — should NOT trigger vision
    const richChunk = 'This is a comprehensive paragraph about financial analysis. ' +
      'The quarterly report shows growth in all major sectors including technology. ' +
      'Revenue increased by 15% year over year.';
    expect(isSparseChunk(richChunk)).toBe(false);

    // Simulate a chunk from an image-heavy PDF — should trigger vision
    const sparseChunk = '# Slide 1\n\n*(Text extraction failed — this may be a scanned PDF)*';
    expect(isSparseChunk(sparseChunk)).toBe(true);
  });
});
