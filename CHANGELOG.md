# Changelog

## 0.0.0-dev

- Added pnpm TypeScript monorepo scaffolding with Biome, Vitest, and GitHub Actions.
- Added core v0.0 types and schemas.
- Added markdown frontmatter handling, page id generation, and physical-line body offsets.
- Added git-backed vault initialization and ingest commits.
- Added SQLite FTS5 search with chunk-level line citations and page-level result de-duplication.
- Added CLI commands for `init`, `ingest`, `index`, `search`, `eval`, and `mcp serve`.
- Added MCP tools `search_knowledge` and `get_page`.
- Added MCP SDK smoke tests for in-memory and streamable HTTP transports.
- Added retrieval eval harness, 15-page sample vault, demo script, coverage gate, and search benchmark.
- Started v0.1 confidence ledger work with event schemas, append-only JSONL storage, and deterministic score materialization.
- Added `akb migrate to-v0.1` and `akb confidence show` as the first CLI surface for confidence ledgers.
- Added `akb verify` to append `verified` confidence ledger events and dry-run low-confidence checks.
- Added `akb supersede` to create supersession ledger links and update the superseding page.
- Added `@akb/ranker` and wired confidence-aware reranking into CLI and MCP search results, including `final_score`, component scores, confidence flags, and default filtering of superseded pages.
