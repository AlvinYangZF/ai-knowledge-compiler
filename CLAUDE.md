# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`akb` (AI Knowledge Compiler) is a git-backed, markdown-native, MCP-first knowledge base system. The core idea: expensive knowledge organization work happens at **ingest time** (compile time), not at query time. The result is a vault of markdown files (canonical truth) plus a SQLite FTS5 index (projection, not committed to git).

Two MCP tools are exposed: `search_knowledge` (BM25 search returning page_id + line-range citations) and `get_page` (full content retrieval by id or path). The CLI (`akb`) wraps the same logic.

## Commands

```bash
pnpm install          # install all workspace dependencies
pnpm build            # build all packages (required before running tests)
pnpm test             # build + run all Vitest suites
pnpm typecheck        # tsc type-check across the monorepo
pnpm lint             # Biome check (format + lint)
pnpm coverage         # build + run tests with V8 coverage
pnpm bench            # run search-engine benchmarks
pnpm demo             # run the end-to-end demo script (scripts/demo.sh)
```

Run a single test file:
```bash
pnpm vitest run packages/search-engine/test/search-index.test.ts
```

Run tests for one package:
```bash
pnpm --filter @akb/search-engine test
```

## Architecture

**Monorepo layout:**
- `packages/core` — shared types and Zod schemas (`Page`, `PageId`, `SearchResult`, `Config`). Everything else depends on this.
- `packages/markdown-engine` — parse YAML frontmatter (`gray-matter`), generate `page_[a-z0-9]{12}` IDs, extract titles, call `ensureFrontmatter` when ingesting.
- `packages/search-engine` — `SearchIndex` class wrapping `better-sqlite3`. Two virtual FTS5 tables: `pages_fts` (full-page) and `chunks_fts` (used for search). `chunkByHeaders` splits body at `##` headers and oversized paragraphs, tracking absolute line numbers so citations are precise to the physical file.
- `packages/git-store` — thin `simple-git` wrapper: `initVault`, `commitFiles`, `getFileHistory`. Commits are always prefixed `akb: `.
- `packages/confidence` — append-only Confidence Ledger (JSONL per page at `.${pageId}.ledger.jsonl`). `computeConfidenceState` folds events into a score using source weights, contradiction penalties, time decay, and verification boosts. Score is never stored in git; it's computed on demand from the event stream.
- `packages/eval-harness` — `runEval` takes a `SearchIndex` and a golden YAML set, returns `EvalReport` with precision@5, precision@10, recall@5, recall@10, and `must_hit_pass_rate`.
- `apps/cli` — `commander`-based CLI wiring together all packages. Commands: `init`, `ingest`, `index`, `search`, `eval`, `mcp serve`.
- `apps/mcp-server` — MCP server using `@modelcontextprotocol/sdk`. Supports `stdio` (default) and `http` transports.

**Data flow for ingest:**
1. `markdown-engine.ensureFrontmatter` stamps missing `id`, `title`, `created_at`, `source_hash` into the file's YAML frontmatter.
2. The file is written to `pages/` inside the vault directory.
3. `search-engine.SearchIndex.upsertPage` runs `chunkByHeaders`, hashes the content, and writes to SQLite only if the hash changed.
4. `git-store.commitFiles` commits the written markdown to the vault's git repo.

**Vault structure on disk:**
```
<vault>/
  pages/           # markdown files (canonical, committed to git)
  .akb/
    config.yaml    # workspace/index/mcp config (committed)
    index.db       # SQLite FTS5 index (gitignored, projection)
    eval/
      golden.yaml  # eval golden set (committed)
  .gitignore       # ignores index.db and WAL files
```

## Key Invariants

- **Markdown is canonical.** SQLite index is always a derived projection. Never write to the index without first writing markdown.
- **`index.db` is not committed to git.** It can always be rebuilt with `akb index --rebuild`.
- **`PageId` format:** `page_[a-z0-9]{12}` — validated via Zod in `@akb/core`.
- **Citations are line-precise.** `SearchResult.citation` carries `line_start` and `line_end` as absolute line numbers in the physical `.md` file (not relative to the body).
- **Confidence events are append-only.** Never delete or mutate `.${pageId}.ledger.jsonl` lines; only append new events.
- **Any PR that changes retrieval behavior must pass eval.** The CI runs `pnpm demo` which includes an eval step.

## TypeScript Conventions

- All packages use strict TypeScript, ESM (`"type": "module"`), `NodeNext` module resolution.
- Import paths inside a package use the `.js` extension (e.g., `from "./chunking.js"`), even for `.ts` source files — this is required by `NodeNext`.
- Package cross-references use workspace aliases (`@akb/core`, `@akb/search-engine`, etc.) defined in `tsconfig.base.json` paths and `vitest.config.ts` aliases.
- Tests use `mkdtempSync`/`rmSync` for temp directories; always clean up in `afterEach`.
- Biome is the single tool for both formatting (2-space indent) and linting. Run `pnpm lint` before committing.

## MCP Integration

To use `akb` as an MCP server in Claude Code, add to your MCP config:
```json
{
  "mcpServers": {
    "akb": {
      "command": "node",
      "args": ["/path/to/ai-knowledge-compiler/apps/cli/dist/main.js", "mcp", "serve"],
      "cwd": "/path/to/your/vault"
    }
  }
}
```

The MCP server opens the index read-only and registers `search_knowledge` and `get_page` tools. HTTP transport is also supported via `mcp serve --transport http`.

## CI

CI (`.github/workflows/ci.yml`) runs on every push and PR: `pnpm lint` → `pnpm typecheck` → `pnpm coverage` → `pnpm demo`. Coverage thresholds: 70% lines/functions/statements, 60% branches (excluding `apps/cli/src/main.ts`). The demo script exercises the full ingest → index → search → eval pipeline against `examples/sample-vault`.
