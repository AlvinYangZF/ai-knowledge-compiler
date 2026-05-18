# Ingest Normalization Design

## Status

Approved direction: use a hybrid converter adapter architecture for `akb ingest`.

This spec covers the design only. It does not implement the feature and does not change existing CLI behavior until the implementation plan is executed.

## Problem

`akb ingest` currently imports Markdown only. Non-Markdown knowledge sources such as PDF, Word documents, plain text exports, HTML/RTF files, and source code files cannot become canonical knowledge pages without manual conversion.

That creates four practical problems:

1. Users must run external conversion steps before ingestion.
2. Converted files are inconsistent because each user chooses a different conversion style.
3. Source metadata such as `source_type`, `source_subtype`, raw source hash, and conversion provenance is often missing.
4. Engineering source code remains only a local `code scan` projection, not canonical knowledge that search, ask, confidence, and MCP can cite.

The goal is to make `ingest` the single entry point for normalizing heterogeneous sources into Markdown pages while preserving auditability.

## Goals

1. `akb ingest <path>` accepts Markdown, document files, and code files.
2. Every imported source is stored in the vault as canonical Markdown under `pages/`.
3. Conversion is deterministic enough for tests, review, and re-ingest behavior.
4. Frontmatter records source type, subtype, original path, raw source hash, and converter metadata; the confidence ledger records source confidence weight.
5. Code files become structured Markdown pages with source fenced blocks and lightweight code metadata.
6. Code knowledge receives the strongest raw source weight in confidence computation.
7. Existing Markdown ingest behavior remains backward compatible.
8. Conversion failures are visible and actionable without silently corrupting the vault.

## Non-Goals

1. No OCR in the first version. Scanned PDFs without extractable text are reported as conversion failures.
2. No LLM-based document cleanup during ingest. LLM compile remains the later synthesis/review path.
3. No direct storage of PDF/DOCX/DOC binaries inside the canonical vault.
4. No deep AST parsing for C/C++ in the first version. Use deterministic shallow extraction only.
5. No change to search-engine indexing semantics beyond indexing the generated Markdown pages.
6. No automatic patch application from converted documents. Existing compile patch workflow still controls synthesis into existing pages.

## Current State

`apps/cli/src/main.ts` owns most ingest logic:

- `ingestCommand()` discovers Markdown files, writes pages, updates `SearchIndex`, commits, and optionally compiles.
- `markdownFilesForIngest()` filters to `.md`.
- `ensureFrontmatter()` in `packages/markdown-engine` adds page metadata.
- `migrate to-v0.1` creates initial `source_added` confidence events using `sourceWeightForPage()`.
- `sourceWeightForPage()` already supports several source types, including `code`, `pdf`, `pdf_academic`, and `pdf_vendor`.
- `code scan` creates a `.akb/code-intel/report.json` projection, but it does not create canonical pages.

The enhancement should split conversion and source discovery away from the CLI without rewriting unrelated commands.

## Architecture

Add a focused package:

```text
packages/ingest-engine/
  src/index.ts
  src/types.ts
  src/discovery.ts
  src/converters/
    markdown.ts
    text.ts
    document.ts
    code.ts
```

The CLI should orchestrate ingestion but no longer know each conversion format in detail.

```text
akb ingest <path>
  -> discoverIngestSources()
  -> convertIngestSource()
  -> ensureFrontmatter()
  -> write pages/**/*.md
  -> update SearchIndex
  -> write source_added ledger event
  -> git commit
  -> optional compile imported pages
```

`packages/ingest-engine` exports:

```ts
export interface IngestSource {
  absolutePath: string;
  relativePath: string;
  extension: string;
  kind: "markdown" | "document" | "text" | "code";
}

export interface ConvertedMarkdown {
  markdown: string;
  title?: string;
  sourceType: string;
  sourceSubtype?: string;
  converter: {
    name: string;
    version?: string;
    mode: "builtin" | "external";
  };
  warnings: string[];
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface DocumentConverter {
  readonly name: string;
  canConvert(source: IngestSource): boolean;
  convert(source: IngestSource, options: ConvertOptions): Promise<ConvertedMarkdown>;
}
```

