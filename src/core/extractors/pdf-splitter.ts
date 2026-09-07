/**
 * PDF splitting utility for large files (>10MB).
 * Uses pdf-lib to split PDFs into page-range chunks targeting <10MB each.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

/** Size threshold: files above this get split */
export const PDF_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB

/** Target chunk size for splitting (9MB — leaves headroom below the 10MB threshold) */
export const SPLIT_TARGET_SIZE = 9 * 1024 * 1024; // 9MB

/**
 * Get the default temp directory for split chunks.
 * Uses ~/.gbrain/tmp/ instead of system tmpdir for tool path compatibility.
 */
export function getSplitTempDir(): string {
  const dir = join(homedir(), '.gbrain', 'tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Split a large PDF into smaller chunks, each targeting <10MB.
 * Returns paths to the chunk files in a temp directory.
 *
 * Strategy: estimate pages-per-chunk from total size / total pages,
 * then create sub-PDFs with those page ranges. After splitting,
 * verify each chunk is under the size limit; re-split oversized chunks
 * with fewer pages per chunk.
 */
export async function splitPdf(
  filePath: string,
  opts?: { maxChunkBytes?: number; tempDir?: string },
): Promise<{ chunkPaths: string[]; tempDir: string; totalPages: number }> {
  const { PDFDocument } = await import('pdf-lib');

  const maxChunkBytes = opts?.maxChunkBytes ?? SPLIT_TARGET_SIZE;
  const data = readFileSync(filePath);
  const fileSize = data.length;

  const srcDoc = await PDFDocument.load(data, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  if (totalPages === 0) {
    throw new Error('PDF has no pages');
  }

  // Estimate pages per chunk (at least 1 page per chunk)
  const bytesPerPage = fileSize / totalPages;
  const pagesPerChunk = Math.max(1, Math.floor(maxChunkBytes / bytesPerPage));

  const dir = opts?.tempDir ?? join(getSplitTempDir(), `cfbrain-pdf-split-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  const chunkPaths: string[] = [];
  let chunkIndex = 0;

  for (let startPage = 0; startPage < totalPages; startPage += pagesPerChunk) {
    const endPage = Math.min(startPage + pagesPerChunk, totalPages);

    const chunkDoc = await PDFDocument.create();
    const pages = await chunkDoc.copyPages(
      srcDoc,
      Array.from({ length: endPage - startPage }, (_, i) => startPage + i),
    );
    for (const page of pages) {
      chunkDoc.addPage(page);
    }

    const chunkBytes = await chunkDoc.save();
    const chunkPath = join(dir, `chunk-${chunkIndex + 1}.pdf`);
    writeFileSync(chunkPath, chunkBytes);
    chunkPaths.push(chunkPath);
    chunkIndex++;
  }

  // Smart re-split: verify chunk sizes, re-split oversized with fewer pages
  const verifiedPaths: string[] = [];
  for (const chunkPath of chunkPaths) {
    const chunkSize = statSync(chunkPath).size;
    if (chunkSize > maxChunkBytes && pagesPerChunk > 1) {
      // Oversized chunk — recursively split with same target
      const subResult = await splitPdf(chunkPath, {
        maxChunkBytes,
        tempDir: join(dir, `resplit-${verifiedPaths.length}`),
      });
      verifiedPaths.push(...subResult.chunkPaths);
    } else {
      verifiedPaths.push(chunkPath);
    }
  }

  return { chunkPaths: verifiedPaths, tempDir: dir, totalPages };
}

/**
 * Clean up a temp directory created by splitPdf.
 */
export function cleanupSplitDir(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
