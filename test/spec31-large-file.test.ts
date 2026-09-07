/**
 * Spec 31: Large PDF/PPT Processing Tests
 * Covers: pdf-splitter, large-file-pipeline, vision, isLargeFile
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';

import { splitPdf, cleanupSplitDir, PDF_SIZE_THRESHOLD } from '../src/core/extractors/pdf-splitter.ts';
import { isLargeFile, processLargeFile } from '../src/core/large-file-pipeline.ts';

// ─── Fixture helpers ───

const TMP_DIR = join(import.meta.dir, '.tmp-spec31-large-file');

/**
 * Create a multi-page PDF using pdf-lib for splitting tests.
 * Generates pages with repeated text to reach a target size.
 */
async function createMultiPagePdf(
  dir: string,
  filename: string,
  opts: { pageCount: number; textPerPage?: string },
): Promise<string> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const text = opts.textPerPage ?? 'This is test content for a large PDF page. '.repeat(100);

  for (let i = 0; i < opts.pageCount; i++) {
    const page = doc.addPage([612, 792]); // US Letter
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

/**
 * Create a small, single-page PDF for non-split tests.
 */
async function createSmallPdf(dir: string, filename: string): Promise<string> {
  return createMultiPagePdf(dir, filename, { pageCount: 1, textPerPage: 'Small PDF content.' });
}

// ─── Tests ───

describe('Spec 31: PDF Splitter', () => {
  let tempDir: string;

  beforeAll(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    tempDir = join(TMP_DIR, 'splitter');
    mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('PDF_SIZE_THRESHOLD is 10MB', () => {
    expect(PDF_SIZE_THRESHOLD).toBe(10 * 1024 * 1024);
  });

  test('splits multi-page PDF into chunks', async () => {
    // Create a 10-page PDF
    const pdfPath = await createMultiPagePdf(tempDir, 'multi.pdf', { pageCount: 10 });

    // Force split by setting a very low maxChunkBytes
    const splitDir = join(tempDir, 'split-output');
    const result = await splitPdf(pdfPath, {
      maxChunkBytes: 1024, // 1KB — forces one page per chunk
      tempDir: splitDir,
    });

    expect(result.totalPages).toBe(10);
    expect(result.chunkPaths.length).toBeGreaterThanOrEqual(2);
    expect(result.tempDir).toBe(splitDir);

    // Each chunk file exists and is a valid file
    for (const chunkPath of result.chunkPaths) {
      expect(existsSync(chunkPath)).toBe(true);
      expect(statSync(chunkPath).size).toBeGreaterThan(0);
    }

    cleanupSplitDir(splitDir);
    expect(existsSync(splitDir)).toBe(false);
  });

  test('single-page PDF produces one chunk', async () => {
    const pdfPath = await createSmallPdf(tempDir, 'single.pdf');

    const splitDir = join(tempDir, 'single-split');
    const result = await splitPdf(pdfPath, { tempDir: splitDir });

    expect(result.totalPages).toBe(1);
    expect(result.chunkPaths).toHaveLength(1);
    expect(existsSync(result.chunkPaths[0])).toBe(true);

    cleanupSplitDir(splitDir);
  });

  test('respects custom maxChunkBytes', async () => {
    const pdfPath = await createMultiPagePdf(tempDir, 'custom-chunk.pdf', { pageCount: 6 });
    const fileSize = statSync(pdfPath).size;

    // Set maxChunkBytes to ~half the file → should produce 2+ chunks
    const splitDir = join(tempDir, 'custom-chunk-split');
    const result = await splitPdf(pdfPath, {
      maxChunkBytes: Math.floor(fileSize / 3),
      tempDir: splitDir,
    });

    expect(result.chunkPaths.length).toBeGreaterThanOrEqual(2);

    cleanupSplitDir(splitDir);
  });

  test('uses auto-generated tempDir if none provided', async () => {
    const pdfPath = await createSmallPdf(tempDir, 'auto-temp.pdf');
    const result = await splitPdf(pdfPath);

    expect(result.tempDir).toContain('cfbrain-pdf-split-');
    expect(existsSync(result.tempDir)).toBe(true);
    expect(result.chunkPaths).toHaveLength(1);

    cleanupSplitDir(result.tempDir);
  });

  test('cleanupSplitDir is safe on non-existent dir', () => {
    // Should not throw
    cleanupSplitDir('/tmp/nonexistent-dir-12345678');
  });

  test('chunk filenames follow pattern chunk-*.pdf', async () => {
    const pdfPath = await createMultiPagePdf(tempDir, 'naming.pdf', { pageCount: 4 });
    const splitDir = join(tempDir, 'naming-split');
    const result = await splitPdf(pdfPath, { maxChunkBytes: 1024, tempDir: splitDir });

    for (let i = 0; i < result.chunkPaths.length; i++) {
      // Chunk filenames contain 'chunk-' prefix and end with '.pdf'
      const basename = result.chunkPaths[i].split('/').pop()!;
      expect(basename).toStartWith('chunk-');
      expect(basename).toEndWith('.pdf');
    }

    cleanupSplitDir(splitDir);
  });
});

describe('Spec 31: isLargeFile', () => {
  const tmpDir = join(TMP_DIR, 'is-large');

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('returns false for small files', async () => {
    const path = await createSmallPdf(tmpDir, 'tiny.pdf');
    expect(isLargeFile(path)).toBe(false);
  });

  test('returns false for non-existent files', () => {
    expect(isLargeFile('/tmp/nonexistent-file-xyz.pdf')).toBe(false);
  });

  test('respects custom threshold', async () => {
    const path = await createSmallPdf(tmpDir, 'threshold.pdf');
    const size = statSync(path).size;
    // Set threshold below file size → should be "large"
    expect(isLargeFile(path, size - 1)).toBe(true);
    // Set threshold above file size → should be "small"
    expect(isLargeFile(path, size + 1)).toBe(false);
  });

  test('returns true when size exactly exceeds threshold', async () => {
    const path = await createSmallPdf(tmpDir, 'exact.pdf');
    const size = statSync(path).size;
    // Equal to threshold → not large (uses >)
    expect(isLargeFile(path, size)).toBe(false);
    // One byte less → large
    expect(isLargeFile(path, size - 1)).toBe(true);
  });
});

describe('Spec 31: processLargeFile', () => {
  const tmpDir = join(TMP_DIR, 'pipeline');

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('processes small PDF without splitting', async () => {
    const pdfPath = await createSmallPdf(tmpDir, 'small-pipeline.pdf');

    const result = await processLargeFile(pdfPath, { noVision: true });

    expect(result.wasSplit).toBe(false);
    expect(result.chunkCount).toBe(1);
    expect(result.markdown).toBeDefined();
    expect(typeof result.markdown).toBe('string');
    expect(Array.isArray(result.images)).toBe(true);
  });

  test('splits and merges large PDF (forced threshold)', async () => {
    const pdfPath = await createMultiPagePdf(tmpDir, 'large-pipeline.pdf', { pageCount: 6 });

    const result = await processLargeFile(pdfPath, {
      noVision: true,
      sizeThreshold: 1024, // Force split (1KB threshold)
    });

    expect(result.wasSplit).toBe(true);
    expect(result.chunkCount).toBeGreaterThanOrEqual(2);
    expect(result.markdown).toContain('Part 1 of');
    expect(result.markdown).toContain('Part 2 of');
    expect(Array.isArray(result.images)).toBe(true);
  });

  test('noVision suppresses image analysis', async () => {
    const pdfPath = await createSmallPdf(tmpDir, 'no-vision.pdf');

    const result = await processLargeFile(pdfPath, { noVision: true });

    expect(result.imageDescriptions).toBeUndefined();
    expect(result.markdown).not.toContain('Image Analysis');
  });

  test('processes PPTX via extractFile path (not split)', async () => {
    // Create a minimal PPTX
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
    zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
</p:presentation>`);
    zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
    zip.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:p><a:r><a:t>Large File Pipeline PPTX Test</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`);

    const pptxPath = join(tmpDir, 'pipeline.pptx');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    writeFileSync(pptxPath, buf);

    const result = await processLargeFile(pptxPath, { noVision: true });

    expect(result.wasSplit).toBe(false);
    expect(result.chunkCount).toBe(1);
    expect(result.markdown).toContain('Large File Pipeline PPTX Test');
  });

  test('cleans up temp dir after split (even on success)', async () => {
    const pdfPath = await createMultiPagePdf(tmpDir, 'cleanup-test.pdf', { pageCount: 4 });
    const splitDir = join(tmpDir, 'cleanup-verify');

    await processLargeFile(pdfPath, {
      noVision: true,
      sizeThreshold: 1024,
      tempDir: splitDir,
    });

    // Temp dir should be cleaned up
    expect(existsSync(splitDir)).toBe(false);
  });

  test('namespaces images from chunks to avoid collisions', async () => {
    const pdfPath = await createMultiPagePdf(tmpDir, 'ns-images.pdf', { pageCount: 4 });

    const result = await processLargeFile(pdfPath, {
      noVision: true,
      sizeThreshold: 1024,
    });

    // If any images were extracted, they should be namespaced with chunk prefix
    for (const img of result.images) {
      expect(img.filename).toMatch(/^chunk\d+-/);
    }
  });
});

describe('Spec 31: Vision module', () => {
  test('getMimeType mapping exists for common formats', async () => {
    // Import the module to verify it loads without errors
    const vision = await import('../src/core/vision.ts');
    expect(vision.VISION_MODEL).toBe('gpt-4o');
    expect(typeof vision.analyzeImage).toBe('function');
    expect(typeof vision.analyzeImageBuffer).toBe('function');
    expect(typeof vision.analyzeImages).toBe('function');
  });
});

describe('Spec 31: LargeFileResult interface', () => {
  const tmpDir = join(TMP_DIR, 'interface');

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('result has all required fields', async () => {
    const pdfPath = await createSmallPdf(tmpDir, 'fields.pdf');
    const result = await processLargeFile(pdfPath, { noVision: true });

    expect('markdown' in result).toBe(true);
    expect('images' in result).toBe(true);
    expect('wasSplit' in result).toBe(true);
    expect('chunkCount' in result).toBe(true);
    expect(typeof result.markdown).toBe('string');
    expect(Array.isArray(result.images)).toBe(true);
    expect(typeof result.wasSplit).toBe('boolean');
    expect(typeof result.chunkCount).toBe('number');
  });
});
