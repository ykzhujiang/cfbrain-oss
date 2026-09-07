# Audit & Stripping Report

How this open-source distribution was separated from its private, in-production
origin — what was found, what was removed, and how it was verified.

- **Executed by:** cfbrain (Main Agent)
- **Date:** 2026-09-06 / 2026-09-08
- **Requested by:** the repository owner
- **Hard constraint:** never modify the running production repositories. All work
  happened in a fresh directory; the source repos were read-only throughout.

---

## 1. Audit scope

Two private production repositories:

| Repo | Visibility | Tracked files | `.git` size |
|---|---|---|---|
| code | PRIVATE | 626 | 41 MB |
| data | PRIVATE | 6,499 | 1.9 GB |

**Headline finding:** code and data *were* correctly split across two
repositories. But both were polluted, and **four real API keys had been committed
into git history**. Neither repo could be made public as-is.

---

## 2. Findings

### 2.1 Secrets in git history (P0)

| Secret | Location | Commits |
|---|---|---|
| `OPENAI_API_KEY` | `shared/scripts/cfbrain-exec.sh` | 4 |
| `OPENAI_API_KEY` (same) | `cfbrain-cli/SKILL.md` | 4 |
| `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` | data repo `config.json` | 5 |
| `FEISHU_APP_SECRET` + `ANTHROPIC_API_KEY` | 4 × `*/.env.bak` | 5 |

**Root cause: a `.gitignore` rule does not untrack an already-committed file.**
Both repos *had* ignore rules for these paths. The files were already in the index,
so the rules did nothing. The data repo ignored `config.json` while `config.json`
sat in `HEAD`; the code repo ignored `*/.env` but not `*.env.bak`, so four backup
files carrying an app secret went in.

This is the single most transferable lesson in this document. If you find a secret
in your index: `git rm --cached <file>`, fix the ignore rule, **and rotate the
key** — it is still in history.

### 2.2 Data repo bloated to 1.9 GB by rebuildable artifacts (P1)

Actual knowledge was 2.5 MB — 0.15% of the repo:

| Path | Size | Files | Nature |
|---|---|---|---|
| `raw/` | 1.7 GB | 920 | source binaries (a 143 MB audio, a 217 MB video) |
| 3 × DB backup dirs | 180 MB | 3,172 | rebuildable |
| `pglite/`, `pglite-data/` | 74 MB | 1,935 | runtime state |
| `.trash/` | 120 KB | 25 | recycle bin |
| **`pages/`** | **2.5 MB** | **350** | **the actual knowledge** |

### 2.3 87 stale duplicate pages (P1)

The data repo root held 89 loose `.md` files; 87 duplicated `pages/`. Root copies
were frozen at 2026-06-17 while `pages/` had advanced to 09-01. Of 30 sampled,
**12 had diverged**. Any code reading by filename could get three-month-old
content.

### 2.4 Business data inside the code repo (P1)

262 files that had no business being in a code repo:

| Content | Files | Sensitivity |
|---|---|---|
| business reports & directives | 126 | high |
| IM attachments (24 MB) | 40 | **critical** — included a company BP and an investor deck |
| meeting verbatim transcripts | 32 | **critical** |
| mailbox contents | 21 | high |
| eval reports | 18 | medium |
| browser session logs | 16 | medium |
| business profile / goals | 9 | high |

### 2.5 The CLI source itself was nearly clean (good news)

76 TS files, 17,624 lines, only **2** hardcoded sensitive values. This is why the
separation was cheap: the leaks were all in config, scripts and operational data,
not in the program.

---

## 3. Principles applied

1. **Whitelist, not blacklist.** Built up from an empty directory by explicitly
   copying vetted paths, rather than deleting sensitive files from a copy. Missing
   a delete is far more likely than missing an add.
2. **Fresh git history.** `git init` from scratch. Because secrets existed in the
   origin's history, *any* inherited commit would carry risk. This repo has exactly
   one commit.
3. **Read-only on the origin.** No write of any kind to the production repos.
4. **Config out of code.** Every environment-specific value is env-driven.
5. **When unsure, exclude.**
6. **Verify with evidence.** An automated scanner plus a real install on an empty
   `HOME` — not "looks fine to me".

---

## 4. What was removed

| Category | Detail |
|---|---|
| Secrets | all 4 keys, `.env`, 4 × `.env.bak`, `config.json` |
| Knowledge | 350 pages, 89 root duplicates |
| Raw material | `raw/` (1.7 GB), `export/` |
| Databases | 5 PGLite copies, `.trash/` |
| IM data | attachments incl. company BP and investor deck |
| Meetings | 32 verbatim transcripts |
| Operations | outbox, mailbox, eval reports, browser logs, session summaries |
| Business context | profile / goals / current-state → replaced with empty templates |
| Internal dev docs | `specs/` (53), implementation plans, prompt drafts, TODOs |
| Build output | `node_modules/`, `bin/`, redundant `package-lock.json` |
| **Cross-agent credential access** | a script that read *another* agent's plaintext `lark.secrets.json` — removed entirely |

