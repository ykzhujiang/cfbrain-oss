import { createHash } from 'crypto';
import type { Page, Chunk, SearchResult } from './types.ts';

/**
 * Validate and normalize a slug. Slugs are lowercased repo-relative paths.
 * Rejects empty slugs, path traversal (..), and leading /.
 */
export function validateSlug(slug: string): string {
  if (!slug || /(^|\/)\.\.($|\/)/.test(slug) || /^\//.test(slug)) {
    throw new Error(`Invalid slug: "${slug}". Slugs cannot be empty, start with /, or contain path traversal.`);
  }
  return slug.toLowerCase();
}

/**
 * SHA-256 hash of compiled_truth, used for import idempotency.
 */
export function contentHash(compiledTruth: string): string {
  return createHash('sha256').update(compiledTruth).digest('hex');
}

/** Parse a types value from DB row — handles TEXT[] from PGLite/Postgres */
function parseTypes(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') {
    // PGLite may return '{person,company}' format
    if (val.startsWith('{') && val.endsWith('}')) {
      return val.slice(1, -1).split(',').filter(Boolean);
    }
    return [val];
  }
  return [];
}

export function rowToPage(row: Record<string, unknown>): Page {
  return {
    id: row.id as number,
    slug: row.slug as string,
    types: parseTypes(row.types),
    title: row.title as string,
    compiled_truth: row.compiled_truth as string,
    frontmatter: (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter) as Record<string, unknown>,
    content_hash: row.content_hash as string | undefined,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToChunk(row: Record<string, unknown>, includeEmbedding = false): Chunk {
  return {
    id: row.id as number,
    page_id: row.page_id as number,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth',
    embedding: includeEmbedding && row.embedding ? row.embedding as Float32Array : null,
    model: row.model as string,
    token_count: row.token_count as number | null,
    embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
  };
}

export function rowToSearchResult(row: Record<string, unknown>): SearchResult {
  return {
    slug: row.slug as string,
    page_id: row.page_id as number,
    title: row.title as string,
    types: parseTypes(row.types),
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth',
    score: Number(row.score),
    stale: Boolean(row.stale),
  };
}
