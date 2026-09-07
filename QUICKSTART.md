# QUICKSTART

Goal: a working brain with real content in it, in about 5 minutes.

---

## 0. Install

```bash
git clone https://github.com/ykzhujiang/cfbrain-oss.git
cd cfbrain-oss
./install.sh
```

`install.sh` is idempotent — re-running it never overwrites your `.env` or your brain.

It will:
1. install Bun if missing
2. `bun install`
3. create `.env` from `.env.example`
4. create a local PGLite brain at `~/.cfbrain/brain.pglite`
5. run `doctor`

If you prefer to do it by hand:

```bash
curl -fsSL https://bun.sh/install | bash     # if you don't have Bun
bun install
cp .env.example .env
bun run src/cli.ts init --pglite --non-interactive
```

> **Shortcut:** the examples below use `bun run src/cli.ts`. Run `bun link` once
> and you can just type `cfbrain` instead.

---

## 1. Add your API key (optional but recommended)

Open `.env` and set:

```
OPENAI_API_KEY=sk-...
```

Without it: `put`, `get`, `list`, `search` (keyword) all work.
With it: `query` (semantic/hybrid search) also works.

---

## 2. Write your first page

Pages are markdown with YAML frontmatter. The `types` field must be one of the
10 allowed types.

```bash
cat > /tmp/note.md <<'EOF'
---
title: Hybrid search beats pure vector search
types: [concept]
confidence: high
---

Pure vector search fails on exact identifiers — names, dates, error codes. Pure
keyword search fails on paraphrase. Reciprocal Rank Fusion over both consistently
beats either alone, which is why [[cfbrain]] runs them in parallel and fuses.

## Source
- [observed: own benchmarking, 2026-09-06] (confidence: high)
EOF

bun run src/cli.ts put hybrid-search --content-file /tmp/note.md
```

Read it back:

```bash
bun run src/cli.ts get hybrid-search
bun run src/cli.ts list
```

Note the `[[cfbrain]]` wiki-link — CFBrain tracked it as a graph edge even though
that page does not exist yet. Create it later and the link resolves automatically.

---

## 3. Keep the original source

This is the point of the tool. Never let the summary become the only copy:

```bash
bun run src/cli.ts put q3-board-deck \
  --content-file /tmp/summary.md \
  --raw ~/Downloads/board-deck.pdf \
  --raw ~/Downloads/transcript.txt
```

The raw files are copied into the brain's `raw/` directory and recorded in the
page's `raw_source` frontmatter, so the summary is always re-derivable.

---

## 4. Import what you already have

```bash
bun run src/cli.ts import ~/my-notes --no-embed   # fast, skips embeddings
bun run src/cli.ts repair --all                   # build wiki-links + embeddings
```

Splitting it this way is much faster for a big folder than doing everything inline.

> **Don't skip `repair`.** `import` writes pages but does **not** resolve
> `[[wiki-links]]` into graph edges or generate embeddings. Without it,
> `backlinks` returns `[]` and `query` finds nothing. Use `repair --links` for the
> graph only, `repair --embed` for embeddings only, or `repair --all` for both.

---

## 5. Search

```bash
# keyword — best for exact names, dates, IDs
bun run src/cli.ts search "board deck"

# hybrid vector + keyword + RRF — best for concepts and questions
bun run src/cli.ts query "why does hybrid search work better?"
```

> **CJK note:** keyword `search` relies on Postgres `tsvector`, which does not
> segment Chinese/Japanese/Korean text. For CJK content use `query` instead.

---

## 6. Build the graph

```bash
bun run src/cli.ts link hybrid-search cfbrain --type implemented_by
bun run src/cli.ts backlinks cfbrain
bun run src/cli.ts graph cfbrain --depth 2
```

---

## 7. Ingest files directly

```bash
bun run src/cli.ts ingest ~/Downloads/whitepaper.pdf
bun run src/cli.ts ingest ~/Downloads/deck.pptx --types intel
```

PDFs over ~10 MB are routed through a splitting pipeline automatically.

---

## 8. Keep it healthy

```bash
bun run src/cli.ts doctor          # connection, schema, indexes, consistency
bun run src/cli.ts lint <slug>     # epistemic check on one page
bun run src/cli.ts repair --all    # reconcile wiki-links + embeddings
```

Run `doctor` first whenever something behaves oddly.

---

## 9. Connect it to Claude (optional)

CFBrain speaks MCP, so an agent can read and write the brain directly:

```bash
bun run src/cli.ts serve            # HTTP server
bun run src/cli.ts call <tool>      # invoke an MCP tool
```

Setup guides: [docs/mcp/CLAUDE_DESKTOP.md](docs/mcp/CLAUDE_DESKTOP.md),
[docs/mcp/CLAUDE_CODE.md](docs/mcp/CLAUDE_CODE.md).

---

## 10. Outgrowing local storage

PGLite handles a few thousand pages comfortably. Beyond that, move to Postgres:

```bash
bun run src/cli.ts migrate --to supabase
```

See [docs/ENGINES.md](docs/ENGINES.md) for the trade-offs.

---

## Where things live

| Path | What |
|---|---|
| `~/.cfbrain/brain.pglite` | the database |
| `~/.cfbrain/pages/` | your pages as markdown (the source of truth) |
| `~/.cfbrain/raw/` | original source files |
| `./.env` | your keys — never committed |

Because `pages/` is plain markdown, you can put `~/.cfbrain` under its own private
git repo and version your knowledge. **Keep that repo private, and never commit
`config.json`** — it can contain API keys.

---

## Next

- Conventions that make the brain trustworthy: [docs/guides/compiled-truth.md](docs/guides/compiled-truth.md), [docs/guides/source-attribution.md](docs/guides/source-attribution.md)
- Running it as an autonomous agent: [agent-templates/](agent-templates/)
