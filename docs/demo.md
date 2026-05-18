# 中文 Demo：一步一步配置自己的 `akb` 知识库

这份文档面向第一次使用 `akb` 的用户，目标是从零开始配置一个自己的知识库，并逐步启用检索、问答、Confidence Ledger、compile patch workflow、context pack、relation graph、code intelligence report、静态 Web UI、质量门禁和 MCP 接入。

`akb` 的核心约定是：Markdown 是事实源，`.akb/index.db`、confidence projection、context pack、relation graph、code intelligence report、Web UI snapshot、runtime cache 等都是可以重建的投影。你需要提交到 git 的主要是 Markdown 页面和 ledger JSONL；不要提交 `.akb/index.db`、`.akb/lint/`、`.akb/context/`、`.akb/graph/`、`.akb/code-intel/`、`.akb/web/`、coverage、dist 等生成物。

## 0. 新设计的使用边界

开始操作前先记住四类产物：

| 类型 | 路径 | 用途 | 是否提交 |
| --- | --- | --- | --- |
| canonical truth | `pages/*.md` | 人和 agent 共同维护的知识页面 | 是 |
| confidence ledger | `pages/.<page_id>.ledger.jsonl` | 来源、验证、矛盾、衰减、supersede 事件流 | 是 |
| review artifact | `.akb/patches/*.yaml` | `compile` 生成的待 review patch | 按团队约定；应用前先 review |
| projection/report | `.akb/index.db`、`.akb/lint/`、`.akb/context/`、`.akb/graph/`、`.akb/code-intel/`、`.akb/web/` | 搜索索引、审计报告、agent 上下文和本地 UI | 否 |

只有两个常用路径会尝试调用 LLM：

- `ask`：先检索本地知识库；只有找到 evidence 且配置了 API key 环境变量时才调用 LLM。没有 evidence 时不会调用。
- `compile`：配置 API key 后使用 provider-backed pipeline；没有 key、超时或输出不符合 schema 时降级为 degraded heuristic patch。

其他命令，包括 `ingest --no-compile`、`index`、`search`、`confidence`、`runbook exec`、`test --link-pages`、`graph`、`code scan`、`web build`、`gate run`，都不依赖 LLM。

推荐第一次建库按这个顺序走：

1. 初始化 vault。
2. 可选配置 LLM provider 和本机环境变量。
3. 先用 `ingest --no-compile` 导入 Markdown。
4. `index --rebuild` 后验证 `search` / `ask`。
5. `migrate to-v0.1` 初始化 Confidence Ledger。
6. 对关键页面小批量运行 `compile`，review patch 后再应用。
7. 生成 `context pack`、`graph`、`code scan`、`web build` 作为 agent/review 辅助。
8. 用 `gate run` 接入 PR/CI。

## 1. 准备环境

在项目根目录安装依赖并构建：

```bash
cd /path/to/ai-knowledge-compiler
pnpm install
pnpm build
```

为了后续命令更短，先设置 CLI 路径：

```bash
export AKB=/path/to/ai-knowledge-compiler/apps/cli/dist/main.js
node "$AKB" --help
```

开发时也可以直接使用源码入口：

```bash
pnpm exec tsx apps/cli/src/main.ts --help
```

## 2. 创建自己的知识库

选择一个目录作为你的知识库。下面以 `/tmp/my-akb-vault` 为例：

```bash
node "$AKB" init /tmp/my-akb-vault
cd /tmp/my-akb-vault
```

初始化后会得到：

- `pages/`：你的 Markdown 知识页面
- `.akb/config.yaml`：知识库配置
- `.akb/eval/golden.yaml`：检索回归测试集
- `.gitignore`：默认忽略 `.akb/index.db`、`.akb/lint/`、`.akb/context/`、`.akb/graph/`、`.akb/code-intel/`、`.akb/web/` 等生成物
- `.git/`：vault 自身是一个 git 仓库

检查配置文件：

```bash
cat .akb/config.yaml
```

最小配置形态如下：

```yaml
version: "0.0"
workspace:
  name: "my-akb-vault"
  vault_dir: "."
index:
  engine: "sqlite-fts5"
  path: ".akb/index.db"
mcp:
  host: "127.0.0.1"
  port: 8765
```

