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
