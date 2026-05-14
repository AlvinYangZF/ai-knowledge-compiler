import { readFileSync } from "node:fs";
import type { PageId } from "@akb/core";
import type { SearchIndex } from "@akb/search-engine";
import { parse } from "yaml";

export interface GoldenItem {
  id: string;
  query: string;
  must_hit_pages: PageId[];
  should_hit_pages?: PageId[];
  notes?: string;
}

export interface GoldenSet {
  version: "1.0";
  items: GoldenItem[];
}

export interface EvalItemResult {
  id: string;
  query: string;
  passed: boolean;
  missing_must_hit_pages: PageId[];
  ranks: Record<string, number | null>;
}

export interface EvalReport {
  total: number;
  precision_at_5: number;
  precision_at_10: number;
  recall_at_5: number;
  recall_at_10: number;
  must_hit_pass_rate: number;
  failures: EvalItemResult[];
  items: EvalItemResult[];
}

export function loadGoldenSet(path: string): GoldenSet {
  const parsed = parse(readFileSync(path, "utf8")) as GoldenSet;
  if (parsed.version !== "1.0" || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid golden set: ${path}`);
  }
  return {
    version: "1.0",
    items: parsed.items.map((item) => ({
      ...item,
      must_hit_pages: item.must_hit_pages ?? [],
      should_hit_pages: item.should_hit_pages ?? [],
    })),
  };
}

export function runEval(index: SearchIndex, set: GoldenSet): EvalReport {
  const items: EvalItemResult[] = [];
  const precision5: number[] = [];
  const precision10: number[] = [];
  const recall5: number[] = [];
  const recall10: number[] = [];

  for (const item of set.items) {
    const results = index.search(item.query, { topK: 10 });
    const relevant = new Set(
      [...(item.must_hit_pages ?? []), ...(item.should_hit_pages ?? [])].map(
        String,
      ),
    );
    const ranks: Record<string, number | null> = {};
    for (const page of relevant) {
      const index = results.findIndex((result) => result.page_id === page);
      ranks[page] = index === -1 ? null : index + 1;
    }

    precision5.push(precisionAt(results, relevant, 5));
    precision10.push(precisionAt(results, relevant, 10));
    recall5.push(recallAt(results, relevant, 5));
    recall10.push(recallAt(results, relevant, 10));

    const missing = item.must_hit_pages.filter((page) => {
      const rank = ranks[String(page)];
      return rank === null || rank > 5;
    });
    items.push({
      id: item.id,
      query: item.query,
      passed: missing.length === 0,
      missing_must_hit_pages: missing,
      ranks,
    });
  }

  const failures = items.filter((item) => !item.passed);
  return {
    total: items.length,
    precision_at_5: mean(precision5),
    precision_at_10: mean(precision10),
    recall_at_5: mean(recall5),
    recall_at_10: mean(recall10),
    must_hit_pass_rate:
      items.length === 0 ? 1 : (items.length - failures.length) / items.length,
    failures,
    items,
  };
}

function precisionAt(
  results: ReturnType<SearchIndex["search"]>,
  relevant: Set<string>,
  k: number,
): number {
  if (k === 0) {
    return 0;
  }
  const hits = results
    .slice(0, k)
    .filter((result) => relevant.has(result.page_id)).length;
  return hits / k;
}

function recallAt(
  results: ReturnType<SearchIndex["search"]>,
  relevant: Set<string>,
  k: number,
): number {
  if (relevant.size === 0) {
    return 1;
  }
  const hits = new Set(
    results.slice(0, k).map((result) => String(result.page_id)),
  );
  let count = 0;
  for (const page of relevant) {
    if (hits.has(page)) {
      count += 1;
    }
  }
  return count / relevant.size;
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}