## 3. 准备你的 Markdown 文件

把已有知识整理成 Markdown 文件。推荐每个主题一个文件，例如：

```text
/path/to/my-docs/
  architecture.md
  deploy-runbook.md
  incident-review.md
```

一个最小页面可以这样写：

```markdown
---
title: Deploy Runbook
tags:
  - deploy
  - runbook
---

# Deploy Runbook

Production deploy requires a clean CI run and a verified rollback plan.

## Rollback

Rollback uses the previous stable image tag.
```

如果你已经有 Obsidian vault，也可以直接导入其中的 Markdown。`akb` 会保留 `[[wikilinks]]`。

## 4. 配置大模型 API Key

如果希望 `ingest` 后的 `compile` 阶段直接使用大模型能力，需要先在 `.akb/config.yaml` 中配置 LLM provider、model 和 API key 环境变量名。`akb` 支持 DeepSeek、OpenAI 和 Anthropic；真实 API key 只放在本机环境变量中，不写入配置文件，避免误提交到远端。

DeepSeek 示例：

```yaml
llm:
  provider: "deepseek"
  base_url: "https://api.deepseek.com"
  model: "deepseek-v4-flash"
  api_key_env: "DEEPSEEK_API_KEY"
```

OpenAI 示例：

```yaml
llm:
  provider: "openai"
  base_url: "https://api.openai.com/v1"
  model: "gpt-4.1-mini"
  api_key_env: "OPENAI_API_KEY"
```

Anthropic 示例：

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

只需要设置你实际使用的 provider 对应的 key。如果你只是第一次批量导入 Markdown，建议仍然先用 `--no-compile`，确认页面结构和索引正常后，再对少量关键页面运行 `compile`。

如果暂时不设置 API key 环境变量，`ask` 会降级为 extractive answer；`compile` 会生成 degraded heuristic patch，并在 `compileMeta.degraded=true` 中记录原因。

## 5. 导入 Markdown、文档和代码

重要：`ingest` 默认会在导入后继续执行 `compile`，为每个新页面生成 reviewable patch。首次批量导入自己的目录时，建议先加 `--no-compile`，只完成导入、格式规范化和索引，确认页面结构正常后再按需运行 compile。

如果没有设置对应 API key 环境变量，`compile` 不会调用大模型，而是走 degraded heuristic fallback。但对大量 Markdown、PDF、Word 或代码文件来说，导入后逐页 compile 仍然可能很慢，因为每个 source 都要扫描 vault 里的候选页面。若已经设置了 API key，则默认 compile 会对每个 source 调用 LLM，更应该避免在首次大目录导入时自动触发。

导入单个文件：

```bash
node "$AKB" ingest /path/to/my-docs/architecture.md --no-compile --no-commit
node "$AKB" ingest /path/to/my-docs/spec.pdf --no-compile --no-commit
node "$AKB" ingest /path/to/my-docs/notes.docx --no-compile --no-commit
node "$AKB" ingest /path/to/project/src/gc.c --no-compile --no-commit
```

导入整个目录：

```bash
node "$AKB" ingest /path/to/my-docs --recursive --no-compile --no-commit
```

`ingest` 会把非 Markdown 输入统一转换成 Markdown canonical page：`spec.pdf` 写成 `pages/spec.pdf.md`，`notes.docx` 写成 `pages/notes.docx.md`，`src/gc.c` 写成 `pages/src/gc.c.md`。代码页会保留 fenced source block，并写入 `source_type: code`、`code_language`、`line_count` 等 frontmatter。PDF/DOC/DOCX 依赖本机可用转换器；可用 `--converter auto|builtin|external` 选择策略，用 `--strict-convert` 要求任何转换失败都让命令失败。

目录导入默认不包含代码文件，避免把整个代码库意外导入。确认要把代码作为最高权重知识源导入时，显式加：

```bash
node "$AKB" ingest /path/to/project --recursive --include-code --no-compile --no-commit
```

如果你已经确认要在导入后立即生成 compile patch，可以限制并发数：

```bash
node "$AKB" ingest /path/to/my-docs --recursive --compile-concurrency 2 --no-commit
```