The exact TypeScript interfaces can be adjusted during implementation, but the package boundary is fixed: discovery and conversion live outside the CLI.

## Discovery

Directory ingest should find all supported sources, not only Markdown.

Supported first-version extensions:

| Kind | Extensions |
| --- | --- |
| Markdown | `.md`, `.markdown` |
| PDF | `.pdf` |
| Word | `.docx`, `.doc` |
| Plain text | `.txt`, `.text`, `.log` |
| Markup export | `.html`, `.htm`, `.rtf`, `.odt` |
| C/C++ code | `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, `.hxx` |
| Existing JS/TS code scan family | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts` |

Ignored directories should include the existing code scan ignores:

- `.akb`
- `.git`
- `node_modules`
- `dist`
- `coverage`

Hidden file behavior remains unchanged:

- hidden entries are skipped by default
- interactive users are asked
- `--include-hidden` imports hidden entries and normalizes the target path to non-hidden segments

Unsupported files are skipped with one warning per file in non-strict mode.

## Target Paths

All canonical outputs are Markdown files under `pages/`.

Path rules:

1. Markdown input keeps the existing relative path when the input already ends in `.md`.
2. `.markdown` becomes `.md`.
3. Non-Markdown input writes to `<original-file-name>.<original-extension>.md`.
4. Directory structure is preserved.
5. Hidden path normalization is applied before target path calculation.

Examples:

| Source | Target |
| --- | --- |
| `notes/design.md` | `pages/notes/design.md` |
| `docs/repo-README.pdf` | `pages/docs/repo-README.pdf.md` |
| `docs/spec.docx` | `pages/docs/spec.docx.md` |
| `src/storage/gc.c` | `pages/src/storage/gc.c.md` |
| `.secret/plan.docx` with `--include-hidden` | `pages/secret/plan.docx.md` |

This preserves the original extension in the target name and prevents collisions between `spec.md`, `spec.pdf`, and `spec.docx`.

## Frontmatter

All converted pages must include standard frontmatter:

```yaml
id: page_<random-12-char>
title: <derived title>
type: <page type>
tags: []
aliases: []
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
imported_at: ISO-8601 timestamp
source_path: <input path as passed or relative to ingested root>
source_hash: sha256:<raw source bytes>
source_type: <markdown|pdf|docx|doc|text|html|rtf|odt|code>
source_subtype: <optional subtype>
converter:
  name: <converter name>
  mode: <builtin|external>
  version: <optional version>
```

Code pages add:

```yaml
type: module
source_type: code
source_subtype: c
code_language: c
line_count: 248
```

PDF pages may add:

```yaml
source_type: pdf
source_subtype: academic
```

PDF subtype inference is conservative:

- If the user or source metadata provides a subtype, preserve it.
- If no subtype is known, leave `source_subtype` absent.
- Do not guess academic/vendor from filename in the first version.

`source_hash` must be computed from raw source bytes, not from generated Markdown. The generated Markdown can change when converter implementations improve; the source hash should represent the original evidence.

## Markdown Conversion Output

Each converter returns Markdown body content, and `ensureFrontmatter()` wraps it.

Document conversion output should preserve:

- first meaningful title when available
- paragraph text
- headings if the converter exposes them
- ordered/unordered lists when available
- tables as Markdown tables when possible
- page boundaries for PDF as HTML comments

PDF output should use page markers:

```markdown
<!-- page 1 -->

Extracted text...

<!-- page 2 -->
```

Document converters should not fabricate content. If layout information is lost, the converter should add a warning to CLI output, not to the canonical page body.

## Code Conversion Output

Code files become structured Markdown, not prose summaries.

Example:

````markdown
# src/storage/gc.c

## Code Metadata

- Language: c
- Lines: 248
- Includes:
  - stdio.h
  - gc.h
- Functions:
  - gc_should_trigger
  - gc_run_cycle

## Source

```c
/* original code */
```
````

First-version code extraction:

| Language family | Metadata |
| --- | --- |
| C/C++ headers and source | `#include` specifiers, rough function names, line count |
| JS/TS family | import specifiers, export count, line count |
| Unknown text-like code | line count only |

