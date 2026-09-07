/**
 * Spec 26: PPT/PDF Ingestion Tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// Extractor unit tests
import { extractPdf, saveExtractedImages } from '../src/core/extractors/pdf.ts';
import { extractPptx } from '../src/core/extractors/pptx.ts';
import { isExtractable, extractFile, classifyContent } from '../src/core/extractors/index.ts';

// ─── Fixture helpers ───

const FIXTURES_DIR = join(import.meta.dir, 'e2e', 'fixtures', 'ingest');

// Minimal valid PDF (text-based)
function createMinimalPdf(dir: string): string {
  const path = join(dir, 'test.pdf');
  // Use pdf-parse CLI or a pre-built fixture; for unit tests we test the extractors
  // with real files. If no fixture exists, skip.
  return path;
}

// Minimal valid PPTX (created programmatically via JSZip)
async function createMinimalPptx(dir: string): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // [Content_Types].xml
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>`);

  // _rels/.rels
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);

  // ppt/presentation.xml
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
</p:presentation>`);

  // ppt/_rels/presentation.xml.rels
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);

  // ppt/slides/slide1.xml — with title + body + table
  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:p><a:r><a:t>Test Slide Title</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:p><a:r><a:t>This is the body text of the slide.</a:t></a:r></a:p>
          <a:p><a:r><a:t>Second paragraph with important data.</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblGrid><a:gridCol w="1000000"/><a:gridCol w="1000000"/></a:tblGrid>
              <a:tr h="300000">
                <a:tc><a:txBody><a:p><a:r><a:t>Header A</a:t></a:r></a:p></a:txBody></a:tc>
                <a:tc><a:txBody><a:p><a:r><a:t>Header B</a:t></a:r></a:p></a:txBody></a:tc>
              </a:tr>
              <a:tr h="300000">
                <a:tc><a:txBody><a:p><a:r><a:t>Value 1</a:t></a:r></a:p></a:txBody></a:tc>
                <a:tc><a:txBody><a:p><a:r><a:t>Value 2</a:t></a:r></a:p></a:txBody></a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`);

  // ppt/slides/_rels/slide1.xml.rels (notes relationship)
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`);

  // ppt/notesSlides/notesSlide1.xml
  zip.file('ppt/notesSlides/notesSlide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
         xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:p><a:r><a:t>This is a speaker note for slide 1.</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`);

  const path = join(dir, 'test.pptx');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(path, buf);
  return path;
}

// ─── Tests ───

describe('Spec 26: File Extractors', () => {
  describe('isExtractable', () => {
    test('recognizes PDF', () => {
      expect(isExtractable('report.pdf')).toBe(true);
      expect(isExtractable('REPORT.PDF')).toBe(true);
    });
    test('recognizes PPTX', () => {
      expect(isExtractable('slides.pptx')).toBe(true);
      expect(isExtractable('old.ppt')).toBe(true);
    });
    test('rejects unsupported', () => {
      expect(isExtractable('doc.txt')).toBe(false);
      expect(isExtractable('sheet.xlsx')).toBe(false);
    });
  });

  describe('classifyContent', () => {
    test('detects meeting type', () => {
      expect(classifyContent('会议纪要 2026年4月', 'meeting.pdf')).toEqual(['meeting']);
    });
    test('detects intel type', () => {
      expect(classifyContent('季度报告 Q1 2026', 'report.pptx')).toEqual(['intel']);
    });
    test('detects company type', () => {
      expect(classifyContent('公司介绍 Trinity Corp', 'intro.pdf')).toEqual(['company']);
    });
    test('defaults to note', () => {
      expect(classifyContent('random thoughts about life', 'misc.pdf')).toEqual(['note']);
    });
  });
});

describe('Spec 26: PPTX Extractor', () => {
  let pptxPath: string;
  const tmpDir = join(import.meta.dir, '.tmp-spec26');

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    pptxPath = await createMinimalPptx(tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('extracts slide text', async () => {
    const result = await extractPptx(pptxPath);
    expect(result.markdown).toContain('Test Slide Title');
    expect(result.markdown).toContain('body text of the slide');
    expect(result.markdown).toContain('Second paragraph');
  });

  test('extracts tables as markdown', async () => {
    const result = await extractPptx(pptxPath);
    expect(result.markdown).toContain('Header A');
    expect(result.markdown).toContain('Header B');
    expect(result.markdown).toContain('Value 1');
    expect(result.markdown).toContain('Value 2');
    expect(result.markdown).toContain('|'); // markdown table pipe
  });

  test('extracts speaker notes', async () => {
    const result = await extractPptx(pptxPath);
    expect(result.markdown).toContain('Speaker Notes');
    expect(result.markdown).toContain('speaker note for slide 1');
  });

  test('returns images array (empty for text-only pptx)', async () => {
    const result = await extractPptx(pptxPath);
    expect(Array.isArray(result.images)).toBe(true);
  });
});

describe('Spec 26: extractFile dispatcher', () => {
  const tmpDir = join(import.meta.dir, '.tmp-spec26-dispatch');

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    await createMinimalPptx(tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('dispatches .pptx to pptx extractor', async () => {
    const result = await extractFile(join(tmpDir, 'test.pptx'));
    expect(result.markdown).toContain('Test Slide Title');
  });

  test('throws on unsupported extension', async () => {
    await expect(extractFile('/tmp/fake.docx')).rejects.toThrow('Unsupported file type');
  });
});

describe('Spec 26: saveExtractedImages', () => {
  const tmpDir = join(import.meta.dir, '.tmp-spec26-images');

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('saves images to directory', () => {
    const images = [
      { filename: 'img1.png', data: Buffer.from('fake-png-data') },
      { filename: 'img2.jpg', data: Buffer.from('fake-jpg-data') },
    ];
    const paths = saveExtractedImages(images, tmpDir);
    expect(paths).toHaveLength(2);
    expect(existsSync(paths[0])).toBe(true);
    expect(existsSync(paths[1])).toBe(true);
  });

  test('returns empty for no images', () => {
    const paths = saveExtractedImages([], tmpDir);
    expect(paths).toHaveLength(0);
  });
});
