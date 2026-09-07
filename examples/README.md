# Examples

Three fictional pages you can import to see the graph and search working end to
end. They contain no real people or private data.

`ada-lovelace` and `analytical-engine` reference each other via `[[wiki-links]]`,
so once links are reconciled you get a real (if tiny) graph.

```bash
# from the repo root
bun run src/cli.ts import ./examples/sample-pages --no-embed
bun run src/cli.ts repair --links      # <-- required: import does not build links
bun run src/cli.ts list
bun run src/cli.ts backlinks analytical-engine
bun run src/cli.ts graph ada-lovelace --depth 2
bun run src/cli.ts search "algorithm"
```

> **Why `repair --links` is needed:** `import` writes pages and content chunks but
> does not resolve `[[wiki-links]]` into graph edges. Reconciling links is a
> separate pass so that bulk imports stay fast. Skip it and `backlinks` returns
> `[]` even though the links are visible in the markdown.

Expected output after the repair step:

```
$ bun run src/cli.ts repair --links
Links created: 2, removed: 0

$ bun run src/cli.ts backlinks analytical-engine
[{ "from_slug": "ada-lovelace", "to_slug": "analytical-engine", "link_type": "wiki-link" }]

$ bun run src/cli.ts graph ada-lovelace --depth 2
ada-lovelace(depth 0) -> analytical-engine(depth 1) -> ada-lovelace(depth 2)
```

## Semantic search

To try vector/hybrid search, set `OPENAI_API_KEY` in `.env`, then:

```bash
bun run src/cli.ts repair --embed
bun run src/cli.ts query "who wrote the first algorithm?"
```

Or do both passes at once:

```bash
bun run src/cli.ts repair --all
```
