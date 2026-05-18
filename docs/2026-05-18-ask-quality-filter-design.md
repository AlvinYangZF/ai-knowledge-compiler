# Ask Quality Filter Design

## Problem

`akb ask` 把所有 ranked 后的检索结果原样喂给 LLM，没有任何质量门禁。低质量、弱相关页面（Bilibili 笔记、升级报告、与问题只共享一个汉字的长尾页面）会污染 LLM 上下文，产生混乱答案，浪费 token。

## Current State

检索 → 排序流水线已经有四个 ranking signal（relevance 0.55、confidence 0.25、freshness 0.10、access 0.10），但它们都是**软信号**。`rankedAskResultsForQuery()` 只要分数 > 0 就会送进 LLM。

可以拿来做 hard filter 但目前都没用上的信号：

- **Confidence score**：ranker 中只是软加权，没有阈值门
- **Source type weight**：只在 ingest 时用于 confidence 计算，search/rank 阶段不可见
- **Authority domain**：只影响 confidence，没有搜索期过滤

## Design

在 `rankedAskResultsForQuery()` 与 `generateAskAnswer()` 之间插入一层 `filterAskResults()`，三层防御，全部可通过 `.akb/config.yaml` 与 CLI flag 配置。

> **重要前提**：当前大量 vault 还没跑过 `migrate to-v0.1`，没有 confidence ledger；frontmatter 里 `source_type` 也未必齐全。Layer 1/2 在这种 vault 上**几乎不会过滤任何东西**，主要靠 Layer 3 的相对相关性兜底。这是设计意图，不是缺陷——三层之间是"渐进生效"关系。

### Layer 1：Confidence Hard Gate

排除 confidence 低于阈值的结果。

- 默认 `min_confidence: 0.3`
- 没有 ledger 的页面 fallback 为 0.7（继承现有 ranker 行为），自然通过
- 主要拦的是已经被 contradicted、衰减过、或显式标低分的页面

### Layer 2：Source Type Weight Gate

排除 source type weight 低于阈值的结果。

- **默认 `min_source_weight: 0.3`**（review 后从 0.4 调低，避免一刀切干掉所有 webpage）
- 当前权重表（来自 `sourceWeightForPage()`）：
  - `markdown`: 1.0、`git_commit`/`code`: 0.9、`pdf_academic`: 0.8、`github_pr`: 0.8、`meeting`: 0.7、`github_issue`: 0.6、`pdf_vendor`: 0.5、`chat`: 0.4、`webpage`: 0.3
- frontmatter 缺 `source_type` 的页面**不被 Layer 2 排除**（向后兼容；用 `sourceWeightForPage()` 已有的 fallback：有 `source_hash`/`source_path` 时记 0.8，否则 0.5）
- 默认阈值 0.3 等价于"webpage 仍然能进，但 future 你新增的低权重 source 不会自动进"——把更激进的过滤留给用户主动调高

### Layer 3：Minimum Relevance Ratio Gate

排除相关性分数远低于头部结果的长尾噪声。

- 默认 `min_score_ratio: 0.2`，作用在 `component_scores.relevance` 上（**不是 final_score**，避免 confidence/freshness 的二次衰减干扰相关性判断）
- 公式（修订版）：

  ```
  let topRelevance = max(results.map(r => r.component_scores.relevance));
  if (topRelevance <= 0) skip Layer 3;          // 全 0 / 全负，filter 失效
  keep top-1 unconditionally;                    // 头部永远保留
  for the rest: keep if r.component_scores.relevance >= topRelevance * min_score_ratio;
  ```

- 这条是真正干掉"只共享一个汉字"型噪声的核心。

### Data Flow

```
askCommand
  ├─ rankedAskResultsForQuery()         // 已有
  ├─ enrichWithSourceWeight(results)    // 新增：批量从 frontmatter 取 source_type
  ├─ filterAskResults(enriched, config) // 新增三层
  │    ├─ Layer 1: confidence  >= min_confidence
  │    ├─ Layer 2: sourceWeight >= min_source_weight
  │    └─ Layer 3: relevance   >= topRelevance * min_score_ratio (top-1 保留)
  ├─ ensureNonEmpty(filtered, original) // 新增：fallback 策略
  └─ generateAskAnswer(survivors)
```

