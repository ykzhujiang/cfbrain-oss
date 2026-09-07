// Page types — open-ended string (no fixed union; extensible via config)
export type PageType = string;

/** Default CFBrain types (user-extensible) */
export const DEFAULT_TYPES = [
  'person', 'company', 'meeting', 'project', 'decision',
  'concept', 'intel', 'deal', 'note', 'recruit',
] as const;

export interface Page {
  id: number;
  slug: string;
  types: string[];
  title: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  content_hash?: string;
  created_at: Date;
  updated_at: Date;
}

export interface PageInput {
  types: string[];
  title: string;
  compiled_truth: string;
  frontmatter?: Record<string, unknown>;
  content_hash?: string;
}

export interface PageFilters {
  types?: string[];
  tag?: string;
  limit?: number;
  offset?: number;
}

// Chunks
export interface Chunk {
  id: number;
  page_id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth';
  embedding: Float32Array | null;
  model: string;
  token_count: number | null;
  embedded_at: Date | null;
}

export interface ChunkInput {
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth';
  embedding?: Float32Array;
  model?: string;
  token_count?: number;
}

// Search
export interface SearchResult {
  slug: string;
  page_id: number;
  title: string;
  types: string[];
  chunk_text: string;
  chunk_source: 'compiled_truth';
  score: number;
  stale: boolean;
}

export interface SearchOpts {
  limit?: number;
  types?: string[];
  exclude_slugs?: string[];
}

// Links
export interface Link {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
}

export interface GraphNode {
  slug: string;
  title: string;
  types: string[];
  depth: number;
  links: { to_slug: string; link_type: string }[];
}

// Raw data
export interface RawData {
  source: string;
  data: Record<string, unknown>;
  fetched_at: Date;
}

// Versions
export interface PageVersion {
  id: number;
  page_id: number;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  snapshot_at: Date;
}

// Stats + Health
export interface BrainStats {
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  link_count: number;
  tag_count: number;
  pages_by_type: Record<string, number>;
}

export interface BrainHealth {
  page_count: number;
  embed_coverage: number;
  stale_pages: number;
  orphan_pages: number;
  dead_links: number;
  missing_embeddings: number;
}

// Ingest log
export interface IngestLogEntry {
  id: number;
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
  created_at: Date;
}

export interface IngestLogInput {
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
}

// Config
export interface EngineConfig {
  database_url?: string;
  database_path?: string;
  engine?: 'postgres' | 'pglite';
}

// Errors
export class CFBrainError extends Error {
  constructor(
    public problem: string,
    public cause_description: string,
    public fix: string,
    public docs_url?: string,
  ) {
    super(`${problem}: ${cause_description}. Fix: ${fix}`);
    this.name = 'CFBrainError';
  }
}
