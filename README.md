# AI-Native Knowledge Compiler (`akb`)

> **The persistent, auditable memory layer for coding agents.**
> coding agent 的可审计持久记忆层。

> ⚠️ **状态：v0.1 本地闭环可运行**。当前已有 TypeScript monorepo、Markdown ingest、SQLite FTS5 + hybrid search、confidence-aware ranker、Confidence Ledger、LLM compile patch workflow、citation-first `ask`、eval harness、MCP server、sample vault 和端到端 demo。还不是 npm 发布版本，CLI 与 schema 仍可能调整。

---

## 这是什么

`akb` 是一个 **git-backed、markdown-native、MCP-first** 的知识库系统，目标是让 coding agent（Claude Code / Codex / Cursor 等）能够**长期、稳定、可追溯地依赖**一份工程知识——而这份知识同时是人类可读、可编辑、可 PR review、可 `git blame` 的。

一句话定位：**人和 agent 共享同一份事实**。

<img width="1024" height="1536" alt="image" src="https://github.com/user-attachments/assets/283870e2-2a78-4cda-af37-cad36e3d1c2b" />


它**不是**：

- 不是另一个 Notion / Confluence —— 那些不为 agent 设计，也不可 git
- 不是另一个 Obsidian —— 那个是给人用的，agent 接口靠插件凑
- 不是另一个 RAG framework —— Dify / RAGFlow 是 query-time 检索，`akb` 是 ingest-time 编译
- 不是 agent 的黑盒 cache —— Devin / Cursor 的内部 memory 不可读、不可改、锁在 vendor 里

它**是**：

- 一个 git-backed markdown vault，知识以纯文本累积、演化、版本化
- 一个 MCP-first 接口，任何支持 MCP 的 agent 都能查同一个知识库
- 一个有 **confidence 演化机制**的"知识 git"——不仅记录"现在认为什么"，也记录"过去认为过什么、为什么改了"

---

## 为什么从头写——以及与现有方案的差异