`search` / `context-pack` 不走 filter，保持透明。

### Source Type 数据来源

`rankedAskResultsForQuery()` 当前返回的 `RankedSearchResult` 不带 `source_type`/`source_weight`。实施层**不修改 ranker 接口**，而是在 cli 层做一次批量 lookup：

```ts
// apps/cli/src/main.ts (新增)
function enrichWithSourceWeight(
  vaultDir: string,
  results: RankedSearchResult[],
): EnrichedAskResult[] {
  // 一次性把 page_id → Page 缓存住，避免 N 次磁盘读
  const pageCache = new Map<PageId, Page>();
  for (const r of results) {
    if (pageCache.has(r.page_id)) continue;
    const file = resolvePageFile(vaultDir, r.page_id);
    if (!file) continue;
    pageCache.set(r.page_id, pageFromFile(vaultDir, file).page);
  }
  return results.map((r) => {
    const page = pageCache.get(r.page_id);
    return {
      ...r,
      source_type: page?.frontmatter.source_type,
      source_weight: page ? sourceWeightForPage(vaultDir, page) : undefined,
    };
  });
}
```

`source_weight === undefined` 的结果在 Layer 2 里**直接放行**（向后兼容）。

### Fallback 策略：当全部被过滤

review 指出"全过滤 → 直接返回 No high-quality evidence"会让 ask 在很多边角场景"看起来坏了"。修订后的策略：

```
if filtered.length === 0:
  if --strict:                       // 显式要求严格，宁缺勿滥
    return "No high-quality evidence found above thresholds"
  else:                              // 默认 graceful fallback
    survivors = original.slice(0, 1) // 至少保 top-1，让 LLM 仍有上下文
    output.warning = "All results below quality thresholds; falling back to top-1."
```

`--strict` 不引入新 config 字段；它是 CLI 一次性开关。

### Configuration

`.akb/config.yaml` 新增可选段：

```yaml
ask:
  min_confidence: 0.3
  min_source_weight: 0.3
  min_score_ratio: 0.2
```

全部字段 optional，缺省走默认。整段缺失也走默认，老 vault 零改动可用。

### CLI Flags

```
--min-confidence <n>      override ask.min_confidence
--min-source-weight <n>   override ask.min_source_weight   (新增；review 反馈：留逃生通道)
--min-score-ratio <n>     override ask.min_score_ratio
--strict                  全部被过滤时返回空答案而不是 fallback 到 top-1
```

### Output Changes

JSON（`filtered` 嵌到 `meta`，避免顶层 schema 膨胀）：

```json
{
  "answer": "...",
  "citations": [...],
  "meta": {
    "filtered": {
      "input_count": 5,
      "kept_count": 2,
      "by_confidence": 1,
      "by_source_weight": 1,
      "by_score_ratio": 1,
      "fallback_top1": false
    }
  }
}
```

人类可读输出（措辞改中性，不再用"low-quality"判断）：

```
Filtered 3 results below quality thresholds (1 confidence, 1 source weight, 1 score ratio).
Generated answer (ark, doubao-seed-2-0-code-preview-260215):
...
```

verbose 模式（`AKB_DEBUG_FILTER=1` 或 `--verbose`）下，**stderr** 打印每条被过滤的页面：

```
[ask-filter] drop page=note/bilibili-rss layer=score_ratio relevance=0.08 top=0.71
[ask-filter] drop page=upgrade-2024Q1 layer=confidence score=0.18 min=0.30
```

不写入 ledger，避免污染事实源；只是诊断输出。

### Edge Cases

- **全部命中阈值，filtered.length > 0**：正常走 LLM。
- **全部被过滤、非 strict**：保留 top-1，标记 `fallback_top1: true`，仍调 LLM。
- **全部被过滤、strict**：返回 no-evidence 文案，不调 LLM。
- **空 ledger**：confidence fallback 0.7，全过 Layer 1。
- **frontmatter 无 `source_type`**：`source_weight` 为 undefined，全过 Layer 2。
- **唯一一条结果**：Layer 3 的 "top-1 unconditional keep" 自动保住。
- **`max_relevance <= 0`**：Layer 3 跳过，等同 disabled。
- **`--include-superseded`**：不自动放宽阈值；用户既然显式要历史页面，就让阈值仍生效。**但** 在文档里明确这一点，避免用户疑惑。

