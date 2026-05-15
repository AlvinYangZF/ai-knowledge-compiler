# v0.0 Demo

This demo exercises the implemented v0.0 loop:

```bash
scripts/demo.sh
```

The script builds the workspace, creates a temporary vault, ingests the sample Markdown pages, rebuilds the SQLite FTS index, runs two searches, and evaluates the sample golden set.

The sample vault currently contains 15 Markdown pages and a 5-query golden set. A passing run ends with:

```text
precision@5:  0.20
precision@10: 0.10
recall@5:     1.00
recall@10:    1.00
must-hit pass rate:  5/5 (100%)
```

To run commands manually after `pnpm build`:

```bash
node apps/cli/dist/main.js init /tmp/akb-demo
cd /tmp/akb-demo
node /path/to/ai-knowledge-compiler/apps/cli/dist/main.js ingest /path/to/ai-knowledge-compiler/examples/sample-vault
node /path/to/ai-knowledge-compiler/apps/cli/dist/main.js index --rebuild
node /path/to/ai-knowledge-compiler/apps/cli/dist/main.js search "garbage collection"
```

To run the search benchmark:

```bash
pnpm bench
```

## MCP Checks

Automated tests cover both in-memory MCP transport and streamable HTTP transport. After building, Claude Code can be pointed at a generated vault with:

```json
{
  "mcpServers": {
    "akb": {
      "command": "node",
      "args": ["/path/to/ai-knowledge-compiler/apps/cli/dist/main.js", "mcp", "serve"],
      "cwd": "/tmp/akb-demo"
    }
  }
}
```

The expected tools are `search_knowledge` and `get_page`.

## Obsidian Check

The generated vault is plain Markdown under `pages/`, with `[[wikilinks]]` preserved. Open `/tmp/akb-demo` as an Obsidian vault after running `scripts/demo.sh` to inspect the pages manually.
