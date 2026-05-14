# `packages/search-engine` 代码骨架

> 配套 v0.0 spec 的 Issue 5。
> 用法：把这份文档完整 paste 给 Codex，让它按文件创建并填充 TODO。
> 所有公开 API 签名、SQL schema、测试结构都是确定的，Codex 只需填实现。

---

## 0. 给 Codex 的初始 prompt

```
Implement `packages/search-engine` according to the skeleton in this document.

Constraints:
1. Do NOT change any exported type signature, function signature, or SQL schema.
2. Fill in every TODO comment with a working implementation.
3. Every public method must have unit tests in test/.
4. Use better-sqlite3 (synchronous API).
5. No async/await in the SearchIndex class — better-sqlite3 is sync.
6. All multi-statement writes must run inside a transaction.
7. Output one file at a time; pause for review before moving to the next.

Start with: src/types.ts, then schema.ts, then chunking.ts, then search-index.ts,
then index.ts (barrel), then tests, then bench.
```

---

## 1. 目录结构

```
packages/search-engine/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                # public API barrel
│   ├── types.ts                # internal types
│   ├── schema.ts               # SQL DDL constants
│   ├── chunking.ts             # chunk-by-header logic
│   └── search-index.ts         # SearchIndex class
├── test/
│   ├── search-index.test.ts
│   ├── chunking.test.ts
│   └── fixtures/
│       └── sample-pages.ts
└── bench/
    └── search-bench.ts
```

---

## 2. `package.json`

```json
{
  "name": "@akb/search-engine",
  "version": "0.0.0",
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
    "test": "vitest run",
    "test:watch": "vitest",
    "bench": "tsx bench/search-bench.ts"
  },
  "dependencies": {
    "@akb/core": "workspace:*",
    "better-sqlite3": "^11.7.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

---

## 3. `tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../core" }]
}
```

---

## 4. `src/types.ts`

```typescript
import type { PageId } from "@akb/core";

/**
 * A single addressable chunk inside a page.
 * line_start and line_end are 1-indexed and inclusive physical file lines.
 * They include frontmatter offset and map directly to citation ranges shown
 * to users and returned via MCP.
 */
export interface Chunk {
  id: string;            // format: "<page_id>:c<index>", e.g., "page_abc:c0"
  pageId: PageId;
  index: number;         // 0-based ordinal within the page
  lineStart: number;     // 1-indexed, inclusive
  lineEnd: number;       // 1-indexed, inclusive
  text: string;
  tokenCount: number;    // approximate; word count / 0.75
}

/**
 * Internal row representation from the pages table.
 * Not exported from the package barrel — use `Page` from @akb/core externally.
 */
export interface PageRow {
  id: string;
  path: string;
  title: string;
  frontmatter: string;   // JSON-serialized
  content_hash: string;  // hash of frontmatter + bodyStartLine + body
  body_start_line: number;
  indexed_at: string;    // ISO 8601
}

/**
 * Stats returned by upsertPage and rebuild for logging.
 */
export interface UpsertResult {
  pageId: PageId;
  action: "inserted" | "updated" | "unchanged";
  chunkCount: number;
  elapsedMs: number;
}

export interface RebuildResult {
  totalPages: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  elapsedMs: number;
}
```

---

## 5. `src/schema.ts`

```typescript
/**
 * Single source of truth for the index DDL.
 *
 * Schema version is tracked via SQLite's `user_version` pragma so we can
 * detect old indexes and refuse to open them rather than silently corrupting.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA user_version = ${SCHEMA_VERSION};

CREATE TABLE IF NOT EXISTS pages (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    frontmatter     TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    body_start_line INTEGER NOT NULL,
    indexed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    id UNINDEXED,
    title,
    body,
    tags,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS chunks (
    id              TEXT PRIMARY KEY,
    page_id         TEXT NOT NULL,
    idx             INTEGER NOT NULL,
    line_start      INTEGER NOT NULL,
    line_end        INTEGER NOT NULL,
    text            TEXT NOT NULL,
    token_count     INTEGER NOT NULL,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    id UNINDEXED,
    page_id UNINDEXED,
    text,
    tokenize='unicode61 remove_diacritics 2'
);

`;

/**
 * Throw if the opened DB has a schema version we don't recognize.
 * Called on every open() to fail loudly on version drift.
 */
