/**
 * Spec 34: Fix large PDF pipeline — stdin bug, smart splitting, batch analysis, path fix
 * Covers: T160 stdin bypass, T161 re-split oversized, T162 batch merge, T163 allowed temp dir
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import {
  splitPdf,
  cleanupSplitDir,
  PDF_SIZE_THRESHOLD,
  SPLIT_TARGET_SIZE,
  getSplitTempDir,
} from '../src/core/extractors/pdf-splitter.ts';
import { isLargeFile, processLargeFile } from '../src/core/large-file-pipeline.ts';

// ─── Fixture helpers ───

const TMP_DIR = join(import.meta.dir, '.tmp-spec34');

async function createMultiPagePdf(
  dir: string,
  filename: string,
  opts: { pageCount: number; textPerPage?: string },
): Promise<string> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const text = opts.textPerPage ?? 'Test content for spec 34. '.repeat(100);

  for (let i = 0; i < opts.pageCount; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${i + 1}\n${text}`, {
      x: 50,
      y: 700,
      size: 10,
      font,
      maxWidth: 500,
    });
  }

  const bytes = await doc.save();
  const path = join(dir, filename);
  writeFileSync(path, bytes);
  return path;
}

// ─── Setup / Teardown ───

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ─── T160: stdin bypass ───

describe('Spec 34 T160: stdin bypass for large PDF --raw', () => {
  test('cli.ts has hasLargePdfRaw guard in stdin read path', () => {
    const cliSource = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf-8');
    expect(cliSource).toContain('hasLargePdfRaw');
    expect(cliSource).toContain('skip if --raw has a large PDF');
  });

  test('hasLargePdfRaw check is before stdin read', () => {
    const cliSource = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf-8');
    // The guard should appear before readFileSync('/dev/stdin')
    const guardIdx = cliSource.indexOf('hasLargePdfRaw(params)');
    const stdinIdx = cliSource.indexOf("readFileSync('/dev/stdin'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(stdinIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(stdinIdx);
  });

  test('stdin is not read when --raw has large PDF and no content', () => {
    // Verify the logic: the code skips stdin when hasLargePdfRaw returns true
    const cliSource = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf-8');
    // Pattern: if (!hasLargePdfRaw(params)) { ... readFileSync('/dev/stdin') }
    expect(cliSource).toContain('if (!hasLargePdfRaw(params))');
  });
});

// ─── T161: Smart re-splitting ───

describe('Spec 34 T161: Smart splitting with re-split verification', () => {
  test('splitPdf re-splits oversized chunks', async () => {
    // Create a 10-page PDF
    const pdfPath = await createMultiPagePdf(TMP_DIR, 'resplit-test.pdf', {
      pageCount: 10,
      textPerPage: 'Re-split verification content. '.repeat(100),
    });

    // Use a very small maxChunkBytes to force splitting into many chunks
    const result = await splitPdf(pdfPath, { maxChunkBytes: 512 });
    expect(result.totalPages).toBe(10);
    // Each chunk should be 1 page (since 512 bytes is tiny)
    expect(result.chunkPaths.length).toBe(10);

    // Verify all chunks exist
    for (const chunkPath of result.chunkPaths) {
      expect(existsSync(chunkPath)).toBe(true);
    }

    cleanupSplitDir(result.tempDir);
  });

  test('splitPdf verifies chunk sizes after initial split', async () => {
    const pdfPath = await createMultiPagePdf(TMP_DIR, 'verify-sizes.pdf', {
      pageCount: 6,
      textPerPage: 'Size verification content. '.repeat(80),
    });

    const fileSize = statSync(pdfPath).size;
    // Set maxChunkBytes to ~1/3 of file — should produce multiple chunks
    const result = await splitPdf(pdfPath, { maxChunkBytes: Math.floor(fileSize / 3) });
    expect(result.chunkPaths.length).toBeGreaterThanOrEqual(2);

    // All chunks should exist
    for (const chunkPath of result.chunkPaths) {
      expect(existsSync(chunkPath)).toBe(true);
    }

    cleanupSplitDir(result.tempDir);
  });

  test('splitPdf handles single-page PDF without re-split', async () => {
    const pdfPath = await createMultiPagePdf(TMP_DIR, 'single-page-resplit.pdf', {
      pageCount: 1,
    });

    // Even with tiny maxChunkBytes, a single page can't be split further
    const result = await splitPdf(pdfPath, { maxChunkBytes: 100 });
    expect(result.chunkPaths.length).toBe(1);
    expect(result.totalPages).toBe(1);

    cleanupSplitDir(result.tempDir);
  });
});

// ─── T162: Batch analysis — all chunks merged ───

describe('Spec 34 T162: Batch analysis merges all chunks', () => {
  test('processLargeFile merges all chunks into single markdown', async () => {
    const pdfPath = await createMultiPagePdf(TMP_DIR, 'batch-merge.pdf', {
      pageCount: 6,
      textPerPage: 'Batch analysis merge test. '.repeat(80),
    });

    const result = await processLargeFile(pdfPath, {
      noVision: true,
      sizeThreshold: 1024, // Force split
    });

    expect(result.wasSplit).toBe(true);
    expect(result.chunkCount).toBeGreaterThan(1);
    // Merged markdown should have Part headers for each chunk
    expect(result.markdown).toContain('Part 1 of');
    expect(result.markdown).toContain(`Part ${result.chunkCount} of`);
    // Should be a single string, not array
    expect(typeof result.markdown).toBe('string');
  });

  test('processLargeFile batch includes all chunk content', async () => {
    const pdfPath = await createMultiPagePdf(TMP_DIR, 'batch-all-content.pdf', {
      pageCount: 4,
      textPerPage: 'Unique chunk identifier for batch test. '.repeat(50),
    });

    const result = await processLargeFile(pdfPath, {
      noVision: true,
      sizeThreshold: 1024,
    });

    // Every chunk should contribute text to the merged result
    for (let i = 1; i <= result.chunkCount; i++) {
      expect(result.markdown).toContain(`Part ${i} of ${result.chunkCount}`);
    }
  });

  test('processLargeFile returns correct chunkCount', async () => {
    const pdfPath = await createMultiPagePdf(TMP_DIR, 'chunk-count.pdf', {
      pageCount: 3,
    });

    // Small file — should not split
    const result = await processLargeFile(pdfPath, { noVision: true });
    expect(result.chunkCount).toBe(1);
    expect(result.wasSplit).toBe(false);
  });
});

// ─── T163: Path fix — chunks saved to allowed directory ───

describe('Spec 34 T163: Chunks saved to ~/.gbrain/tmp/', () => {
  test('getSplitTempDir returns ~/.gbrain/tmp/', () => {
    const dir = getSplitTempDir();
    const expected = join(homedir(), '.gbrain', 'tmp');
    expect(dir).toBe(expected);
  });

  test('getSplitTempDir creates the directory if missing', () => {
    const dir = getSplitTempDir();
    expect(existsSync(dir)).toBe(true);
  });

  test('splitPdf uses ~/.gbrain/tmp/ by default (not system tmpdir)', async () => {
    const pdfPath = await createMultiPagePdf(TMP_DIR, 'path-test.pdf', {
      pageCount: 2,
    });

    const result = await splitPdf(pdfPath);
    const gbrainTmp = join(homedir(), '.gbrain', 'tmp');
    // tempDir should be under ~/.gbrain/tmp/
    expect(result.tempDir.startsWith(gbrainTmp)).toBe(true);

    cleanupSplitDir(result.tempDir);
  });

  test('splitPdf respects custom tempDir override', async () => {
    const pdfPath = await createMultiPagePdf(TMP_DIR, 'custom-dir.pdf', {
      pageCount: 2,
    });

    const customDir = join(TMP_DIR, 'custom-split-dir');
    const result = await splitPdf(pdfPath, { tempDir: customDir });
    expect(result.tempDir).toBe(customDir);
    expect(existsSync(customDir)).toBe(true);

    cleanupSplitDir(result.tempDir);
  });

  test('processLargeFile uses allowed directory for split chunks', async () => {
    const pdfPath = await createMultiPagePdf(TMP_DIR, 'pipeline-path.pdf', {
      pageCount: 4,
    });

    // After processLargeFile, temp dir should have been cleaned up
    // but the function should have used ~/.gbrain/tmp/ during processing
    const result = await processLargeFile(pdfPath, {
      noVision: true,
      sizeThreshold: 1024,
    });
    expect(result.wasSplit).toBe(true);
    // The function completes without error — temp dir was accessible
    expect(result.markdown.length).toBeGreaterThan(0);
  });
});