### Files to Modify

1. `packages/core/src/index.ts`
   - 新增 `AskFilterConfigSchema`，挂到 `ConfigSchema.ask`
2. `apps/cli/src/main.ts`
   - 新增 `enrichWithSourceWeight()`、`filterAskResults()`、`applyAskFilterFallback()`
   - 在 `askCommand()` 的 `rankedAskResultsForQuery` 之后、`generateAskAnswer` 之前接入
   - 新增 `--min-confidence` `--min-source-weight` `--min-score-ratio` `--strict` flag
   - JSON payload 增加 `meta.filtered`；人类输出增加单行摘要
3. `apps/cli/src/main.test.ts`
   - 新增 filter 单元测试：每层独立、组合、fallback、strict、空 ledger、缺 source_type
4. ranker / search-engine **不动**

### Not In Scope

- 语义相似度过滤（要 embedding 模型或额外 LLM 调用）
- 内容密度评分（阈值难调）
- 搜索期 authority domain 过滤（独立设计）
- 自动从路径/内容推 `source_type`

---

## Implementation Sketch

### 1. `packages/core/src/index.ts` — Schema

```ts
const AskFilterConfigSchema = z
  .object({
    min_confidence: z.number().min(0).max(1).default(0.3),
    min_source_weight: z.number().min(0).max(1).default(0.3),
    min_score_ratio: z.number().min(0).max(1).default(0.2),
  })
  .strict()
  .default({});

export const ConfigSchema = z.object({
  // ... existing fields ...
  ask: AskFilterConfigSchema.optional(),
});

export type AskFilterConfig = z.infer<typeof AskFilterConfigSchema>;

export function resolvedAskFilterConfig(
  config: Config,
  overrides: Partial<AskFilterConfig> = {},
): AskFilterConfig {
  const base = config.ask ?? AskFilterConfigSchema.parse({});
  return {
    min_confidence: overrides.min_confidence ?? base.min_confidence,
    min_source_weight: overrides.min_source_weight ?? base.min_source_weight,
    min_score_ratio: overrides.min_score_ratio ?? base.min_score_ratio,
  };
}
```

### 2. `apps/cli/src/main.ts` — 类型与 enrich

```ts
interface EnrichedAskResult extends RankedSearchResult {
  source_type?: string;
  source_weight?: number;
}

interface AskFilterStats {
  input_count: number;
  kept_count: number;
  by_confidence: number;
  by_source_weight: number;
  by_score_ratio: number;
  fallback_top1: boolean;
}

interface AskFilterOutcome {
  results: EnrichedAskResult[];
  stats: AskFilterStats;
}
```

### 3. `apps/cli/src/main.ts` — `filterAskResults`