## 5. What was rewritten

| Target | Change |
|---|---|
| `src/core/feishu.ts` | dropped a hardcoded `/Users/<name>` HOME fallback; `lark-cli` now resolves from `PATH` (`LARK_CLI_BIN` to override) — also makes it work on Linux |
| `src/commands/feishu.ts` | hardcoded tenant domain → `config.feishu.domain` / `FEISHU_DOMAIN` |
| `src/commands/mail.ts` | default recipient roster contained two real personal addresses → now empty, driven by `CFBRAIN_BRIEFING_RECIPIENTS` |
| `src/core/agentmail.ts` | default inbox → non-routable `agent@example.com` placeholder |
| tests | assertions updated to the new empty-roster semantics; personal names and paths genericised |
| `agent-templates/**` | all tenant identifiers, wiki node tokens, names, paths → placeholders |
| identity sections | referenced three *other* real agents by name and email → generic `<OTHER_AGENT_N>` |

Placeholder mapping: `<YOUR_FEISHU_APP_ID>`, `<YOUR_FEISHU_SPACE_ID>`,
`<YOUR_FEISHU_OWNER_OPEN_ID>`, `<YOUR_FEISHU_BOT_OPEN_ID>`,
`<NODE_TOKEN_{TYPE}>`, `<OWNER>`, `<YOUR_COMPANY>`, `<AGENT_NAME>`,
`$CFBRAIN_HOME`, `$CFBRAIN_DATA_HOME`, `<your-org>.feishu.cn`.

## 6. What was added

`README.md`, `QUICKSTART.md`, `.env.example` (documents all 21 env vars),
`install.sh` (idempotent installer), `.gitignore` (hardened with the 2.1 lesson),
`examples/` (3 fictional pages), `agent-templates/README.md`,
`scripts/scan-secrets.sh`.

## 7. Bug found and fixed during verification

`cfbrain init` **failed on a first-ever install.** PGLite creates its database
directory but not the parents, and `~/.cfbrain` does not exist yet on a clean
machine:

```
ENOENT: no such file or directory, mkdir '/…/.cfbrain/brain.pglite'
```

Every new user would have hit this on step one. Fixed by creating the parent
directory before connecting (`src/commands/init.ts`).

Also corrected two **documentation** inaccuracies found by actually running the
examples: `import` does not build wiki-links or embeddings, so `backlinks`
returns `[]` until `repair --links` runs. The docs now say so explicitly instead of
promising results that would not appear.

---

## 8. Verification evidence

```
$ ./scripts/scan-secrets.sh
 ok   no OpenAI/Anthropic API keys
 ok   no Feishu app ids or open ids
 ok   no Feishu space id / wiki node tokens
 ok   no personal / org identifiers
 ok   no reads of another agent's credential store
 ok   no hardcoded /Users or /home paths
 ok   no real email addresses
 ok   no .env / config.json / *.env.bak / *.pem / *.key
 ok   no pages/ raw/ export/ directories
CLEAN — safe to commit.

$ bun test
 1080 pass · 119 skip · 0 fail   (skips require an external DATABASE_URL)

$ HOME=<empty dir> bash install.sh
 ok  Bun 1.3.13 · dependencies installed · .env created
 ok  brain created · doctor passed
```

Also verified end to end on a clean checkout with an empty `HOME`:
`init` → `put` → `get` → `list` → `search` → `import` → `repair --links` →
`backlinks` → `graph` → `doctor`.

Final: **275 files, 4.3 MB, 1 commit, no `node_modules`, no secrets.**

---

## 9. What stripping does NOT fix

A clean new repo says nothing about the old ones. These require human action:

1. **Rotate all four keys.** They remain in two private repos' history; anyone with
   read access can extract them. This is the only genuinely urgent item.
2. **Stop the bleeding in the origin:** `git rm --cached config.json` and the four
   `.env.bak`; add `*.env.bak` to `.gitignore`.
3. **History rewrite** to purge 1.9 GB of binaries and the keys needs
   `git filter-repo` across ~1,099 commits. Higher risk — a deliberate decision,
   not something to do casually.
4. **Delete the 87 stale root duplicates** (`pages/` is the single source of truth).
   One file, `2026-04-19-intel-claude-max-saving-2.md`, exists *only* at the root —
   decide whether to migrate or drop it.
5. **Keep both origin repos PRIVATE**, regardless of this distribution's status.

---

## 10. Reusing this process

`scripts/scan-secrets.sh` is the durable artifact. Run it before every commit:

```bash
./scripts/scan-secrets.sh   # exit 0 = clean, 1 = blocked
```

It checks seven classes: API-key shapes, tenant identifiers, personal/org
identifiers, cross-agent credential paths, hardcoded home paths, real email
addresses, and files that must never be committed. Extend the patterns for your
own environment — a scanner that has never blocked anything is not proof of
cleanliness, only of a weak pattern set.
