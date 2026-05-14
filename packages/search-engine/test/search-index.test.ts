import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