export function assertSchemaCompatible(actual: number): void {
  if (actual === 0) {
    // Fresh DB — caller will run SCHEMA_SQL.
    return;
  }
  if (actual !== SCHEMA_VERSION) {
    throw new Error(
      `Schema version mismatch: db is v${actual}, code expects v${SCHEMA_VERSION}. ` +
      `Run 'akb index --rebuild' to recreate the index.`
    );
  }
}
```

---

## 6. `src/chunking.ts`

```typescript
import type { Chunk } from "./types.js";
import type { PageId } from "@akb/core";

export interface ChunkingOptions {
  /** Maximum tokens per chunk. Default: 800. */
  maxTokens?: number;
  /** Approximate chars-per-token ratio. Default: 4 (English-heavy). */
  charsPerToken?: number;
  /** Physical file line number where `body` starts. Default: 1. */
  bodyStartLine?: number;
}

/**
 * Split markdown body into chunks based on header structure.
 *
 * Rules:
 *  1. Split points are markdown ATX headers at level 1, 2, or 3 (#, ##, ###).
 *  2. Each chunk includes the header line itself.
 *  3. If a chunk exceeds maxTokens, split it again by paragraph (blank-line separated).
 *  4. If a single paragraph exceeds maxTokens, split it on sentence boundaries
 *     (., !, ?, 。, ！, ？ followed by space or newline).
 *  5. Header-like lines inside fenced code blocks are ignored.
 *  6. line_start and line_end are 1-indexed, inclusive, and refer to the
 *     physical markdown file after adding bodyStartLine - 1. Trailing blank
 *     lines are NOT included in the range.
 *
 * Edge cases:
 *  - Empty body → return [].
 *  - Body with no headers → single chunk spanning all lines (subject to maxTokens split).
 *  - Body starting before first header → that leading section is its own chunk.
 *
 * @param pageId      Used to construct chunk ids ("<pageId>:c<n>").
 * @param body        Markdown body WITHOUT frontmatter.
 * @param opts        Chunking parameters.
 */
export function chunkByHeaders(
  pageId: PageId,
  body: string,
  opts: ChunkingOptions = {}
): Chunk[] {
  const maxTokens = opts.maxTokens ?? 800;
  const charsPerToken = opts.charsPerToken ?? 4;
  const bodyStartLine = opts.bodyStartLine ?? 1;

  // TODO: split body into lines, preserving physical file line numbers via bodyStartLine
  // TODO: scan lines, find header positions (^#{1,3}\s), ignoring fenced code blocks
  // TODO: build coarse sections between header positions
  // TODO: for each section, if estimateTokens(text) > maxTokens, split further
  // TODO: assemble Chunk objects with correct lineStart, lineEnd, tokenCount
  // TODO: return array

  throw new Error("not implemented");
}

/**
 * Approximate token count. Cheap and deterministic — not a real tokenizer.
 * Used for chunk-size decisions only, never for billing.
 */
export function estimateTokens(text: string, charsPerToken = 4): number {
  return Math.ceil(text.length / charsPerToken);
}
```

**Test cases that must pass** (`test/chunking.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import { chunkByHeaders } from "../src/chunking.js";

