/**
 * Raw file storage utilities.
 * raw/ stores immutable copies of original source files (PDF, images, audio, etc.)
 * referenced by pages via the `raw_source` frontmatter field.
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, extname, basename } from 'path';
import { createHash } from 'crypto';
import type { GBrainConfig } from './config.ts';
import { getBrainDir } from './pages-fs.ts';

/**
 * Get the raw/ directory path for the brain.
 */
export function getRawDir(config: GBrainConfig): string {
  return join(getBrainDir(config), 'raw');
}

/**
 * Ensure raw/ directory exists, creating it if needed.
 */
export function ensureRawDir(config: GBrainConfig): string {
  const rawDir = getRawDir(config);
  mkdirSync(rawDir, { recursive: true });
  return rawDir;
}

/**
 * Copy a file into raw/ with date-slug naming: {date}-{slug}.{ext}
 * Returns the relative path from brain root (e.g., "raw/2026-04-14-intel-report.pdf").
 *
 * If the destination already exists with identical content, returns the existing path (immutable).
 * If the destination exists with DIFFERENT content, appends a numeric suffix:
 * {date}-{slug}-2.{ext}, {date}-{slug}-3.{ext}, etc.
 */
export function copyToRaw(config: GBrainConfig, sourcePath: string, slug: string): string {
  const rawDir = ensureRawDir(config);
  const ext = extname(sourcePath); // includes the dot
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const baseName = `${date}-${slug}`;
  let destName = `${baseName}${ext}`;
  let destPath = join(rawDir, destName);

  if (existsSync(destPath)) {
    // Compare content to determine if it's the same file
    const sourceHash = hashFile(sourcePath);
    const destHash = hashFile(destPath);

    if (sourceHash === destHash) {
      // Same file — return existing path (immutable, no overwrite needed)
      return `raw/${destName}`;
    }

    // Different file with same name — find next available suffix
    let suffix = 2;
    while (true) {
      destName = `${baseName}-${suffix}${ext}`;
      destPath = join(rawDir, destName);
      if (!existsSync(destPath)) {
        break; // Found an available name
      }
      // Check if this suffixed file is the same content
      if (hashFile(destPath) === sourceHash) {
        return `raw/${destName}`; // Already stored with this suffix
      }
      suffix++;
    }
  }

  copyFileSync(sourcePath, destPath);
  return `raw/${destName}`;
}

/**
 * Hash a file's content using SHA-256.
 */
function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Resolve a raw_source relative path to an absolute path.
 */
export function resolveRawPath(config: GBrainConfig, rawSource: string): string {
  return join(getBrainDir(config), rawSource);
}

/**
 * Normalize raw_source to always be an array.
 */
export function normalizeRawSource(rawSource: unknown): string[] {
  if (!rawSource) return [];
  if (Array.isArray(rawSource)) return rawSource.map(String);
  return [String(rawSource)];
}

/**
 * Write synthesized text content to raw/ with date-slug naming.
 * Used for auto-raw: .url files, .md snapshots, .txt transcripts, .json messages.
 * Returns the relative path from brain root (e.g., "raw/2026-04-15-my-slug.url").
 *
 * If suffix is provided (e.g., "-transcript"), it's appended before the extension:
 *   writeRawText(config, slug, '.txt', content, '-transcript') → raw/2026-04-15-slug-transcript.txt
 *
 * Idempotent: if a file with identical content already exists, returns the existing path.
 */
export function writeRawText(
  config: GBrainConfig,
  slug: string,
  ext: string,
  textContent: string,
  nameSuffix?: string,
): string {
  const rawDir = ensureRawDir(config);
  const date = new Date().toISOString().slice(0, 10);
  const baseName = `${date}-${slug}${nameSuffix || ''}`;
  let destName = `${baseName}${ext}`;
  let destPath = join(rawDir, destName);

  const contentBuffer = Buffer.from(textContent, 'utf-8');
  const contentHash = createHash('sha256').update(contentBuffer).digest('hex');

  if (existsSync(destPath)) {
    const existingHash = createHash('sha256').update(readFileSync(destPath)).digest('hex');
    if (existingHash === contentHash) {
      return `raw/${destName}`;
    }
    // Different content — find next suffix
    let suffix = 2;
    while (true) {
      destName = `${baseName}-${suffix}${ext}`;
      destPath = join(rawDir, destName);
      if (!existsSync(destPath)) break;
      const h = createHash('sha256').update(readFileSync(destPath)).digest('hex');
      if (h === contentHash) return `raw/${destName}`;
      suffix++;
    }
  }

  writeFileSync(destPath, contentBuffer);
  return `raw/${destName}`;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg']);

/**
 * Classify a raw source file as 'image' or 'file' based on extension.
 */
export function getRawMediaType(rawSource: string): 'image' | 'file' {
  const ext = extname(rawSource).toLowerCase();
  return IMAGE_EXTS.has(ext) ? 'image' : 'file';
}
