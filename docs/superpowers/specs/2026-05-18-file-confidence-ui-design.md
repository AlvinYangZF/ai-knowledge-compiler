# File Confidence UI Design

## Decision

Add a `Files` view to the existing static `akb web build` output. The UI will show repository or document file paths from page `references:` and the confidence state of the knowledge pages that depend on each file.

This stays inside the current static HTML review UI generated at `.akb/web/index.html`. It does not introduce a new frontend application, server, framework, or API.

## Goals

- Let a reviewer start from a file path and see which knowledge pages depend on that file.
- Show confidence per file by aggregating the confidence of referenced pages.
- Make risky files easy to find before code review, documentation review, or release gates.
- Reuse current Confidence Ledger projection behavior instead of inventing a second scoring model.
- Keep the output as a local generated artifact that is safe to rebuild and not committed.

## Non-Goals

- No live server, database query endpoint, or websocket updates.
- No editing pages, applying patches, or changing ledger state from the UI.
- No graph canvas or dependency visualization in the first version.
- No attempt to list every code file in the repo. The first version only shows files referenced by knowledge pages through `references:`.
- No authentication or multi-user state.

## Current System Fit

The repo already has the required primitives:

- `web build` generates `.akb/web/index.html` from a static snapshot.
- `pageFileReferences(page)` extracts file references from page frontmatter.
- `confidenceByFileEntries(vaultDir, now)` groups pages by referenced file.
- `confidenceSummaryForPage(vaultDir, page, now, includeEvents)` returns page score, status flags, counts, timestamps, and optional event summaries.
- `confidence report --by-file` already writes a Markdown report grouped by file.

The new UI should promote the existing file-confidence report into the static web review surface.

## Data Model

Extend `buildWebSnapshot()` with a `files` array. Keep the existing page, patch, lineage, eval, and graph fields unchanged.

```ts
interface WebFileConfidenceEntry {
  file: string;
  page_count: number;
  min_score: number | null;
  average_score: number | null;
  risk_level: "needs_review" | "stale" | "missing_ledger" | "superseded" | "ok";
  flags: string[];
  pages: ConfidenceFilePageSummary[];
}
```

Aggregation rules:

- `pages` comes from `confidenceByFileEntries(vaultDir, undefined)`.
- `page_count` is `pages.length`.
- `min_score` is the lowest non-null page score, or `null` if all pages are missing ledger state.
- `average_score` is the average of non-null scores, or `null`.
- `flags` is the sorted union of all page `status.flags`.
- `risk_level` uses the highest-risk matching condition:
  - `missing_ledger` if any page has `MISSING_LEDGER`
  - `needs_review` if any page has `NEEDS_REVIEW`
  - `stale` if any page has `STALE`
  - `superseded` if any page has `SUPERSEDED`
  - `ok` otherwise

Default sort:

1. Risk level: `missing_ledger`, `needs_review`, `stale`, `superseded`, `ok`
2. Lower `min_score`
3. Higher `page_count`
4. File path ascending

## Information Architecture

Add a `Files` tab next to the existing tabs:

```text
Pages | Files | Confidence | Patches | Lineage | Eval | Relation Graph
```

The tab shows a two-pane workflow:

```text
Left pane: File browser
  Search input
  Risk filter buttons
  Sort selector
  File rows

Main pane: Selected file detail
  File header
  Confidence summary strip
  Referenced pages table
  Recent event drawer for selected page
```

The existing global page list can remain in the left sidebar for other tabs. When the `Files` tab is active, the sidebar content should switch to the file browser so reviewers can search file paths directly.

## File Browser

Each file row shows:

- File path
- Risk label
- Minimum confidence score
- Number of referenced pages
- Compact status flags

Rows should be dense and stable. Long paths wrap at safe breakpoints. Selecting a row updates the main detail panel and preserves the active `Files` tab.

Filters:

- `All`
- `Needs Review`
- `Stale`
- `Missing Ledger`
- `Superseded`
- `OK`

