/**
 * `cfbrain analyze-file <file>` command.
 * Analyzes a large PDF/PPTX file and outputs the extracted content.
 * Does not create a brain page — useful for previewing extraction results.
 */

import { existsSync, statSync } from 'fs';
import { basename, extname } from 'path';
import { isExtractable } from '../core/extractors/index.ts';
import { processLargeFile, isLargeFile } from '../core/large-file-pipeline.ts';

export async function runAnalyzeFile(args: string[]) {
  const filePath = args.find(a => !a.startsWith('--'));
  const noVision = args.includes('--no-vision');
  const jsonOutput = args.includes('--json');

  if (!filePath) {
    console.error('Usage: cfbrain analyze-file <file> [--no-vision] [--json]');
    console.error('');
    console.error('Analyzes a PDF/PPTX file and outputs the extracted content.');
    console.error('For large files (>10MB), automatically splits and processes in chunks.');
    console.error('');
    console.error('Options:');
    console.error('  --no-vision   Skip image analysis with vision model');
    console.error('  --json        Output as JSON (includes metadata)');
    console.error('');
    console.error('Examples:');
    console.error('  cfbrain analyze-file report.pdf');
    console.error('  cfbrain analyze-file slides.pptx --no-vision');
    console.error('  cfbrain analyze-file big-deck.pdf --json');
    process.exit(1);
  }

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  if (!isExtractable(filePath)) {
    console.error(`Unsupported file type: ${extname(filePath)}`);
    console.error('Supported: .pdf, .ppt, .pptx');
    process.exit(1);
  }

  const stat = statSync(filePath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  const large = isLargeFile(filePath);

  console.error(`Analyzing ${basename(filePath)} (${sizeMB}MB)${large ? ' — large file mode' : ''}...`);

  const result = await processLargeFile(filePath, { noVision });

  if (jsonOutput) {
    const output = {
      file: basename(filePath),
      sizeBytes: stat.size,
      wasSplit: result.wasSplit,
      chunkCount: result.chunkCount,
      imageCount: result.images.length,
      visionDescriptions: result.imageDescriptions?.length ?? 0,
      markdown: result.markdown,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(result.markdown);
    if (result.images.length > 0) {
      console.error(`\n--- ${result.images.length} image(s) extracted ---`);
    }
    if (result.wasSplit) {
      console.error(`--- Processed in ${result.chunkCount} chunks ---`);
    }
  }
}
