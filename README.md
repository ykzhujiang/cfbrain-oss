# CFBrain

**A Postgres-native personal knowledge brain with hybrid RAG search.**

CFBrain turns scattered notes, PDFs, meeting transcripts and half-formed thoughts
into a queryable knowledge graph that an AI agent can actually reason over — with
every claim traceable back to its original source.

It runs fully local by default. No server, no cloud account, no Docker.

**Your data never leaves your machine.** `init` creates `~/.cfbrain` with no git
remote configured, so nothing is pushed anywhere — not to GitHub, not to this
project, not to anyone. Syncing is opt-in and you choose the destination; see
[docs/DATA-AND-SYNC.md](docs/DATA-AND-SYNC.md).

```bash
git clone https://github.com/ykzhujiang/cfbrain-oss.git
cd cfbrain-oss
./install.sh
```

Or build a single self-contained binary — no Bun, no `node_modules`, no source
tree needed to run it:

```bash
bun run build          # -> bin/cfbrain  (79 MB, everything embedded)
./scripts/verify-binary.sh
```

---

## Why this exists

Most "AI memory" tools store text and hope the embedding model figures it out.
That breaks down the moment you need to trust the answer. CFBrain is built around
three opinions:

**1. Compiled truth, not an append-only log.**
Each page has a top section that is *rewritten* to hold your current best
understanding, and a timeline below that only ever grows. You read the conclusion;
the evidence chain stays auditable underneath.

**2. Every claim carries its source and confidence.**
Pages are annotated `observed` / `self-described` / `reported` / `inferred` with a
confidence level. When two sources disagree, both are kept and flagged rather than
silently resolved. An agent reading the brain can tell you *why* it believes
something — or admit it does not know.

**3. Raw material is never thrown away.**
`--raw` stores the original PDF, audio, transcript or screenshot alongside the
compiled page. The summary is always re-derivable from the primary evidence.

---

## What you get

| | |
|---|---|
| **Storage** | PGLite (embedded Postgres) by default; swap to Supabase/Postgres with one command |
| **Search** | Keyword (tsvector) + vector (pgvector) + RRF hybrid fusion with query expansion |
| **Graph** | Typed `[[wiki-links]]`, backlinks, multi-hop graph traversal |
| **Ingest** | Markdown, PDF, PPTX, meeting minutes; large-file splitting pipeline |
| **Integrity** | `doctor` health checks, `lint` epistemic checks, `repair` bulk reconciliation |
| **Interfaces** | CLI, MCP server (Claude Desktop / Claude Code), HTTP server |
| **Optional** | Feishu/Lark wiki two-way sync, email digests |

---

## Quick start

```bash
./install.sh                                  # Bun + deps + local brain
bun run src/cli.ts --help
```

Write and read a page:

```bash
cat > /tmp/ada.md <<'EOF'
---
title: Ada Lovelace
types: [person]
confidence: high
---

19th-century mathematician, widely considered the first computer programmer.
Wrote the first algorithm intended for [[analytical-engine]].

## Source
- [reported: public record, 2026-09-06] (confidence: high)
EOF

bun run src/cli.ts put ada-lovelace --content-file /tmp/ada.md
bun run src/cli.ts get ada-lovelace
bun run src/cli.ts list
bun run src/cli.ts search "Lovelace"
```

Import an existing folder of markdown:

```bash
bun run src/cli.ts import ~/my-notes --no-embed
bun run src/cli.ts repair --all          # build wiki-links + embeddings
bun run src/cli.ts query "who works on chip design?"
```

Full walkthrough: **[QUICKSTART.md](QUICKSTART.md)**

---

## Command overview

```
SETUP     init · migrate · doctor · config · integrations
PAGES     get · put · delete · list
SEARCH    search (keyword) · query (hybrid vector + keyword)
INGEST    import · ingest (PDF/PPTX) · ingest-minutes · sync
LINKS     link · unlink · backlinks · graph
TAGS      tags · tag · untag
EMBED     embed · repair
SERVE     serve (HTTP) · call (MCP)
FEISHU    feishu setup (guided install) · init/push/status/poll   (optional)
```

`bun run src/cli.ts --help` prints the authoritative list.

---

## The 10 page types

`person` · `company` · `meeting` · `project` · `decision` · `concept` · `intel` ·
`deal` · `note` · `recruit`

`put` rejects anything outside this list — a deliberate constraint that keeps the
graph queryable instead of accumulating one-off categories. Use `--force` to
override when you genuinely need to.

