/**
 * `cfbrain ingest <file>` command.
 * Extracts content from PDF/PPTX files and creates a CFBrain page.
 *
 * Workflow:
 * 1. Detect file type
 * 2. Extract content (text, tables, images, notes)
 * 3. Copy original to raw/ (immutable)
 * 4. Save extracted images to raw/<slug>/
 * 5. Compile markdown with frontmatter
 * 6. Create page via put pipeline
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { basename, extname } from 'path';
import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { isExtractable, extractFile, classifyContent } from '../core/extractors/index.ts';
import { saveExtractedImages } from '../core/extractors/pdf.ts';
import { copyToRaw, ensureRawDir, getRawDir } from '../core/raw-files.ts';
import { importFromContent } from '../core/import-file.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { writePageFile, gitAutoCommit, getBrainDir } from '../core/pages-fs.ts';
import { appendChangelog, type ChangelogEntry } from '../core/changelog.ts';
import { isLargeFile, processLargeFile } from '../core/large-file-pipeline.ts';
import { join } from 'path';

export async function runIngest(engine: BrainEngine, args: string[]) {
  const filePath = args.find(a => !a.startsWith('--'));
  const typesArg = args.find((a, i) => args[i - 1] === '--types');
  const slugArg = args.find((a, i) => args[i - 1] === '--slug');
  const noEmbed = args.includes('--no-embed');
  const noVision = args.includes('--no-vision');

  if (!filePath) {
    console.error('Usage: cfbrain ingest <file> [--types <type>] [--slug <slug>] [--no-embed] [--no-vision]');
    console.error('');
    console.error('Supported: .pdf, .ppt, .pptx');
    console.error('');
    console.error('Examples:');
    console.error('  cfbrain ingest report.pdf');
    console.error('  cfbrain ingest slides.pptx --types intel --slug quarterly-report');
    process.exit(1);
  }

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const ext = extname(filePath).toLowerCase();
  if (!isExtractable(filePath)) {
    console.error(`Unsupported file type: ${ext}`);
    console.error('Supported: .pdf, .ppt, .pptx');
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: cfbrain init');
    process.exit(1);
  }

  // Derive slug from filename if not provided
  const slug = slugArg || basename(filePath, ext)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '');

  // Check idempotency via file hash
  const fileHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  const existing = await engine.getPage(slug).catch(() => null);
  if (existing?.frontmatter?.file_hash === fileHash) {
    console.log(`Skipped (unchanged): ${slug}`);
    return;
  }

  console.log(`Extracting content from ${basename(filePath)}...`);

  // 1. Extract content — use large file pipeline for big files
  const useLargePipeline = isLargeFile(filePath);
  let result: { markdown: string; images: { filename: string; data: Buffer }[] };
  let wasSplit = false;
  let chunkCount = 1;

  if (useLargePipeline) {
    const stat = statSync(filePath);
    console.log(`  Large file detected (${(stat.size / 1024 / 1024).toFixed(1)}MB) — using split pipeline`);
    const largeResult = await processLargeFile(filePath, { noVision });
    result = largeResult;
    wasSplit = largeResult.wasSplit;
    chunkCount = largeResult.chunkCount;
    if (wasSplit) {
      console.log(`  Split into ${chunkCount} chunks`);
    }
    if (largeResult.imageDescriptions?.length) {
      console.log(`  Analyzed ${largeResult.imageDescriptions.length} image(s) with vision`);
    }
  } else {
    result = await extractFile(filePath);
  }

  // 2. Auto-classify or use manual types
  const types = typesArg
    ? typesArg.split(',').map(t => t.trim())
    : classifyContent(result.markdown, basename(filePath));

  // 3. Copy original to raw/
  const rawSource = copyToRaw(config, filePath, slug);
  console.log(`  Raw file: ${rawSource}`);

  // 4. Save extracted images
  const rawDir = getRawDir(config);
  const imageDir = join(rawDir, slug);
  const imagePaths: string[] = [];
  if (result.images.length > 0) {
    const saved = saveExtractedImages(result.images, imageDir);
    for (const p of saved) {
      // Convert to relative path from brain root
      const brainDir = getBrainDir(config);
      const rel = p.replace(brainDir + '/', '');
      imagePaths.push(rel);
    }
    console.log(`  Extracted ${result.images.length} image(s)`);
  }

  // 5. Build frontmatter + compiled truth
  const title = inferTitle(result.markdown, basename(filePath, ext));
  const frontmatter: Record<string, unknown> = {
    raw_source: rawSource,
    file_hash: fileHash,
    source_file: basename(filePath),
    ingested_at: new Date().toISOString(),
  };
  if (imagePaths.length > 0) {
    frontmatter.extracted_images = imagePaths;
  }

  // Add image references to markdown
  let compiledTruth = result.markdown;
  if (imagePaths.length > 0) {
    compiledTruth += '\n\n## Extracted Images\n';
    for (const p of imagePaths) {
      compiledTruth += `\n- ${basename(p)}`;
    }
  }

  const content = serializeMarkdown(frontmatter, compiledTruth, {
    types,
    title,
    tags: [],
  });

  // 6. Import page
  const importResult = await importFromContent(engine, slug, content, { noEmbed });

  if (importResult.status === 'imported') {
    const brainDir = getBrainDir(config);
    const isCreate = !existing;

    // Write pages/ file
    try {
      const page = await engine.getPage(importResult.slug);
      const tags = await engine.getTags(importResult.slug);
      const md = serializeMarkdown(
        page.frontmatter,
        page.compiled_truth,
        { types: page.types, title: page.title, tags },
      );
      writePageFile(config, importResult.slug, md);
      gitAutoCommit(config, `ingest: ${importResult.slug} — ${isCreate ? 'Created' : 'Updated'} from ${basename(filePath)}`);
    } catch { /* silent */ }

    // Changelog
    const entry: ChangelogEntry = {
      action: isCreate ? 'created' : 'updated',
      slug: importResult.slug,
      reason: `Ingested from ${basename(filePath)}`,
      source: 'cli',
      triggered_by: 'ingest',
    };
    appendChangelog(brainDir, entry).catch(() => {});

    console.log(`✅ ${isCreate ? 'Created' : 'Updated'}: ${importResult.slug} (${types.join(', ')}, ${importResult.chunks} chunks)`);
  } else {
    console.log(`Skipped: ${slug} (content unchanged)`);
  }
}

function inferTitle(markdown: string, fallback: string): string {
  // Try to find first heading
  const match = markdown.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();

  // Try first significant line
  const firstLine = markdown.split('\n').find(l => l.trim().length > 5 && !l.startsWith('#'));
  if (firstLine && firstLine.trim().length < 80) return firstLine.trim();

  // Fallback to filename
  return fallback
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}