`ingest` 写入 Markdown 和更新索引的阶段仍然是串行的，避免多个写入者同时改 `pages/` 和 `.akb/index.db`。`--compile-concurrency` 只影响导入完成后的 compile 阶段，每个 source 生成独立的 proposed patch，不会自动应用 patch。批量 compile 结束后会打印 `Compile summary`，汇总 total、provider success、degraded、provider 分布和 degraded reason 计数。LLM compile provider 请求默认 120 秒超时，建议并发从 `2` 开始，避免过多 LLM 并发触发限流或超时。

如果目录里包含隐藏文件或隐藏文件夹，`ingest` 会在开始时先列出这些路径并询问是否导入；默认不导入。非交互环境中不会等待输入，也会按默认值跳过隐藏项。确认导入隐藏项后，目标路径会自动转成非隐藏路径，例如 `.hidden.md` 会写入为 `pages/hidden.md`，`.secret/child.md` 会写入为 `pages/secret/child.md`。

如果你已经确认需要导入隐藏项，也可以直接使用：

```bash
node "$AKB" ingest /path/to/my-docs --recursive --include-hidden --no-compile --no-commit
```

导入开始后会先打印总数，并逐个显示进度：

```text
Found 125 ingestible sources to ingest.
Ingest [##------------------] 10/125 HLD_02_CONTROLLER_THREAD_EN.md -> pages/HLD_02_CONTROLLER_THREAD_EN.md
```

常用选项：

- `--recursive`：递归导入目录下支持的 Markdown、文档和文本格式
- `--tag <tag>`：给导入页面追加 tag
- `--force`：覆盖已有同名页面
- `--include-hidden`：导入隐藏文件和隐藏文件夹，并把写入 `pages/` 的路径转换为非隐藏路径
- `--include-code`：目录导入时包含支持的代码文件；单个代码文件导入不需要这个选项
- `--no-include-documents`：只导入 Markdown，跳过 PDF、Word、文本和 markup 文档
- `--converter <auto|builtin|external>`：选择转换器策略，默认 `auto`
- `--strict-convert`：任一转换失败就让命令失败，适合 CI 或正式批量导入
- `--no-compile`：导入后不触发 compile。首次批量导入强烈建议使用
- `--compile`：导入后立即对每个新页面生成 compile patch。只建议在文件数量少或你已经准备好 review patch 时使用
- `--compile-concurrency <n>`：导入完成后并发 compile 的 source 数量。默认 `1`，建议从 `2` 开始
- `--no-commit`：跳过自动 git commit，适合试跑和本地调试

导入后检查页面：

```bash
find pages -maxdepth 2 -type f -name "*.md" | sort
git status --short
```

如果你已经执行了不带 `--no-compile` 的批量导入并感觉卡住，可以先中断命令，然后重新执行：

```bash
node "$AKB" ingest /path/to/my-docs --recursive --no-compile --no-commit
node "$AKB" index --rebuild
```

如果中断前已经打印了 `Ingested N pages.`，说明 Markdown 多半已经写入 `pages/`，只是后续 compile 阶段还在跑。这种情况下通常不需要重新 ingest，直接重建索引即可：

```bash
node "$AKB" index --rebuild
node "$AKB" compile status
```

如果重新 ingest 时提示 `Target page already exists`，也说明页面已经导入过。不要急着加 `--force` 覆盖，先检查 `pages/` 里的文件是否符合预期。

确认页面导入正常后，再用 `compile --source <page-id-or-path>` 或 `compile --all-pending` 分批生成 patch。

## 6. 建立索引并搜索

重建 SQLite FTS5 索引：

```bash
node "$AKB" index --rebuild
```

执行基础搜索：

```bash
node "$AKB" search "deploy rollback"
```

输出会包含：

- `page_id`
- Markdown 路径
- 标题
- snippet
- `line_start` / `line_end` 行号 citation

执行 hybrid search：

```bash
node "$AKB" search "deploy rollback" --hybrid
node "$AKB" search "deploy rollback" --hybrid --format json
```

`--hybrid` 会结合 BM25、本地 sparse vector score 和 confidence-aware rerank。默认搜索会过滤 superseded 页面；如需查看历史页面：

```bash
node "$AKB" search "deploy rollback" --include-superseded
```

