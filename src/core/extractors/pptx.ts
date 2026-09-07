/**
 * PPTX content extractor → markdown.
 * PPTX is a ZIP file containing XML. We extract directly using JSZip.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ExtractResult } from './pdf.ts';

export async function extractPptx(filePath: string): Promise<ExtractResult> {
  // Dynamic import JSZip (pptx-compose depends on it, so it's available)
  const JSZip = (await import('jszip')).default;

  const data = readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  const images: ExtractResult['images'] = [];
  const sections: string[] = [];

  // Find all slide XML files
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
      const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
      return na - nb;
    });

  // Find notes files
  const notesFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f));

  for (let i = 0; i < slideFiles.length; i++) {
    const slideXml = await zip.file(slideFiles[i])!.async('text');
    const slideNum = i + 1;

    // Extract text from XML
    const texts = extractTextsFromXml(slideXml);
    const title = texts[0] || `Slide ${slideNum}`;
    const bodyTexts = texts.slice(1);

    sections.push(`## ${title}`);
    if (bodyTexts.length > 0) {
      sections.push(bodyTexts.join('\n'));
    }

    // Extract tables from XML
    const tables = extractTablesFromXml(slideXml);
    if (tables.length > 0) {
      for (const table of tables) {
        sections.push(rowsToMarkdownTable(table));
      }
    }

    // Extract notes
    const notesFile = notesFiles.find(f =>
      f.includes(`notesSlide${slideNum}.xml`),
    );
    if (notesFile) {
      const notesXml = await zip.file(notesFile)!.async('text');
      const notesTexts = extractTextsFromXml(notesXml);
      // Filter out slide number placeholders
      const meaningful = notesTexts.filter(t => t.length > 2 && !/^\d+$/.test(t));
      if (meaningful.length > 0) {
        sections.push(`> **Speaker Notes:** ${meaningful.join(' ')}`);
      }
    }

    sections.push('');
  }

  // Extract embedded images
  const imageFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/media\/image\d+\.(png|jpg|jpeg|gif|bmp|svg)$/i.test(f));

  for (let i = 0; i < imageFiles.length; i++) {
    const imgData = await zip.file(imageFiles[i])!.async('nodebuffer');
    const ext = imageFiles[i].split('.').pop() || 'png';
    images.push({ filename: `pptx-image-${i + 1}.${ext}`, data: imgData });
  }

  const markdown = sections.join('\n\n').trim();
  return {
    markdown: markdown || '*(Empty PPTX file)*',
    images,
  };
}

/**
 * Extract text runs from OOXML. Handles <a:t> tags inside <a:p> paragraphs.
 */
function extractTextsFromXml(xml: string): string[] {
  const paragraphs: string[] = [];

  // Split by paragraph tags <a:p>
  const pMatches = xml.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g) || [];

  for (const p of pMatches) {
    // Extract all <a:t> text runs within this paragraph
    const tMatches = p.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || [];
    const texts = tMatches.map(t => {
      const inner = t.replace(/<a:t[^>]*>/, '').replace(/<\/a:t>/, '');
      return decodeXmlEntities(inner);
    });
    const line = texts.join('').trim();
    if (line) {
      paragraphs.push(line);
    }
  }

  return paragraphs;
}

/**
 * Extract tables from OOXML. Tables use <a:tbl> with <a:tr> rows and <a:tc> cells.
 */
function extractTablesFromXml(xml: string): string[][][] {
  const tables: string[][][] = [];
  const tblMatches = xml.match(/<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>/g) || [];

  for (const tbl of tblMatches) {
    const rows: string[][] = [];
    const trMatches = tbl.match(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g) || [];

    for (const tr of trMatches) {
      const cells: string[] = [];
      const tcMatches = tr.match(/<a:tc\b[^>]*>[\s\S]*?<\/a:tc>/g) || [];

      for (const tc of tcMatches) {
        const texts = extractTextsFromXml(tc);
        cells.push(texts.join(' '));
      }
      rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }

  return tables;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function rowsToMarkdownTable(rows: string[][]): string {
  if (!rows || rows.length === 0) return '';
  const header = rows[0].map(cell => cell.trim() || ' ');
  const separator = header.map(() => '---');
  const dataRows = rows.slice(1).map(row => row.map(cell => cell.trim() || ' '));
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...dataRows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}