Karpathy 在 2026 年 4 月提出的 [LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 已经有多个社区实现（`NiharShrotri/llm-wiki`、`nashsu/llm_wiki`、`nvk/llm-wiki`、ΩmegaWiki 等）。我们认真调研过这些实现，结论是：**"ingest-time compile 而非 query-time RAG"这个核心范式已经被反复实现，不值得再造。但有七项能力，没有任何现有实现覆盖**——而这七项恰好是"让 agent 长期可信地依赖知识库"的关键。

### Prior Art 对照

| 能力 | 现有 LLM Wiki 实现 | `akb` |
| --- | --- | --- |
| ingest-time compile（非 query-time RAG） | ✅ 已是标配 | ✅ 采用 |
| merge / create / contradict 关系判定 | ✅ 已是标配 | ✅ 采用 |
| Obsidian 兼容 / `[[wikilink]]` | ✅ 已是标配 | ✅ 采用 |
| 混合检索 BM25 + vector + rerank | ✅ 部分实现 | ✅ 采用 |
| **MCP 接口（agent-native）** | ❌ 无 | ✅ **核心差异** |
| **行号级 citation**（page_id + 行号范围） | ⚠️ 仅页级 | ✅ **核心差异** |
| **Confidence Ledger**（append-only 事件流） | ⚠️ 仅 LLM 主观打分 | ✅ **核心差异** |
| **Chunk Lineage**（derived chunk 可溯源 + replay） | ⚠️ 仅页级 / session 级 | ✅ **核心差异** |
| **Runtime Verification**（CI / runbook 自动验证知识） | ❌ 无 | ✅ **核心差异** |
| **内建 Eval 框架**（每个 PR 跑 golden set 回归） | ❌ 无 | ✅ **核心差异** |
| **代码反向解析**（codebase → 设计文档） | ❌ 无（面向 research/PKM） | ✅ **核心差异（规划中）** |

中期对标：**Karpathy LLM Wiki 模式的工程化实现**——同时具备 MCP 协议、git 原生、citation、confidence、code intel。这是目前还没人把所有零件拼齐的位置。

长期定位：coding agent 的工程记忆层。但**不是要做更好的 Devin memory**，而是做相反方向——human-readable + git-versioned + multi-agent-shared。两者长期会并存（agent 自己的快记忆 + 团队的慢记忆），`akb` 占的是后者。

---

## 核心设计原则

### 1. Markdown 是 canonical，其它都是投影

`markdown` 是事实源（canonical truth）。所有 index / vector / graph / confidence 事件缓存都是从 markdown 派生的**投影层（projection layer）**，永远不反过来。

- 任何投影任何时候都可以从 markdown 完全重建
- 投影与 markdown 冲突时，markdown 赢
- 任何写操作必须先写 markdown，再更新投影
- 投影层不入 git，只有 markdown 和事件流（JSONL）入 git

我们**明确拒绝 claim-first / graph-first 架构**（让外部 graph 是真相、markdown 是 render layer）。理由：LLM 抽 claim 准确率长尾差、人类无法直接编辑、叙事被切碎、双向同步是分布式系统级难题。详见 [v0.0 spec § 0.6](docs/v0.0-spec.md)。

### 2. Citation-first

没有 citation 的知识系统最终会退化成"模型觉得"而不是"知识库事实"。`akb` 强制每个检索结果带可定位的 citation——精确到 `page_id + line_start + line_end`。patch、supersede、contradiction、confidence、replay 全部建立在 knowledge provenance 之上。

### 3. Compile-time vs Query-time 的工作划分

产品名字里 "Compiler" 的技术兑现：**昂贵的、累积的、需要 LLM 判断的工作发生在 ingest time（compile time），只做一次；query time 只剩"检索 + 重排 + 取内容"这种廉价、无状态、确定的操作**。这是与 RAG 的本质区别——RAG 把组织工作放 query time 每次重做。

### 4. Confidence 是事件流，不是分数

`Confidence Ledger` 不是一个 `confidence: 0.82` 字段，而是一个 **append-only 事件流**——知识库的 git log。知识不应该被覆盖，而应该演化。Page 的 confidence 是这个事件流的物化视图。它解决的是普通 RAG 系统一定会遇到的退化：claim 永远新鲜、矛盾静默共存、来源无权重、老知识不衰减。详见 [v0.1 confidence ledger](docs/v0.1-confidence-ledger.md)。

---

## 架构概览

```
            ┌─────────────────────────────────────────┐
            │  人 / coding agent                       │
            └────────────────┬────────────────────────┘
                             │ MCP / CLI
                             ▼
   ┌──────────────────────────────────────────────────────┐
   │  akb                                                  │
   │                                                       │
   │   ingest ──► compile ──► patch ──► apply               │
   │     │          │          │         │                 │
   │     │          │          │         ├─► markdown (canonical, git)
   │     │          │          │         └─► confidence ledger (JSONL, git)
   │     │          │          │                            │
   │   query ◄── rank ◄── search index ◄────────────────────┤
   │                          ▲                             │
   │                          │  投影层 (不入 git)：           │
   │                          └─ FTS5 / vector / graph /     │
   │                             confidence cache / lineage  │
   └──────────────────────────────────────────────────────┘
                             │
                             ▼
              git-backed markdown vault
              （Obsidian 可直接打开）
```

- **canonical**：`pages/*.md` + `.ledger.jsonl` —— 入 git，是事实
- **projection**：SQLite FTS5、vector index、relation graph、confidence cache、chunk lineage —— 不入 git，可随时从 canonical 重建
- **接口**：CLI（`akb ...`）+ MCP server（`search_knowledge` / `get_page` / ...）

---

## 使用手册

### 安装与构建

```bash
pnpm install
pnpm build
```

开发期可以直接用源码入口：

```bash
pnpm exec tsx apps/cli/src/main.ts --help
```

构建后用 dist 入口：

```bash
node apps/cli/dist/main.js --help
```

### 创建 vault

```bash
node apps/cli/dist/main.js init /tmp/akb-demo
cd /tmp/akb-demo
```

`akb init` 会创建：

- `pages/`：canonical Markdown 页面
- `.akb/config.yaml`：vault 配置
- `.akb/eval/golden.yaml`：eval golden set
- `.gitignore`：忽略 `.akb/index.db`、`.akb/lint/` 等投影/诊断输出
- git 仓库

最小配置如下：

```yaml
version: "0.0"
workspace:
  name: "akb-demo"
  vault_dir: "."
index:
  engine: "sqlite-fts5"
  path: ".akb/index.db"
mcp:
  host: "127.0.0.1"
  port: 8765
```

### 配置大模型（可选）

如果希望 `ask` 和 `compile` 使用大模型能力，先在 `.akb/config.yaml` 中配置 LLM provider、model 和 API key 环境变量名。真实 API key 只放在本机环境变量中，不写入配置文件，避免误提交到远端。

DeepSeek：

```yaml
llm:
  provider: "deepseek"
  base_url: "https://api.deepseek.com"
  model: "deepseek-v4-flash"
  api_key_env: "DEEPSEEK_API_KEY"
```

OpenAI：

```yaml
llm:
  provider: "openai"
  base_url: "https://api.openai.com/v1"
  model: "gpt-4.1-mini"
  api_key_env: "OPENAI_API_KEY"
```

Anthropic：

```yaml
llm:
  provider: "anthropic"
  base_url: "https://api.anthropic.com/v1"
  model: "claude-sonnet-4-20250514"
  api_key_env: "ANTHROPIC_API_KEY"
```

设置本机环境变量：

```bash
export DEEPSEEK_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
```

只需要设置你实际使用的 provider 对应的 key。未设置环境变量时，`ask` 会降级为 extractive answer，`compile` 会生成 degraded heuristic patch。

### Ingest / Index / Search

```bash
AKB=/path/to/ai-knowledge-compiler/apps/cli/dist/main.js

node "$AKB" ingest /path/to/markdown-or-directory --recursive --no-compile --no-commit
node "$AKB" ingest /path/to/markdown-or-directory --recursive --compile-concurrency 2 --no-commit
node "$AKB" index --rebuild
node "$AKB" search "garbage collection"
node "$AKB" search "garbage collection" --hybrid --format json
```

`ingest` 支持单个 Markdown 文件或目录。目录递归导入需要显式传 `--recursive`。默认会在导入后触发 `compile` 并为写入操作创建 git commit；首次批量导入建议加 `--no-compile --no-commit`，确认 `pages/` 和索引正常后再分批运行 compile。

导入阶段会串行写入 Markdown 和更新 SQLite index，避免多个写入者同时改 vault。导入完成后的 compile 阶段可以用 `--compile-concurrency <n>` 做有限并发；每个 source 仍只生成 proposed patch，不会直接应用到页面。批量 compile 结束后会打印 `Compile summary`，汇总 total、provider success、degraded、provider 分布和 degraded reason 计数。LLM compile provider 请求默认 120 秒超时，建议并发从 `2` 开始，避免过多并发触发 provider 限流或超时。

`search` 默认使用 BM25，并返回带 `page_id + line_start + line_end` 的 citation。`--hybrid` 会叠加本地 sparse vector score，再交给 confidence-aware ranker 排序。默认会过滤 superseded 页面，历史页面可用 `--include-superseded` 查看。

### Ask

`ask` 在检索结果上生成 citation-first 回答：

```bash
node "$AKB" ask "wear leveling 和 garbage collection 的关系是什么？"
node "$AKB" ask "wear leveling" --hybrid --format json
```

未配置 LLM 时，`ask` 返回 extractive answer，并保留引用。配置 LLM 后会调用 `.akb/config.yaml` 中指定的 DeepSeek、OpenAI 或 Anthropic 生成答案；模型输出必须只引用检索返回的 refs，否则自动降级为 extractive answer。

`ask` 先检索本地知识库，只有找到 evidence 后才调用 LLM。原始问题没有命中时，会自动用问题里的英文缩写或关键词重试检索，例如中文问题里的 `FTL`。人类可读输出会标明是否使用 retrieval fallback，以及成功生成时使用的 provider/model；如果没有任何 evidence，会明确显示 LLM 没有被调用。

### Confidence Ledger

Confidence Ledger 是每个页面旁边的 append-only JSONL 事件流，例如 `pages/.page_xxx.ledger.jsonl`。常用命令：

```bash
node "$AKB" migrate to-v0.1 --no-commit
node "$AKB" confidence show page_gc0000000000
node "$AKB" confidence recompute page_gc0000000000 --format json
node "$AKB" confidence sections page_gc0000000000
node "$AKB" confidence file src/deploy.ts
node "$AKB" confidence file src/deploy.ts --format json --events
node "$AKB" confidence report --by-file
node "$AKB" projection rebuild --confidence
node "$AKB" verify "pages/*.md" --dry-run
node "$AKB" verify page_gc0000000000 --by-agent codex --reason "reviewed current behavior" --no-commit
node "$AKB" decay --run --no-commit
```

`confidence sections <page>` 会按 Markdown header 切分页面，报告每个 section 的稳定 id、行号范围、继承自 page ledger 的 score/status，以及 derived marker 数量。`confidence file <path>` 会从页面 frontmatter 的 `references:` 反查哪些知识页引用了某个代码或文档路径，并显示这些页面的 score 和 `NEEDS_REVIEW` / `STALE` 等状态。`confidence report --by-file` 会生成 `.akb/lint/confidence-by-file.md`，适合在检查某个代码文件变更影响哪些知识页时使用。

运行时信号可以通过 webhook/watch 写入 ledger：

```bash
node "$AKB" runbook exec page_runbook00001 --no-commit
node "$AKB" test --link-pages --command "pnpm test" --no-commit
node "$AKB" webhook ci-success --changed-file pages/gc.md --evidence https://ci.example/run/123 --no-commit
node "$AKB" webhook ci-failure --changed-file pages/gc.md --evidence https://ci.example/run/124 --no-commit
node "$AKB" watch --once --no-commit
```

`runbook exec` 会执行 runbook 页面里的 shell fenced code block。全部步骤成功时写 `verified`，某一步失败时写 `contradicted_by`。`test --link-pages` 会扫描 `@akb-page <page_id>` 标注，执行指定测试命令，并把测试结果写入对应页面 ledger。

### Supersede

页面替代关系会写入 ledger，并更新 Markdown frontmatter：

```bash
node "$AKB" supersede page_old000000000 --by page_new000000000 --reason "new source supersedes old design" --no-commit
```

如果旧页面已经被另一个页面 supersede，默认会拒绝覆盖链路。确认要替换链路时使用：

```bash
node "$AKB" supersede page_old000000000 --by page_newer0000000 --unlink --reason "replace superseder" --no-commit
```

### Compile / Patch / Lineage

`compile` 把 source 页面编译成 reviewable patch，默认不直接改 Markdown：

```bash
node "$AKB" compile --source page_compile00002
node "$AKB" compile --all-pending
node "$AKB" compile status
node "$AKB" patch list
node "$AKB" patch show patch_page_compile00002
```

没有设置对应 API key 环境变量时，compile 会生成 degraded heuristic patch，并在 `compileMeta.degraded=true` 中记录原因。配置 DeepSeek、OpenAI 或 Anthropic 后，compile 会跑 provider-backed pipeline，并记录 pinned `modelId`、`promptHashes` 和 `resolvedModelId`。

Provider-backed compile 的单次 LLM 请求默认 120 秒超时。`classify` 的 relation 和 `synthesize` 的 patch changes 如果不符合本地 schema，`akb` 会把校验错误反馈给模型并自动重试一次；重试后仍无效、请求超时或 provider 不可用时，才会降级生成 heuristic patch，不阻塞 ingest。

`compile --all-pending` 也会在末尾打印 `Compile summary`。这对排查大批量 LLM compile 很有用：如果 degraded 数量偏高，先看 `Degraded reasons` 里是 API key、timeout、classify relation 还是 synthesize patch schema 问题。

应用或拒绝 patch：

```bash
node "$AKB" patch apply patch_page_compile00002 --reviewed --no-commit
node "$AKB" patch reject patch_page_compile00002 --reason "not relevant" --no-commit
```

回放 patch：

```bash
node "$AKB" compile replay patch_page_compile00002
```

Provider-backed patch replay 会重新调用对应 provider，并拒绝降级为 heuristic replay；heuristic/legacy patch 仍按 heuristic 路径回放。

查看 lineage：

```bash
node "$AKB" lineage page_compile00001
node "$AKB" lineage --reverse page_compile00002
```

生成 agent session 可用的 context pack：

```bash
node "$AKB" context pack "garbage collection" --top-k 5
node "$AKB" context pack "garbage collection" --format json --output .akb/context/gc.json
```

Context pack 会把检索命中的页面内容、行号 citation、confidence 状态、相关 proposed/applied/rejected patch 摘要和 chunk lineage 摘要放到一个可审计 JSON 包里。写入 `.akb/context/*.json` 的文件是生成物，不需要提交。

导出或查看 relation graph projection：

```bash
node "$AKB" graph export --format json --output .akb/graph/relations.json
node "$AKB" graph show page_gc0000000000
```

Graph projection 从 Markdown 派生，不入 git；当前包含 `wiki_link`、`references` 和 `supersedes` 三类边。

生成静态 Web UI：

```bash
node "$AKB" web build --output .akb/web
```

`web build` 会生成 `.akb/web/index.html`，内嵌当前 vault 的页面、confidence、section report、patch、lineage、eval 和 relation graph snapshot。这个文件是本地 review 产物，不需要提交。

### Eval / Benchmark / Demo

```bash
node "$AKB" eval --set .akb/eval/golden.yaml
pnpm bench
pnpm demo
```

`pnpm demo` 会构建工作区、创建临时 vault、导入 `examples/sample-vault/`、编译 pending sources、重建 index、运行 search 和 eval。

### MCP Server

stdio transport：

```bash
node "$AKB" mcp serve
```

HTTP transport：

```bash
node "$AKB" mcp serve --transport http --port 8765
```

Claude Code MCP 配置示例：

```json
{
  "mcpServers": {
    "akb": {
      "command": "node",
      "args": ["/path/to/ai-knowledge-compiler/apps/cli/dist/main.js", "mcp", "serve"],
      "cwd": "/path/to/your/vault"
    }
  }
}
```

当前 MCP server 暴露 `search_knowledge` 和 `get_page`，检索结果同样包含行号级 citation，并使用 confidence-aware rerank。

### 常用验证命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm coverage
pnpm demo
```

改检索、ranker、confidence、compile 或 MCP 行为时，至少运行相关 focused tests，并在合并前跑完整验证。

## 路线图状态

### v0.0 — 最小闭环

已实现：`init / ingest / index / search / mcp serve / eval`、git-backed markdown vault、Obsidian 兼容、SQLite FTS5 + BM25、行号级 citation、MCP `search_knowledge` / `get_page`、eval harness、sample vault 和 demo。

详见 [docs/v0.0-spec.md](docs/v0.0-spec.md) 和 [docs/search-engine-skeleton.md](docs/search-engine-skeleton.md)。

### v0.1 — Confidence + Compile + Hybrid Ask

已实现：

- Confidence Ledger：JSONL ledger、score materialization、SQLite confidence projection、source weights、decay、verification、supersession、runtime CI signals、runbook/test 强验证、stale decision lint、section-level confidence report、按 `references` 反查文件 confidence
- Confidence-aware retrieval：CLI/MCP search rerank、superseded filtering、hybrid retrieval
- LLM Compile：DeepSeek / OpenAI / Anthropic-backed 5-stage pipeline、heuristic fallback、patch-as-proposal、apply/reject workflow、lineage、replay
- `akb ask`：extractive fallback、provider-generated cited answer、bad citation guard、no-answer handling
- Context pack：按查询生成带 citation、confidence、patch 和 lineage 摘要的 agent 上下文包
- Relation graph projection：从 wikilink、frontmatter references 和 supersedes 派生 graph export/show
- v0.1 migration and projection rebuild commands

详见 [docs/v0.1-confidence-ledger.md](docs/v0.1-confidence-ledger.md) 和 [docs/v0.1-llm-compile.md](docs/v0.1-llm-compile.md)。

### v0.2 及以后

- Section-level confidence ledger events（当前 v0.1 已有按 header 的只读 report）
- Code intelligence —— codebase 反向解析成设计文档 / ADR
- GraphRAG traversal、团队协作

---

## 设计文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/v0.0-spec.md](docs/v0.0-spec.md) | v0.0 极简 spec —— 最小闭环、12 个可执行 issue、定位与 prior art、投影层原则 |
| [docs/search-engine-skeleton.md](docs/search-engine-skeleton.md) | `search-engine` 包的代码骨架 —— API / SQL schema / 测试用例 frozen，可直接交给 agent 实现 |
| [docs/v0.1-confidence-ledger.md](docs/v0.1-confidence-ledger.md) | Confidence Ledger 设计 —— 事件流、衰减公式、来源权重、supersession、runtime verification |
| [docs/v0.1-llm-compile.md](docs/v0.1-llm-compile.md) | LLM Compile 设计 —— 5 阶段 pipeline、chunk lineage schema、与 confidence ledger 的集成 |
| [docs/demo.md](docs/demo.md) | demo 脚本说明 |

建议阅读顺序：`v0.0-spec` → `confidence-ledger` → `llm-compile` → `search-engine-skeleton`。

---

## 关键设计纪律

写在最前面，避免 scope creep：

1. 默认路径必须能在没有 LLM API key 的情况下运行；LLM 增强路径必须显式降级并记录原因
2. 任何让 LLM 写入 vault 的功能都走 patch + review gate，不直接写
3. v0.1 起默认 LLM provider 是 DeepSeek；DeepSeek、OpenAI、Anthropic 的 provider、model、base URL 和 API key 环境变量名可配置；真实 secret 只放在本机环境变量中
4. 任何加新 MCP tool 的提议都要先证明现有的不够 —— 工具爆炸是 agent 系统的头号风险
5. 任何投影层数据都不入 git —— git 只追事实源
6. 任何"修改 vault"的代码路径都必须先写 markdown 再更新投影
7. 每个 PR 必须跑通 eval，retrieval 准确率不允许回归
8. confidence 由系统事件自动产生，不允许 LLM 给自己打分 —— 那样无法 audit

---

## Prior Art & 致谢

- **[Andrej Karpathy](https://karpathy.ai/)** —— [LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)，本项目的范式来源
- **[NiharShrotri/llm-wiki](https://github.com/NiharShrotri/llm-wiki)** —— 完成度最高的 CLI 实现，3-pass ingest + 混合检索 + lint 的工程参考
- **[nvk/llm-wiki](https://github.com/nvk/llm-wiki)** —— agent-native 的 AGENTS.md 协议、structural guardian、dual-linking 格式参考
- **[nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)** —— two-step CoT ingest、4-signal 知识图谱的设计参考
- **ΩmegaWiki / llm-wiki KG 实现** —— edge-level provenance + `needs_review` flag 的设计印证

`akb` 站在这些工作之上，补的是它们共同缺失的那一块：**让知识库成为 agent 可长期信任、人可持续审计的工程记忆**。

---

## License

MIT —— 见 [LICENSE](LICENSE)。

---

## 贡献

当前处于 v0.1 本地闭环阶段。如果你对使用手册、设计文档、prior art 对照或 v0.2 方向有意见，欢迎开 issue 讨论。

代码开始前，所有架构变更先走 issue + 设计文档 PR，不直接写代码——这个项目本身就是在实践"知识先于代码"。