## 7. 用 `ask` 进行带引用问答

没有配置 LLM 时，`ask` 会使用 extractive answer，也就是从检索结果中抽取可引用片段：

```bash
node "$AKB" ask "如何回滚生产部署？"
node "$AKB" ask "deploy rollback" --hybrid --format json
```

配置 LLM 后，`ask` 会调用 `.akb/config.yaml` 中指定的 DeepSeek、OpenAI 或 Anthropic 模型生成答案，并要求答案只能引用检索到的 refs。模型如果引用了不存在的 refs，会自动降级为 extractive answer。

```bash
node "$AKB" ask "如何回滚生产部署？" --hybrid
```

`ask` 不是自由聊天命令，它会先检索本地知识库，只有找到 evidence 后才调用 LLM。原始问题没有命中时，会自动从问题中提取英文缩写或关键词重试检索。例如中文问题里包含 `FTL`，但英文文档没有中文词时，`ask` 会先用原问题检索，失败后再用 `FTL` 检索。

人类可读输出会显示：

- 是否使用了 retrieval fallback
- 成功生成时使用的 provider/model
- 没有 evidence 时，明确提示 LLM 没有被调用

API key 配置方式见第 4 节。不要把真实 key 写入配置文件或提交到远端。

## 8. 启用 Confidence Ledger

Confidence Ledger 是每个页面旁边的 append-only JSONL 事件流，用来记录来源、验证、衰减、矛盾、supersede 等事件。

这一步不依赖 LLM。它维护的是知识库的可信度历史：Markdown 页面仍然是事实源，`pages/.<page_id>.ledger.jsonl` 是可信度事件流，`.akb/index.db` 里的 `confidence_events` 和 `confidence_state` 只是可重建的查询投影。

### 8.1 初始化已有页面的 ledger

将现有 vault 迁移到 v0.1 ledger 形态：

```bash
node "$AKB" migrate to-v0.1 --no-commit
```

这个命令会扫描 `pages/*.md`，为还没有 ledger 的页面创建 `pages/.<page_id>.ledger.jsonl`。通常会写入 `source_added` 事件，用页面 frontmatter 里的 `source_path`、`source_hash`、`source_type` 等信息计算初始 source weight；已经有 ledger 的页面会跳过，避免重复写入事件。

命令还会生成或更新 `.akb/migration-report.md`，列出迁移了哪些页面、跳过了多少页面、每页初始化后有多少事件和初始 score。`--no-commit` 表示只改工作区，不自动创建 git commit；确认结果后可以手动提交。

### 8.2 重建 confidence projection

如果你刚迁移完、刚 pull 了别人的 ledger、删除过 `.akb/index.db`，或者想确认投影和 JSONL 事件流一致，就重建 confidence projection：

```bash
node "$AKB" projection rebuild --confidence
```

这个命令从 Markdown 页面和 `pages/.<page_id>.ledger.jsonl` 重新计算 `.akb/index.db` 里的 confidence 表。它不会反向修改 Markdown 或 ledger JSONL。搜索和 MCP 会优先读这个投影来做 confidence-aware rerank；投影缺失时会回退到逐页读取 ledger，但大库会更慢。

如果你想同时重建搜索索引和 confidence 投影，可以使用：

```bash
node "$AKB" projection rebuild --all
```

### 8.3 查看和审计单页 confidence

查看某个页面当前的 confidence：

```bash
node "$AKB" confidence show <page-id-or-path>
```

`<page-id-or-path>` 可以是 `page_xxx`，也可以是 `pages/deploy-runbook.md` 这样的页面路径。输出会包含：

- 当前 score
- source strength、contradiction penalty、time decay、verification boost 等分解项
- 参与计算的事件列表
- `NEEDS_REVIEW`、`STALE`、`SUPERSEDED` 等状态标记

如果需要给脚本或调试工具读取，使用 JSON 输出：

```bash
node "$AKB" confidence show <page-id-or-path> --format json
```

重新回放某个页面的 ledger，确认当前 score 是否能从事件流复算出来：

```bash
node "$AKB" confidence recompute <page-id-or-path> --format json
```

`confidence show` 更适合人工查看；`confidence recompute` 更适合审计和测试，因为它会明确返回 replay 了多少个事件。两者都不会写入文件。