describe("chunkByHeaders", () => {
  it("returns empty array for empty body", () => {
    expect(chunkByHeaders("page_x", "")).toEqual([]);
  });

  it("returns single chunk when body has no headers", () => {
    const body = "Just some text.\nAnother line.";
    const chunks = chunkByHeaders("page_x", body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(2);
  });

  it("splits at H1, H2, H3 headers", () => {
    const body = [
      "# Section A",       // L1
      "Body of A.",         // L2
      "## Subsection A1",   // L3
      "More text.",         // L4
      "# Section B",        // L5
      "Body of B.",         // L6
    ].join("\n");
    const chunks = chunkByHeaders("page_x", body);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(2);
    expect(chunks[1].lineStart).toBe(3);
    expect(chunks[1].lineEnd).toBe(4);
    expect(chunks[2].lineStart).toBe(5);
    expect(chunks[2].lineEnd).toBe(6);
  });

  it("does NOT split at H4 or deeper", () => {
    const body = "# A\nx\n#### sub\ny";
    const chunks = chunkByHeaders("page_x", body);
    expect(chunks).toHaveLength(1);
  });

  it("does NOT split at header-looking lines inside fenced code blocks", () => {
    const body = ["# A", "```bash", "# not a markdown header", "echo ok", "```", "## B", "text"].join("\n");
    const chunks = chunkByHeaders("page_x", body);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(5);
    expect(chunks[1].lineStart).toBe(6);
  });

  it("handles leading text before first header", () => {
    const body = "intro line\n# Section\nbody";
    const chunks = chunkByHeaders("page_x", body);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(1);
  });

  it("applies bodyStartLine so citations match the physical markdown file", () => {
    const body = "# Section\nbody";
    const chunks = chunkByHeaders("page_x", body, { bodyStartLine: 7 });
    expect(chunks[0].lineStart).toBe(7);
    expect(chunks[0].lineEnd).toBe(8);
  });

  it("further splits sections exceeding maxTokens", () => {
    const longText = "word ".repeat(1000);     // ~1250 tokens at 4 chars/token
    const body = `# Big\n${longText}`;
    const chunks = chunkByHeaders("page_x", body, { maxTokens: 400 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(400 * 1.2);  // allow 20% slack
    }
  });

  it("assigns sequential chunk ids", () => {
    const body = "# A\nx\n# B\ny\n# C\nz";
    const chunks = chunkByHeaders("page_x", body);
    expect(chunks[0].id).toBe("page_x:c0");
    expect(chunks[1].id).toBe("page_x:c1");
    expect(chunks[2].id).toBe("page_x:c2");
  });
});
```

---

## 7. `src/search-index.ts`

```typescript
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Page, PageId, SearchResult } from "@akb/core";
import {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  assertSchemaCompatible,
} from "./schema.js";
import { chunkByHeaders } from "./chunking.js";
import type { Chunk, UpsertResult, RebuildResult } from "./types.js";

export interface SearchIndexOptions {
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Open in read-only mode (used by mcp-server). */
  readonly?: boolean;
  /** Max tokens per chunk. Default: 800. */
  maxChunkTokens?: number;
}

export interface SearchOptions {
  /** Max number of results to return. Default: 10. */
  topK?: number;
  /** Filter by frontmatter tag (any-of). */
  tags?: string[];
  /** Snippet length in characters. Default: 200. */
  snippetChars?: number;
}

export interface UpsertPageOptions {
  /** Physical file line where the markdown body starts after frontmatter. Default: 1. */
  bodyStartLine?: number;
}

/**
 * Synchronous, SQLite-backed search index with FTS5 BM25.
 *
 * Lifecycle:
 *   const idx = new SearchIndex({ dbPath: ".akb/index.db" });
 *   idx.upsertPage(page, body);
 *   const results = idx.search("query");
 *   idx.close();
 */
export class SearchIndex {
  private readonly db: Database.Database;
  private readonly maxChunkTokens: number;

  // Prepared statements cached on first use.
  private stmtUpsertPage?: Database.Statement;
  private stmtDeleteChunks?: Database.Statement;
  private stmtInsertChunk?: Database.Statement;
  private stmtGetPageHash?: Database.Statement;
  // TODO: declare remaining prepared statements

  constructor(opts: SearchIndexOptions) {
    this.db = new Database(opts.dbPath, { readonly: opts.readonly ?? false });
    if (!opts.readonly) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
    }
    this.db.pragma("foreign_keys = ON");
    this.maxChunkTokens = opts.maxChunkTokens ?? 800;

    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;
    assertSchemaCompatible(currentVersion);
    if (!opts.readonly && currentVersion === 0) {
      this.db.exec(SCHEMA_SQL);
    }
  }

  /**
   * Insert or update a page and its chunks atomically.
   *
   * Returns action="unchanged" if content_hash matches the existing row.
   * The hash covers frontmatter, body, and bodyStartLine so citation offsets
   * are refreshed when frontmatter length changes.
   */
  upsertPage(page: Page, body: string, opts: UpsertPageOptions = {}): UpsertResult {
    const startMs = performance.now();
    const bodyStartLine = opts.bodyStartLine ?? 1;
    const contentHash = sha256(
      JSON.stringify(page.frontmatter) + "\n" + bodyStartLine + "\n" + body
    );

    // TODO: check existing hash via stmtGetPageHash
    // TODO: if unchanged → return action="unchanged" with chunkCount from existing
    // TODO: begin transaction
    // TODO: upsert pages row, including body_start_line
    // TODO: delete existing chunks (cascade handles chunks_fts and pages_fts)
    // TODO: chunk body via chunkByHeaders(page.id, body, { maxTokens: this.maxChunkTokens, bodyStartLine })
    // TODO: insert each chunk into chunks and chunks_fts
    // TODO: insert pages_fts row with title + concatenated body + tags
    // TODO: commit
    // TODO: return UpsertResult

    throw new Error("not implemented");
  }

  /**
   * Remove a page and all its chunks. No-op if page doesn't exist.
   */
  deletePage(pageId: PageId): void {
    // TODO: begin transaction
    // TODO: delete from pages_fts where id = ?
    // TODO: delete from chunks_fts where page_id = ?
    // TODO: delete from chunks where page_id = ?  (also removed by cascade but be explicit)
    // TODO: delete from pages where id = ?
    // TODO: commit

    throw new Error("not implemented");
  }

  /**
   * BM25 search across chunks. Results joined back to pages for title/path.
   *
   * Ranking: pure FTS5 bm25() score, lower is better → invert so higher is better.
   * Filtering: if opts.tags is provided, restrict to pages whose frontmatter.tags
   *            intersects the filter set (post-filter for v0.0; index later if hot).
   */
  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    const topK = opts.topK ?? 10;
    const snippetChars = opts.snippetChars ?? 200;

    // TODO: sanitize query — FTS5 has its own syntax, escape user input or use MATCH ? prepared
    // TODO: execute SELECT joining chunks_fts → chunks → pages
    //       SELECT
    //         p.id, p.path, p.title, p.frontmatter,
    //         c.line_start, c.line_end, c.text,
    //         bm25(chunks_fts) AS rank
    //       FROM chunks_fts
    //       JOIN chunks c ON c.id = chunks_fts.id
    //       JOIN pages p ON p.id = c.page_id
    //       WHERE chunks_fts MATCH ?
    //       ORDER BY rank
    //       LIMIT ?
    // TODO: for each row, parse frontmatter JSON, apply tag filter if any
    // TODO: build snippet — substring of chunk text around best match
    // TODO: map to SearchResult { page_id, path, title, score, snippet, citation }
    // TODO: score = 1 / (1 + rank)  so higher is better, consistent across implementations

    throw new Error("not implemented");
  }

  /**
   * Drop all data and rebuild from a fresh list of pages.
   * Used by `akb index --rebuild`.
   */
  rebuild(pages: Iterable<{ page: Page; body: string; bodyStartLine?: number }>): RebuildResult {
    const startMs = performance.now();
    // TODO: drop all rows from pages, chunks, pages_fts, chunks_fts (DELETE FROM, not DROP TABLE)
    // TODO: count inserts inside a single big transaction (much faster than per-page tx)
    // TODO: return RebuildResult
    throw new Error("not implemented");
  }

  /**
   * For incremental index from CLI: list page ids currently in the DB.
   * CLI compares this against the filesystem to detect deletions.
   */
  listIndexedPageIds(): PageId[] {
    // TODO: SELECT id FROM pages
    throw new Error("not implemented");
  }

  /**
   * For diagnostics. Logged by `akb index` after a run.
   */
  getStats(): { pages: number; chunks: number; dbSizeBytes: number } {
    // TODO: COUNT(*) from pages, chunks; statSync the db file
    throw new Error("not implemented");
  }

  close(): void {
    this.db.close();
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
```

**Critical test cases** (`test/search-index.test.ts`):

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SearchIndex } from "../src/search-index.js";
import { samplePages } from "./fixtures/sample-pages.js";

describe("SearchIndex", () => {
  let dir: string;
  let idx: SearchIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "akb-test-"));
    idx = new SearchIndex({ dbPath: join(dir, "index.db") });
  });

  afterEach(() => {
    idx.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upsertPage is idempotent on identical content", () => {
    const { page, body } = samplePages.gc;
    const r1 = idx.upsertPage(page, body);
    expect(r1.action).toBe("inserted");
    const r2 = idx.upsertPage(page, body);
    expect(r2.action).toBe("unchanged");
  });

  it("upsertPage on changed content replaces chunks atomically", () => {
    const { page, body } = samplePages.gc;
    idx.upsertPage(page, body);
    const r = idx.upsertPage(page, body + "\n\n## New section\nNew content.");
    expect(r.action).toBe("updated");
    expect(r.chunkCount).toBeGreaterThan(1);
  });

  it("search returns results with physical line ranges", () => {
    const { page, body } = samplePages.gc;
    idx.upsertPage(page, body);
    const results = idx.search("garbage collection");
    expect(results.length).toBeGreaterThan(0);
    const bodyLines = body.split("\n");
    for (const r of results) {
      expect(r.citation.line_start).toBeGreaterThanOrEqual(1);
      expect(r.citation.line_end).toBeLessThanOrEqual(bodyLines.length);
      expect(r.citation.line_end).toBeGreaterThanOrEqual(r.citation.line_start);
    }
  });

  it("search line ranges include frontmatter offset", () => {
    const { page, body } = samplePages.gc;
    idx.upsertPage(page, body, { bodyStartLine: 7 });
    const results = idx.search("garbage collection");
    expect(results[0].citation.line_start).toBeGreaterThanOrEqual(7);
  });

  it("search ranks more relevant page higher", () => {
    idx.upsertPage(samplePages.gc.page, samplePages.gc.body);
    idx.upsertPage(samplePages.ftl.page, samplePages.ftl.body);
    const results = idx.search("garbage collection");
    expect(results[0].page_id).toBe(samplePages.gc.page.id);
  });

  it("deletePage removes from search results", () => {
    idx.upsertPage(samplePages.gc.page, samplePages.gc.body);
    idx.deletePage(samplePages.gc.page.id);
    const results = idx.search("garbage collection");
    expect(results).toHaveLength(0);
  });

  it("rejects opening an incompatible schema version", () => {
    idx.close();
    // Manually bump user_version to a future value
    const db = new Database(join(dir, "index.db"));
    db.pragma("user_version = 999");
    db.close();
    expect(() => new SearchIndex({ dbPath: join(dir, "index.db") })).toThrow(/schema version/i);
  });
});
```

`test/fixtures/sample-pages.ts`:

```typescript
import type { Page } from "@akb/core";

export const samplePages = {
  gc: {
    page: {
      id: "page_gc001",
      path: "pages/storage/gc.md",
      title: "Garbage Collection Strategy",
      frontmatter: {
        id: "page_gc001",
        title: "Garbage Collection Strategy",
        tags: ["storage", "gc"],
        created_at: "2026-05-13",
        updated_at: "2026-05-13",
      },
    } as Page,
    body: `# Garbage Collection Strategy

We adopt a hybrid garbage collection approach combining greedy and FIFO selection.

## Trigger Conditions

GC is triggered when the free block count drops below 10% of total blocks.

## Victim Selection

The victim block is chosen by minimizing the cost-benefit ratio.`,
  },
  ftl: {
    page: {
      id: "page_ftl001",
      path: "pages/storage/ftl.md",
      title: "FTL Internals",
      frontmatter: {
        id: "page_ftl001",
        title: "FTL Internals",
        tags: ["storage", "ftl"],
        created_at: "2026-05-13",
        updated_at: "2026-05-13",
      },
    } as Page,
    body: `# FTL Internals

The Flash Translation Layer maps logical block addresses to physical block addresses.

## Mapping Granularity

We use page-level mapping for flexibility at the cost of larger metadata.`,
  },
};
```

---

## 8. `src/index.ts` (barrel)

```typescript
export { SearchIndex } from "./search-index.js";
export type {
  SearchIndexOptions,
  SearchOptions,
  UpsertPageOptions,
} from "./search-index.js";
export type {
  Chunk,
  UpsertResult,
  RebuildResult,
} from "./types.js";
export { SCHEMA_VERSION } from "./schema.js";
```

> Note: `Page`, `PageId`, `SearchResult` come from `@akb/core`, not re-exported here.

---

## 9. `bench/search-bench.ts`

```typescript
/**
 * Benchmark: index N pages and run M queries.
 * Reports p50/p95/p99 latency for ingest and search.
 *
 * Run with: pnpm bench
 *
 * Target SLO for v0.0:
 *   - upsertPage p95 < 50ms for 1 KB pages
 *   - search p95 < 50ms at 100-page corpus
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchIndex } from "../src/search-index.js";

const N_PAGES = 100;
const N_QUERIES = 200;

function makePage(i: number) {
  return {
    page: {
      id: `page_bench${i.toString().padStart(4, "0")}`,
      path: `pages/bench/p${i}.md`,
      title: `Bench Page ${i}`,
      frontmatter: { id: `page_bench${i}`, title: `Bench Page ${i}`, tags: ["bench"] },
    },
    body: `# Bench Page ${i}\n\nThis page discusses garbage collection, FTL, KV cache, ${
      ["wear leveling", "compaction", "scheduling", "throttling"][i % 4]
    }, and other storage topics.\n\n## Details\n\nMore details here for chunk ${i}.`,
  };
}