Code body is stored verbatim inside a fenced code block. This preserves citation behavior because search results can point to generated Markdown lines.

The design deliberately avoids generating natural-language summaries during ingest. If a project wants design-doc synthesis from code, that belongs in a later LLM-assisted code intelligence workflow.

## Converter Selection

CLI option:

```text
--converter <auto|builtin|external>
```

Default: `auto`.

Modes:

- `auto`: try deterministic built-in adapters first when reliable, then external tools.
- `builtin`: use only Node/TypeScript or platform APIs available from the process.
- `external`: use only configured command-line tools.

Document conversion priority:

| Format | Auto priority |
| --- | --- |
| Markdown | built-in pass-through |
| Text/log | built-in UTF-8 text reader |
| PDF | `pdftotext`, then macOS PDFKit/text extraction when available |
| DOCX | built-in library adapter, then `pandoc`, then `libreoffice` |
| DOC | `libreoffice`, then macOS `textutil`, then `antiword` |
| HTML/RTF/ODT | `pandoc`, then `libreoffice`, then macOS `textutil` where applicable |
| Code | built-in code converter |

External tools are optional capabilities. Missing tools should not crash non-strict batch ingest.

## CLI Behavior

Existing flags remain:

- `--tag`
- `--force`
- `--include-hidden`
- `--compile`
- `--no-compile`
- `--compile-concurrency`
- `--recursive`
- `--no-recursive`
- `--no-commit`

New flags:

```text
--include-documents / --no-include-documents
--include-code / --no-include-code
--strict-convert
--converter <auto|builtin|external>
```

Defaults:

- `include-documents`: true
- `include-code`: false for general directory ingest
- `include-code`: true when the input path is a single supported code file
- `strict-convert`: false
- `converter`: auto

Rationale for `include-code` default:

Bulk-importing an entire project root could otherwise create hundreds or thousands of code pages unexpectedly. Single-file code ingest should work without an extra flag because the user's intent is explicit.

Example output:

```text
Found 12 ingestible sources: 3 markdown, 4 documents, 5 code.
Ingest [##------------------] 1/12 docs/spec.pdf -> pages/docs/spec.pdf.md
Ingest [####----------------] 2/12 src/storage/gc.c -> pages/src/storage/gc.c.md
Warning: skipped docs/legacy.doc: no DOC converter available. Install libreoffice, textutil, or antiword.
Ingested 11 pages. Skipped 1 source.
```

In strict mode:

```text
Error: failed to convert docs/legacy.doc: no DOC converter available.
```

The command should exit non-zero and avoid committing partial results when strict conversion fails.

## Confidence Integration

New ingest should append a `source_added` ledger event for each newly imported page.

Event properties:

- `actor: "system"`
- `actorId: "akb-ingest"`
- `sourceId`: stable ID derived from raw source hash and source path
- `sourceKey`: raw source hash or normalized source path
- `sourceWeight`: computed from `sourceWeightForPage()`

`sourceWeightForPage()` should be updated:

| Source type | Weight |
| --- | ---: |
| `code` | 1.00 |
| `markdown` | 0.95 |
| `git_commit` | 0.90 |
| `pdf` + `source_subtype: academic` | 0.80 |
| `pdf_academic` legacy | 0.80 |
| unknown sourced page with `source_hash`/`source_path` | 0.80 |
| `github_pr` | 0.80 |
| `meeting` | 0.70 |
| authority `webpage` | 0.60 |
| `github_issue` | 0.60 |
| `pdf` + `source_subtype: vendor` or `vendor_whitepaper` | 0.50 |
| `docx`, `doc`, `text`, `html`, `rtf`, `odt` | 0.50 |
| `chat` | 0.40 |
| non-authority `webpage` | 0.30 |

Code gets the highest raw source weight because source code is executable ground truth for implementation behavior. Human-authored Markdown remains strong but should not outrank directly ingested code by default.

This does not mean every code-derived page is always fully trusted. Confidence can still decay, be contradicted, be superseded, or be overridden by human/system events.

## Index And Compile Interaction

