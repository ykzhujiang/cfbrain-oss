/**
 * File content extraction dispatcher.
 * Routes to the appropriate extractor based on file extension.
 * For large files (>10MB PDFs), automatically uses the split pipeline.
 */

import { extname } from 'path';
import { statSync } from 'fs';
import type { ExtractResult } from './pdf.ts';

export type { ExtractResult } from './pdf.ts';
export { splitPdf, cleanupSplitDir, PDF_SIZE_THRESHOLD } from './pdf-splitter.ts';

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.ppt', '.pptx']);

export function isExtractable(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export async function extractFile(filePath: string): Promise<ExtractResult> {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case '.pdf': {
      const { extractPdf } = await import('./pdf.ts');
      return extractPdf(filePath);
    }
    case '.ppt':
    case '.pptx': {
      const { extractPptx } = await import('./pptx.ts');
      return extractPptx(filePath);
    }
    default:
      throw new Error(`Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`);
  }
}

/**
 * Simple heuristic to auto-classify content into CFBrain types.
 */
export function classifyContent(markdown: string, filename: string): string[] {
  const lower = markdown.toLowerCase() + ' ' + filename.toLowerCase();

  // Check patterns
  if (/会议|meeting|minutes|议程|agenda/.test(lower)) return ['meeting'];
  if (/报告|report|分析|analysis|研究|research|白皮书|whitepaper/.test(lower)) return ['intel'];
  if (/公司|company|组织|organization|corp|inc|ltd/.test(lower)) return ['company'];
  if (/项目|project|计划|plan|roadmap/.test(lower)) return ['project'];
  if (/决策|decision|审批|approval/.test(lower)) return ['decision'];
  if (/概念|concept|框架|framework|方法论|methodology/.test(lower)) return ['concept'];
  if (/交易|deal|融资|funding|投资|invest/.test(lower)) return ['deal'];

  // Default
  return ['note'];
}