const QUERIES = [
  "garbage collection",
  "FTL mapping",
  "wear leveling",
  "compaction strategy",
  "KV cache",
];

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), "akb-bench-"));
  const idx = new SearchIndex({ dbPath: join(dir, "bench.db") });

  // Ingest phase
  const ingestTimes: number[] = [];
  for (let i = 0; i < N_PAGES; i++) {
    const { page, body } = makePage(i);
    const t = performance.now();
    idx.upsertPage(page as any, body);
    ingestTimes.push(performance.now() - t);
  }

  // Search phase
  const searchTimes: number[] = [];
  for (let i = 0; i < N_QUERIES; i++) {
    const q = QUERIES[i % QUERIES.length];
    const t = performance.now();
    idx.search(q);
    searchTimes.push(performance.now() - t);
  }

  console.log(`Indexed ${N_PAGES} pages:`);
  console.log(`  p50: ${percentile(ingestTimes, 0.50).toFixed(2)}ms`);
  console.log(`  p95: ${percentile(ingestTimes, 0.95).toFixed(2)}ms`);
  console.log(`  p99: ${percentile(ingestTimes, 0.99).toFixed(2)}ms`);
  console.log(`Ran ${N_QUERIES} searches:`);
  console.log(`  p50: ${percentile(searchTimes, 0.50).toFixed(2)}ms`);
  console.log(`  p95: ${percentile(searchTimes, 0.95).toFixed(2)}ms`);
  console.log(`  p99: ${percentile(searchTimes, 0.99).toFixed(2)}ms`);

  idx.close();
  rmSync(dir, { recursive: true, force: true });
}