```ts
function filterAskResults(
  results: EnrichedAskResult[],
  cfg: AskFilterConfig,
  opts: { verbose?: boolean } = {},
): { kept: EnrichedAskResult[]; stats: Omit<AskFilterStats, "fallback_top1"> } {
  const stats = {
    input_count: results.length,
    kept_count: 0,
    by_confidence: 0,
    by_source_weight: 0,
    by_score_ratio: 0,
  };
  if (results.length === 0) {
    return { kept: [], stats };
  }

  // Layer 3 阈值（基于 component_scores.relevance）
  const topRelevance = Math.max(
    ...results.map((r) => r.component_scores.relevance),
  );
  const ratioThreshold =
    topRelevance > 0 ? topRelevance * cfg.min_score_ratio : -Infinity;

  const kept: EnrichedAskResult[] = [];
  results.forEach((r, idx) => {
    // Layer 1
    if (r.component_scores.confidence < cfg.min_confidence) {
      stats.by_confidence += 1;
      if (opts.verbose) {
        console.error(
          `[ask-filter] drop page=${r.page_id} layer=confidence ` +
            `score=${r.component_scores.confidence.toFixed(2)} ` +
            `min=${cfg.min_confidence}`,
        );
      }
      return;
    }
    // Layer 2 — undefined source_weight 直接放行
    if (
      r.source_weight !== undefined &&
      r.source_weight < cfg.min_source_weight
    ) {
      stats.by_source_weight += 1;
      if (opts.verbose) {
        console.error(
          `[ask-filter] drop page=${r.page_id} layer=source_weight ` +
            `weight=${r.source_weight} min=${cfg.min_source_weight}`,
        );
      }
      return;
    }
    // Layer 3 — top-1 无条件保留
    if (idx === 0) {
      kept.push(r);
      return;
    }
    if (r.component_scores.relevance < ratioThreshold) {
      stats.by_score_ratio += 1;
      if (opts.verbose) {
        console.error(
          `[ask-filter] drop page=${r.page_id} layer=score_ratio ` +
            `relevance=${r.component_scores.relevance.toFixed(2)} ` +
            `top=${topRelevance.toFixed(2)} ratio=${cfg.min_score_ratio}`,
        );
      }
      return;
    }
    kept.push(r);
  });
  stats.kept_count = kept.length;
  return { kept, stats };
}

function applyAskFilterFallback(
  filtered: { kept: EnrichedAskResult[]; stats: Omit<AskFilterStats, "fallback_top1"> },
  original: EnrichedAskResult[],
  strict: boolean,
): AskFilterOutcome {
  if (filtered.kept.length > 0 || original.length === 0) {
    return {
      results: filtered.kept,
      stats: { ...filtered.stats, fallback_top1: false },
    };
  }
  if (strict) {
    return {
      results: [],
      stats: { ...filtered.stats, fallback_top1: false },
    };
  }
  return {
    results: original.slice(0, 1),
    stats: { ...filtered.stats, kept_count: 1, fallback_top1: true },
  };
}
```

### 4. `apps/cli/src/main.ts` — `askCommand` 接入点

只展示新增/修改的片段：

```ts
interface AskOptions {
  // ... existing ...
  minConfidence?: number;
  minSourceWeight?: number;
  minScoreRatio?: number;
  strict?: boolean;
  verbose?: boolean;
}

async function askCommand(question: string, options: AskOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const start = performance.now();
  const config = readVaultConfig(vaultDir);
  const retrieval = rankedAskResultsForQuery(vaultDir, question, options);

  // 新增：enrich + filter + fallback
  const enriched = enrichWithSourceWeight(vaultDir, retrieval.results);
  const filterCfg = resolvedAskFilterConfig(config, {
    min_confidence: options.minConfidence,
    min_source_weight: options.minSourceWeight,
    min_score_ratio: options.minScoreRatio,
  });
  const verbose = options.verbose === true || process.env.AKB_DEBUG_FILTER === "1";
  const filtered = filterAskResults(enriched, filterCfg, { verbose });
  const outcome = applyAskFilterFallback(filtered, enriched, options.strict === true);

  const results = outcome.results;
  const noEvidence = results.length === 0;
  // ...剩余逻辑用 results 即可，与原来一致...

  const payload = {
    question,
    answer,
    citations,
    no_evidence: noEvidence,
    // ... existing fields ...
    meta: { filtered: outcome.stats },
  };

  if (options.format !== "json") {
    if (
      outcome.stats.input_count > 0 &&
      outcome.stats.input_count > outcome.stats.kept_count
    ) {
      const dropped = outcome.stats.input_count - outcome.stats.kept_count;
      const detail = [
        outcome.stats.by_confidence > 0 &&
          `${outcome.stats.by_confidence} confidence`,
        outcome.stats.by_source_weight > 0 &&
          `${outcome.stats.by_source_weight} source weight`,
        outcome.stats.by_score_ratio > 0 &&
          `${outcome.stats.by_score_ratio} score ratio`,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(
        `Filtered ${dropped} results below quality thresholds (${detail}).`,
      );
      if (outcome.stats.fallback_top1) {
        console.log("All results below thresholds; fell back to top-1.");
      }
    }
    // ... 后续 generated/extractive 输出保持不变 ...
  }
}
```

### 5. CLI flag 注册

