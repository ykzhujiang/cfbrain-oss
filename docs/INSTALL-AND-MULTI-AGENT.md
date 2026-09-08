# Install & Multi-Agent Setup

Three questions this answers:

1. How does someone install this? Do they have to build it?
2. How do they point it at **their own** Feishu wiki with **their own** categories?
3. Can their **other agents** write into the brain?

Short answers: `git clone` + two commands · yes, fully · yes, over MCP.

---

## 1. Installing

### Recommended: clone + link

```bash
git clone https://github.com/ykzhujiang/cfbrain-oss.git
cd cfbrain-oss
./install.sh          # installs Bun if missing, deps, .env, local brain
bun link              # makes `cfbrain` a global command
```

Now `cfbrain` works from any directory:

```bash
cfbrain --help
cfbrain list
```

**Verified:** on a clean machine with an empty `HOME`, `install.sh` completes and
`doctor` passes. `bun link` then gives a working global `cfbrain`.

### Also works: single self-contained binary

```bash
bun run build              # -> bin/cfbrain   (79 MB)
bun run build:all          # + linux-x64 (116 MB)
./scripts/verify-binary.sh # 11 checks in a fully isolated environment
```

The binary needs **nothing else**: no Bun, no `node_modules`, no source tree.
Hand someone the file and it runs.

**Verified** by copying it to an empty directory and running under `env -i`
(empty environment, no inherited `PATH`, throwaway `HOME`): `init` → `put` →
`get` → `list` → `search` → `repair --links` → `doctor` → MCP `tools/list` +
`put_page` all pass — 11/11.

<details>
<summary>What had to be fixed to make this work</summary>

PGLite loads five payloads as side files from its npm package: `pglite.wasm`
(8.3 MB), `pglite.data` (5.0 MB), `initdb.wasm` (168 KB), plus `vector.tar.gz`
and `pg_trgm.tar.gz` extension bundles. `bun build --compile` does not bundle
them, and their lookup paths are baked to Bun's virtual filesystem, so the
binary failed with:

```
ENOENT: open '/$bunfs/root/pglite.data'
error: Extension bundle not found: file:///$bunfs/pg_trgm.tar.gz
```

Copying the files next to the binary does not help — the paths point into
`/$bunfs/`.

Fix (`src/core/pglite-assets.ts`): import every payload with
`with { type: 'file' }` so Bun embeds it, then
- pass the WASM/data payloads to `PGlite.create()` via its documented
  `pgliteWasmModule` / `initdbWasmModule` / `fsBundle` options;
- for extensions, PGLite only accepts `bundlePath: URL` and reads `file:` URLs
  off the real filesystem, so the embedded tarballs are written once into a
  version-keyed temp dir and referenced from there.

Both paths degrade gracefully: if the embedded assets cannot be loaded, PGLite's
own resolution takes over, which is what happens when running from source. This
accounts for the size increase from 65 MB to 79 MB.

</details>

---

## 2. Their own Feishu wiki, their own categories

### Categories are fully theirs

The 10 shipped types are only defaults. Types live in `config.json` under
`type_labels`, and `put` validates against **that**, not against a hardcoded list.

```bash
cfbrain types list                          # see current types + page counts
cfbrain types add paper --label "论文"       # add your own
cfbrain types remove deal                   # drop one you don't need
cfbrain types rename intel --label "行业情报" # relabel
```

**Verified:** after `types add paper`, a page with `types: [paper]` writes fine.
After `types remove deal`, a page with `types: [deal]` is rejected:

```
Error [invalid_params]: Invalid type(s): deal.
Allowed types: person, company, meeting, project, decision, concept, intel, note, recruit, paper.
```

So a classmate can throw away the whole default taxonomy and use their own.

### Pointing at their own Feishu space

```bash
# 1. install and authenticate lark-cli separately (its own tool, own auth flow)
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login

# 2a. let CFBrain create the space (needs one extra scope, granted once)
cfbrain feishu init --create-space "My Brain"
# 2b. or create it yourself in Feishu and pass its id (no extra scope needed)
cfbrain feishu init --space-id <THEIR_SPACE_ID>

# 4. push
cfbrain feishu push --all
cfbrain feishu status --json
```

Notes and caveats:

- `--create-space <name>` creates the space for them, but needs the
  `wiki:space:write_only` scope (`lark-cli auth login --scope "wiki:space:write_only"`).
  `--space-id <id>` works with a hand-created space and needs no extra scope.
- `feishu init` creates directory nodes named from the **current** `type_labels`,
  so run `cfbrain types ...` **first**, then `feishu init`.