Search matches:

- File path
- Referenced page path
- Referenced page title
- Page id

## File Detail

The file detail view starts with:

- File path
- Overall risk level
- Minimum score
- Average score
- Referenced page count
- Count of pages with flags

Below that, show a table of pages that reference the file:

| Column | Purpose |
| --- | --- |
| Page | Title, page id, and page path |
| Score | Numeric score and compact meter |
| Status | Flags and reasons |
| Evidence | Source count and contradiction count |
| Freshness | Last verified and last event timestamps |

Clicking a page row should select that page in the existing page-oriented state and allow the user to switch to `Pages` or `Confidence` without losing context.

## Visual Direction

This is an engineering review surface, not a landing page.

Use a restrained, dense audit-console style:

- High information density with clear spacing.
- File paths and ids use monospace.
- Scores use compact horizontal meters.
- Risk states use a small, consistent semantic palette:
  - OK: green accent
  - Stale: amber
  - Needs review: red
  - Missing ledger: neutral warning gray
  - Superseded: muted purple or slate
- Avoid decorative backgrounds, oversized hero sections, nested cards, or marketing copy.

The interface should prioritize scanning and comparison. Tables should remain readable on desktop, and mobile should collapse page rows into stacked summaries.

## Interaction Details

- Default selected file is the highest-risk file.
- If there are no referenced files, show an empty state explaining that file confidence depends on page `references:`.
- File filters update the list without changing the selected file unless the selected file is no longer visible.
- When the selected file is filtered out, select the first visible file.
- Score meters must not resize rows during updates.
- Timestamps render as raw ISO strings in v1 for auditability.
- All dynamic HTML inserted from snapshot data must be text-based DOM nodes or escaped strings. File paths, page titles, and reasons must not be trusted as HTML.

## Accessibility

- File rows and tabs are keyboard reachable buttons.
- The selected file row has an explicit active state.
- Risk is not conveyed by color alone; labels are always visible.
- Tables use semantic headers.
- Text must wrap without horizontal overflow on narrow screens.

## Implementation Plan Shape

Expected implementation tasks:

1. Add `files` to the web snapshot using existing confidence-by-file helpers.
2. Add risk aggregation helpers and focused unit/CLI tests.
3. Add the `Files` tab and file browser rendering in `renderWebIndex()`.
4. Update README and demo docs.
5. Verify `pnpm lint`, `pnpm typecheck`, focused CLI tests, and `pnpm test`.

The implementation should stay in `apps/cli/src/main.ts` for the first version because the existing static web UI is already generated there. If the HTML renderer grows substantially, a later refactor can extract web rendering helpers into a package-local module.

## Test Plan

Add or update CLI tests to cover:

- `web build` snapshot includes `files`.
- A page with `references: ["src/deploy.ts"]` appears under `files[0].file`.
- File entry includes the referenced page confidence summary.
- Risk sorting puts missing ledger or needs-review files before OK files.
- Generated HTML contains a `Files` tab and file filter UI.
- The existing `Pages`, `Confidence`, `Patches`, `Lineage`, `Eval`, and `Relation Graph` views still render.

Manual verification:

```bash
pnpm lint
pnpm typecheck
pnpm vitest run apps/cli/test/cli.test.ts -t "web UI"
pnpm test
node apps/cli/dist/main.js web build --output .akb/web
```

Open `.akb/web/index.html` and inspect:

- `Files` tab is visible.
- Referenced files are listed.
- Selecting a file shows page confidence rows.
- Risk filters work.
- Long paths wrap cleanly.

## Acceptance Criteria

- Running `akb web build --output .akb/web` creates a static HTML file with a `Files` view.
- The `Files` view shows one row for each file referenced by at least one page.
- Selecting a file shows all pages that reference it and their confidence score/status.
- File-level risk uses the worst associated page state.
- No generated `.akb/web` artifacts are committed.
- No new frontend application or runtime server is introduced.
