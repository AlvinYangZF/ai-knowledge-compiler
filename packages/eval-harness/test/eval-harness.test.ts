import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchIndex } from "@akb/search-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGoldenSet, runEval } from "../src/index.js";

describe("eval-harness", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "akb-eval-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads the v0.0 golden set YAML format", () => {
    const file = join(dir, "golden.yaml");
    writeFileSync(
      file,
      [
        'version: "1.0"',
        "items:",
        "  - id: q001",
        "    query: garbage collection strategy",
        "    must_hit_pages:",
        "      - page_gc123456789",
        "    should_hit_pages:",
        "      - page_ftl12345678",
      ].join("\n"),
    );

    expect(loadGoldenSet(file).items[0].must_hit_pages).toEqual([
      "page_gc123456789",
    ]);
  });

  it("reports must-hit failures and precision/recall", () => {
    const index = {
      search(query: string, opts: { topK?: number }) {
        if (query.includes("garbage")) {
          return [
            {
              page_id: "page_gc123456789",
              path: "pages/gc.md",
              title: "GC",
              score: 1,
              snippet: "",
              citation: { line_start: 1, line_end: 2 },
            },
            {
              page_id: "page_other123456",
              path: "pages/other.md",
              title: "Other",
              score: 0.5,
              snippet: "",
              citation: { line_start: 1, line_end: 2 },
            },
          ].slice(0, opts.topK ?? 10);
        }
        return [];
      },
    } as unknown as SearchIndex;

    const report = runEval(index, {
      version: "1.0",
      items: [
        {
          id: "q001",
          query: "garbage collection",
          must_hit_pages: ["page_gc123456789" as never],
        },
        {
          id: "q002",
          query: "wear leveling",
          must_hit_pages: ["page_wear123456" as never],
        },
      ],
    });

    expect(report.total).toBe(2);
    expect(report.must_hit_pass_rate).toBe(0.5);
    expect(report.failures[0].id).toBe("q002");
  });
});
