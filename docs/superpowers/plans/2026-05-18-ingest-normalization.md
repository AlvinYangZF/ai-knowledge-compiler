# Ingest Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `akb ingest` so supported documents and source code are normalized into canonical Markdown pages with source metadata, confidence ledger events, and tests.

**Architecture:** Add `packages/ingest-engine` for file discovery, target path calculation, raw source hashing, and conversion adapters. Keep CLI orchestration in `apps/cli/src/main.ts`, but route all ingest inputs through the engine before writing pages, updating the index, recording confidence, committing, and optionally compiling.

**Tech Stack:** TypeScript ESM monorepo, Vitest, Commander, Node filesystem APIs, `execFileSync`-style external command runner injection for optional document converters.

---

## Scope

Implement the first usable slice from `docs/superpowers/specs/2026-05-18-ingest-normalization-design.md`:

- Markdown and text pass-through/normalization.
- C/C++ and existing JS/TS-family code conversion into fenced Markdown pages.
- Optional external converters for PDF/DOC/DOCX/HTML/RTF/ODT with actionable missing-tool errors.
- CLI flags for document/code inclusion, strict conversion, and converter mode.
- Immediate `source_added` confidence ledger events for imported pages.
- Code source weight raised to `1.0`.
- Documentation updates.

Do not implement OCR, tree-sitter/deep AST parsing, LLM cleanup, or binary artifact storage.

## File Structure

- Create `packages/ingest-engine/package.json`: package metadata and build/test scripts.
- Create `packages/ingest-engine/tsconfig.json`: composite package config.
- Create `packages/ingest-engine/src/index.ts`: public exports.
- Create `packages/ingest-engine/src/types.ts`: shared input/output types.
- Create `packages/ingest-engine/src/discovery.ts`: supported extension classification, directory discovery, target path calculation.
- Create `packages/ingest-engine/src/converters.ts`: Markdown/text/code/document conversion and external command runner support.
- Create `packages/ingest-engine/test/ingest-engine.test.ts`: unit coverage for discovery, target paths, converters, source hashing, and external converter errors.
- Modify `tsconfig.base.json`, `tsconfig.json`, and `apps/cli/tsconfig.json`: add `@akb/ingest-engine` path/reference.
- Modify `apps/cli/package.json`: add workspace dependency.
- Modify `apps/cli/src/main.ts`: replace Markdown-only discovery with ingest-engine, add flags, write ledger events.
- Modify `apps/cli/test/cli.test.ts`: CLI coverage for text/code/doc failure, confidence ledger, and changed migration behavior.
- Modify `README.md`, `docs/demo.md`, `docs/v0.1-confidence-ledger.md`, `docs/v0.0-spec.md`: document behavior and weights.

## Task 1: Add Implementation Plan Commit

**Files:**
- Create: `docs/superpowers/plans/2026-05-18-ingest-normalization.md`

- [ ] **Step 1: Save this implementation plan**

Run:

```bash
test -f docs/superpowers/plans/2026-05-18-ingest-normalization.md
```

Expected: exit code `0`.

- [ ] **Step 2: Commit the plan**

Run:

```bash
git add docs/superpowers/plans/2026-05-18-ingest-normalization.md
git commit -m "add ingest normalization implementation plan"
```

Expected: commit succeeds.

## Task 2: Build `@akb/ingest-engine`

**Files:**
- Create: `packages/ingest-engine/package.json`
- Create: `packages/ingest-engine/tsconfig.json`
- Create: `packages/ingest-engine/src/index.ts`
- Create: `packages/ingest-engine/src/types.ts`
- Create: `packages/ingest-engine/src/discovery.ts`
- Create: `packages/ingest-engine/src/converters.ts`
- Create: `packages/ingest-engine/test/ingest-engine.test.ts`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write failing engine tests**

Add tests that assert:

```ts
expect(discoverIngestSources(root, { recursive: true, includeHidden: false, includeDocuments: true, includeCode: false }).sources.map((s) => s.relativePath)).toEqual(["docs/a.md", "docs/readme.pdf", "notes/plain.txt"]);
expect(targetMarkdownPath({ relativePath: "docs/readme.pdf", extension: ".pdf", kind: "document" })).toBe("docs/readme.pdf.md");
expect(convertIngestSource(codeSource, { mode: "auto" })).resolves.toMatchObject({ ok: true });
expect(result.value.markdown).toContain("```c");
expect(result.value.metadata.includes).toEqual(["stdio.h", "gc.h"]);
expect(rawSourceHash(Buffer.from("abc"))).toMatch(/^sha256:/);
expect(convertIngestSource(docSource, { mode: "external", commandRunner: failingRunner })).resolves.toMatchObject({ ok: false });
```

- [ ] **Step 2: Verify tests fail before implementation**

Run:

```bash
pnpm --filter @akb/ingest-engine test
```

Expected: fails because the package or exports do not exist yet.

- [ ] **Step 3: Implement package metadata and exports**

Create package files matching existing monorepo conventions:

```json
{
  "name": "@akb/ingest-engine",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {}
}
```

- [ ] **Step 4: Implement discovery and target path logic**

Implement supported extension maps, ignored directories, `discoverIngestSources()`, and `targetMarkdownPath()`.

- [ ] **Step 5: Implement converters**

Implement:

- Markdown UTF-8 pass-through.
- Text/log Markdown wrapping.
- Code Markdown wrapping with C/C++ includes/functions and JS/TS imports/exports.
- Document external conversion via injected/default command runner for `pdftotext`, `pandoc`, and `textutil`.
- `rawSourceHash(Buffer)`.

- [ ] **Step 6: Verify engine tests pass**

Run:

```bash
pnpm --filter @akb/ingest-engine test
pnpm typecheck
```

Expected: both pass.

- [ ] **Step 7: Commit engine package**

Run:

```bash
git add packages/ingest-engine tsconfig.base.json tsconfig.json
git commit -m "add ingest normalization engine"
```

Expected: commit succeeds.

## Task 3: Wire Engine Into CLI Ingest

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/tsconfig.json`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/test/cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Add tests that assert:

```ts
const textOutput = runCli(["ingest", textFile, "--no-compile", "--no-commit"], vault);
expect(textOutput).toContain("Found 1 ingestible source");
expect(existsSync(join(vault, "pages", "plain.txt.md"))).toBe(true);

const codeOutput = runCli(["ingest", codeFile, "--no-compile", "--no-commit"], vault);
expect(codeOutput).toContain("pages/gc.c.md");
expect(readFileSync(join(vault, "pages", "gc.c.md"), "utf8")).toContain("source_type: code");

const dirOutput = runCli(["ingest", sourceDir, "--recursive", "--no-compile", "--no-commit"], vault);
expect(dirOutput).toContain("Found 1 ingestible source");
expect(existsSync(join(vault, "pages", "src", "gc.c.md"))).toBe(false);

const dirCodeOutput = runCli(["ingest", sourceDir, "--recursive", "--include-code", "--no-compile", "--no-commit"], vault);
expect(dirCodeOutput).toContain("Found 2 ingestible sources");
expect(existsSync(join(vault, "pages", "src", "gc.c.md"))).toBe(true);
```

- [ ] **Step 2: Verify CLI tests fail before implementation**

Run:

```bash
pnpm --filter @akb/cli test
```

Expected: fails because `ingest` still accepts Markdown only.

- [ ] **Step 3: Add CLI dependency and TS reference**

Add `@akb/ingest-engine` to `apps/cli/package.json` and `apps/cli/tsconfig.json`.

- [ ] **Step 4: Add CLI options**

Add Commander flags:

```ts
.option("--include-documents", "include PDF, Word, text, and markup document sources")
.option("--no-include-documents", "skip non-markdown document sources")
.option("--include-code", "include supported code files")
.option("--no-include-code", "skip supported code files")
.option("--strict-convert", "fail when any source cannot be converted")
.option("--converter <mode>", "converter mode: auto, builtin, or external", parseConverterMode, "auto")
```

- [ ] **Step 5: Replace Markdown-only discovery**

Use `discoverIngestSources()` and `convertIngestSource()` inside `ingestCommand()`. Keep existing hidden-entry prompt, force replacement, indexing, commit, and compile behavior.

- [ ] **Step 6: Verify CLI focused tests pass**

Run:

```bash
pnpm --filter @akb/cli test
```

Expected: passes.

- [ ] **Step 7: Commit CLI ingest wiring**

Run:

```bash
git add apps/cli/package.json apps/cli/tsconfig.json apps/cli/src/main.ts apps/cli/test/cli.test.ts
git commit -m "wire ingest normalization into cli"
```

Expected: commit succeeds.

## Task 4: Confidence Ledger And Source Weight Updates

**Files:**
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/test/cli.test.ts`

- [ ] **Step 1: Write failing confidence tests**

Add tests that assert:

```ts
runCli(["ingest", codeFile, "--no-compile", "--no-commit"], vault);
const codePage = pageFromMarkdown(readFileSync(join(vault, "pages", "gc.c.md"), "utf8"));
const ledger = readFileSync(join(vault, "pages", `.${codePage.id}.ledger.jsonl`), "utf8");
const event = JSON.parse(ledger.trim().split("\n")[0]);
expect(event.kind).toBe("source_added");
expect(event.actorId).toBe("akb-ingest");
expect(event.sourceWeight).toBe(1);
```

Also update the legacy migration test so it creates a v0.0 page directly under `pages/` instead of using new `ingest`.

- [ ] **Step 2: Verify focused tests fail**

Run:

```bash
pnpm --filter @akb/cli test
```

Expected: fails because ingest does not yet write ledger events and code weight is still `0.9`.

- [ ] **Step 3: Implement immediate source_added events**

After each page is written and parsed, append `source_added` through `appendConfidenceEventAndUpdateProjection()` with:

```ts
actor: "system",
actorId: "akb-ingest",
sourceId: stableId("src", sourceKey),
sourceKey,
sourceWeight: sourceWeightForPage(vaultDir, page)
```

Include ledger paths in commit file lists.

- [ ] **Step 4: Raise code source weight**

Change `sourceTypeWeights.code` to `1`.

- [ ] **Step 5: Verify confidence tests pass**

Run:

```bash
pnpm --filter @akb/cli test
pnpm typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit confidence integration**

Run:

```bash
git add apps/cli/src/main.ts apps/cli/test/cli.test.ts
git commit -m "record ingest confidence events"
```

Expected: commit succeeds.

## Task 5: Document Failure Modes And Documentation

**Files:**
- Modify: `apps/cli/test/cli.test.ts`
- Modify: `README.md`
- Modify: `docs/demo.md`
- Modify: `docs/v0.1-confidence-ledger.md`
- Modify: `docs/v0.0-spec.md`

- [ ] **Step 1: Write failing strict-convert tests**

Add CLI tests that assert a `.doc` file without available external converters is skipped in non-strict mode and fails under `--strict-convert --converter external` with an actionable error.

- [ ] **Step 2: Verify failure before final strict behavior**

Run:

```bash
pnpm --filter @akb/cli test
```

Expected: fails if strict conversion behavior or messages are incomplete.

- [ ] **Step 3: Complete strict conversion behavior**

Ensure non-strict mode skips failed conversions with warning output and strict mode aborts without committing converted pages from the failed command.

- [ ] **Step 4: Update docs**

Document:

- PDF/DOCX/DOC conversion behavior.
- Code ingest and `--include-code` default.
- `--strict-convert` and `--converter`.
- Source weight table with `code: 1.0`.

- [ ] **Step 5: Verify focused docs/tests**

Run:

```bash
pnpm --filter @akb/cli test
pnpm typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit final behavior and docs**

Run:

```bash
git add apps/cli/test/cli.test.ts README.md docs/demo.md docs/v0.1-confidence-ledger.md docs/v0.0-spec.md
git commit -m "document normalized ingest behavior"
```

Expected: commit succeeds.

## Task 6: Full Local Verification

**Files:**
- No required source changes unless verification exposes a defect.

- [ ] **Step 1: Run full verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm coverage
pnpm demo
```

Expected: all pass.

- [ ] **Step 2: Inspect commit split**

Run:

```bash
git log --oneline origin/main..HEAD
git status -sb
```

Expected:

- Multiple focused commits exist.
- Only pre-existing unrelated untracked files remain, if any.
- No generated artifacts or local temp files are staged.

- [ ] **Step 3: Completion audit**

Map the objective to evidence:

- Plan doc exists and was executed.
- Work is split into testable commits.
- Tests were added or updated.
- Full local verification passed.
- Final implementation commits are present locally.