查看按 Markdown header 切分的 section-level confidence：

```bash
node "$AKB" confidence sections <page-id-or-path>
node "$AKB" confidence sections <page-id-or-path> --format json
```

当前 section-level report 不新增独立 ledger 事件，而是继承页面 ledger 的 score/status，并为每个 header section 输出稳定 `section_id`、行号范围和 derived marker 数量。它适合定位“哪个 section 是 LLM compile 派生内容”“哪个 section 需要 review”，同时保持 canonical source 仍然是 Markdown 页面和页面级 ledger。

如果页面 frontmatter 里维护了 `references:`，可以从代码或文档路径反查相关知识页：

```bash
node "$AKB" confidence file src/deploy.ts
```

这个命令会扫描 `pages/*.md` 的 `references:`，列出引用 `src/deploy.ts` 的页面、当前 score，以及 `NEEDS_REVIEW`、`STALE`、`SUPERSEDED` 等状态。路径会按 vault 内相对路径匹配，所以 `src/deploy.ts` 和 `./src/deploy.ts` 会归一化为同一个引用。

需要给脚本读取时使用 JSON，并用 `--events` 带上每个页面的 ledger 事件摘要：

```bash
node "$AKB" confidence file src/deploy.ts --format json --events
```

如果想一次生成所有文件引用的审计报告：

```bash
node "$AKB" confidence report --by-file
```

报告会写入 `.akb/lint/confidence-by-file.md`，按被引用文件分组列出相关页面、score、状态和最近事件时间。这个文件是 lint/report 产物，不需要提交到 git。

### 8.4 记录人工或 agent 验证

记录人工或 agent 验证：

```bash
node "$AKB" verify pages/deploy-runbook.md \
  --by-agent codex \
  --reason "manual demo review" \
  --no-commit
```

`verify` 会向目标页面的 ledger 追加一个 `verified` 事件，并刷新该页在 `.akb/index.db` 里的 confidence projection。默认 actor 是当前本机用户；加 `--by-agent codex` 后会记录为 agent 验证。`--reason` 会进入 ledger，建议写清楚验证依据，例如“人工阅读过部署回滚步骤”或“agent 执行过 runbook smoke test”。

目标可以是 page id、页面路径，也可以是 `pages/runbooks/**` 这样的 glob：

```bash
node "$AKB" verify "pages/runbooks/**" \
  --by-agent codex \
  --reason "runbook review" \
  --no-commit
```

只想找出低 confidence 页面，不想写 ledger 时使用 dry run：

```bash
node "$AKB" verify "pages/**" --dry-run
```

`--dry-run` 会按当前实现使用 `0.70` 作为低 confidence 阈值，只打印需要 review 的页面，不写事件、不刷新投影、不提交。

### 8.5 写入时间衰减 checkpoint

随着时间推移，长期没有被验证或更新的页面 confidence 会自然衰减。`decay` 命令用于把这种衰减固化成稀疏 checkpoint：

```bash
node "$AKB" decay --run --no-commit
```

`--run` 是保护开关，避免误操作时直接写事件。命令会扫描所有已有 ledger 的页面，只在需要记录时写入 `decay_checkpoint`：例如距离上次 decay checkpoint 已经足够久，或 score 跨过了关键阈值。没有达到条件的页面不会产生新事件，避免 ledger 被日常噪音刷屏。

需要复现某个时间点的计算时，可以固定时钟：

```bash
node "$AKB" decay --run --now 2026-05-17T00:00:00.000Z --no-commit
```

### 8.6 执行 runbook / linked tests 产生强 runtime 信号

如果一个页面是可执行 runbook，可以把 shell 代码块作为真实验证来源：

````markdown
```bash
pnpm test
```
````

执行 runbook：

```bash
node "$AKB" runbook exec pages/deploy-runbook.md --no-commit
```

`runbook exec` 会依次执行页面中的 `bash` / `sh` / `shell` / `zsh` fenced code block。所有步骤成功时写入 `verified` 事件，actor id 默认为 `runbook-exec`；任一步骤失败时写入 `contradicted_by`，severity 为 `major`，并返回非 0。

测试也可以显式链接到页面。在测试文件、Markdown 或 YAML 中加入：

