# Repository Guidelines

## Project Structure & Module Organization

This repository is an implemented TypeScript monorepo for the `akb` knowledge compiler. The root contains workspace config, CI config, `README.md`, `LICENSE`, design specifications in `docs/`, runnable apps in `apps/*`, reusable packages in `packages/*`, and a demo vault in `examples/sample-vault/`.

- `docs/v0.0-spec.md`: minimum viable `akb` architecture and implementation plan.
- `docs/search-engine-skeleton.md`: planned TypeScript search package API, schema, tests, and benchmark skeleton.
- `docs/v0.1-confidence-ledger.md` and `docs/v0.1-llm-compile.md`: post-v0.0 design extensions.
- `apps/cli`: `akb` CLI for init, ingest, index, search, eval, MCP, and confidence-ledger commands.
- `apps/mcp-server`: MCP server exposing `search_knowledge` and `get_page`.
- `packages/core`, `git-store`, `markdown-engine`, `search-engine`, `eval-harness`, `confidence`, and `ranker`: reusable implementation packages.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies after scaffold creation.
- `pnpm build`: build all workspace packages and apps.
- `pnpm test`: run Vitest suites.
- `pnpm typecheck`: run TypeScript type checks.
- `pnpm lint`: run Biome checks.
- `pnpm coverage`: build and run Vitest with V8 coverage.
- `pnpm demo`: run the end-to-end sample-vault demo.
- `pnpm bench`: run the search benchmark.
- `node apps/cli/dist/main.js init`, `ingest`, `index`, `search`, `mcp serve`, `eval`: local CLI workflow after `pnpm build`.

For documentation-only changes, inspect with `rg`, review rendered Markdown when practical, and ensure links point to existing files. For retrieval behavior changes, run focused tests and `pnpm demo`; full verification is `pnpm lint && pnpm typecheck && pnpm coverage && pnpm demo`.

## Coding Style & Naming Conventions

Keep Markdown headings concise and use fenced code blocks for commands and schemas. Use lowercase, hyphenated filenames for docs, matching the existing `docs/v0.1-llm-compile.md` pattern.

For TypeScript code, follow the existing implementation: strict TypeScript, ESM modules, package-local public APIs, and predictable CLI output that is easy to test. Avoid decorative terminal output in v0.0/v0.1 CLI paths.

## Testing Guidelines

Use Vitest with `*.test.ts` files and cover public APIs, CLI integration, temp-directory workflows, citation line-number behavior, MCP tool payloads, and ranker behavior. Every PR that changes retrieval behavior should run `pnpm demo`, which includes `akb eval`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `add design docs` and `Init repo`. Keep subjects direct and scope them to the change.

Pull requests should include a concise summary, affected docs or planned modules, linked issues when relevant, and the exact verification performed. For architecture changes, update the relevant design doc before adding implementation code.

## Agent-Specific Instructions

Treat Markdown and Confidence Ledger JSONL as canonical source material. Do not introduce projection files, generated indexes, secrets, or API-key-dependent workflows into version control unless a design doc explicitly requires it. `.akb/index.db`, coverage output, dist output, and TypeScript build info remain generated artifacts.