- It is idempotent: existing root nodes with matching titles are reused, not
  duplicated.
- Set `FEISHU_DOMAIN` (or `feishu.domain` in config) to their tenant, e.g.
  `acme.feishu.cn`, so generated links point at the right host.
- Feishu is entirely optional. Everything else works without it.

---

## 3. Letting their other agents write into the brain

This is what MCP is for. `cfbrain serve` is an MCP stdio server that exposes **30
tools** generated from the operations registry — including `put_page`, `get_page`,
`search`, `query`, `add_link`, `get_backlinks`, `put_raw_data`.

Any MCP-capable agent (Claude Desktop, Claude Code, OpenCode, …) can then read and
write the same brain.

### Wiring it up

Claude Desktop / Claude Code — add to the MCP servers config:

```json
{
  "mcpServers": {
    "cfbrain": {
      "command": "cfbrain",
      "args": ["serve"],
      "env": { "HOME": "<YOUR_HOME_DIR>" }
    }
  }
}
```

If `cfbrain` is not on PATH, use the absolute form:

```json
{
  "command": "bun",
  "args": ["run", "/path/to/cfbrain-oss/src/cli.ts", "serve"]
}
```

See [mcp/CLAUDE_DESKTOP.md](mcp/CLAUDE_DESKTOP.md) and
[mcp/CLAUDE_CODE.md](mcp/CLAUDE_CODE.md).

### Verified end to end

A simulated external agent spoke raw MCP over stdio and successfully wrote and
read back a page:

```
initialize  -> OK  {name: cfbrain, version: 0.8.0}
tools/list  -> OK, 30 tools (put_page, get_page, search, query, add_link, …)
put_page    -> {"slug": "written-by-other-agent", "status": "created_or_updated"}
get_page    -> {"slug": "written-by-other-agent", "title": "…", …}
```

### Bug fixed to make this work

`cfbrain serve` used to exit instantly and answer nothing — not even
`initialize`. Cause: `cli.ts` ends with `main().then(() => process.exit(0))`, and
`serve` returned as soon as the transport *connected*, so the process was killed
before handling a single request. MCP integration was effectively dead.

Fixed in `src/commands/serve.ts`: the command now stays alive until the client
disconnects (stdin closes) or it is signalled.

### Without MCP

For scripts or non-MCP agents, invoke tools directly:

```bash
cfbrain call get_page '{"slug":"ada-lovelace"}'
cfbrain call put_page '{"slug":"x","content":"---\ntitle: X\ntypes: [note]\n---\nbody"}'
```

Same registry, same behaviour.

---

## Recommended setup for a new user

```bash
# 1. install
git clone https://github.com/ykzhujiang/cfbrain-oss.git
cd cfbrain-oss && ./install.sh && bun link

# 2. key for semantic search
$EDITOR .env                       # set OPENAI_API_KEY

# 3. make the taxonomy yours BEFORE touching Feishu
cfbrain types add <type> --label "<Label>"
cfbrain types remove <unwanted>

# 4. try it
cfbrain import ./examples/sample-pages --no-embed
cfbrain repair --all
cfbrain query "who wrote the first algorithm?"

# 5. optional: Feishu
lark-cli auth login
cfbrain feishu init --space-id <SPACE_ID>
cfbrain feishu push --all

# 6. optional: let other agents in
#    add the MCP server block above to your agent's config
```

---

## Current limitations, stated plainly

| Want | Status |
|---|---|
| `git clone` + install script | **works** (verified on empty HOME) |
| Global `cfbrain` command | **works** via `bun link` |
| Download one binary, run it | **works** — `bun run build`, verified 11/11 in an isolated environment |
| `npm install -g` from GitHub | untested; repo is private, so not usable by others yet |
| Own categories | **works**, fully replaceable |
| Own Feishu wiki | implemented both ways (`--create-space` / `--space-id`); **not verified end to end** — needs a throwaway Feishu account, see docs/FEISHU-SETUP.md |
| Other agents writing via MCP | **works** (after the `serve` fix above) |
| CJK keyword search | weak — `tsvector` does not segment CJK; use `query` instead |
| Feishu attachments > ~100 MB | fails, leaves an empty attachment block |

One more prerequisite worth stating: **the repo is currently PRIVATE.** Nobody can
clone it until it is made public or they are added as a collaborator.

---

## Feishu specifics

Which wiki space, how to authorise, and how categories work are covered in
detail in **[FEISHU-SETUP.md](FEISHU-SETUP.md)**, including which parts are
verified and which are not.