The existing index path remains:

1. write Markdown file
2. parse page
3. `index.upsertPage(page, body, { bodyStartLine })`

Compile behavior remains:

- `--no-compile` skips compile
- default behavior compiles imported pages after ingest
- compile receives generated Markdown pages as sources

Recommended user guidance:

- For large document/code directory imports, use `--no-compile` first.
- Review generated Markdown pages.
- Run targeted `compile` later when the imported pages are known-good.

## Error Handling

Non-strict mode:

- unreadable source: warn and skip
- unsupported extension: warn and skip
- missing optional converter: warn and skip
- conversion produces empty Markdown: warn and skip
- single-file input that cannot convert: exit non-zero because the command did no useful work

Strict mode:

- any conversion failure aborts the ingest
- no git commit is created
- already-written files from the current command are removed before exit where possible
- index changes are rolled back by deleting newly inserted page IDs from `SearchIndex`

The implementation should avoid partial commits. It is acceptable for non-strict mode to keep successfully converted pages when some other sources fail.

## Security And Safety

External converters must be invoked with `execFileSync` or equivalent argument-array APIs, never shell string interpolation.

External conversion should:

- run with explicit input/output paths
- write temporary files under `.akb/tmp/ingest/`
- clean temporary files after success or failure
- cap captured stdout/stderr to avoid huge terminal output
- avoid following symlinks outside the requested ingest root unless the existing filesystem behavior already allows it

The first version does not sandbox LibreOffice, Pandoc, or other external tools. Documentation must state that users should ingest trusted local files.

## Documentation Updates

Update:

- `README.md`: usage examples for PDF, DOCX, and code ingest
- `docs/demo.md`: new section under ingest explaining conversion and `--no-compile`
- `docs/v0.1-confidence-ledger.md`: source weight table update for `code`, `docx`, `doc`, and converted documents
- `docs/v0.0-spec.md`: add a note that v0.0 Markdown-only behavior has been superseded by v0.1 ingest normalization

Do not commit generated converter outputs from tests or local experiments.

## Testing Strategy

Unit tests in `packages/ingest-engine`:

1. discovers mixed directory sources and respects recursive flags
2. skips ignored directories
3. preserves hidden-entry behavior through inputs supplied by the CLI
4. converts Markdown pass-through
5. converts UTF-8 text into Markdown
6. converts C and C++ files into structured Markdown with includes and fenced source
7. extracts JS/TS import/export metadata using existing logic moved from CLI or shared helper
8. computes target paths for `.pdf`, `.docx`, `.doc`, and code files
9. reports missing converter errors without throwing in non-strict conversion result mode

CLI integration tests:

1. existing Markdown ingest tests continue passing
2. single `.txt` file becomes `pages/name.txt.md`
3. single `.c` file becomes `pages/name.c.md` with `source_type: code`
4. directory ingest excludes code by default but includes code with `--include-code`
5. `.doc` with no converter is skipped in non-strict mode
6. `.doc` with no converter fails under `--strict-convert`
7. converted pages are indexed and searchable
8. converted pages get `source_added` ledger events
9. `source_hash` changes when raw input changes, even if generated Markdown title stays the same
10. `sourceWeightForPage()` returns `1.0` for code

Tests must not require LibreOffice, Pandoc, or `pdftotext` to be installed in CI. External converter behavior should be tested through fake command adapters or by injecting converter availability.

## Acceptance Criteria

1. `akb ingest docs/repo.pdf --no-compile --no-commit` creates `pages/docs/repo.pdf.md` when a PDF converter is available.
2. `akb ingest notes/spec.docx --no-compile --no-commit` creates `pages/notes/spec.docx.md` when a DOCX converter is available.
3. `akb ingest src/gc.c --no-compile --no-commit` creates `pages/src/gc.c.md` with code metadata and fenced source.
4. `akb search gc_should_trigger` can cite the generated code page.
5. New ingest immediately records `sourceWeight: 1` for code pages in the confidence ledger.
6. Missing optional converters produce actionable messages.
7. Existing Markdown ingest, hidden file handling, force replacement, indexing, commit, and compile behavior do not regress.