```ts
// @akb-page page_deploy000001
```

然后运行：

```bash
node "$AKB" test --link-pages --command "pnpm test" --no-commit
```

命令会扫描 `@akb-page <page_id>` 标注，执行 `--command` 指定的测试命令。测试通过时给关联页面写 `verified`，失败时写 `contradicted_by`。没有显式 `@akb-page` 标注时会拒绝写 ledger，避免把“测试通过”误归因到无关页面。

### 8.7 接收外部 CI/runtime 信号

`webhook` 用来把外部系统的结果转成 ledger 事件。例如 CI 成功可以证明相关页面仍然有效，CI 失败可以说明相关页面可能已经被现实行为反驳。

```bash
node "$AKB" webhook ci-success \
  --changed-file scripts/deploy.sh \
  --evidence https://ci.example/run/123 \
  --no-commit

node "$AKB" webhook ci-failure \
  --changed-file scripts/deploy.sh \
  --evidence https://ci.example/run/124 \
  --no-commit
```

`ci-success` 会写入 `verified` 事件，`ci-failure` 会写入 `contradicted_by` 事件。两者都要求提供 `--evidence` 或 `--pr-number`，并且至少提供一个 `--changed-file` 或 `--changed-files-list`。

注意：`--changed-file` 指的是外部系统变更的文件路径，例如源码、测试或配置文件。`akb` 会查找哪些页面的 frontmatter `references` 包含这个路径，然后只给这些页面写 ledger 事件。例如某个页面可以这样声明自己依赖部署脚本：

```yaml
---
id: page_deploy000001
title: Deploy Runbook
references:
  - scripts/deploy.sh
---
```

如果没有页面引用这个 changed file，命令会报错，而不是随便给所有页面加事件。

如果你把 runtime signal 写成文件，也可以用 watch 处理：

```bash
node "$AKB" watch --once --no-commit
```

`watch --once` 会读取 `.akb/runtime-signals/*.json`，把文件中的信号转成 ledger 事件，然后删除已处理的 signal 文件。每个 signal 文件至少需要包含：

```json
{
  "kind": "ci_success",
  "page_ids": ["page_deploy000001"],
  "actor_id": "ci:github-actions",
  "evidence": "https://ci.example/run/123"
}
```

`kind` 以 `failure`、`failed` 或 `error` 结尾时会写 `contradicted_by`；其他 kind 会写 `verified`。这个文件模式适合没有 webhook 集成的系统：只要能把 JSON 写进 `.akb/runtime-signals/`，就能参与 Confidence Ledger。

## 9. 使用 compile 生成可 review 的 patch

`compile` 用来把新 source 对现有 vault 的影响编译成 patch。它不会直接修改 Markdown，而是生成 `.akb/patches/*.yaml`，等待 review。

推荐工作流是：先用 `ingest --no-compile` 完成批量导入，再从少量重要页面开始手动 compile。这样可以避免第一次导入大目录时长时间等待，也能让 review 范围更小。

查看待 compile 的 source：

```bash
node "$AKB" compile status
```

编译单个页面：

```bash
node "$AKB" compile --source <page-id-or-path>
```

编译所有 pending source：

```bash
node "$AKB" compile --all-pending
```

如果没有设置对应 API key 环境变量，compile 会生成 degraded heuristic patch，并在 `compileMeta.degraded=true` 中记录原因。配置 DeepSeek、OpenAI 或 Anthropic 后，compile 会跑 provider-backed pipeline，并记录 pinned `modelId`、`promptHashes` 和 `resolvedModelId`。

Provider-backed compile 的单次 LLM 请求默认 120 秒超时。`classify` 的 relation 和 `synthesize` 的 patch changes 如果不符合本地 schema，`akb` 会把校验错误反馈给模型并自动重试一次；重试后仍无效、请求超时或 provider 不可用时，才会降级生成 heuristic patch。因此导入成功不依赖每一次 LLM compile 都成功。

`compile --all-pending` 和导入后的批量 compile 会在末尾打印 `Compile summary`。如果 degraded 数量偏高，先看 `Degraded reasons`，它会按原因聚合显示 API key、timeout、classify relation 或 synthesize patch schema 等问题。

查看 patch：