```ts
program
  .command("ask")
  .argument("<question>")
  .option("--hybrid", "use hybrid retrieval")
  .option("--include-superseded", "include superseded pages")
  .option("--format <fmt>", "json|text", "text")
  .option("--min-confidence <n>", "override ask.min_confidence", parseFloat)
  .option(
    "--min-source-weight <n>",
    "override ask.min_source_weight",
    parseFloat,
  )
  .option("--min-score-ratio <n>", "override ask.min_score_ratio", parseFloat)
  .option("--strict", "do not fall back to top-1 when all filtered")
  .option("--verbose", "print per-result filter decisions to stderr")
  .action(askCommand);
```

### 6. 测试用例骨架

```ts
// apps/cli/src/main.test.ts (新增 describe block)
describe("filterAskResults", () => {
  const baseCfg: AskFilterConfig = {
    min_confidence: 0.3,
    min_source_weight: 0.3,
    min_score_ratio: 0.2,
  };
  const mk = (over: Partial<EnrichedAskResult>): EnrichedAskResult => ({
    page_id: "p" as PageId,
    path: "p.md",
    title: "p",
    snippet: "...",
    score: 1,
    citation: { line_start: 1, line_end: 1 },
    final_score: 1,
    component_scores: {
      relevance: 1,
      confidence: 0.7,
      freshness: 0.5,
      access_recency: 0.5,
    },
    flags: [],
    source_type: "markdown",
    source_weight: 1,
    ...over,
  });

  it("drops by confidence", () => {
    const r = filterAskResults(
      [
        mk({ component_scores: { ...mk({}).component_scores, confidence: 0.1 } }),
      ],
      baseCfg,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.stats.by_confidence).toBe(1);
  });

  it("drops by source_weight but skips when undefined", () => {
    const dropped = mk({ source_weight: 0.2 });
    const passes = mk({ source_weight: undefined });
    const r = filterAskResults([dropped, passes], baseCfg);
    expect(r.kept.map((x) => x.page_id)).toEqual([passes.page_id]);
    expect(r.stats.by_source_weight).toBe(1);
  });

  it("always keeps top-1 even if relevance below ratio", () => {
    // 唯一结果且 relevance 极小
    const only = mk({
      component_scores: { ...mk({}).component_scores, relevance: 0.001 },
    });
    const r = filterAskResults([only], baseCfg);
    expect(r.kept).toHaveLength(1);
  });

  it("drops long-tail by score ratio", () => {
    const top = mk({ page_id: "top" as PageId });
    const tail = mk({
      page_id: "tail" as PageId,
      component_scores: { ...mk({}).component_scores, relevance: 0.05 },
    });
    const r = filterAskResults([top, tail], baseCfg);
    expect(r.kept.map((x) => x.page_id)).toEqual(["top"]);
    expect(r.stats.by_score_ratio).toBe(1);
  });

  it("skips ratio gate when topRelevance == 0", () => {
    const a = mk({
      page_id: "a" as PageId,
      component_scores: { ...mk({}).component_scores, relevance: 0 },
    });
    const b = mk({
      page_id: "b" as PageId,
      component_scores: { ...mk({}).component_scores, relevance: 0 },
    });
    const r = filterAskResults([a, b], baseCfg);
    expect(r.kept).toHaveLength(2);
  });
});

describe("applyAskFilterFallback", () => {
  it("falls back to top-1 by default when all filtered", () => {
    const original = [/* ...two results... */];
    const out = applyAskFilterFallback(
      { kept: [], stats: emptyStats(2) },
      original,
      false,
    );
    expect(out.results).toHaveLength(1);
    expect(out.stats.fallback_top1).toBe(true);
  });
  it("returns empty under --strict", () => {
    const out = applyAskFilterFallback(
      { kept: [], stats: emptyStats(2) },
      [/* ... */],
      true,
    );
    expect(out.results).toHaveLength(0);
    expect(out.stats.fallback_top1).toBe(false);
  });
});
```

## Open Questions

1. `min_source_weight` 默认 0.3 等于"放行 webpage"。一旦后续 source 表新增 `<0.3` 的类型（例如 `forum`），需要同步评估是否调整默认。
2. 是否要在 `meta.filtered` 里附 dropped page_id 列表？目前选择不附（避免大 payload + 隐私），verbose 模式 stderr 已能拿到。
3. 与未来"语义相似度过滤"的关系：本设计是 lexical+元数据 hard gate，**先于** 任何语义层。语义层落地后作为 Layer 4 增量。
