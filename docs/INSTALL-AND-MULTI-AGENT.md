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

### Not currently viable: single-file binary

`package.json` has a `build` script that produces a 65 MB standalone binary:

```bash
bun run build     # -> bin/cfbrain
```

The binary runs (`--help` works) **but cannot open a local PGLite brain**:

```
ENOENT: no such file or directory, open '/$bunfs/root/pglite.data'
```

PGLite ships a 5 MB `pglite.data` WASM payload that Bun's compiler does not embed,
and the lookup path is baked to Bun's virtual filesystem, so copying the file next
to the binary does not help either (tested). Fixing this needs asset-embedding work
in the build.

**Consequence:** there is no "download one file and run" distribution yet. Everyone
needs the repo + Bun. If you want a true single binary, that is a real task, not a
config flag.

> A binary built this way *should* still work against a remote Postgres
> (`CFBRAIN_DATABASE_URL`), since that path never touches PGLite — but that is
> untested, so do not rely on it.

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
lark-cli auth login

# 2. create a wiki space in Feishu yourself, copy its space id from the URL
# 3. wire it up — creates one root directory node per type, idempotent
cfbrain feishu init --space-id <THEIR_SPACE_ID>

# 4. push
cfbrain feishu push --all
cfbrain feishu status --json
```

Notes and caveats:

- **They must create the wiki space themselves.** `feishu init` does not create a
  space; it takes an existing `space_id` and builds the type directories inside it.
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
| Download one binary, run it | **does not work** for local PGLite — needs asset-embedding work |
| `npm install -g` from GitHub | untested; repo is private, so not usable by others yet |
| Own categories | **works**, fully replaceable |
| Own Feishu wiki | **works**, but the space must be created by hand first |
| Other agents writing via MCP | **works** (after the `serve` fix above) |
| CJK keyword search | weak — `tsvector` does not segment CJK; use `query` instead |
| Feishu attachments > ~100 MB | fails, leaves an empty attachment block |

One more prerequisite worth stating: **the repo is currently PRIVATE.** Nobody can
clone it until it is made public or they are added as a collaborator.