main();
```

---

## 10. Codex 工作流建议

按这个顺序让 Codex 一次填一个文件，每个文件后人工 review：

1. `types.ts`（几乎只是 paste）
2. `schema.ts`（同上）
3. `chunking.ts` + 测试 — 这一步最容易出 bug，line number 算错就全完，先把测试跑绿再继续
4. `search-index.ts` 的 constructor + `upsertPage` + 测试
5. `search-index.ts` 的 `search` + 测试 — 注意 FTS5 query 转义
6. `search-index.ts` 剩余方法（`deletePage`、`rebuild`、`listIndexedPageIds`、`getStats`）
7. `index.ts` barrel
8. `bench/search-bench.ts` — 跑一遍验证 SLO

每一步给 Codex 的指令模板：

```
Implement <file> per the skeleton in akb_search_engine_skeleton.md.
Constraints:
- Do not change any exported signature.
- Replace every "TODO:" comment with working code.
- All tests in test/<corresponding>.test.ts must pass.
- Run `pnpm test` and `pnpm typecheck` before declaring done.
- If you find a bug in the skeleton itself, stop and flag it instead of working around it.
```

---

## 11. 几个埋的坑（提前告诉 Codex）

1. **FTS5 query 转义**：用户输入的 `query` 不能直接拼进 MATCH。带特殊字符（`"`、`-`、`*`）的会让 FTS5 报语法错。最简单的做法是 wrap in double quotes 并 escape 内部的 `"` 为 `""`。
2. **`pages_fts` 不要做外部 content table**：v0.0 选择独立 FTS5 表而不是 contentless 或外部 content，因为 update 时直接 DELETE+INSERT 更简单。代价是磁盘占用约 2x，对 100 页规模完全可接受。
3. **WAL 模式的副作用**：进程崩溃时 `.akb/index.db-wal` 和 `-shm` 可能残留。`SearchIndex.close()` 必须显式调用，CLI 的 cleanup 路径要确保即使 throw 也关掉。
4. **`bm25(table)` 返回值**：越小越好（不是越大）。Public API 要反转成"越大越好"，否则 MCP 客户端 LLM 会用错。
5. **更新 `pages_fts` 必须先 DELETE 再 INSERT**：FTS5 没有 UPSERT 语义。
6. **chunk 边界包含 trailing blank lines 的 bug**：测试里专门测了 `line_end` 不能超出 body 总行数——这个 case 容易写错。
7. **代码块里的 `#` 不是标题**：扫描 header 时必须跟踪 fenced code block 状态，否则 shell 注释、YAML 示例、配置片段会打断 chunk 边界。
8. **read-only 连接不要设置写入型 PRAGMA**：MCP server 用 readonly 打开索引时，不应执行 `journal_mode = WAL` / `synchronous = NORMAL` 这类可能改 DB 状态的 PRAGMA。
9. **`better-sqlite3` 是 ESM 不友好的 CJS 包**：在 `"type": "module"` 的项目里需要 `import Database from "better-sqlite3"` 而不是 `import { Database } from ...`。已经在示例代码里写对了。

---

## 12. 当这个 package 完成意味着什么

`packages/search-engine` 跑绿之后，剩余的 Issue 是：

- Issue 6（CLI 骨架）+ Issue 7（ingest）+ Issue 8（index/search 命令）：把这个 package 接上 CLI
- Issue 9（mcp-server）：把这个 package 接上 MCP

也就是说 search-engine 是整个 v0.0 数据流的核心。它如果稳了，剩下的都是胶水代码，每个 1 天能搞定。
