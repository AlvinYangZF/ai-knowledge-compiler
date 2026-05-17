# Demo

This demo exercises the implemented local `akb` loop through v0.1:

```bash
pnpm demo
```

`pnpm demo` runs `scripts/demo.sh`. The script builds the workspace, creates a temporary vault, ingests the sample Markdown pages, compiles pending sources into reviewable patches, rebuilds the SQLite FTS index, runs searches, and evaluates the sample golden set.

The sample vault currently contains 15 Markdown pages and a 5-query golden set. A passing run ends with:

```text
precision@5:  0.20
precision@10: 0.10
recall@5:     1.00
recall@10:    1.00
must-hit pass rate:  5/5 (100%)
```

The demo uses the no-secret path. If `DEEPSEEK_API_KEY` is not set, compile still runs and emits degraded heuristic patches with `compileMeta.degraded=true`.

## Implemented Coverage

The automated demo covers these implemented capabilities:

- Workspace build through `pnpm -r build`
- Vault creation through `akb init`
- Markdown ingest from `examples/sample-vault/`
- Pending-source compile into `.akb/patches/*.yaml`
- Heuristic fallback when DeepSeek credentials are absent
- SQLite FTS5 index rebuild
- BM25 search with line-number citations
- JSON search output
- Eval harness against the sample golden set

Additional implemented capabilities are covered by automated tests and can be checked manually with the commands below:

- Hybrid search and confidence-aware rerank
- `akb ask` extractive fallback and DeepSeek-generated cited answers
- Confidence Ledger migration, projection rebuild, score recompute, decay, verification, and runtime signal ingestion
- Supersession chains, including `--unlink`
- Patch review workflow: `patch list`, `patch show`, `patch apply`, `patch reject`
- Compile replay for heuristic and DeepSeek-backed patches
- Chunk lineage and reverse lineage
- MCP server over stdio and HTTP with `search_knowledge` and `get_page`

## Manual Walkthrough

After `pnpm build`, run commands manually with a local CLI path:

```bash
AKB=/path/to/ai-knowledge-compiler/apps/cli/dist/main.js

node "$AKB" init /tmp/akb-demo
cd /tmp/akb-demo
node "$AKB" ingest /path/to/ai-knowledge-compiler/examples/sample-vault --recursive --no-commit
node "$AKB" compile --all-pending
node "$AKB" index --rebuild
node "$AKB" search "garbage collection"
node "$AKB" search "wear leveling" --hybrid --format json
node "$AKB" eval --set .akb/eval/golden.yaml
```

The generated vault is plain Markdown under `pages/`, with `[[wikilinks]]` preserved. Open `/tmp/akb-demo` as an Obsidian vault to inspect the pages manually.

## Confidence Checks

Initialize and inspect v0.1 confidence state:

```bash
node "$AKB" migrate to-v0.1 --no-commit
node "$AKB" projection rebuild --confidence
node "$AKB" confidence show page_gc0000000000
node "$AKB" confidence recompute page_gc0000000000 --format json
```

Record verification and time-decay signals:

```bash
node "$AKB" verify page_gc0000000000 --by-agent codex --reason "manual demo review" --no-commit
node "$AKB" decay --run --no-commit
```

Record runtime signals from external systems:

```bash
node "$AKB" webhook ci-success --changed-file pages/gc.md --evidence https://ci.example/run/123 --no-commit
node "$AKB" webhook ci-failure --changed-file pages/gc.md --evidence https://ci.example/run/124 --no-commit
node "$AKB" watch --once --no-commit
```

## Compile And Patch Checks

Inspect pending patches:

```bash
node "$AKB" compile status
node "$AKB" patch list
node "$AKB" patch show patch_page_gc0000000000
```

Replay a patch:

```bash
node "$AKB" compile replay patch_page_gc0000000000
```

Choose one review outcome for a patch:

```bash
node "$AKB" patch apply patch_page_gc0000000000 --reviewed --no-commit
node "$AKB" patch reject patch_page_gc0000000000 --reason "demo rejection" --no-commit
```

DeepSeek-backed compile can be checked by adding LLM config to `.akb/config.yaml` and exporting the configured secret:

```yaml
llm:
  provider: "deepseek"
  base_url: "https://api.deepseek.com"
  model: "deepseek-v4-flash"
  api_key_env: "DEEPSEEK_API_KEY"
```

```bash
export DEEPSEEK_API_KEY=...
node "$AKB" compile --source page_gc0000000000
node "$AKB" compile replay patch_page_gc0000000000
```

DeepSeek-backed replay re-runs the provider pipeline and fails if replay degrades to heuristic output.

## Ask Checks

Without LLM config, `ask` returns an extractive answer with citations:

```bash
node "$AKB" ask "How does garbage collection relate to wear leveling?"
node "$AKB" ask "wear leveling" --hybrid --format json
```

With LLM config, `ask` calls DeepSeek and accepts only answers that cite available refs. Invalid citations degrade back to extractive output.

## Supersede And Lineage Checks

Create supersession links:

```bash
node "$AKB" supersede page_gc0000000000 --by page_watermark000 --reason "demo supersession" --no-commit
node "$AKB" supersede page_gc0000000000 --by page_writeamp0000 --unlink --reason "replace superseder" --no-commit
```

Inspect lineage:

```bash
node "$AKB" lineage page_gc0000000000
node "$AKB" lineage --reverse page_gc0000000000
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

HTTP transport can be started with:

```bash
node "$AKB" mcp serve --transport http --port 8765
```

## Search Benchmark

To run the search benchmark:

```bash
pnpm bench
```

## Next Demo Targets

The following capabilities are planned next and should be added to this demo once implemented:

- Strong runtime verification: `akb runbook exec` and `akb test --link-pages`
- Section-level confidence for header-scoped confidence materialization
- Code intelligence: codebase-to-design-doc extraction and ADR/context generation
- Context-pack generation for agent sessions
- GraphRAG and relation graph projection
- Web UI for inspecting pages, confidence events, patches, and lineage
- Richer team workflows around patch review, PR checks, and reviewer assignment
