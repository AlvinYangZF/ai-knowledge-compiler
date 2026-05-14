import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@akb/core";
import { SearchIndex } from "../src/search-index.js";

const dir = mkdtempSync(join(tmpdir(), "akb-search-bench-"));
const idx = new SearchIndex({ dbPath: join(dir, "index.db") });

try {
  const pages = Array.from({ length: 100 }, (_, index) => makePage(index));
  const startIndex = performance.now();
  for (const item of pages) {
    idx.upsertPage(item.page, item.body, { bodyStartLine: 7 });
  }
  const indexMs = performance.now() - startIndex;

  const queries = Array.from({ length: 50 }, (_, index) =>
    index % 2 === 0
      ? "garbage collection watermark"
      : "mapping cache logical page",
  );
  const latencies: number[] = [];
  for (const query of queries) {
    const start = performance.now();
    idx.search(query, { topK: 5 });
    latencies.push(performance.now() - start);
  }
  latencies.sort((a, b) => a - b);

  console.log(`Indexed 100 pages in ${indexMs.toFixed(2)}ms`);
  console.log(`Search p50: ${percentile(latencies, 0.5).toFixed(2)}ms`);
  console.log(`Search p95: ${percentile(latencies, 0.95).toFixed(2)}ms`);
} finally {
  idx.close();
  rmSync(dir, { recursive: true, force: true });
}

function makePage(index: number): { page: Page; body: string } {
  const suffix = index.toString(36).padStart(12, "0");
  const id = `page_${suffix}` as never;
  return {
    page: {
      id,
      path: `pages/bench/page-${index}.md`,
      title: `Bench Page ${index}`,
      frontmatter: {
        id,
        title: `Bench Page ${index}`,
        tags: ["bench", index % 2 === 0 ? "gc" : "ftl"],
        aliases: [],
      },
    },
    body: [
      `# Bench Page ${index}`,
      "",
      "Garbage collection watermark policy keeps enough free blocks for foreground writes.",
      "The mapping cache stores logical page to physical page entries for the flash translation layer.",
      "",
      "## Details",
      "",
      "Wear leveling and write amplification are tracked as separate firmware signals.",
    ].join("\n"),
  };
}

function percentile(values: number[], p: number): number {
  const index = Math.min(values.length - 1, Math.floor(values.length * p));
  return values[index] ?? 0;
}
