/**
 * Large file analysis pipeline.
 * Detects file size/type → splits or extracts → optionally analyzes images with vision → merges results.
 *
 * For PDFs >10MB: split into chunks → extract each chunk → merge text
 * For image-heavy PDFs: detect sparse text extraction, fallback to vision model
 * For PPTs: extract text + images → optionally describe key images via vision
 */

import { statSync, existsSync, readFileSync } from 'fs';
import { extname, basename } from 'path';
import { execSync } from 'child_process';
import type { ExtractResult } from './extractors/pdf.ts';
import { splitPdf, cleanupSplitDir, PDF_SIZE_THRESHOLD, getSplitTempDir } from './extractors/pdf-splitter.ts';
import { extractFile } from './extractors/index.ts';

/**
 * Minimum characters for a chunk's text extraction to be considered "substantial".
 * Below this threshold, the chunk is flagged as image-heavy and vision fallback kicks in.
 */
export const SPARSE_THRESHOLD = 100;

/**
 * Check if a chunk's extracted markdown is too sparse (image-heavy PDF).
 * Strips markdown headers, italic boilerplate notes, and whitespace before measuring.
 */
export function isSparseChunk(markdown: string): boolean {
  const cleaned = markdown
    .replace(/^#+\s.*$/gm, '')       // strip markdown headers
    .replace(/\*\(.*?\)\*/g, '')     // strip italic notes like "*(Text extraction failed...)*"
    .replace(/\|\s*---\s*/g, '')     // strip table separator lines
    .trim();
  return cleaned.length < SPARSE_THRESHOLD;
}

/**
 * Vision fallback for a sparse PDF chunk.
 * Calls `openclaw pdf <path>` which uses a vision model to extract text.
 * Returns the vision-extracted markdown, or null if openclaw is unavailable.
 *
 * Guards: returns null immediately if the file doesn't exist or isn't a valid PDF
 * (checks for %PDF magic bytes). This prevents spawning a slow external process
 * on invalid inputs.
 */
export async function visionFallbackChunk(chunkPath: string): Promise<string | null> {
  try {
    // Guard: file must exist
    if (!existsSync(chunkPath)) return null;

    // Guard: file must start with PDF magic bytes (%PDF)
    const fd = readFileSync(chunkPath, { encoding: null, flag: 'r' });
    if (fd.length < 4 || fd.slice(0, 4).toString('ascii') !== '%PDF') return null;

    const result = execSync(`openclaw pdf "${chunkPath}"`, {
      encoding: 'utf-8',
      timeout: 120_000, // 2 min per chunk
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // openclaw not available or failed — return null so caller can keep text result
    return null;
  }
}

export interface LargeFileResult {
  markdown: string;
  images: ExtractResult['images'];
  /** Whether the file was split into chunks */
  wasSplit: boolean;
  /** Number of chunks processed (1 if not split) */
  chunkCount: number;
  /** Descriptions from vision analysis, if performed */
  imageDescriptions?: string[];
}

export interface LargeFilePipelineOpts {
  /** Skip vision analysis even if images are found */
  noVision?: boolean;
  /** Maximum images to analyze with vision (default: 10) */
  maxVisionImages?: number;
  /** Custom size threshold for splitting (default: 10MB) */
  sizeThreshold?: number;
  /** Temp dir for split chunks */
  tempDir?: string;
}

/**
 * Process a file through the large file pipeline.
 * Automatically detects whether splitting/vision is needed.
 */
export async function processLargeFile(
  filePath: string,
  opts?: LargeFilePipelineOpts,
): Promise<LargeFileResult> {
  const ext = extname(filePath).toLowerCase();
  const stat = statSync(filePath);
  const threshold = opts?.sizeThreshold ?? PDF_SIZE_THRESHOLD;

  // PDF >threshold → split and extract chunks
  if (ext === '.pdf' && stat.size > threshold) {
    return processLargePdf(filePath, opts);
  }

  // Regular extraction (small files or PPTs of any size — PPTX extractor handles them fine)
  const result = await extractFile(filePath);
  const output: LargeFileResult = {
    markdown: result.markdown,
    images: result.images,
    wasSplit: false,
    chunkCount: 1,
  };

  // Vision analysis for extracted images
  if (!opts?.noVision && result.images.length > 0) {
    const descriptions = await analyzeExtractedImages(result.images, opts);
    if (descriptions.length > 0) {
      output.imageDescriptions = descriptions;
      output.markdown = appendImageDescriptions(output.markdown, descriptions, result.images);
    }
  }

  return output;
}

/**
 * Split a large PDF into chunks, extract each, and merge results.
 * Uses hybrid approach: text extraction for text-rich chunks, vision fallback for sparse/image-heavy chunks.
 */
async function processLargePdf(
  filePath: string,
  opts?: LargeFilePipelineOpts,
): Promise<LargeFileResult> {
  const { extractPdf } = await import('./extractors/pdf.ts');

  const splitResult = await splitPdf(filePath, {
    maxChunkBytes: opts?.sizeThreshold,
    tempDir: opts?.tempDir ?? getSplitTempDir(),
  });

  const allSections: string[] = [];
  const allImages: ExtractResult['images'] = [];
  let visionFallbackCount = 0;

  try {
    for (let i = 0; i < splitResult.chunkPaths.length; i++) {
      const chunkPath = splitResult.chunkPaths[i];
      const result = await extractPdf(chunkPath);

      let chunkMarkdown = result.markdown;

      // T165/T166/T167: Hybrid approach — vision fallback for sparse chunks
      if (!opts?.noVision && isSparseChunk(chunkMarkdown)) {
        const visionResult = await visionFallbackChunk(chunkPath);
        if (visionResult) {
          chunkMarkdown = visionResult;
          visionFallbackCount++;
        }
        // If vision also fails, keep the sparse text result as-is
      }

      if (splitResult.chunkPaths.length > 1) {
        allSections.push(`\n## Part ${i + 1} of ${splitResult.chunkPaths.length}\n`);
      }
      allSections.push(chunkMarkdown);

      // Namespace image filenames to avoid collisions
      for (const img of result.images) {
        img.filename = `chunk${i + 1}-${img.filename}`;
        allImages.push(img);
      }
    }
  } finally {
    cleanupSplitDir(splitResult.tempDir);
  }

  const merged = allSections.join('\n\n');
  const output: LargeFileResult = {
    markdown: merged,
    images: allImages,
    wasSplit: splitResult.chunkPaths.length > 1,
    chunkCount: splitResult.chunkPaths.length,
  };

  // Vision analysis for extracted images
  if (!opts?.noVision && allImages.length > 0) {
    const descriptions = await analyzeExtractedImages(allImages, opts);
    if (descriptions.length > 0) {
      output.imageDescriptions = descriptions;
      output.markdown = appendImageDescriptions(output.markdown, descriptions, allImages);
    }
  }

  return output;
}

/**
 * Analyze extracted images with vision. Limits to maxVisionImages.
 */
async function analyzeExtractedImages(
  images: ExtractResult['images'],
  opts?: LargeFilePipelineOpts,
): Promise<string[]> {
  try {
    const { analyzeImageBuffer } = await import('./vision.ts');
    const maxImages = opts?.maxVisionImages ?? 10;
    const toAnalyze = images.slice(0, maxImages);

    const descriptions: string[] = [];
    for (const img of toAnalyze) {
      try {
        const ext = img.filename.split('.').pop() || 'png';
        const desc = await analyzeImageBuffer(img.data, `.${ext}`);
        descriptions.push(desc);
      } catch {
        descriptions.push('*(Vision analysis failed for this image)*');
      }
    }
    return descriptions;
  } catch {
    // Vision module not available (e.g. no OPENAI_API_KEY)
    return [];
  }
}

/**
 * Append image descriptions to the markdown output.
 */
function appendImageDescriptions(
  markdown: string,
  descriptions: string[],
  images: ExtractResult['images'],
): string {
  if (descriptions.length === 0) return markdown;

  const sections: string[] = [markdown, '\n## Image Analysis\n'];
  for (let i = 0; i < descriptions.length; i++) {
    const imgName = images[i]?.filename || `Image ${i + 1}`;
    sections.push(`### ${imgName}\n\n${descriptions[i]}\n`);
  }

  return sections.join('\n');
}

/**
 * Check if a file is considered "large" and needs the pipeline.
 */
export function isLargeFile(filePath: string, threshold?: number): boolean {
  const t = threshold ?? PDF_SIZE_THRESHOLD;
  try {
    return statSync(filePath).size > t;
  } catch {
    return false;
  }
}
