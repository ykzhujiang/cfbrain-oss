/**
 * PDF content extractor → markdown.
 * Uses pdf-parse v2 for text, tables, and images.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

export interface ExtractResult {
  markdown: string;
  images: { filename: string; data: Buffer }[];
}

export async function extractPdf(filePath: string): Promise<ExtractResult> {
  const { PDFParse } = await import('pdf-parse');

  const data = readFileSync(filePath);
  const parser = new PDFParse({ data });
  const images: ExtractResult['images'] = [];
  const sections: string[] = [];

  // Extract text
  try {
    const textResult = await parser.getText();
    if (textResult.text?.trim()) {
      sections.push(textResult.text.trim());
    }
  } catch (e) {
    // If getText fails, the PDF might be image-only
    sections.push('*(Text extraction failed — this may be a scanned PDF)*');
  }

  // Extract tables
  try {
    const tableResult = await parser.getTable();
    if (tableResult.tables && tableResult.tables.length > 0) {
      sections.push('\n## Tables\n');
      for (let i = 0; i < tableResult.tables.length; i++) {
        const table = tableResult.tables[i];
        if (table.rows && table.rows.length > 0) {
          sections.push(`### Table ${i + 1}\n`);
          sections.push(rowsToMarkdownTable(table.rows));
        }
      }
    }
  } catch {
    // Tables not available — skip silently
  }

  // Extract images
  try {
    const imageResult = await parser.getImage();
    if (imageResult.images && imageResult.images.length > 0) {
      for (let i = 0; i < imageResult.images.length; i++) {
        const img = imageResult.images[i];
        if (img.data) {
          const ext = img.mimeType?.includes('png') ? 'png' : 'jpg';
          const filename = `image-${i + 1}.${ext}`;
          images.push({ filename, data: Buffer.from(img.data) });
        }
      }
    }
  } catch {
    // Images not available — skip silently
  }

  return {
    markdown: sections.join('\n\n'),
    images,
  };
}

function rowsToMarkdownTable(rows: unknown[][]): string {
  if (!rows || rows.length === 0) return '';

  const header = rows[0].map(cell => String(cell ?? '').trim());
  const separator = header.map(() => '---');
  const dataRows = rows.slice(1).map(row =>
    row.map(cell => String(cell ?? '').trim()),
  );

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...dataRows.map(row => `| ${row.join(' | ')} |`),
  ];

  return lines.join('\n');
}

/**
 * Save extracted images to a directory and return relative paths.
 */
export function saveExtractedImages(
  images: ExtractResult['images'],
  targetDir: string,
): string[] {
  if (images.length === 0) return [];
  mkdirSync(targetDir, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const outPath = join(targetDir, img.filename);
    writeFileSync(outPath, img.data);
    paths.push(outPath);
  }
  return paths;
}