```bash
node "$AKB" patch list
node "$AKB" patch show <patch-id>
```

回放 patch，确认结果可复现：

```bash
node "$AKB" compile replay <patch-id>
```

Provider-backed patch replay 会重新调用对应 provider。如果 replay 降级为 heuristic，命令会失败，而不是静默通过。

## 10. Review 并应用或拒绝 patch

应用 patch：

```bash
node "$AKB" patch apply <patch-id> --no-commit
```

如果 patch 含低置信度或 close-review 变更，需要显式确认：

```bash
node "$AKB" patch apply <patch-id> --reviewed --no-commit
```

拒绝 patch：

```bash
node "$AKB" patch reject <patch-id> --reason "not relevant" --no-commit
```

应用 patch 后，`akb` 会更新 Markdown，并写入相关 confidence/lineage 信息。

## 11. 管理 supersede 关系

当一个页面被新页面取代时，使用 `supersede`：

```bash
node "$AKB" supersede <old-page-id-or-path> \
  --by <new-page-id-or-path> \
  --reason "new source supersedes old design" \
  --no-commit
```

如果旧页面已经有 superseder，默认会拒绝覆盖。确认要替换链路时使用 `--unlink`：

```bash
node "$AKB" supersede <old-page-id-or-path> \
  --by <newer-page-id-or-path> \
  --unlink \
  --reason "replace superseder" \
  --no-commit
```

搜索默认过滤 superseded 页面；需要查看历史页面时加 `--include-superseded`。

## 12. 查看 lineage

查看某个页面或 chunk 的 lineage：

```bash
node "$AKB" lineage <page-or-chunk-id>
```

查看某个 source 影响了哪些页面：

```bash
node "$AKB" lineage --reverse <source-page-or-chunk-id>
```

lineage 用来解释 compile 生成内容来自哪些 source chunk，也用于 replay 和审计。

### 12.1 查看 relation graph projection

`graph` 命令会从当前 Markdown 派生关系图，不维护独立事实源：

```bash
node "$AKB" graph export --format json --output .akb/graph/relations.json
node "$AKB" graph show <page-id-or-path>
```

当前 graph projection 包含三类边：

- `wiki_link`：页面正文中的 `[[wikilink]]`
- `references`：frontmatter `references:` 指向的代码或文档路径
- `supersedes`：frontmatter `supersedes:` 声明的页面替代关系

`.akb/graph/relations.json` 是投影文件，可以随时从 Markdown 重建，不需要提交。

### 12.2 生成静态 Web UI

如果想用浏览器查看当前 vault 快照，可以生成静态 Web UI：

```bash
node "$AKB" web build --output .akb/web
```

生成结果是 `.akb/web/index.html`。这个页面内嵌当前 vault 的页面列表、正文、confidence 状态、section report、patch 摘要、lineage 摘要、eval report 摘要和 relation graph。它是本地 review 产物，可以直接打开，不需要提交到 git。

### 12.3 生成 code intelligence report

如果你的知识库引用了代码文件，或者你想让 agent 先理解代码库的文件结构，可以生成浅层 code intelligence report：

```bash
node "$AKB" code scan src --output .akb/code-intel/report.json
```

这个命令会递归扫描 TypeScript / JavaScript 文件，并生成：

- 文件列表
- 每个文件的行数、import 数、export 数
- 相对 import 关系图，例如 `src/index.ts -> src/format.ts`

`code scan` 是确定性扫描，不调用 LLM，也不需要配置 API key。`.akb/code-intel/report.json` 是本地投影文件，可以交给 agent、人工 review，或作为后续 LLM 反向生成设计文档 / ADR 的输入；默认不需要提交到 git。

## 13. 生成 context pack 给 agent 使用

当你要开启一个 coding agent session，或者想把某个问题相关的知识打包给外部工具时，可以生成 context pack：

```bash
node "$AKB" context pack "garbage collection" --top-k 5
```

默认输出是人工可读摘要。需要给脚本或 agent 读取时使用 JSON：

```bash
node "$AKB" context pack "garbage collection" \
  --top-k 5 \
  --format json \
  --output .akb/context/gc.json
```

Context pack 会包含：

