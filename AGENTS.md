# Repository Guidelines

## Project Structure & Module Organization

This repository is currently design-stage and documentation-only. The root contains `README.md`, `LICENSE`, and design specifications in `docs/`.

- `docs/v0.0-spec.md`: minimum viable `akb` architecture and implementation plan.
- `docs/search-engine-skeleton.md`: planned TypeScript search package API, schema, tests, and benchmark skeleton.
- `docs/v0.1-confidence-ledger.md` and `docs/v0.1-llm-compile.md`: post-v0.0 design extensions.

When code is added, follow the v0.0 monorepo direction: `apps/*` for runnable applications such as the CLI, `packages/*` for reusable modules, and `test/` or package-local test directories for Vitest coverage.

## Build, Test, and Development Commands

There is no package manifest or runnable build system yet. Do not report planned commands as working until files such as `package.json` and `pnpm-workspace.yaml` exist.

Planned commands from the specs include:

- `pnpm install`: install workspace dependencies after scaffold creation.
- `pnpm test`: run Vitest suites.
- `pnpm typecheck`: run TypeScript type checks.
- `akb init`, `akb ingest`, `akb index`, `akb search`, `akb mcp serve`, `akb eval`: target CLI workflow described in `docs/v0.0-spec.md`.

For documentation-only changes, inspect with `rg`, review rendered Markdown when practical, and ensure links point to existing files.

## Coding Style & Naming Conventions

Keep Markdown headings concise and use fenced code blocks for commands and schemas. Use lowercase, hyphenated filenames for docs, matching the existing `docs/v0.1-llm-compile.md` pattern.

For future TypeScript code, follow the specs: strict TypeScript, ESM modules, package-local public APIs, and predictable CLI output that is easy to test. Avoid decorative terminal output in v0.0.

## Testing Guidelines

Current documentation changes do not have automated tests. For implementation work, use Vitest with `*.test.ts` files and cover public APIs, CLI integration, temp-directory workflows, and citation line-number behavior. Every PR that changes retrieval behavior should run `akb eval` once that command exists.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `add design docs` and `Init repo`. Keep subjects direct and scope them to the change.

Pull requests should include a concise summary, affected docs or planned modules, linked issues when relevant, and the exact verification performed. For architecture changes, update the relevant design doc before adding implementation code.

## Agent-Specific Instructions

Treat Markdown as the canonical source of product intent. Do not introduce projection files, generated indexes, secrets, or API-key-dependent workflows into version control unless a design doc explicitly requires it.