---

## Requirements

- **[Bun](https://bun.sh) ≥ 1.0** — the only hard dependency (`install.sh` will fetch it)
- **An OpenAI-compatible API key** — only for semantic search; keyword search works without one
- *Optional:* Postgres/Supabase for large brains, `lark-cli` for Feishu sync

---

## Configuration

Everything is environment-driven. Copy the template and edit:

```bash
cp .env.example .env
```

`.env.example` documents every variable. Nothing is required except
`OPENAI_API_KEY` (and even that only for semantic search).

> **`.env` and `config.json` are gitignored.** Never commit real keys. Note that
> adding a `.gitignore` rule does *not* untrack an already-committed file — see
> [docs/AUDIT-AND-STRIPPING.md](docs/AUDIT-AND-STRIPPING.md) for how that bites.

### Leak protection

This repo ships a scanner and a git hook so the mistake above cannot repeat:

```bash
./scripts/scan-secrets.sh    # exit 0 = clean, 1 = blocked
./scripts/install-hooks.sh   # run once: blocks any commit that fails the scan
```

The scanner checks API-key shapes, tenant identifiers, personal data, hardcoded
home paths, real email addresses, and files that must never be committed. Extend
the patterns in `scripts/scan-secrets.sh` for your own environment.

---

## Agent templates (optional)

`agent-templates/` contains the multi-agent architecture this brain was built to
serve — a **Main** agent that does the knowledge work, plus a
**Planner → Generator → Evaluator** loop that improves the system itself.

```
agent-templates/
├── main/AGENTS.md          # knowledge capture, retrieval, audit workflows
├── planner/AGENTS.md       # decides what to improve next
├── generator/AGENTS.md     # implements changes
├── evaluator/AGENTS.md     # gates changes before deploy
├── shared/control/         # guardrails / red lines
├── shared/context/         # business profile, goals, rules (fill these in)
└── shared/scripts/         # orchestration, cron, deploy
```

These are **templates**, not runnable config. Every environment-specific value is
a `<PLACEHOLDER>`. Start with `shared/context/profile.md` — the agent's judgement
is only as good as the context you give it.

---

## Known limitations

Being honest about what does not work yet:

- **CJK keyword search is weak.** `search` uses Postgres `tsvector`, which does not
  segment Chinese/Japanese/Korean. Use `query` (vector search) for CJK content.
- **Large file attachments over ~100 MB fail on Feishu push.** The uploader is not
  multipart; it leaves an empty attachment block. Small files are fine.
- **`specs/` and internal design docs are not included** in this distribution.
- **Feishu integration assumes `lark-cli`**, which is a separate tool with its own
  auth flow.

---

## Documentation

| Doc | What's in it |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | 5-minute walkthrough |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Engines, schema, search pipeline |
| [docs/guides/](docs/guides/) | Compiled truth, source attribution, entity detection, search modes |
| [docs/mcp/](docs/mcp/) | Claude Desktop / Claude Code / MCP setup |
| [docs/ENGINES.md](docs/ENGINES.md) | PGLite vs Postgres trade-offs |
| [docs/INSTALL-AND-MULTI-AGENT.md](docs/INSTALL-AND-MULTI-AGENT.md) | Install options, using your own Feishu wiki + categories, letting other agents write via MCP |
| [docs/DATA-AND-SYNC.md](docs/DATA-AND-SYNC.md) | 数据存在哪、同步到哪、和本仓库什么关系（**先读这个**） |
| [docs/FEISHU-SETUP.md](docs/FEISHU-SETUP.md) | 飞书接入：用哪个知识库、怎么授权、分类怎么定 |
| [docs/AGENT-INSTALL-GUIDE.md](docs/AGENT-INSTALL-GUIDE.md) | 给 AI Agent 执行的干净机器安装验收脚本 |
| [docs/MANUAL-TESTING.md](docs/MANUAL-TESTING.md) | Step-by-step manual test guide with expected output |
| [docs/AUDIT-AND-STRIPPING.md](docs/AUDIT-AND-STRIPPING.md) | How this open-source build was separated from its private origin |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow |

---

## Provenance

This is a sanitised distribution of a private, in-production personal knowledge
system. All secrets, knowledge content, personal data and organisation-specific
identifiers were removed, and the git history was started fresh — see
[docs/AUDIT-AND-STRIPPING.md](docs/AUDIT-AND-STRIPPING.md) for the full audit and
the exact removal criteria.

---

## License

MIT — see [LICENSE](LICENSE).
