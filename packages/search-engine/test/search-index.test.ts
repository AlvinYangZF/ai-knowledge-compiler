import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchIndex } from "../src/search-index.js";
import { samplePages } from "./fixtures/sample-pages.js";

describe("SearchIndex", () => {
  let dir: string;
  let idx: SearchIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "akb-search-"));
    idx = new SearchIndex({ dbPath: join(dir, "index.db") });
  });

  afterEach(() => {
    idx.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upsertPage is idempotent on identical content", () => {
    const { page, body } = samplePages.gc;
    expect(idx.upsertPage(page, body).action).toBe("inserted");
    expect(idx.upsertPage(page, body).action).toBe("unchanged");
  });

  it("upsertPage on changed content replaces chunks atomically", () => {
    const { page, body } = samplePages.gc;
    idx.upsertPage(page, body);
    const result = idx.upsertPage(
      page,
      `${body}\n\n## New section\nNew content.`,
    );
    expect(result.action).toBe("updated");
    expect(result.chunkCount).toBeGreaterThan(2);
  });

  it("search returns BM25 results with physical line citations", () => {
    idx.upsertPage(samplePages.gc.page, samplePages.gc.body, {
      bodyStartLine: 7,
    });
    idx.upsertPage(samplePages.ftl.page, samplePages.ftl.body, {
      bodyStartLine: 7,
    });

    const results = idx.search("garbage collection", { topK: 5 });

    expect(results[0].page_id).toBe(samplePages.gc.page.id);
    expect(results[0].citation.line_start).toBeGreaterThanOrEqual(7);
    expect(results[0].citation.line_end).toBeGreaterThanOrEqual(
      results[0].citation.line_start,
    );
    expect(results[0].snippet).toContain("garbage collection");
  });

  it("search returns at most one best-ranked chunk per page", () => {
    idx.upsertPage(
      samplePages.gc.page,
      [
        "# Garbage Collection",
        "garbage collection primary result",
        "",
        "## More Garbage Collection",
        "garbage collection secondary result",
      ].join("\n"),
    );

    const results = idx.search("garbage collection", { topK: 5 });

    expect(results).toHaveLength(1);
    expect(results[0].page_id).toBe(samplePages.gc.page.id);
  });

  it("deletePage removes page and search records", () => {
    idx.upsertPage(samplePages.gc.page, samplePages.gc.body);
    idx.deletePage(samplePages.gc.page.id);

    expect(idx.search("garbage collection")).toEqual([]);
    expect(idx.listIndexedPageIds()).toEqual([]);
  });

  it("rebuild replaces the full indexed page set", () => {
    idx.upsertPage(samplePages.gc.page, samplePages.gc.body);

    const result = idx.rebuild([
      { page: samplePages.ftl.page, body: samplePages.ftl.body },
    ]);

    expect(result.totalPages).toBe(1);
    expect(idx.search("garbage collection")).toEqual([]);
    expect(idx.search("mapping cache")[0].page_id).toBe(
      samplePages.ftl.page.id,
    );
  });

  it("returns indexed pages by id or path for MCP get_page", () => {
    idx.upsertPage(samplePages.gc.page, samplePages.gc.body, {
      bodyStartLine: 7,
    });

    expect(idx.getPageByIdOrPath(samplePages.gc.page.id)?.page.title).toBe(
      "Garbage Collection Strategy",
    );
    expect(idx.getPageByIdOrPath("pages/storage/gc.md")?.bodyStartLine).toBe(7);
  });

  it("materializes derived chunk lineage from akb derived comments", () => {
    const { page } = samplePages.gc;
    idx.upsertPage(
      page,
      [
        "# Derived GC",
        '<!-- akb:derived source=page_source00001:c0 method=extend patch=patch_source promptHash="sha256:def" modelId="deepseek-v4-flash" compiledAt="2026-05-16T00:00:00.000Z" -->',
        "Compiled garbage collection guidance.",
      ].join("\n"),
    );

    const chunks = idx.getChunksForPage(page.id);
    expect(chunks[0].origin.kind).toBe("derived");
    expect(idx.getChunkLineage(`${page.id}:c0`)).toEqual([
      {
        chunkId: `${page.id}:c0`,
        sourceUnitId: null,
        sourceChunkId: "page_source00001:c0",
        method: "extend",
        patchId: "patch_source",
        promptHash: "sha256:def",
        modelId: "deepseek-v4-flash",
        compiledAt: "2026-05-16T00:00:00.000Z",
      },
    ]);
    expect(idx.getReverseChunkLineage("page_source00001")).toEqual([
      expect.objectContaining({
        chunkId: `${page.id}:c0`,
        sourceChunkId: "page_source00001:c0",
      }),
    ]);

    expect(idx.getChunkById(`${page.id}:c0`)?.lineStart).toBe(1);

    idx.upsertPage(page, "# Verbatim GC\nNo derived marker.");

    expect(idx.getChunksForPage(page.id)[0].origin.kind).toBe("verbatim");
    expect(idx.getChunkLineage(`${page.id}:c0`)).toEqual([]);
  });

  it("supports reverse lineage from source unit ids", () => {
    const { page } = samplePages.gc;
    idx.upsertPage(
      page,
      [
        "# Derived From Unit",
        '<!-- akb:derived source=su_001 method=merge patch=patch_unit promptHash="sha256:abc" modelId="deepseek-v4-flash" compiledAt="2026-05-16T00:00:00.000Z" -->',
        "Merged guidance.",
      ].join("\n"),
    );

    expect(idx.getReverseChunkLineage("su_001")).toEqual([
      {
        chunkId: `${page.id}:c0`,
        sourceUnitId: "su_001",
        sourceChunkId: null,
        method: "merge",
        patchId: "patch_unit",
        promptHash: "sha256:abc",
        modelId: "deepseek-v4-flash",
        compiledAt: "2026-05-16T00:00:00.000Z",
      },
    ]);
  });

  it("migrates v1 indexes to the lineage schema", () => {
    idx.close();
    const dbPath = join(dir, "legacy.db");
    const db = new Database(dbPath);
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE pages (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        frontmatter TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        body_start_line INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        id UNINDEXED,
        title,
        body,
        tags,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        id UNINDEXED,
        page_id UNINDEXED,
        text,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    db.close();

    const migrated = new SearchIndex({ dbPath });
    expect(
      migrated.upsertPage(samplePages.gc.page, samplePages.gc.body).action,
    ).toBe("inserted");
    expect(
      migrated.getChunksForPage(samplePages.gc.page.id)[0].origin.kind,
    ).toBe("verbatim");
    migrated.close();
  });

  it("keeps derived origin on all pieces of an oversized derived section", () => {
    idx.close();
    const small = new SearchIndex({
      dbPath: join(dir, "small.db"),
      maxChunkTokens: 5,
    });
    try {
      small.upsertPage(
        samplePages.gc.page,
        [
          "# Large Derived",
          '<!-- akb:derived source=page_source00001:c0 method=extend patch=patch_large promptHash="sha256:large" modelId="deepseek-v4-flash" compiledAt="2026-05-16T00:00:00.000Z" -->',
          "word ".repeat(120),
        ].join("\n"),
      );

      const chunks = small.getChunksForPage(samplePages.gc.page.id);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.origin.kind === "derived")).toBe(
        true,
      );
      for (const chunk of chunks) {
        expect(small.getChunkLineage(chunk.id)[0]?.sourceChunkId).toBe(
          "page_source00001:c0",
        );
      }
    } finally {
      small.close();
    }
  });
});