- 检索命中的页面内容和行号 citation
- confidence score、状态标记和最近 ledger 时间
- 页面 frontmatter 中的 `references:`
- 相关 patch 摘要，包括 proposed / applied / rejected patch
- 已应用 compile 内容的 chunk lineage 摘要

`.akb/context/*.json` 是生成物，用来传给 agent 或审计一次 session，不需要提交到 git。

## 14. 配置 MCP 给 coding agent 使用

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
      "cwd": "/path/to/my-akb-vault"
    }
  }
}
```

当前 MCP server 暴露：

- `search_knowledge`
- `get_page`

检索结果包含行号级 citation，并使用 confidence-aware rerank。

## 15. 为自己的知识库添加 eval

编辑 `.akb/eval/golden.yaml`，加入与你知识库相关的问题：

```yaml
version: "1.0"
items:
  - id: deploy_rollback
    query: "how to rollback production deploy"
    must_hit:
      - page_deployrun001
```

运行 eval：

```bash
node "$AKB" eval --set .akb/eval/golden.yaml
```

建议把 golden set 当作知识库质量门禁：每次大规模 ingest、compile 或修改 ranker 后都跑一次。

## 16. 运行团队质量门禁

`gate run` 用于 CI/PR 场景，把几个质量信号串成一个明确的通过/失败出口：

```bash
node "$AKB" gate run \
  --changed-file src/deploy.ts \
  --max-degraded-ratio 0.25
```

如果 CI 已经有 changed files 列表，可以传文件：

```bash
node "$AKB" gate run \
  --changed-files-list .changed-files \
  --eval-set .akb/eval/golden.yaml
```

当前 gate 会检查：

- `akb lint` 的 hard errors，例如 broken wikilink、supersession cycle、unresolved contradiction、CI-gated stale ADR
- changed file 关联页面的 confidence，任何 `NEEDS_REVIEW` / `STALE` / `SUPERSEDED` 或缺 ledger 的页面都会让 gate 失败
- proposed/applied/rejected patch 中 degraded compile 的比例
- 可选 eval golden set 是否有 failure

失败时命令返回非 0，并打印具体失败项，适合直接接到 PR check。

## 17. 运行内置 sample demo

如果你想先看完整样例：

```bash
cd /path/to/ai-knowledge-compiler
pnpm demo
```

`pnpm demo` 会构建工作区、创建临时 vault、导入 `examples/sample-vault/`、编译 pending sources、重建 index、运行 search 和 eval。

当前 sample vault 包含 15 个 Markdown 页面和 5 条 golden queries。通过时会看到类似：

```text
precision@5:  0.20
precision@10: 0.10
recall@5:     1.00
recall@10:    1.00
must-hit pass rate:  5/5 (100%)
```

## 18. 已实现功能总览

当前已经实现并可用于本地知识库的能力：

- `akb init / ingest / index / search / ask / eval`
- SQLite FTS5 BM25 检索
- hybrid search 和 confidence-aware rerank
- 行号级 citation
- Markdown vault + git-backed workflow
- Obsidian 兼容的 Markdown / `[[wikilinks]]`
- Confidence Ledger JSONL 事件流
- confidence projection rebuild / recompute / show / section report / file report
- decay、verify、runbook/test 强 runtime verification、runtime webhook/watch 信号
- supersede 链和 `--unlink`
- DeepSeek / OpenAI / Anthropic-backed `ask`
- DeepSeek / OpenAI / Anthropic-backed compile pipeline
- heuristic fallback
- patch proposal / apply / reject
- compile replay
- chunk lineage / reverse lineage
- context pack
- relation graph projection
- code intelligence report
- static Web UI snapshot
- team quality gate
- MCP stdio / HTTP server
- eval harness 和 search benchmark

## 19. v0.2+ 功能边界

当前 v0.1 已经完成本地闭环。后续版本会在这些方向继续扩展：

- LLM-assisted code intelligence：基于 `code scan` report 反向生成设计文档、ADR 和上下文包
- GraphRAG traversal
- 团队协作工作流：patch reviewer 和多人 review 分派

## 20. 常用验证命令

在项目根目录运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm coverage
pnpm demo
pnpm bench
```

文档改动通常至少跑：

```bash
pnpm lint
pnpm typecheck
```
