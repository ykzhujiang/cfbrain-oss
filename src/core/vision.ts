/**
 * Vision analysis using OpenAI GPT-4o.
 * Sends images to the vision model and returns text descriptions.
 */

import { readFileSync } from 'fs';
import { extname } from 'path';
import OpenAI from 'openai';

const VISION_MODEL = 'gpt-4o';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

/**
 * Analyze a single image file and return a text description.
 */
export async function analyzeImage(
  imagePath: string,
  prompt?: string,
): Promise<string> {
  const data = readFileSync(imagePath);
  return analyzeImageBuffer(data, extname(imagePath), prompt);
}

/**
 * Analyze an image from a Buffer.
 */
export async function analyzeImageBuffer(
  data: Buffer,
  ext: string,
  prompt?: string,
): Promise<string> {
  const mimeType = getMimeType(ext);
  const base64 = data.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const systemPrompt = prompt ||
    'Describe this image in detail. If it contains a chart, table, or diagram, extract all the data and relationships. If it contains text, transcribe it.';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient().chat.completions.create({
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: systemPrompt },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            ],
          },
        ],
        max_tokens: 2000,
      });

      return response.choices[0]?.message?.content || '*(No description generated)*';
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Vision analysis failed after all retries');
}

/**
 * Analyze multiple images, returning descriptions in order.
 * Limits concurrency to avoid rate limits.
 */
export async function analyzeImages(
  imagePaths: string[],
  opts?: { concurrency?: number; prompt?: string },
): Promise<string[]> {
  const concurrency = opts?.concurrency ?? 3;
  const results: string[] = new Array(imagePaths.length);

  // Process in batches
  for (let i = 0; i < imagePaths.length; i += concurrency) {
    const batch = imagePaths.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(p => analyzeImage(p, opts?.prompt).catch(e => `*(Vision error: ${e.message})*`)),
    );
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
  }

  return results;
}

function getMimeType(ext: string): string {
  const lower = ext.toLowerCase().replace(/^\./, '');
  switch (lower) {
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'svg': return 'image/svg+xml';
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
}

export { VISION_MODEL };
