# CFBrain Architecture

Three-layer model: **Raw → Brain → Display**.

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Raw                                            │
│   raw/ directory — original source files, MIME detect   │
│   Untouched ingestion artifacts (PDFs, HTML, audio)     │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Brain                                          │
│   PGLite / Postgres DB + pages/ directory               │
│   Pages (types[], tags, links, versions)                │
│   Chunks + embeddings (vector search)                   │
│   Structured CHANGELOG (append-only)                    │
│   Epistemology lint (attribution + staleness)            │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Display (Feishu Wiki)                          │
│   Origin docs + type-directory shortcuts                │
│   Two-pass push (nodes → content with wiki-links)       │
│   Block API content rendering                           │
│   Comment polling + resolution loop                     │
│   CHANGELOG wiki page                                   │
└─────────────────────────────────────────────────────────┘
```

## Engine Abstraction

`BrainEngine` interface (`src/core/engine.ts`) defines 37 methods. Two implementations:

- **PGLiteEngine** — embedded Postgres 17.5 via WASM. Zero-config default. Data at `~/.cfbrain/brain.pglite`.
- **PostgresEngine** — Postgres + pgvector (Supabase or self-hosted). Recommended for 1000+ pages.

Engine factory (`src/core/engine-factory.ts`) dynamically imports the configured engine.

## Contract-First Operations

`src/core/operations.ts` defines ~30 operations. Both CLI (`src/cli.ts`) and MCP server (`src/mcp/server.ts`) are generated from this single source. Each operation specifies name, params, handler, and CLI hints.

## Data Flow

```
Source files → importFromFile → parseMarkdown → chunk → embed → putPage (DB + pages/)
                                                                    ↓
                                                              feishu push
                                                                    ↓
                                                         Feishu Wiki (display)
```

## Feishu Sync Flow

1. **`feishu init`** — configure space, create type directories, idempotent
2. **`feishu push`** — two-pass: Pass 1 creates/updates wiki nodes; Pass 2 writes content with resolved `[[wiki-links]]`
3. **`feishu poll`** — collect comments from Feishu nodes
4. **`resolve-comment`** — close the loop: process comment, update page, mark resolved

Stale cleanup runs on multi-page pushes. Delete operations archive nodes to trash directory.

## Multi-Type Architecture

Pages have `types: string[]` (not singular type). Types are stored as `TEXT[]` in the database with GIN index. Type directories in Feishu use shortcuts (one origin doc, shortcuts in each matching type directory).

## Key Directories

- `src/core/` — engine, operations, types, search, chunkers, embedding
- `src/commands/` — CLI command handlers (one file per command group)
- `src/mcp/` — MCP stdio server
- `specs/` — Feature specifications
- `test/` — Unit tests (Bun test runner)
- `test/e2e/` — E2E tests (require Postgres + pgvector)
- `skills/` — Fat markdown skill files (ingest, query, maintain, enrich, etc.)
