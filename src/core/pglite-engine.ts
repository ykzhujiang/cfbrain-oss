import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { BrainEngine } from './engine.ts';
import { runMigrations } from './migrate.ts';
import { getPgliteSchemaSql } from './pglite-schema.ts';
import type {
  Page, PageInput, PageFilters,
  Chunk, ChunkInput,
  SearchResult, SearchOpts,
  Link, GraphNode,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
} from './types.ts';
import { validateSlug, contentHash, rowToPage, rowToChunk, rowToSearchResult } from './utils.ts';

type PGLiteDB = PGlite;

export class PGLiteEngine implements BrainEngine {
  private _db: PGLiteDB | null = null;

  get db(): PGLiteDB {
    if (!this._db) throw new Error('PGLite not connected. Call connect() first.');
    return this._db;
  }

  // Lifecycle
  async connect(config: EngineConfig): Promise<void> {
    const dataDir = config.database_path || undefined; // undefined = in-memory
    this._db = await PGlite.create({
      dataDir,
      extensions: { vector, pg_trgm },
    });
  }

  async disconnect(): Promise<void> {
    if (this._db) {
      await this._db.close();
      this._db = null;
    }
  }

  async initSchema(): Promise<void> {
    await this.db.exec(getPgliteSchemaSql());

    const { applied } = await runMigrations(this);
    if (applied > 0) {
      console.log(`  ${applied} migration(s) applied`);
    }
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txEngine = Object.create(this) as PGLiteEngine;
      Object.defineProperty(txEngine, 'db', { get: () => tx });
      return fn(txEngine);
    });
  }

  // Pages CRUD
  async getPage(slug: string): Promise<Page | null> {
    const { rows } = await this.db.query(
      `SELECT id, slug, types, title, compiled_truth, frontmatter, content_hash, created_at, updated_at
       FROM pages WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return null;
    return rowToPage(rows[0] as Record<string, unknown>);
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    slug = validateSlug(slug);
    const hash = page.content_hash || contentHash(page.compiled_truth);
    const frontmatter = page.frontmatter || {};

    const typesArr = page.types || [];
    const { rows } = await this.db.query(
      `INSERT INTO pages (slug, types, title, compiled_truth, frontmatter, content_hash, updated_at)
       VALUES ($1, $2::text[], $3, $4, $5::jsonb, $6, now())
       ON CONFLICT (slug) DO UPDATE SET
         types = EXCLUDED.types,
         title = EXCLUDED.title,
         compiled_truth = EXCLUDED.compiled_truth,
         frontmatter = EXCLUDED.frontmatter,
         content_hash = EXCLUDED.content_hash,
         updated_at = now()
       RETURNING id, slug, types, title, compiled_truth, frontmatter, content_hash, created_at, updated_at`,
      [slug, typesArr, page.title, page.compiled_truth, JSON.stringify(frontmatter), hash]
    );
    return rowToPage(rows[0] as Record<string, unknown>);
  }

  async deletePage(slug: string): Promise<void> {
    await this.db.query('DELETE FROM pages WHERE slug = $1', [slug]);
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;

    let result;
    if (filters?.types?.length && filters?.tag) {
      result = await this.db.query(
        `SELECT p.* FROM pages p
         JOIN tags t ON t.page_id = p.id
         WHERE p.types && $1::text[] AND t.tag = $2
         ORDER BY p.updated_at DESC LIMIT $3 OFFSET $4`,
        [filters.types, filters.tag, limit, offset]
      );
    } else if (filters?.types?.length) {
      result = await this.db.query(
        `SELECT * FROM pages WHERE types && $1::text[]
         ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
        [filters.types, limit, offset]
      );
    } else if (filters?.tag) {
      result = await this.db.query(
        `SELECT p.* FROM pages p
         JOIN tags t ON t.page_id = p.id
         WHERE t.tag = $1
         ORDER BY p.updated_at DESC LIMIT $2 OFFSET $3`,
        [filters.tag, limit, offset]
      );
    } else {
      result = await this.db.query(
        `SELECT * FROM pages
         ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
    }

    return (result.rows as Record<string, unknown>[]).map(rowToPage);
  }

  async resolveSlugs(partial: string): Promise<string[]> {
    // Try exact match first
    const exact = await this.db.query('SELECT slug FROM pages WHERE slug = $1', [partial]);
    if (exact.rows.length > 0) return [(exact.rows[0] as { slug: string }).slug];

    // Fuzzy match via pg_trgm
    const { rows } = await this.db.query(
      `SELECT slug, similarity(title, $1) AS sim
       FROM pages
       WHERE title % $1 OR slug ILIKE $2
       ORDER BY sim DESC
       LIMIT 5`,
      [partial, '%' + partial + '%']
    );
    return (rows as { slug: string }[]).map(r => r.slug);
  }

  // Search
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = opts?.limit || 20;

    const { rows } = await this.db.query(
      `SELECT DISTINCT ON (p.slug)
        p.slug, p.id as page_id, p.title, p.types,
        cc.chunk_text, cc.chunk_source,
        ts_rank(p.search_vector, websearch_to_tsquery('english', $1)) AS score,
        false AS stale
      FROM pages p
      JOIN content_chunks cc ON cc.page_id = p.id
      WHERE p.search_vector @@ websearch_to_tsquery('english', $1)
        ${opts?.types?.length ? `AND p.types && $2::text[]` : ''}
      ORDER BY p.slug, score DESC`,
      opts?.types?.length ? [query, opts.types] : [query]
    );

    // Re-sort by score (DISTINCT ON requires ORDER BY slug first) and apply limit
    const sorted = (rows as Record<string, unknown>[]).sort(
      (a: any, b: any) => b.score - a.score
    );
    sorted.splice(limit);

    return sorted.map(rowToSearchResult);
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = opts?.limit || 20;
    const vecStr = '[' + Array.from(embedding).join(',') + ']';

    const { rows } = await this.db.query(
      `SELECT
        p.slug, p.id as page_id, p.title, p.types,
        cc.chunk_text, cc.chunk_source,
        1 - (cc.embedding <=> $1::vector) AS score,
        false AS stale
      FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE cc.embedding IS NOT NULL
        ${opts?.types?.length ? `AND p.types && $3::text[]` : ''}
      ORDER BY cc.embedding <=> $1::vector
      LIMIT $2`,
      opts?.types?.length ? [vecStr, limit, opts.types] : [vecStr, limit]
    );

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }

  // Chunks
  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    // Get page_id
    const pageResult = await this.db.query('SELECT id FROM pages WHERE slug = $1', [slug]);
    if (pageResult.rows.length === 0) throw new Error(`Page not found: ${slug}`);
    const pageId = (pageResult.rows[0] as { id: number }).id;

    // Remove chunks that no longer exist
    const newIndices = chunks.map(c => c.chunk_index);
    if (newIndices.length > 0) {
      // PGLite doesn't auto-serialize arrays, so use ANY with explicit array cast
      await this.db.query(
        `DELETE FROM content_chunks WHERE page_id = $1 AND chunk_index != ALL($2::int[])`,
        [pageId, newIndices]
      );
    } else {
      await this.db.query('DELETE FROM content_chunks WHERE page_id = $1', [pageId]);
      return;
    }

    // Batch upsert: build dynamic multi-row INSERT
    const cols = '(page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at)';
    const rowParts: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const chunk of chunks) {
      const embeddingStr = chunk.embedding
        ? '[' + Array.from(chunk.embedding).join(',') + ']'
        : null;

      if (embeddingStr) {
        rowParts.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::vector, $${paramIdx++}, $${paramIdx++}, now())`);
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, embeddingStr, chunk.model || 'text-embedding-3-large', chunk.token_count || null);
      } else {
        rowParts.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NULL, $${paramIdx++}, $${paramIdx++}, NULL)`);
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, chunk.model || 'text-embedding-3-large', chunk.token_count || null);
      }
    }

    await this.db.query(
      `INSERT INTO content_chunks ${cols} VALUES ${rowParts.join(', ')}
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         embedding = COALESCE(EXCLUDED.embedding, content_chunks.embedding),
         model = COALESCE(EXCLUDED.model, content_chunks.model),
         token_count = EXCLUDED.token_count,
         embedded_at = COALESCE(EXCLUDED.embedded_at, content_chunks.embedded_at)`,
      params
    );
  }

  async getChunks(slug: string): Promise<Chunk[]> {
    const { rows } = await this.db.query(
      `SELECT cc.* FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = $1
       ORDER BY cc.chunk_index`,
      [slug]
    );
    return (rows as Record<string, unknown>[]).map(r => rowToChunk(r));
  }

  async deleteChunks(slug: string): Promise<void> {
    await this.db.query(
      `DELETE FROM content_chunks
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1)`,
      [slug]
    );
  }

  // Links
  async addLink(from: string, to: string, context?: string, linkType?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context)
       SELECT f.id, t.id, $3, $4
       FROM pages f, pages t
       WHERE f.slug = $1 AND t.slug = $2
       ON CONFLICT (from_page_id, to_page_id) DO UPDATE SET
         link_type = EXCLUDED.link_type,
         context = EXCLUDED.context`,
      [from, to, linkType || '', context || '']
    );
  }

  async removeLink(from: string, to: string): Promise<void> {
    await this.db.query(
      `DELETE FROM links
       WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1)
         AND to_page_id = (SELECT id FROM pages WHERE slug = $2)`,
      [from, to]
    );
  }

  async getLinks(slug: string): Promise<Link[]> {
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       WHERE f.slug = $1`,
      [slug]
    );
    return rows as unknown as Link[];
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       WHERE t.slug = $1`,
      [slug]
    );
    return rows as unknown as Link[];
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    const { rows } = await this.db.query(
      `WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.types, 0 as depth
        FROM pages p WHERE p.slug = $1

        UNION

        SELECT p2.id, p2.slug, p2.title, p2.types, g.depth + 1
        FROM graph g
        JOIN links l ON l.from_page_id = g.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE g.depth < $2
      )
      SELECT DISTINCT g.slug, g.title, g.types, g.depth,
        coalesce(
          (SELECT jsonb_agg(jsonb_build_object('to_slug', p3.slug, 'link_type', l2.link_type))
           FROM links l2
           JOIN pages p3 ON p3.id = l2.to_page_id
           WHERE l2.from_page_id = g.id),
          '[]'::jsonb
        ) as links
      FROM graph g
      ORDER BY g.depth, g.slug`,
      [slug, depth]
    );

    return (rows as Record<string, unknown>[]).map(r => {
      const types = Array.isArray(r.types) ? r.types.map(String) :
        typeof r.types === 'string' && (r.types as string).startsWith('{') ?
          (r.types as string).slice(1, -1).split(',').filter(Boolean) : [];
      return {
        slug: r.slug as string,
        title: r.title as string,
        types,
        depth: r.depth as number,
        links: (typeof r.links === 'string' ? JSON.parse(r.links) : r.links) as { to_slug: string; link_type: string }[],
      };
    });
  }

  // Tags
  async addTag(slug: string, tag: string): Promise<void> {
    await this.db.query(
      `INSERT INTO tags (page_id, tag)
       SELECT id, $2 FROM pages WHERE slug = $1
       ON CONFLICT (page_id, tag) DO NOTHING`,
      [slug, tag]
    );
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    await this.db.query(
      `DELETE FROM tags
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1)
         AND tag = $2`,
      [slug, tag]
    );
  }

  async getTags(slug: string): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT tag FROM tags
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1)
       ORDER BY tag`,
      [slug]
    );
    return (rows as { tag: string }[]).map(r => r.tag);
  }

  // Raw data
  async putRawData(slug: string, source: string, data: object): Promise<void> {
    await this.db.query(
      `INSERT INTO raw_data (page_id, source, data)
       SELECT id, $2, $3::jsonb
       FROM pages WHERE slug = $1
       ON CONFLICT (page_id, source) DO UPDATE SET
         data = EXCLUDED.data,
         fetched_at = now()`,
      [slug, source, JSON.stringify(data)]
    );
  }

  async getRawData(slug: string, source?: string): Promise<RawData[]> {
    let result;
    if (source) {
      result = await this.db.query(
        `SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
         JOIN pages p ON p.id = rd.page_id
         WHERE p.slug = $1 AND rd.source = $2`,
        [slug, source]
      );
    } else {
      result = await this.db.query(
        `SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
         JOIN pages p ON p.id = rd.page_id
         WHERE p.slug = $1`,
        [slug]
      );
    }
    return result.rows as unknown as RawData[];
  }

  // Versions
  async createVersion(slug: string): Promise<PageVersion> {
    const { rows } = await this.db.query(
      `INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
       SELECT id, compiled_truth, frontmatter
       FROM pages WHERE slug = $1
       RETURNING *`,
      [slug]
    );
    return rows[0] as unknown as PageVersion;
  }

  async getVersions(slug: string): Promise<PageVersion[]> {
    const { rows } = await this.db.query(
      `SELECT pv.* FROM page_versions pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.slug = $1
       ORDER BY pv.snapshot_at DESC`,
      [slug]
    );
    return rows as unknown as PageVersion[];
  }

  async revertToVersion(slug: string, versionId: number): Promise<void> {
    await this.db.query(
      `UPDATE pages SET
        compiled_truth = pv.compiled_truth,
        frontmatter = pv.frontmatter,
        updated_at = now()
      FROM page_versions pv
      WHERE pages.slug = $1 AND pv.id = $2 AND pv.page_id = pages.id`,
      [slug, versionId]
    );
  }

  // Stats + health
  async getStats(): Promise<BrainStats> {
    const { rows: [stats] } = await this.db.query(`
      SELECT
        (SELECT count(*) FROM pages) as page_count,
        (SELECT count(*) FROM content_chunks) as chunk_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) as embedded_count,
        (SELECT count(*) FROM links) as link_count,
        (SELECT count(DISTINCT tag) FROM tags) as tag_count
    `);

    const { rows: types } = await this.db.query(
      `SELECT unnest(types) as type_name, count(*)::int as count FROM pages GROUP BY type_name ORDER BY count DESC`
    );
    const pages_by_type: Record<string, number> = {};
    for (const t of types as { type_name: string; count: number }[]) {
      pages_by_type[t.type_name] = t.count;
    }

    const s = stats as Record<string, unknown>;
    return {
      page_count: Number(s.page_count),
      chunk_count: Number(s.chunk_count),
      embedded_count: Number(s.embedded_count),
      link_count: Number(s.link_count),
      tag_count: Number(s.tag_count),
      pages_by_type,
    };
  }

  async getHealth(): Promise<BrainHealth> {
    const { rows: [h] } = await this.db.query(`
      SELECT
        (SELECT count(*) FROM pages) as page_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL)::float /
          GREATEST((SELECT count(*) FROM content_chunks), 1)::float as embed_coverage,
        (SELECT count(*) FROM pages p
         WHERE p.updated_at < NOW() - INTERVAL '90 days'
        ) as stale_pages,
        (SELECT count(*) FROM pages p
         WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
        ) as orphan_pages,
        (SELECT count(*) FROM links l
         WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)
        ) as dead_links,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NULL) as missing_embeddings
    `);

    const r = h as Record<string, unknown>;
    return {
      page_count: Number(r.page_count),
      embed_coverage: Number(r.embed_coverage),
      stale_pages: Number(r.stale_pages),
      orphan_pages: Number(r.orphan_pages),
      dead_links: Number(r.dead_links),
      missing_embeddings: Number(r.missing_embeddings),
    };
  }

  // Ingest log
  async logIngest(entry: IngestLogInput): Promise<void> {
    await this.db.query(
      `INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [entry.source_type, entry.source_ref, JSON.stringify(entry.pages_updated), entry.summary]
    );
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    const limit = opts?.limit || 500;
    const { rows } = await this.db.query(
      `SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows as unknown as IngestLogEntry[];
  }

  // Sync
  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    newSlug = validateSlug(newSlug);
    await this.db.query(
      `UPDATE pages SET slug = $1, updated_at = now() WHERE slug = $2`,
      [newSlug, oldSlug]
    );
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Stub: links use integer page_id FKs, already correct after updateSlug.
  }

  // Config
  async getConfig(key: string): Promise<string | null> {
    const { rows } = await this.db.query('SELECT value FROM config WHERE key = $1', [key]);
    return rows.length > 0 ? (rows[0] as { value: string }).value : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  // Raw SQL execution
  async executeRaw(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const result = await this.db.query(sql, params);
    return result.rows as Record<string, unknown>[];
  }

  // Migration support
  async runMigration(_version: number, sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async getChunksWithEmbeddings(slug: string): Promise<Chunk[]> {
    const { rows } = await this.db.query(
      `SELECT cc.* FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = $1
       ORDER BY cc.chunk_index`,
      [slug]
    );
    return (rows as Record<string, unknown>[]).map(r => rowToChunk(r, true));
  }

  // Files
  async listFiles(pageSlug?: string): Promise<any[]> {
    if (pageSlug) {
      const result = await this.db.query(
        'SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata, created_at FROM files WHERE page_slug = $1 ORDER BY created_at DESC',
        [pageSlug]
      );
      return result.rows;
    }
    const result = await this.db.query(
      'SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata, created_at FROM files ORDER BY created_at DESC'
    );
    return result.rows;
  }

  async uploadFile(file: { page_slug?: string; filename: string; storage_path: string; mime_type?: string; size_bytes?: number; content_hash: string; metadata?: Record<string, any> }): Promise<{ id: number }> {
    const existing = await this.db.query(
      'SELECT id FROM files WHERE content_hash = $1 AND page_slug = $2',
      [file.content_hash, file.page_slug ?? null]
    );
    if (existing.rows.length > 0) {
      return { id: existing.rows[0].id };
    }
    const result = await this.db.query(
      `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [file.page_slug ?? null, file.filename, file.storage_path, file.mime_type ?? null, file.size_bytes ?? null, file.content_hash, JSON.stringify(file.metadata ?? {})]
    );
    return { id: result.rows[0].id };
  }

  async getFileUrl(storagePath: string): Promise<{ storage_path: string; filename: string; mime_type?: string } | null> {
    const result = await this.db.query(
      'SELECT storage_path, filename, mime_type FROM files WHERE storage_path = $1',
      [storagePath]
    );
    return result.rows[0] ?? null;
  }
}
