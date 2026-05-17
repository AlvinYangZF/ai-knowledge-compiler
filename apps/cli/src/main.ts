#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  buildHeuristicCompilePatch,
  buildCompilePatch as buildProviderCompilePatch,
  type CompilePageInput,
  createCompileJsonProvider,
  type LlmProviderName,
} from "@akb/compile";
import {
  appendConfidenceEvent,
  type ConfidenceEvent,
  ConfidenceProjection,
  type ConfidenceState,
  computeConfidenceState,
  loadConfidenceEvents,
  parseConfidenceEvent,
} from "@akb/confidence";
import type {
  Config,
  Page,
  PageFrontmatter,
  PageId,
  SearchResult,
} from "@akb/core";
import { ConfigSchema, PageFrontmatterSchema, PageIdSchema } from "@akb/core";
import { loadGoldenSet, runEval } from "@akb/eval-harness";
import { commitFiles, initVault } from "@akb/git-store";
import { ensureFrontmatter, parseMarkdown } from "@akb/markdown-engine";
import { serveMcp } from "@akb/mcp-server";
import { type RankConfidenceState, rankSearchResults } from "@akb/ranker";
import { chunkByHeaders, SearchIndex } from "@akb/search-engine";
import { Command, InvalidArgumentError } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

interface IngestOptions {
  tag?: string[];
  force?: boolean;
  includeHidden?: boolean;
  commit?: boolean;
  recursive?: boolean;
  compile?: boolean;
  compileConcurrency?: number;
}

interface IndexOptions {
  rebuild?: boolean;
}

interface SearchOptions {
  topK?: number;
  format?: "text" | "json";
  includeSuperseded?: boolean;
  hybrid?: boolean;
}

interface AskOptions extends SearchOptions {}

interface ContextPackOptions extends SearchOptions {
  output?: string;
  now?: string;
}

interface GraphOptions {
  format?: "text" | "json";
  output?: string;
}

interface RelationGraphNode {
  id: string;
  kind: "page" | "file";
  label: string;
  path?: string;
}

interface RelationGraphEdge {
  from: string;
  to: string;
  relation: "wiki_link" | "references" | "supersedes";
  evidence: string;
}

interface AskCitation {
  ref: number;
  page_id: PageId;
  path: string;
  title: string;
  line_start: number;
  line_end: number;
  flags: string[];
}

interface GeneratedAskAnswer {
  answer: string | null;
  provider: string;
  model: string;
  noAnswer?: boolean;
}

interface EvalOptions {
  set?: string;
  output?: string;
}

interface EvalCompileOptions {
  set?: string;
  output?: string;
  baseline?: string;
  maxRelationRegression?: number;
}

interface CompileGoldenItem {
  id: string;
  description?: string;
  setup: {
    existingPages: string[];
    newSource: string;
  };
  expect: {
    relations: Array<{
      againstPage?: string;
      relation?: string;
      relationIn?: string[];
    }>;
    mustCreatePage?: boolean;
    mustNotCreatePage?: boolean;
    mustNotDeleteContent?: boolean;
  };
}

interface CompileEvalFailure {
  id: string;
  source: string;
  againstPage?: string;
  expectedRelation: string | string[];
  actualRelation?: string;
  actualTargetPage?: string;
  kind:
    | "relation"
    | "target"
    | "create_page"
    | "delete_content"
    | "lineage"
    | "relation_regression";
}

interface VerifyOptions {
  byAgent?: string;
  reason?: string;
  dryRun?: boolean;
  commit?: boolean;
}

interface SupersedeOptions {
  by: string;
  reason?: string;
  unlink?: boolean;
  commit?: boolean;
}

interface MigrateOptions {
  commit?: boolean;
}

interface ConfidenceShowOptions {
  format?: "text" | "json";
  now?: string;
}

interface ConfidenceRecomputeOptions extends ConfidenceShowOptions {}

interface ConfidenceFileOptions extends ConfidenceShowOptions {
  events?: boolean;
}

interface ConfidenceSectionsOptions extends ConfidenceShowOptions {}

interface ConfidenceReportOptions {
  byFile?: boolean;
  now?: string;
}

interface ConfidenceFilePageSummary {
  page_id: PageId;
  path: string;
  title: string;
  score: number | null;
  source_count: number;
  contradiction_count: number;
  superseded_by?: PageId;
  last_verified_at?: string;
  last_event_at?: string;
  computed_at: string;
  status: { flags: string[]; reasons: string[] };
  events?: ReturnType<typeof summarizeConfidenceEvent>[];
}

interface ConfidenceByFileEntry {
  file: string;
  pages: ConfidenceFilePageSummary[];
}

interface MarkdownSection {
  section_id: string;
  heading: string;
  level: number;
  line_start: number;
  line_end: number;
  content: string;
}

interface ProjectionRebuildOptions {
  confidence?: boolean;
  all?: boolean;
}

interface LintOptions {
  now?: string;
}

interface LintReport {
  lowConfidence: Array<{ page: Page; score: number }>;
  stale: Array<{ page: Page; lastVerifiedAt: string; ciGate: boolean }>;
  unresolvedContradictions: Array<{
    page: Page;
    contradictionCount: number;
  }>;
  orphanPages: Page[];
  highDerivedRatio: Array<{
    page: Page;
    derivedChunks: number;
    totalChunks: number;
    ratio: number;
  }>;
  orphanedLineage: Array<{ page: Page; chunkId: string; source: string }>;
  brokenWikiLinks: Array<{ page: Page; target: string }>;
  supersessionCycles: PageId[][];
}

interface DecayOptions {
  run?: boolean;
  now?: string;
  commit?: boolean;
}

interface WebhookCiSuccessOptions {
  actorId?: string;
  changedFile?: string[];
  changedFilesList?: string;
  evidence?: string;
  prNumber?: string;
  commit?: boolean;
}

interface WatchOptions {
  once?: boolean;
  commit?: boolean;
}

interface RunbookExecOptions {
  actorId?: string;
  now?: string;
  commit?: boolean;
}

interface LinkedTestOptions {
  linkPages?: boolean;
  command?: string;
  actorId?: string;
  evidence?: string;
  now?: string;
  commit?: boolean;
}

interface CompileOptions {
  source?: string;
  allPending?: boolean;
  dryRun?: boolean;
  model?: string;
}

interface CompileRunSummary {
  total: number;
  providerSuccess: number;
  degraded: number;
  dryRuns: number;
  byProvider: Map<string, number>;
  degradedReasons: Map<string, number>;
}

interface PatchApplyOptions {
  commit?: boolean;
  reviewed?: boolean;
}

interface PatchRejectOptions {
  reason?: string;
  commit?: boolean;
}

interface PatchDocument {
  id: string;
  status: "proposed" | "applied" | "rejected";
  source?: { sourceId?: string; pageId?: string; ingestPath?: string };
  compileMeta?: Record<string, unknown>;
  rejectReason?: string;
  rejectedAt?: string;
  changes?: PatchChange[];
  lineage?: {
    units?: Array<{
      id: string;
      sourcePageId?: string;
      sourceChunkIds?: string[];
      kind?: string;
    }>;
    derivedChunks?: Array<Record<string, unknown>>;
  };
}

type PatchChange =
  | {
      type: "modify";
      pageId: string;
      operation: "append_section" | "replace_section" | "insert_after_section";
      targetSection?: string;
      relation: string;
      classifyConfidence: number;
      reasoning: string;
      needsCloseReview?: boolean;
      content: string;
      confidenceImpact?: Record<string, unknown>;
    }
  | {
      type: "confidence_only";
      pageId: string;
      relation: "duplicate";
      confidenceImpact: Record<string, unknown>;
    }
  | {
      type: "create";
      newPageId: string;
      path?: string;
      relation: "new" | "supersede";
      classifyConfidence: number;
      reasoning: string;
      needsCloseReview?: boolean;
      supersedes?: string;
      content: string;
      confidenceImpact?: Record<string, unknown>;
    };

let currentArgv = process.argv;

export async function run(argv = process.argv): Promise<void> {
  currentArgv = argv;
  const program = new Command();
  program
    .name("akb")
    .description("AI-native knowledge compiler")
    .version("0.0.1");
  program.command("init").argument("<name>").action(initCommand);
  program
    .command("ingest")
    .argument("<path>")
    .option("--tag <tag>", "add a tag to imported pages", collect, [])
    .option("--force", "overwrite existing page file")
    .option(
      "--include-hidden",
      "include hidden files and directories, importing them as non-hidden paths",
    )
    .option("--compile", "compile imported pages into reviewable patches")
    .option("--no-compile", "skip compile after ingest")
    .option(
      "--compile-concurrency <n>",
      "number of imported pages to compile in parallel",
      parsePositiveInt,
      1,
    )
    .option("--no-commit", "skip git commit")
    .option("--recursive", "recursively ingest markdown files from directories")
    .option(
      "--no-recursive",
      "only ingest top-level markdown files from directories",
    )
    .action(ingestCommand);
  program
    .command("index")
    .option("--rebuild", "rebuild the full index")
    .action(indexCommand);
  program
    .command("search")
    .argument("<query>")
    .option("--top-k <n>", "number of results", parsePositiveInt, 5)
    .option("--hybrid", "combine BM25 with local sparse vector scores")
    .option("--format <format>", "text or json", parseFormat, "text")
    .option("--include-superseded", "include historical superseded pages")
    .action(searchCommand);
  program
    .command("ask")
    .argument("<question>")
    .option("--top-k <n>", "number of cited results", parsePositiveInt, 5)
    .option("--hybrid", "combine BM25 with local sparse vector scores")
    .option("--format <format>", "text or json", parseFormat, "text")
    .option("--include-superseded", "include historical superseded pages")
    .action(askCommand);
  const context = program.command("context");
  context
    .command("pack")
    .argument("<query>")
    .option("--top-k <n>", "number of pages to include", parsePositiveInt, 5)
    .option("--hybrid", "combine BM25 with local sparse vector scores")
    .option("--format <format>", "text or json", parseFormat, "text")
    .option("--include-superseded", "include historical superseded pages")
    .option("--output <path>", "write context pack JSON to a file")
    .option("--now <timestamp>", "clock timestamp for deterministic output")
    .action(contextPackCommand);
  const graph = program.command("graph");
  graph
    .command("export")
    .option("--format <format>", "text or json", parseFormat, "text")
    .option("--output <path>", "write relation graph JSON to a file")
    .action(graphExportCommand);
  graph
    .command("show")
    .argument("<page-id-or-path-or-file>")
    .option("--format <format>", "text or json", parseFormat, "text")
    .action(graphShowCommand);
  const evalCmd = program
    .command("eval")
    .option("--set <path>", "golden set path")
    .option("--output <path>", "write JSON report")
    .action(evalCommand);
  evalCmd
    .command("compile")
    .option("--set <path>", "compile golden set path")
    .option("--output <path>", "write JSON report")
    .option("--baseline <path>", "previous compile eval JSON report")
    .option(
      "--max-relation-regression <ratio>",
      "maximum allowed relation accuracy regression",
      parseRatio,
      0.08,
    )
    .action(evalCompileCommand);
  program
    .command("lint")
    .option("--now <timestamp>", "clock timestamp for deterministic lint")
    .action(lintCommand);
  program
    .command("decay")
    .option("--run", "write sparse decay checkpoints")
    .option("--now <timestamp>", "clock timestamp for deterministic runs")
    .option("--no-commit", "skip git commit")
    .action(decayCommand);
  const runbook = program.command("runbook");
  runbook
    .command("exec")
    .argument("<page-id-or-path>")
    .option("--actor-id <id>", "runtime actor id", "runbook-exec")
    .option("--now <timestamp>", "clock timestamp for deterministic output")
    .option("--no-commit", "skip git commit")
    .action(runbookExecCommand);
  program
    .command("test")
    .option("--link-pages", "link test result to @akb-page annotations")
    .option("--command <command>", "test command to execute", "pnpm test")
    .option("--actor-id <id>", "runtime actor id", "test:integration")
    .option("--evidence <value>", "external evidence URL or id")
    .option("--now <timestamp>", "clock timestamp for deterministic output")
    .option("--no-commit", "skip git commit")
    .action(linkedTestCommand);
  const webhook = program.command("webhook");
  webhook
    .command("ci-success")
    .option("--actor-id <id>", "external actor id")
    .option("--changed-file <path>", "changed file path", collect, [])
    .option("--changed-files-list <path>", "file containing changed paths")
    .option("--evidence <value>", "external evidence URL or id")
    .option("--pr-number <number>", "pull request number for CI evidence")
    .option("--no-commit", "skip git commit")
    .action(webhookCiSuccessCommand);
  webhook
    .command("ci-failure")
    .option("--actor-id <id>", "external actor id")
    .option("--changed-file <path>", "changed file path", collect, [])
    .option("--changed-files-list <path>", "file containing changed paths")
    .option("--evidence <value>", "external evidence URL or id")
    .option("--pr-number <number>", "pull request number for CI evidence")
    .option("--no-commit", "skip git commit")
    .action(webhookCiFailureCommand);
  program
    .command("watch")
    .option("--once", "process runtime signal files once and exit")
    .option("--no-commit", "skip git commit")
    .action(watchCommand);
  program
    .command("verify")
    .argument("<page-or-glob>")
    .option("--by-agent <id>", "record verification from an agent")
    .option("--reason <reason>", "human-readable verification reason")
    .option("--dry-run", "report low-confidence pages without writing events")
    .option("--no-commit", "skip git commit")
    .action(verifyCommand);
  program
    .command("supersede")
    .argument("<old-page-id-or-path>")
    .requiredOption(
      "--by <new-page-id-or-path>",
      "page that supersedes the old page",
    )
    .option("--reason <reason>", "human-readable supersession reason")
    .option("--unlink", "allow replacing an existing supersession link")
    .option("--no-commit", "skip git commit")
    .action(supersedeCommand);
  const migrate = program.command("migrate");
  migrate
    .command("to-v0.1")
    .option("--no-commit", "skip git commit")
    .action(migrateToV01Command);
  const confidence = program.command("confidence");
  confidence
    .command("show")
    .argument("<page-id-or-path>")
    .option("--format <format>", "text or json", parseFormat, "text")
    .option("--now <timestamp>", "clock timestamp for deterministic output")
    .action(confidenceShowCommand);
  confidence
    .command("recompute")
    .argument("<page-id-or-path>")
    .option("--format <format>", "text or json", parseFormat, "text")
    .option("--now <timestamp>", "clock timestamp for deterministic replay")
    .action(confidenceRecomputeCommand);
  confidence
    .command("file")
    .argument("<path>")
    .option("--format <format>", "text or json", parseFormat, "text")
    .option("--events", "include confidence ledger events in JSON output")
    .option("--now <timestamp>", "clock timestamp for deterministic output")
    .action(confidenceFileCommand);
  confidence
    .command("sections")
    .argument("<page-id-or-path>")
    .option("--format <format>", "text or json", parseFormat, "text")
    .option("--now <timestamp>", "clock timestamp for deterministic output")
    .action(confidenceSectionsCommand);
  confidence
    .command("report")
    .option("--by-file", "write confidence report grouped by referenced file")
    .option("--now <timestamp>", "clock timestamp for deterministic output")
    .action(confidenceReportCommand);
  const projection = program.command("projection");
  projection
    .command("rebuild")
    .option("--confidence", "rebuild confidence ledger projection")
    .option("--all", "rebuild all supported projections")
    .action(projectionRebuildCommand);
  const compile = program.command("compile");
  compile
    .option("--source <page-id-or-path>", "source page to compile")
    .option("--all-pending", "compile all sources without existing patches")
    .option("--dry-run", "show candidate changes without writing a patch")
    .option("--model <model>", "compile model id")
    .action(compileCommand);
  compile.command("status").action(compileStatusCommand);
  compile.command("replay").argument("<patch-id>").action(compileReplayCommand);
  const patch = program.command("patch");
  patch.command("list").action(patchListCommand);
  patch.command("show").argument("<patch-id>").action(patchShowCommand);
  patch
    .command("apply")
    .argument("<patch-id>")
    .option("--reviewed", "confirm close review for low-confidence changes")
    .option("--no-commit", "skip git commit")
    .action(patchApplyCommand);
  patch
    .command("reject")
    .argument("<patch-id>")
    .option("--reason <reason>", "human-readable rejection reason")
    .option("--no-commit", "skip git commit")
    .action(patchRejectCommand);
  program
    .command("lineage")
    .argument("[chunk-or-page]")
    .option("--reverse <source-id>", "show pages influenced by source")
    .action(lineageCommand);
  const mcp = program.command("mcp");
  mcp
    .command("serve")
    .option("--transport <transport>", "stdio or http", "stdio")
    .option("--port <port>", "HTTP port", parsePositiveInt, 8765)
    .action(async (opts: { transport: "stdio" | "http"; port: number }) => {
      await serveMcp({
        cwd: process.cwd(),
        transport: opts.transport,
        port: opts.port,
      });
    });
  await program.parseAsync(argv);
}

async function initCommand(name: string): Promise<void> {
  const vaultDir = resolve(process.cwd(), name);
  if (existsSync(vaultDir) && readdirSync(vaultDir).length > 0) {
    throw new Error(`Target directory is not empty: ${vaultDir}`);
  }

  mkdirSync(join(vaultDir, ".akb", "eval"), { recursive: true });
  mkdirSync(join(vaultDir, ".akb", "patches", "applied"), { recursive: true });
  mkdirSync(join(vaultDir, ".akb", "patches", "rejected"), {
    recursive: true,
  });
  mkdirSync(join(vaultDir, "pages"), { recursive: true });
  writeFileSync(join(vaultDir, "pages", ".gitkeep"), "");
  writeFileSync(
    join(vaultDir, ".gitignore"),
    ".akb/index.db\n.akb/index.db-*\n.akb/lint/\n",
  );
  writeFileSync(
    join(vaultDir, "README.md"),
    [`# ${basename(vaultDir)}`, "", "This is an akb markdown vault.", ""].join(
      "\n",
    ),
  );
  writeFileSync(
    join(vaultDir, ".akb", "config.yaml"),
    stringifyYaml(
      ConfigSchema.parse({
        version: "0.0",
        workspace: { name: basename(vaultDir), vault_dir: "." },
        index: { engine: "sqlite-fts5", path: ".akb/index.db" },
        mcp: { host: "127.0.0.1", port: 8765 },
      }),
    ),
  );
  writeFileSync(
    join(vaultDir, ".akb", "eval", "golden.yaml"),
    'version: "1.0"\nitems: []\n',
  );
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  index.close();
  await initVault(vaultDir);
  console.log(`Initialized vault at ${vaultDir}`);
}

async function ingestCommand(
  inputPath: string,
  options: IngestOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const source = resolve(vaultDir, inputPath);
  const recursive = options.recursive ?? true;
  const hiddenEntries = hiddenEntriesForIngest(source, recursive);
  const includeHidden = await shouldIncludeHiddenEntries(
    hiddenEntries,
    options.includeHidden === true,
  );
  const files = markdownFilesForIngest(source, recursive, includeHidden);
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  const existingPagePathsById = pagePathByIdMap(vaultDir);
  const written: string[] = [];
  const removed: string[] = [];
  const sourceIsDirectory = statSync(source).isDirectory();

  console.log(
    `Found ${files.length} markdown file${files.length === 1 ? "" : "s"} to ingest.`,
  );
  try {
    for (const [fileIndex, file] of files.entries()) {
      const relativeSource = sourceIsDirectory
        ? relative(source, file)
        : basename(file);
      console.log(
        ingestProgressLine(fileIndex + 1, files.length, relativeSource),
      );
      const targetSource = includeHidden
        ? nonHiddenRelativePath(relativeSource)
        : relativeSource;
      const targetRelative = toPosix(join("pages", targetSource));
      const target = join(vaultDir, targetRelative);
      if (existsSync(target) && !options.force) {
        throw new Error(
          `Target page already exists: ${targetRelative}. Use --force to overwrite.`,
        );
      }
      const raw = readUtf8File(file);
      if (raw === undefined || raw.trim().length === 0) {
        console.warn(`Skipping unreadable or empty markdown file: ${file}`);
        continue;
      }
      const finalContent = ensureFrontmatter(
        raw,
        {},
        { tags: options.tag, sourcePath: inputPath },
      );
      const imported = parseMarkdown(finalContent);
      const importedId = String(imported.frontmatter.id) as PageId;
      const existingPath = existingPagePathsById.get(importedId);
      if (existingPath && resolve(existingPath) !== resolve(target)) {
        if (!options.force) {
          throw new Error(
            `Page id already exists in ${toPosix(relative(vaultDir, existingPath))}: ${importedId}. Use --force to replace it.`,
          );
        }
        rmSync(existingPath, { force: true });
        index.deletePage(importedId);
        existingPagePathsById.delete(importedId);
        removed.push(toPosix(relative(vaultDir, existingPath)));
      }
      const replacedPageId = existsSync(target)
        ? pageFromFile(vaultDir, target).page.id
        : undefined;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, finalContent);
      const { page, body, bodyStartLine } = pageFromFile(vaultDir, target);
      if (replacedPageId && replacedPageId !== page.id) {
        index.deletePage(replacedPageId);
        existingPagePathsById.delete(replacedPageId);
      }
      index.upsertPage(page, body, { bodyStartLine });
      existingPagePathsById.set(page.id, target);
      written.push(targetRelative);
    }
  } finally {
    index.close();
  }

  const metadataFiles =
    options.compile === false ? recordCompileDisabled(vaultDir, written) : [];

  if (written.length > 0 && options.commit !== false) {
    await commitFiles(
      vaultDir,
      [...written, ...removed, ...metadataFiles],
      `ingest ${written.length === 1 ? basename(written[0]) : `${written.length} pages`}`,
    );
  }
  console.log(
    `Ingested ${written.length} page${written.length === 1 ? "" : "s"}.`,
  );
  if (options.compile !== false) {
    await compileImportedPages(written, options.compileConcurrency ?? 1);
  }
}

async function compileImportedPages(
  sources: string[],
  concurrency: number,
): Promise<void> {
  if (sources.length === 0) {
    return;
  }
  const workerCount = Math.max(1, Math.min(concurrency, sources.length));
  if (workerCount > 1) {
    console.log(
      `Compiling ${sources.length} imported page${sources.length === 1 ? "" : "s"} with concurrency ${workerCount}.`,
    );
  }
  const vaultDir = process.cwd();
  const config = readVaultConfig(vaultDir);
  const summary = emptyCompileRunSummary();
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < sources.length) {
        const source = sources[nextIndex];
        nextIndex += 1;
        const patch = await compileOneSource(vaultDir, config, source, {});
        recordCompileSummary(summary, patch, false);
      }
    }),
  );
  printCompileSummary(summary);
}

async function indexCommand(options: IndexOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  const pages = scanVaultPages(vaultDir);
  const start = performance.now();

  try {
    if (options.rebuild) {
      const result = index.rebuild(pages);
      console.log(
        `Indexed ${result.totalPages} pages (${result.inserted} inserted, 0 updated, 0 deleted, 0 unchanged) in ${result.elapsedMs}ms`,
      );
      return;
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const item of pages) {
      const result = index.upsertPage(item.page, item.body, {
        bodyStartLine: item.bodyStartLine,
      });
      if (result.action === "inserted") {
        inserted += 1;
      } else if (result.action === "updated") {
        updated += 1;
      } else {
        unchanged += 1;
      }
    }

    const existing = new Set(index.listIndexedPageIds().map(String));
    const present = new Set(pages.map((item) => String(item.page.id)));
    let deleted = 0;
    for (const pageId of existing) {
      if (!present.has(pageId)) {
        index.deletePage(pageId as PageId);
        deleted += 1;
      }
    }

    console.log(
      `Indexed ${pages.length} pages (${inserted} inserted, ${updated} updated, ${deleted} deleted, ${unchanged} unchanged) in ${Math.round(
        performance.now() - start,
      )}ms`,
    );
  } finally {
    index.close();
  }
}

async function searchCommand(
  query: string,
  options: SearchOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const start = performance.now();
  const results = rankedResultsForQuery(vaultDir, query, options);
  const elapsedMs = Math.round(performance.now() - start);
  if (options.format === "json") {
    console.log(
      JSON.stringify(
        {
          query,
          retrieval_mode: options.hybrid ? "hybrid" : "bm25",
          results,
          elapsed_ms: elapsedMs,
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const [offset, result] of results.entries()) {
    const flags =
      result.flags.length > 0 ? ` flags=${result.flags.join(",")}` : "";
    console.log(
      `[${offset + 1}] ${result.page_id}  ${result.path}  L${result.citation.line_start}-L${result.citation.line_end}  score=${result.final_score.toFixed(2)} ${options.hybrid ? "hybrid" : "bm25"}=${result.score.toFixed(2)}${flags}`,
    );
    console.log(`    ${result.title}`);
    console.log(`    > ${result.snippet.replace(/\s+/g, " ")}`);
    console.log("");
  }
  console.log(`${results.length} results in ${elapsedMs}ms.`);
}

function rankedResultsForQuery(
  vaultDir: string,
  query: string,
  options: SearchOptions,
): ReturnType<typeof rankSearchResults> {
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  try {
    const topK = options.topK ?? 5;
    const rawResults = options.hybrid
      ? index.hybridSearch(query, { topK: Math.max(topK * 10, 50) })
      : index.search(query, { topK: Math.max(topK * 10, 50) });
    return rankSearchResults({
      rawResults,
      confidenceState: rankConfidenceStateForResults(vaultDir, rawResults),
      options: { includeSuperseded: options.includeSuperseded === true },
    }).slice(0, topK);
  } finally {
    index.close();
  }
}

function rankedAskResultsForQuery(
  vaultDir: string,
  question: string,
  options: AskOptions,
): {
  results: ReturnType<typeof rankSearchResults>;
  query: string;
  fallback: boolean;
} {
  const results = rankedResultsForQuery(vaultDir, question, options);
  if (results.length > 0) {
    return { results, query: question, fallback: false };
  }
  for (const fallbackQuery of askRetrievalFallbackQueries(question)) {
    const fallbackResults = rankedResultsForQuery(
      vaultDir,
      fallbackQuery,
      options,
    );
    if (fallbackResults.length > 0) {
      return { results: fallbackResults, query: fallbackQuery, fallback: true };
    }
  }
  return { results: [], query: question, fallback: false };
}

async function contextPackCommand(
  query: string,
  options: ContextPackOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const now = parseOptionalNow(options.now) ?? new Date();
  const pack = buildContextPack(vaultDir, query, options, now);

  if (options.output) {
    const outputPath = resolve(vaultDir, options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(pack, null, 2)}\n`);
    const relativeOutput = toPosix(relative(vaultDir, outputPath));
    console.log(
      `Wrote context pack ${relativeOutput} with ${pack.pages.length} page${pack.pages.length === 1 ? "" : "s"}.`,
    );
    return;
  }

  if (options.format === "json") {
    console.log(JSON.stringify(pack, null, 2));
    return;
  }

  printContextPack(pack);
}

function buildContextPack(
  vaultDir: string,
  query: string,
  options: ContextPackOptions,
  now: Date,
) {
  const results = rankedResultsForQuery(vaultDir, query, options);
  const patches = loadAllPatches(vaultDir);
  return {
    schema_version: "context-pack/0.1",
    query,
    retrieval_mode: options.hybrid ? "hybrid" : "bm25",
    generated_at: now.toISOString(),
    pages: results.map((result, index) =>
      contextPackPage(vaultDir, result, index + 1, now, patches),
    ),
  };
}

function contextPackPage(
  vaultDir: string,
  result: ReturnType<typeof rankSearchResults>[number],
  ref: number,
  now: Date,
  patches: PatchDocument[],
) {
  const file = resolvePageFile(vaultDir, result.page_id);
  if (!file) {
    throw new Error(`Indexed page not found: ${result.page_id}`);
  }
  const { page, body, bodyStartLine } = pageFromFile(vaultDir, file);
  return {
    ref,
    page_id: page.id,
    path: page.path,
    title: page.title,
    citation: result.citation,
    retrieval: {
      score: result.score,
      final_score: result.final_score,
      component_scores: result.component_scores,
      flags: result.flags,
    },
    confidence: confidenceSummaryForPage(vaultDir, page, now, false),
    content: body.trimEnd(),
    body_start_line: bodyStartLine,
    references: pageFileReferences(page),
    patches: contextPatchSummariesForPage(patches, page.id),
    lineage: contextLineageForPage(vaultDir, page.id),
  };
}

function printContextPack(pack: ReturnType<typeof buildContextPack>): void {
  console.log(`Context pack: ${pack.query}`);
  console.log(`  generated at: ${pack.generated_at}`);
  console.log(`  retrieval: ${pack.retrieval_mode}`);
  console.log(`  pages: ${pack.pages.length}`);
  for (const page of pack.pages) {
    console.log(
      `[${page.ref}] ${page.page_id} ${page.path} L${page.citation.line_start}-L${page.citation.line_end}`,
    );
    console.log(
      `    confidence: ${page.confidence.score === null ? "missing" : page.confidence.score.toFixed(4)} ${page.confidence.status.flags.join(", ") || "OK"}`,
    );
    console.log(`    patches: ${page.patches.length}`);
    console.log(`    lineage: ${page.lineage.length}`);
  }
}

function contextPatchSummariesForPage(
  patches: PatchDocument[],
  pageId: PageId,
) {
  return patches
    .filter((patch) => patchTouchesPage(patch, pageId))
    .map((patch) => ({
      id: patch.id,
      status: patch.status,
      source_page_id: patch.source?.pageId,
      provider:
        typeof patch.compileMeta?.provider === "string"
          ? patch.compileMeta.provider
          : undefined,
      model_id:
        typeof patch.compileMeta?.modelId === "string"
          ? patch.compileMeta.modelId
          : undefined,
      degraded: patch.compileMeta?.degraded === true,
      degraded_reason:
        typeof patch.compileMeta?.degradedReason === "string"
          ? patch.compileMeta.degradedReason
          : undefined,
      changes: (patch.changes ?? []).map(contextPatchChangeSummary),
    }));
}

function patchTouchesPage(patch: PatchDocument, pageId: PageId): boolean {
  if (patch.source?.pageId === pageId) {
    return true;
  }
  if (
    (patch.lineage?.units ?? []).some((unit) => unit.sourcePageId === pageId)
  ) {
    return true;
  }
  return (patch.changes ?? []).some((change) => {
    if (change.type === "modify" || change.type === "confidence_only") {
      return change.pageId === pageId;
    }
    return change.newPageId === pageId || change.supersedes === pageId;
  });
}

function contextPatchChangeSummary(change: PatchChange) {
  if (change.type === "create") {
    return {
      type: change.type,
      relation: change.relation,
      new_page_id: change.newPageId,
      path: change.path,
      classify_confidence: change.classifyConfidence,
      needs_close_review: change.needsCloseReview === true,
      supersedes: change.supersedes,
    };
  }
  if (change.type === "confidence_only") {
    return {
      type: change.type,
      relation: change.relation,
      page_id: change.pageId,
    };
  }
  return {
    type: change.type,
    relation: change.relation,
    page_id: change.pageId,
    operation: change.operation,
    target_section: change.targetSection,
    classify_confidence: change.classifyConfidence,
    needs_close_review: change.needsCloseReview === true,
  };
}

function contextLineageForPage(vaultDir: string, pageId: PageId) {
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  try {
    return index.getChunksForPage(pageId).flatMap((chunk) =>
      index.getChunkLineage(chunk.id).map((row) => ({
        chunk_id: row.chunkId,
        method: row.method,
        source_chunk_id: row.sourceChunkId,
        source_unit_id: row.sourceUnitId,
        patch_id: row.patchId,
        model_id: row.modelId,
        compiled_at: row.compiledAt,
      })),
    );
  } finally {
    index.close();
  }
}

async function graphExportCommand(options: GraphOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const graph = buildRelationGraph(vaultDir);
  if (options.output) {
    const outputPath = resolve(vaultDir, options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(graph, null, 2)}\n`);
    const relativeOutput = toPosix(relative(vaultDir, outputPath));
    console.log(
      `Wrote relation graph ${relativeOutput} with ${graph.nodes.length} nodes and ${graph.edges.length} edges.`,
    );
    return;
  }
  if (options.format === "json") {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }
  console.log(
    `Relation graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges.`,
  );
}

async function graphShowCommand(
  target: string,
  options: GraphOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const graph = buildRelationGraph(vaultDir);
  const nodeId = resolveGraphNodeId(vaultDir, target, graph);
  if (!graph.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`Graph node not found: ${target}`);
  }
  const report = {
    node: graph.nodes.find((node) => node.id === nodeId),
    outgoing: graph.edges.filter((edge) => edge.from === nodeId),
    incoming: graph.edges.filter((edge) => edge.to === nodeId),
  };
  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Relation graph for ${nodeId}`);
  console.log("Outgoing:");
  if (report.outgoing.length === 0) {
    console.log("  none");
  }
  for (const edge of report.outgoing) {
    console.log(`  out ${edge.relation} -> ${edge.to}`);
  }
  console.log("Incoming:");
  if (report.incoming.length === 0) {
    console.log("  none");
  }
  for (const edge of report.incoming) {
    console.log(`  in ${edge.relation} <- ${edge.from}`);
  }
}

function buildRelationGraph(vaultDir: string): {
  schema_version: "relation-graph/0.1";
  nodes: RelationGraphNode[];
  edges: RelationGraphEdge[];
} {
  const pages = scanVaultPages(vaultDir);
  const pageTargetIds = pageTargetLookup(pages.map((item) => item.page));
  const nodes = new Map<string, RelationGraphNode>();
  const edges = new Map<string, RelationGraphEdge>();
  for (const item of pages) {
    nodes.set(item.page.id, {
      id: item.page.id,
      kind: "page",
      label: item.page.title,
      path: item.page.path,
    });
  }
  const addEdge = (edge: RelationGraphEdge) => {
    edges.set(`${edge.from}\0${edge.relation}\0${edge.to}`, edge);
  };
  for (const item of pages) {
    for (const link of extractWikiLinks(item.body)) {
      const targetPageId = pageTargetIds.get(normalizeWikiTarget(link));
      if (targetPageId) {
        addEdge({
          from: item.page.id,
          to: targetPageId,
          relation: "wiki_link",
          evidence: link,
        });
      }
    }
    for (const reference of pageFileReferences(item.page)) {
      const fileNodeId = `file:${reference}`;
      nodes.set(fileNodeId, {
        id: fileNodeId,
        kind: "file",
        label: reference,
        path: reference,
      });
      addEdge({
        from: item.page.id,
        to: fileNodeId,
        relation: "references",
        evidence: reference,
      });
    }
    const supersedes = item.page.frontmatter.supersedes;
    if (typeof supersedes === "string" && nodes.has(supersedes)) {
      addEdge({
        from: item.page.id,
        to: supersedes,
        relation: "supersedes",
        evidence: supersedes,
      });
    }
  }
  return {
    schema_version: "relation-graph/0.1",
    nodes: [...nodes.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    edges: [...edges.values()].sort((left, right) =>
      `${left.from}:${left.relation}:${left.to}`.localeCompare(
        `${right.from}:${right.relation}:${right.to}`,
      ),
    ),
  };
}

function resolveGraphNodeId(
  vaultDir: string,
  target: string,
  graph: ReturnType<typeof buildRelationGraph>,
): string {
  if (target.startsWith("file:")) {
    return target;
  }
  const pageFile = resolvePageFile(vaultDir, target);
  if (pageFile) {
    return pageFromFile(vaultDir, pageFile).page.id;
  }
  const fileNode = `file:${normalizeReferencePath(target)}`;
  if (graph.nodes.some((node) => node.id === fileNode)) {
    return fileNode;
  }
  return target;
}

function askRetrievalFallbackQueries(question: string): string[] {
  const seen = new Set<string>();
  const tokens = [...question.matchAll(/[A-Za-z][A-Za-z0-9_+#-]*/g)]
    .map((match) => match[0])
    .filter((token) => token.length >= 2);
  const acronymTokens = tokens.filter((token) => /[A-Z]/.test(token));
  const otherTokens = tokens.filter((token) => !/[A-Z]/.test(token));
  return [...acronymTokens, ...otherTokens]
    .map((token) => token.trim())
    .filter((token) => {
      const key = token.toLowerCase();
      if (seen.has(key) || token === question) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

async function askCommand(
  question: string,
  options: AskOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const start = performance.now();
  const config = readVaultConfig(vaultDir);
  const retrieval = rankedAskResultsForQuery(vaultDir, question, options);
  const results = retrieval.results;
  const noEvidence = results.length === 0;
  const citations = results.map((result, index) => ({
    ref: index + 1,
    page_id: result.page_id,
    path: result.path,
    title: result.title,
    line_start: result.citation.line_start,
    line_end: result.citation.line_end,
    flags: result.flags,
  }));
  let generated: GeneratedAskAnswer | undefined;
  let degradedReason: string | undefined = noEvidence
    ? `No indexed knowledge matched: ${question}`
    : undefined;
  if (!noEvidence) {
    try {
      generated = await generateAskAnswer(question, results, citations, config);
    } catch (error) {
      degradedReason = askDegradedReason(error, config.llm);
    }
  }
  const answer = noEvidence
    ? null
    : generated
      ? generated.answer
      : extractiveAnswer(results);
  const payload = {
    question,
    answer,
    citations,
    no_evidence: noEvidence,
    answer_no_evidence: generated?.noAnswer === true,
    retrieval_query: retrieval.query,
    retrieval_fallback: retrieval.fallback,
    retrieval_mode: options.hybrid ? "hybrid" : "bm25",
    degraded: generated === undefined,
    degraded_reason: generated === undefined ? degradedReason : undefined,
    answer_provider: generated?.provider,
    answer_model: generated?.model,
    elapsed_ms: Math.round(performance.now() - start),
  };
  if (options.format === "json") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (retrieval.fallback) {
    console.log(
      `Retrieval fallback: used "${retrieval.query}" after no results for the original question.`,
    );
  }
  console.log(askOutputHeading(noEvidence, generated));
  if (noEvidence) {
    console.log("LLM not called: no indexed evidence matched.");
  }
  if (answer) {
    console.log(answer);
  } else if (generated?.noAnswer === true) {
    console.log("No answer from retrieved evidence.");
  }
  console.log("");
  for (const citation of citations) {
    console.log(
      `[${citation.ref}] ${citation.page_id} ${citation.path} L${citation.line_start}-${citation.line_end}`,
    );
  }
  console.log("");
  if (payload.degraded_reason) {
    console.log(`Warning: ${payload.degraded_reason}.`);
  }
}

function askOutputHeading(
  noEvidence: boolean,
  generated: GeneratedAskAnswer | undefined,
): string {
  if (noEvidence) {
    return "No evidence found.";
  }
  if (!generated) {
    return "Extractive answer (degraded):";
  }
  const provider = `${generated.provider}, ${generated.model}`;
  return generated.noAnswer === true
    ? `Generated no-answer (${provider}):`
    : `Generated answer (${provider}):`;
}

function extractiveAnswer(
  results: ReturnType<typeof rankSearchResults>,
): string {
  return results
    .slice(0, 3)
    .map((result, index) => `${cleanSnippet(result.snippet)} [${index + 1}]`)
    .join(" ");
}

function cleanSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function generateAskAnswer(
  question: string,
  results: ReturnType<typeof rankSearchResults>,
  citations: AskCitation[],
  config: Config,
): Promise<GeneratedAskAnswer> {
  if (!config.llm) {
    throw new Error("LLM answer generation not configured");
  }
  const llm = config.llm;
  const provider = llm.provider;
  const { apiKey, apiKeyEnv } = configuredLlmApiKey(llm);
  if (!apiKey) {
    throw new Error(missingLlmApiKeyMessage(provider, apiKeyEnv));
  }
  const model = llm.model;
  const llmProvider = createCompileJsonProvider({
    providerName: provider,
    apiKey,
    baseUrl: llm.base_url,
    model,
    retries: 0,
    timeoutMs: 8_000,
  });
  const response = await llmProvider.completeJson({
    responseSchemaName: "akb_ask_answer",
    messages: [
      {
        role: "system",
        content: [
          "You answer questions using only the provided knowledge snippets.",
          'Return JSON only: {"answer":"...","used_refs":[1],"no_answer":false}.',
          "Every factual sentence in answer must include bracket citations like [1].",
          "Only cite refs that appear in the provided snippets.",
          'If the snippets do not answer the question, return {"answer":null,"used_refs":[],"no_answer":true}.',
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Question: ${question}`,
          "",
          "Snippets:",
          ...results.map((result, index) =>
            [
              `[${index + 1}] ${result.title} (${result.page_id}) ${result.path} L${result.citation.line_start}-L${result.citation.line_end}`,
              cleanSnippet(result.snippet),
            ].join("\n"),
          ),
        ].join("\n"),
      },
    ],
  });
  const parsed = JSON.parse(response.content) as unknown;
  if (
    !isRecord(parsed) ||
    (parsed.answer !== null && typeof parsed.answer !== "string")
  ) {
    throw new Error(
      `${providerDisplayName(provider)} ask response missing answer`,
    );
  }
  if (parsed.no_answer === true) {
    if (parsed.answer !== null) {
      throw new Error(
        `${providerDisplayName(provider)} ask no_answer response must use null answer`,
      );
    }
    const refs = Array.isArray(parsed.used_refs) ? parsed.used_refs : [];
    if (refs.length > 0) {
      throw new Error(
        `${providerDisplayName(provider)} ask no_answer response cannot cite refs`,
      );
    }
    return {
      answer: null,
      provider,
      model: response.model || model,
      noAnswer: true,
    };
  }
  if (parsed.answer === null || parsed.answer.trim().length === 0) {
    throw new Error(
      `${providerDisplayName(provider)} ask response omitted answer`,
    );
  }
  const usedRefs = Array.isArray(parsed.used_refs) ? parsed.used_refs : [];
  const allowedRefs = new Set(citations.map((citation) => citation.ref));
  if (usedRefs.length === 0 && parsed.answer.trim().length > 0) {
    throw new Error(
      `${providerDisplayName(provider)} ask response omitted citations`,
    );
  }
  for (const ref of usedRefs) {
    if (
      typeof ref !== "number" ||
      !Number.isInteger(ref) ||
      !allowedRefs.has(ref)
    ) {
      throw new Error(
        `${providerDisplayName(provider)} ask response cited unavailable ref: ${ref}`,
      );
    }
  }
  const answerRefs = new Set(
    [...parsed.answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])),
  );
  if (answerRefs.size === 0 && parsed.answer.trim().length > 0) {
    throw new Error(
      `${providerDisplayName(provider)} ask response omitted visible citations`,
    );
  }
  for (const ref of answerRefs) {
    if (!allowedRefs.has(ref)) {
      throw new Error(
        `${providerDisplayName(provider)} ask response cited unavailable ref: ${ref}`,
      );
    }
  }
  for (const ref of usedRefs) {
    if (!answerRefs.has(ref)) {
      throw new Error(
        `${providerDisplayName(provider)} ask response omitted visible citation: ${ref}`,
      );
    }
  }
  for (const ref of answerRefs) {
    if (!usedRefs.includes(ref)) {
      throw new Error(
        `${providerDisplayName(provider)} ask response omitted used ref: ${ref}`,
      );
    }
  }
  return {
    answer: parsed.answer,
    provider,
    model: response.model || model,
  };
}

function askDegradedReason(error: unknown, llm?: Config["llm"]) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  return `LLM answer generation failed (${sanitizeAskError(message, llm)}); used extractive retrieval answer`;
}

function sanitizeAskError(message: string, llm?: Config["llm"]): string {
  const { apiKey } = configuredLlmApiKey(llm);
  let sanitized = apiKey ? message.split(apiKey).join("[redacted]") : message;
  sanitized = sanitized.replace(/Authorization\s+Bearer\s+\S+/gi, "[redacted]");
  sanitized = sanitized.replace(/Bearer\s+\S+/gi, "[redacted]");
  sanitized = sanitized.replace(/https?:\/\/\S+/gi, "[redacted-url]");
  return sanitized;
}

function configuredLlmApiKey(llm: Config["llm"] | undefined): {
  apiKey?: string;
  apiKeyEnv?: string;
} {
  if (!llm) {
    return {};
  }
  if (llm.api_key_env) {
    return {
      apiKey: process.env[llm.api_key_env],
      apiKeyEnv: llm.api_key_env,
    };
  }
  return {};
}

function missingLlmApiKeyMessage(
  provider: LlmProviderName,
  apiKeyEnv?: string,
): string {
  return `Missing ${apiKeyEnv ?? defaultApiKeyEnvForProvider(provider)}`;
}

function defaultApiKeyEnvForProvider(provider: LlmProviderName): string {
  if (provider === "openai") {
    return "OPENAI_API_KEY";
  }
  if (provider === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  return "DEEPSEEK_API_KEY";
}

function providerDisplayName(provider: LlmProviderName): string {
  if (provider === "openai") {
    return "OpenAI";
  }
  if (provider === "anthropic") {
    return "Anthropic";
  }
  return "DeepSeek";
}

function rankConfidenceStateForResults(
  vaultDir: string,
  results: SearchResult[],
  now?: Date,
): Map<PageId, RankConfidenceState> {
  const states = loadProjectedRankConfidenceState(
    vaultDir,
    results.map((result) => result.page_id),
  );
  for (const result of results) {
    const projectedEvents = now
      ? loadProjectedConfidenceEvents(vaultDir, result.page_id)
      : [];
    const events = [
      ...loadConfidenceEvents(vaultDir, result.path, result.page_id),
      ...projectedEvents,
    ];
    if (events.length === 0) {
      continue;
    }
    const latestLedgerEventAt = [...events]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .at(-1)?.timestamp;
    const projected = states.get(result.page_id);
    if (
      !now &&
      projected &&
      latestLedgerEventAt &&
      projected.lastEventAt &&
      projected.lastEventAt >= latestLedgerEventAt
    ) {
      continue;
    }
    const state = computeConfidenceState(events, { now });
    states.set(result.page_id, {
      score: state.score,
      supersededBy: state.supersededBy,
      lastVerifiedAt: state.lastVerifiedAt,
      lastEventAt: state.lastEventAt,
      recentMajorContradictedAt: latestMajorContradictionAt(events),
    });
  }
  return states;
}

function loadProjectedConfidenceEvents(
  vaultDir: string,
  pageId: PageId,
): ReturnType<typeof loadConfidenceEvents> {
  const projection = new ConfidenceProjection({
    dbPath: join(vaultDir, ".akb", "index.db"),
    readonly: true,
  });
  try {
    return projection.getEvents(pageId);
  } catch {
    return [];
  } finally {
    projection.close();
  }
}

function loadProjectedRankConfidenceState(
  vaultDir: string,
  pageIds: PageId[],
): Map<PageId, RankConfidenceState> {
  const projection = new ConfidenceProjection({
    dbPath: join(vaultDir, ".akb", "index.db"),
    readonly: true,
  });
  try {
    const states = new Map<PageId, RankConfidenceState>();
    for (const [pageId, state] of projection.getStates(pageIds)) {
      states.set(pageId, {
        score: state.score,
        supersededBy: state.supersededBy,
        lastVerifiedAt: state.lastVerifiedAt,
        lastEventAt: state.lastEventAt,
        recentMajorContradictedAt: latestMajorContradictionAt(
          projection.getEvents(pageId),
        ),
      });
    }
    return states;
  } catch {
    return new Map();
  } finally {
    projection.close();
  }
}

function latestMajorContradictionAt(
  events: ReturnType<typeof loadConfidenceEvents>,
): string | undefined {
  return events
    .filter(
      (event) => event.kind === "contradicted_by" && event.severity === "major",
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.timestamp;
}

async function evalCommand(options: EvalOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const goldenPath = resolve(vaultDir, options.set ?? ".akb/eval/golden.yaml");
  const set = loadGoldenSet(goldenPath);
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  try {
    const report = runEval(index, set);
    if (options.output) {
      writeFileSync(
        resolve(vaultDir, options.output),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    console.log(`Eval: ${report.total} items`);
    console.log(`  precision@5:  ${report.precision_at_5.toFixed(2)}`);
    console.log(`  precision@10: ${report.precision_at_10.toFixed(2)}`);
    console.log(`  recall@5:     ${report.recall_at_5.toFixed(2)}`);
    console.log(`  recall@10:    ${report.recall_at_10.toFixed(2)}`);
    console.log(
      `  must-hit pass rate:  ${report.total - report.failures.length}/${report.total} (${Math.round(
        report.must_hit_pass_rate * 100,
      )}%)`,
    );
    if (report.failures.length > 0) {
      console.log("");
      console.log("FAILED:");
      for (const failure of report.failures) {
        console.log(`  ${failure.id} "${failure.query}"`);
        console.log(
          `    missing: ${failure.missing_must_hit_pages.join(", ")}`,
        );
      }
      process.exitCode = 1;
    }
  } finally {
    index.close();
  }
}

function evalCompileCommand(options: EvalCompileOptions): void {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const setOption = options.set ?? cliOptionValue("--set");
  const outputOption = options.output ?? cliOptionValue("--output");
  const baselineOption = options.baseline ?? cliOptionValue("--baseline");
  const maxRelationRegression = options.maxRelationRegression ?? 0.08;
  const goldenPath = resolve(
    vaultDir,
    setOption ?? ".akb/eval/compile-golden.yaml",
  );
  const items = loadCompileGoldenItems(goldenPath);
  const failures: CompileEvalFailure[] = [];
  let relationChecks = 0;
  let relationPasses = 0;
  let targetChecks = 0;
  let targetPasses = 0;
  let lineageChecks = 0;
  let lineagePasses = 0;

  for (const item of items) {
    const patch = buildCompileEvalPatch(vaultDir, goldenPath, item);
    const changes = patch.changes ?? [];
    lineageChecks += 1;
    const lineageFailures = validateCompileEvalLineage(
      vaultDir,
      goldenPath,
      item,
      patch,
    );
    if (lineageFailures.length === 0) {
      lineagePasses += 1;
    } else {
      failures.push({
        id: item.id,
        source: item.setup.newSource,
        expectedRelation: "complete lineage",
        actualRelation: lineageFailures.join("; "),
        kind: "lineage",
      });
    }
    for (const expected of item.expect.relations) {
      relationChecks += 1;
      const expectedRelations =
        expected.relationIn ?? (expected.relation ? [expected.relation] : []);
      const relationMatched = changes.find(
        (change) =>
          "relation" in change &&
          expectedRelations.includes(change.relation) &&
          (!expected.againstPage ||
            compileChangeTargetPage(change) === expected.againstPage),
      );
      if (relationMatched) {
        relationPasses += 1;
      } else {
        const actual = changes.find((change) => "relation" in change);
        failures.push({
          id: item.id,
          source: item.setup.newSource,
          againstPage: expected.againstPage,
          expectedRelation:
            expected.relationIn ?? expected.relation ?? "<missing>",
          actualRelation:
            actual && "relation" in actual ? actual.relation : undefined,
          actualTargetPage: actual
            ? compileChangeTargetPage(actual)
            : undefined,
          kind: "relation",
        });
      }

      if (expected.againstPage) {
        targetChecks += 1;
        const candidates = changes.filter(
          (change) => compileChangeTargetPage(change) === expected.againstPage,
        );
        if (candidates.length > 0) {
          targetPasses += 1;
        } else {
          const actual = changes.find((change) => "pageId" in change);
          failures.push({
            id: item.id,
            source: item.setup.newSource,
            againstPage: expected.againstPage,
            expectedRelation:
              expected.relationIn ?? expected.relation ?? "<missing>",
            actualRelation:
              actual && "relation" in actual ? actual.relation : undefined,
            actualTargetPage: actual
              ? compileChangeTargetPage(actual)
              : undefined,
            kind: "target",
          });
        }
      }
    }
    const createsPage = changes.some((change) => changeCreatesPage(change));
    if (item.expect.mustCreatePage && !createsPage) {
      failures.push({
        id: item.id,
        source: item.setup.newSource,
        expectedRelation: "new page",
        kind: "create_page",
      });
    }
    if (item.expect.mustNotCreatePage && createsPage) {
      failures.push({
        id: item.id,
        source: item.setup.newSource,
        expectedRelation: "no new page",
        actualRelation: "new",
        kind: "create_page",
      });
    }
    if (
      item.expect.mustNotDeleteContent &&
      changes.some(
        (change) =>
          "operation" in change && String(change.operation).includes("delete"),
      )
    ) {
      failures.push({
        id: item.id,
        source: item.setup.newSource,
        expectedRelation: "no deleted content",
        kind: "delete_content",
      });
    }
  }

  const relationAccuracy =
    relationChecks === 0 ? 1 : relationPasses / relationChecks;
  const targetAccuracy = targetChecks === 0 ? 1 : targetPasses / targetChecks;
  const lineageIntegrity =
    lineageChecks === 0 ? 1 : lineagePasses / lineageChecks;
  let baselineRelationAccuracy: number | undefined;
  let relationAccuracyRegression: number | undefined;
  if (baselineOption) {
    baselineRelationAccuracy = loadBaselineRelationAccuracy(
      resolve(vaultDir, baselineOption),
    );
    relationAccuracyRegression = baselineRelationAccuracy - relationAccuracy;
    if (relationAccuracyRegression > maxRelationRegression) {
      failures.push({
        id: "quality_gate",
        source: baselineOption,
        expectedRelation: `relation accuracy regression <= ${maxRelationRegression.toFixed(4)}`,
        actualRelation: `regression ${relationAccuracyRegression.toFixed(4)}`,
        kind: "relation_regression",
      });
    }
  }

  const failedItemIds = new Set(failures.map((failure) => failure.id));
  const report = {
    schema_version: "compile-eval/0.1",
    total: items.length,
    relation_checks: relationChecks,
    relation_passes: relationPasses,
    target_checks: targetChecks,
    target_passes: targetPasses,
    lineage_checks: lineageChecks,
    lineage_passes: lineagePasses,
    passed: items.length - failedItemIds.size,
    failed: failedItemIds.size,
    failure_count: failures.length,
    relation_accuracy: relationAccuracy,
    target_accuracy: targetAccuracy,
    lineage_integrity: lineageIntegrity,
    baseline_relation_accuracy: baselineRelationAccuracy,
    relation_accuracy_regression: relationAccuracyRegression,
    max_relation_regression: baselineOption ? maxRelationRegression : undefined,
    failures,
  };
  if (outputOption) {
    writeFileSync(
      resolve(vaultDir, outputOption),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }

  console.log(`Compile eval: ${items.length} items`);
  console.log(`  relation accuracy: ${relationPasses}/${relationChecks}`);
  console.log(`  target accuracy:   ${targetPasses}/${targetChecks}`);
  console.log(`  lineage integrity: ${lineagePasses}/${lineageChecks}`);
  if (relationAccuracyRegression !== undefined) {
    console.log(
      `  relation accuracy regression: ${relationAccuracyRegression.toFixed(4)} (max ${maxRelationRegression.toFixed(4)})`,
    );
  }
  if (failures.length > 0) {
    console.log("");
    console.log("FAILED:");
    for (const failure of failures) {
      console.log(
        `  ${failure.id} source=${failure.source}: expected ${Array.isArray(failure.expectedRelation) ? failure.expectedRelation.join(" or ") : failure.expectedRelation}${failure.againstPage ? ` -> ${failure.againstPage}` : ""}, got ${failure.actualRelation ?? "none"}${failure.actualTargetPage ? ` -> ${failure.actualTargetPage}` : ""}`,
      );
    }
    process.exitCode = 1;
  }
}

function loadCompileGoldenItems(path: string): CompileGoldenItem[] {
  const parsed = parseYaml(readFileSync(path, "utf8")) as {
    version?: string;
    items?: unknown[];
  };
  if (parsed.version !== "1.0" || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid compile golden set: ${path}`);
  }
  return parsed.items.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid compile golden item at index ${index}`);
    }
    const id = stringField(item, "id");
    const setup = recordField(item, "setup");
    const expect = recordField(item, "expect");
    const relations = arrayField(expect, "relations").map(
      (relation, relationIndex) => {
        if (!isRecord(relation)) {
          throw new Error(
            `Invalid compile golden relation at ${index}.${relationIndex}`,
          );
        }
        const relationValue =
          typeof relation.relation === "string" ? relation.relation : undefined;
        const relationIn = Array.isArray(relation.relationIn)
          ? relation.relationIn.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined;
        if (!relationValue && (!relationIn || relationIn.length === 0)) {
          throw new Error(
            `Invalid compile golden relation at ${index}.${relationIndex}`,
          );
        }
        return {
          againstPage:
            typeof relation.againstPage === "string"
              ? relation.againstPage
              : undefined,
          relation: relationValue,
          relationIn,
        };
      },
    );
    return {
      id,
      description:
        typeof item.description === "string" ? item.description : undefined,
      setup: {
        existingPages: Array.isArray(setup.existingPages)
          ? setup.existingPages.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        newSource: stringField(setup, "newSource"),
      },
      expect: {
        relations,
        mustCreatePage:
          typeof expect.mustCreatePage === "boolean"
            ? expect.mustCreatePage
            : undefined,
        mustNotCreatePage:
          typeof expect.mustNotCreatePage === "boolean"
            ? expect.mustNotCreatePage
            : undefined,
        mustNotDeleteContent:
          typeof expect.mustNotDeleteContent === "boolean"
            ? expect.mustNotDeleteContent
            : undefined,
      },
    };
  });
}

function loadBaselineRelationAccuracy(path: string): number {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (
    !isRecord(parsed) ||
    typeof parsed.relation_accuracy !== "number" ||
    parsed.relation_accuracy < 0 ||
    parsed.relation_accuracy > 1
  ) {
    throw new Error(`Invalid compile eval baseline: ${path}`);
  }
  return parsed.relation_accuracy;
}

function buildCompileEvalPatch(
  vaultDir: string,
  goldenPath: string,
  item: CompileGoldenItem,
): PatchDocument {
  const source = compileEvalPageInput(
    vaultDir,
    goldenPath,
    item.setup.newSource,
  );
  const candidates = compileEvalCandidates(vaultDir, goldenPath, item, source);
  return buildHeuristicCompilePatch({
    source,
    candidates,
  }) as PatchDocument;
}

function compileEvalCandidates(
  vaultDir: string,
  goldenPath: string,
  item: CompileGoldenItem,
  source: CompilePageInput,
): CompilePageInput[] {
  return item.setup.existingPages.length > 0
    ? item.setup.existingPages.map((ref) =>
        compileEvalPageInput(vaultDir, goldenPath, ref),
      )
    : scanVaultPages(vaultDir).filter(
        (candidate) => candidate.page.id !== source.page.id,
      );
}

function validateCompileEvalLineage(
  vaultDir: string,
  goldenPath: string,
  item: CompileGoldenItem,
  patch: PatchDocument,
): string[] {
  const source = compileEvalPageInput(
    vaultDir,
    goldenPath,
    item.setup.newSource,
  );
  const inputs = [
    source,
    ...compileEvalCandidates(vaultDir, goldenPath, item, source),
  ];
  const knownChunks = new Set<string>();
  for (const input of inputs) {
    for (const chunk of chunkByHeaders(input.page.id, input.body, {
      bodyStartLine: input.bodyStartLine,
    })) {
      knownChunks.add(chunk.id);
    }
  }
  const knownUnits = new Set(
    (patch.lineage?.units ?? []).map((unit) => String(unit.id)),
  );
  const failures: string[] = [];
  const markerSources = compileEvalDerivedSources(patch);
  const hasContentChanges = (patch.changes ?? []).some(
    (change) => "content" in change && typeof change.content === "string",
  );
  if (hasContentChanges && markerSources.length === 0) {
    failures.push("derived content missing akb:derived marker");
  }
  if (markerSources.length > 0 && knownUnits.size === 0) {
    failures.push("derived content missing lineage units");
  }
  if (
    markerSources.length > 0 &&
    (patch.lineage?.derivedChunks ?? []).length === 0
  ) {
    failures.push("derived content missing derivedChunks");
  }
  const derivedFromChunkIds = new Set<string>();
  const derivedFromUnitIds = new Set<string>();
  for (const unit of patch.lineage?.units ?? []) {
    for (const chunkId of unit.sourceChunkIds ?? []) {
      if (!knownChunks.has(chunkId)) {
        failures.push(`unresolved lineage source ${chunkId}`);
      }
    }
  }
  for (const markerSource of markerSources) {
    if (markerSource.includes(":c")) {
      if (!knownChunks.has(markerSource)) {
        failures.push(`unresolved derived source ${markerSource}`);
      }
    } else if (!knownUnits.has(markerSource)) {
      failures.push(`unresolved derived source ${markerSource}`);
    }
  }
  for (const derived of patch.lineage?.derivedChunks ?? []) {
    const chunkId = typeof derived.chunkId === "string" ? derived.chunkId : "";
    if (!isValidEvalDerivedChunkId(chunkId, patch)) {
      failures.push(`invalid derived chunk target ${chunkId || "<missing>"}`);
    }
    if (!isRecord(derived.derivedFrom)) {
      failures.push("derived chunk missing derivedFrom");
      continue;
    }
    for (const chunkId of toStringArray(derived.derivedFrom.sourceChunkIds)) {
      derivedFromChunkIds.add(chunkId);
      if (!knownChunks.has(chunkId)) {
        failures.push(`unresolved derived lineage chunk ${chunkId}`);
      }
    }
    for (const unitId of toStringArray(derived.derivedFrom.sourceUnitIds)) {
      derivedFromUnitIds.add(unitId);
      if (!knownUnits.has(unitId)) {
        failures.push(`unresolved derived lineage unit ${unitId}`);
      }
    }
  }
  for (const markerSource of markerSources) {
    if (markerSource.includes(":c")) {
      if (!derivedFromChunkIds.has(markerSource)) {
        failures.push(`marker source missing from lineage ${markerSource}`);
      }
    } else if (!derivedFromUnitIds.has(markerSource)) {
      failures.push(`marker source missing from lineage ${markerSource}`);
    }
  }
  return [...new Set(failures)];
}

function isValidEvalDerivedChunkId(
  chunkId: string,
  patch: PatchDocument,
): boolean {
  if (!chunkId.includes(":c")) {
    return false;
  }
  const pageId = chunkId.split(":")[0];
  return (patch.changes ?? []).some(
    (change) =>
      compileChangeTargetPage(change) === pageId ||
      (change.type === "create" && change.newPageId === pageId),
  );
}

function compileEvalDerivedSources(patch: PatchDocument): string[] {
  const sources: string[] = [];
  for (const change of patch.changes ?? []) {
    if ("content" in change && typeof change.content === "string") {
      sources.push(...extractDerivedSources(change.content));
    }
  }
  return sources;
}

function compileEvalPageInput(
  vaultDir: string,
  goldenPath: string,
  ref: string,
): CompilePageInput {
  const goldenRelative = resolve(dirname(goldenPath), ref);
  const vaultRelative = resolve(vaultDir, ref);
  const file = existsSync(goldenRelative)
    ? goldenRelative
    : existsSync(vaultRelative)
      ? vaultRelative
      : resolvePageFile(vaultDir, ref);
  if (!file) {
    throw new Error(`Compile eval page not found: ${ref}`);
  }
  return pageFromFile(vaultDir, file);
}

async function lintCommand(options: LintOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const report = buildLintReport(vaultDir, parseOptionalNow(options.now));
  writeLintReports(vaultDir, report);
  printLintReport(report);
  if (
    report.unresolvedContradictions.length > 0 ||
    report.stale.some((issue) => issue.ciGate) ||
    report.brokenWikiLinks.length > 0 ||
    report.supersessionCycles.length > 0
  ) {
    process.exitCode = 1;
  }
}

function buildLintReport(vaultDir: string, now?: Date): LintReport {
  const pages = scanVaultPages(vaultDir);
  const lookup = pageLookup(pages.map((item) => item.page));
  const confidence = rankConfidenceStateForResults(
    vaultDir,
    pages.map((item) => ({
      page_id: item.page.id,
      path: item.page.path,
      title: item.page.title,
      score: 0,
      snippet: "",
      citation: { line_start: 1, line_end: 1 },
    })),
    now,
  );
  const knownPageIds = new Set(pages.map((item) => String(item.page.id)));
  const chunksByPage = new Map<PageId, ReturnType<typeof chunkByHeaders>>();
  const knownChunkIds = new Set<string>();
  for (const item of pages) {
    const chunks = chunkByHeaders(item.page.id, item.body, {
      bodyStartLine: item.bodyStartLine,
    });
    chunksByPage.set(item.page.id, chunks);
    for (const chunk of chunks) {
      knownChunkIds.add(chunk.id);
    }
  }
  const knownLineageUnitIds = new Set<string>();
  for (const patch of loadAllPatches(vaultDir)) {
    for (const unit of patch.lineage?.units ?? []) {
      knownLineageUnitIds.add(unit.id);
    }
  }

  const lowConfidence: LintReport["lowConfidence"] = [];
  const stale: LintReport["stale"] = [];
  const unresolvedContradictions: LintReport["unresolvedContradictions"] = [];
  const brokenWikiLinks: LintReport["brokenWikiLinks"] = [];
  const highDerivedRatio: LintReport["highDerivedRatio"] = [];
  const orphanedLineage: LintReport["orphanedLineage"] = [];
  const outgoingCounts = new Map<PageId, number>(
    pages.map((item) => [item.page.id, 0]),
  );
  const incomingCounts = new Map<PageId, number>(
    pages.map((item) => [item.page.id, 0]),
  );
  const targetToPageId = pageTargetLookup(pages.map((item) => item.page));

  for (const item of pages) {
    const state = confidence.get(item.page.id);
    if (state && state.score < 0.5) {
      lowConfidence.push({ page: item.page, score: state.score });
    }
    const events = loadConfidenceEvents(vaultDir, item.page.path, item.page.id);
    const lastVerifiedAt =
      state?.lastVerifiedAt ?? firstConfidenceEvidenceAt(events);
    const staleCiGate =
      isDecisionPage(item.page) &&
      typeof lastVerifiedAt === "string" &&
      isAtLeastDaysOld(lastVerifiedAt, 100, now);
    if (staleCiGate) {
      stale.push({ page: item.page, lastVerifiedAt, ciGate: true });
    } else if (
      state?.lastVerifiedAt &&
      isOlderThanDays(state.lastVerifiedAt, 180, now)
    ) {
      stale.push({
        page: item.page,
        lastVerifiedAt: state.lastVerifiedAt,
        ciGate: false,
      });
    }
    if (events.length > 0) {
      const activeContradictionCount = countActiveContradictions(events);
      if (activeContradictionCount > 0) {
        unresolvedContradictions.push({
          page: item.page,
          contradictionCount: activeContradictionCount,
        });
      }
    }
    const chunks = chunksByPage.get(item.page.id) ?? [];
    const derivedChunks = chunks.filter(
      (chunk) => chunk.origin.kind === "derived",
    );
    if (chunks.length > 0 && derivedChunks.length / chunks.length > 0.5) {
      highDerivedRatio.push({
        page: item.page,
        derivedChunks: derivedChunks.length,
        totalChunks: chunks.length,
        ratio: derivedChunks.length / chunks.length,
      });
    }
    for (const chunk of derivedChunks) {
      if (chunk.origin.kind !== "derived") {
        continue;
      }
      for (const source of chunk.origin.derivedFrom.sourceChunkIds) {
        if (!knownChunkIds.has(source)) {
          orphanedLineage.push({ page: item.page, chunkId: chunk.id, source });
        }
      }
      for (const source of chunk.origin.derivedFrom.sourceUnitIds) {
        if (!sourceUnitExists(source, knownPageIds, knownLineageUnitIds)) {
          orphanedLineage.push({ page: item.page, chunkId: chunk.id, source });
        }
      }
    }
    const links = extractWikiLinks(item.body);
    for (const target of links) {
      if (!lookup.has(normalizeWikiTarget(target))) {
        brokenWikiLinks.push({ page: item.page, target });
      } else {
        const targetPageId = targetToPageId.get(normalizeWikiTarget(target));
        if (targetPageId && targetPageId !== item.page.id) {
          outgoingCounts.set(
            item.page.id,
            (outgoingCounts.get(item.page.id) ?? 0) + 1,
          );
          incomingCounts.set(
            targetPageId,
            (incomingCounts.get(targetPageId) ?? 0) + 1,
          );
        }
      }
    }
  }
  const orphanPages = pages
    .filter((item) => {
      const outgoing = outgoingCounts.get(item.page.id) ?? 0;
      return outgoing === 0 && (incomingCounts.get(item.page.id) ?? 0) === 0;
    })
    .map((item) => item.page);

  return {
    lowConfidence,
    stale,
    unresolvedContradictions,
    orphanPages,
    highDerivedRatio,
    orphanedLineage,
    brokenWikiLinks,
    supersessionCycles: findSupersessionCycles(pages.map((item) => item.page)),
  };
}

function isDecisionPage(page: Page): boolean {
  const type = page.frontmatter.type;
  return typeof type === "string" && type.toLowerCase() === "decision";
}

function firstConfidenceEvidenceAt(
  events: ConfidenceEvent[],
): string | undefined {
  return [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0]
    ?.timestamp;
}

function countActiveContradictions(events: ConfidenceEvent[]): number {
  let activeContradictions = 0;
  for (const event of [...events].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  )) {
    if (event.kind === "contradicted_by") {
      activeContradictions += 1;
    } else if (event.kind === "verified" || event.kind === "superseded_by") {
      activeContradictions = 0;
    }
  }
  return activeContradictions;
}

function printLintReport(report: LintReport): void {
  console.log("Confidence issues:");
  if (
    report.lowConfidence.length === 0 &&
    report.stale.length === 0 &&
    report.unresolvedContradictions.length === 0
  ) {
    console.log("  none");
  }
  for (const issue of report.lowConfidence) {
    console.log(
      `  warn low-confidence ${issue.page.id} ${issue.page.path} score=${issue.score.toFixed(4)}`,
    );
  }
  for (const issue of report.stale) {
    if (issue.ciGate) {
      console.log(
        `  error stale-ci-gate ${issue.page.id} ${issue.page.path} last_verified_at=${issue.lastVerifiedAt}`,
      );
    } else {
      console.log(
        `  warn stale ${issue.page.id} ${issue.page.path} last_verified_at=${issue.lastVerifiedAt}`,
      );
    }
  }
  for (const issue of report.unresolvedContradictions) {
    console.log(
      `  error unresolved contradiction ${issue.page.id} ${issue.page.path} count=${issue.contradictionCount}`,
    );
  }

  console.log("Structural issues:");
  if (report.orphanPages.length === 0) {
    console.log("  no orphan pages");
  } else {
    console.log(`  warn ${report.orphanPages.length} orphan pages`);
    for (const page of report.orphanPages) {
      console.log(`  warn orphan ${page.id} ${page.path}`);
    }
  }
  if (report.highDerivedRatio.length > 0) {
    console.log(`  warn ${report.highDerivedRatio.length} high derived ratio`);
    for (const issue of report.highDerivedRatio) {
      console.log(
        `  warn derived-ratio ${issue.page.id} ${issue.page.path} ratio=${issue.ratio.toFixed(2)}`,
      );
    }
  }
  if (report.orphanedLineage.length > 0) {
    console.log(`  warn ${report.orphanedLineage.length} orphaned lineage`);
    for (const issue of report.orphanedLineage) {
      console.log(
        `  warn orphaned-lineage ${issue.page.id} ${issue.chunkId} <- ${issue.source}`,
      );
    }
  }

  console.log("Broken wiki links:");
  if (report.brokenWikiLinks.length === 0) {
    console.log("  none");
  }
  for (const issue of report.brokenWikiLinks) {
    console.log(`  error ${issue.page.id} -> [[${issue.target}]]`);
  }

  console.log("Supersession cycles:");
  if (report.supersessionCycles.length === 0) {
    console.log("  none");
  }
  for (const cycle of report.supersessionCycles) {
    console.log(`  error ${cycle.join(" -> ")}`);
  }
}

function writeLintReports(vaultDir: string, report: LintReport): void {
  const lintDir = join(vaultDir, ".akb", "lint");
  mkdirSync(lintDir, { recursive: true });
  writeFileSync(
    join(lintDir, "low-confidence.md"),
    renderLintTable(
      "Low Confidence",
      ["Page", "Path", "Score", "Suggestion"],
      report.lowConfidence.map((issue) => [
        issue.page.id,
        issue.page.path,
        issue.score.toFixed(4),
        "consider supersede or re-verify",
      ]),
    ),
  );
  writeFileSync(
    join(lintDir, "stale.md"),
    renderLintTable(
      "Stale Verification",
      ["Page", "Path", "Last Verified At", "Suggestion"],
      report.stale.map((issue) => [
        issue.page.id,
        issue.page.path,
        issue.lastVerifiedAt,
        issue.ciGate
          ? "CI gate: re-verify this ADR before merging"
          : "re-verify or supersede this page",
      ]),
    ),
  );
  writeFileSync(
    join(lintDir, "orphan-pages.md"),
    renderLintTable(
      "Orphan Pages",
      ["Page", "Path", "Suggestion"],
      report.orphanPages.map((page) => [
        page.id,
        page.path,
        "add wiki links or verify this page is intentionally standalone",
      ]),
    ),
  );
  writeFileSync(
    join(lintDir, "unresolved-contradictions.md"),
    renderLintTable(
      "Unresolved Contradictions",
      ["Page", "Path", "Contradictions", "Suggestion"],
      report.unresolvedContradictions.map((issue) => [
        issue.page.id,
        issue.page.path,
        String(issue.contradictionCount),
        "supersede the page or re-verify with stronger evidence",
      ]),
    ),
  );
  writeFileSync(
    join(lintDir, "derived-ratio.md"),
    renderLintTable(
      "High Derived Ratio",
      ["Page", "Path", "Derived Chunks", "Total Chunks", "Ratio", "Suggestion"],
      report.highDerivedRatio.map((issue) => [
        issue.page.id,
        issue.page.path,
        String(issue.derivedChunks),
        String(issue.totalChunks),
        issue.ratio.toFixed(2),
        "human review recommended for heavily synthesized content",
      ]),
    ),
  );
  writeFileSync(
    join(lintDir, "orphaned-lineage.md"),
    renderLintTable(
      "Orphaned Lineage",
      ["Page", "Path", "Chunk", "Missing Source", "Suggestion"],
      report.orphanedLineage.map((issue) => [
        issue.page.id,
        issue.page.path,
        issue.chunkId,
        issue.source,
        "restore the source page or re-verify the derived claim",
      ]),
    ),
  );
  writeFileSync(join(lintDir, "suggestions.md"), renderLintSuggestions(report));
}

function renderLintTable(
  title: string,
  columns: string[],
  rows: string[][],
): string {
  const header = `# ${title}\n\n`;
  if (rows.length === 0) {
    return `${header}No issues found.\n`;
  }
  return [
    header.trimEnd(),
    "",
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function renderLintSuggestions(report: LintReport): string {
  const lines = ["# Lint Suggestions", ""];
  for (const issue of report.lowConfidence) {
    lines.push(
      `- ${issue.page.id} (${issue.score.toFixed(4)}): consider supersede or re-verify.`,
    );
  }
  for (const issue of report.stale) {
    lines.push(
      issue.ciGate
        ? `- ${issue.page.id}: CI gate requires ADR re-verification; last verified at ${issue.lastVerifiedAt}.`
        : `- ${issue.page.id}: re-verify stale page last verified at ${issue.lastVerifiedAt}.`,
    );
  }
  for (const page of report.orphanPages) {
    lines.push(
      `- ${page.id}: add incoming/outgoing wiki links or mark it intentionally standalone.`,
    );
  }
  for (const issue of report.unresolvedContradictions) {
    lines.push(
      `- ${issue.page.id}: resolve ${issue.contradictionCount} active contradiction(s) by superseding or re-verifying with stronger evidence.`,
    );
  }
  for (const issue of report.highDerivedRatio) {
    lines.push(
      `- ${issue.page.id}: review heavily synthesized content (${issue.derivedChunks}/${issue.totalChunks} derived chunks).`,
    );
  }
  for (const issue of report.orphanedLineage) {
    lines.push(
      `- ${issue.page.id}: restore missing lineage source ${issue.source} or re-verify ${issue.chunkId}.`,
    );
  }
  if (lines.length === 2) {
    lines.push("No suggestions.");
  }
  lines.push("");
  return lines.join("\n");
}

async function decayCommand(options: DecayOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  if (!options.run) {
    throw new Error("Use --run to write decay checkpoints");
  }
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`Invalid --now timestamp: ${options.now}`);
  }

  const written = new Set<string>();
  for (const item of scanVaultPages(vaultDir)) {
    const events = loadConfidenceEvents(vaultDir, item.page.path, item.page.id);
    if (events.length === 0) {
      continue;
    }
    const before = computeConfidenceState(events, {
      now: new Date(events.at(-1)?.timestamp ?? now.toISOString()),
      pageType:
        typeof item.page.frontmatter.type === "string"
          ? item.page.frontmatter.type
          : undefined,
    });
    const after = computeConfidenceState(events, {
      now,
      pageType:
        typeof item.page.frontmatter.type === "string"
          ? item.page.frontmatter.type
          : undefined,
    });
    const periodicDue = shouldWriteDecayCheckpoint(events, now);
    const thresholdCrossed = crossedConfidenceThreshold(
      before.score,
      after.score,
    );
    if (!periodicDue && !thresholdCrossed) {
      continue;
    }
    const lastEventAt = events.at(-1)?.timestamp ?? now.toISOString();
    const event = parseConfidenceEvent({
      id: stableId("evt", `${item.page.id}:decay:${now.toISOString()}`),
      kind: "decay_checkpoint",
      pageId: item.page.id,
      timestamp: now.toISOString(),
      actor: "system",
      actorId: "akb-decay",
      daysSinceLastEvent: daysBetweenIso(lastEventAt, now),
      appliedDecay: Math.max(0, before.score - after.score),
    });
    written.add(
      toPosix(
        relative(
          vaultDir,
          appendConfidenceEventAndUpdateProjection(vaultDir, item.page, event, {
            now,
          }),
        ),
      ),
    );
  }

  if (written.size > 0 && options.commit !== false) {
    await commitFiles(vaultDir, [...written], "record confidence decay");
  }
  console.log(
    `Wrote ${written.size} decay checkpoint${written.size === 1 ? "" : "s"}.`,
  );
}

async function runbookExecCommand(
  pageIdOrPath: string,
  options: RunbookExecOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const file = resolvePageFile(vaultDir, pageIdOrPath);
  if (!file) {
    throw new Error(`Page not found: ${pageIdOrPath}`);
  }
  const target = pageFromFile(vaultDir, file);
  const steps = extractRunbookSteps(target.body);
  if (steps.length === 0) {
    throw new Error(`No executable runbook steps found for ${target.page.id}`);
  }
  const now = parseOptionalNow(options.now) ?? new Date();
  const actorId = options.actorId ?? "runbook-exec";

  for (const step of steps) {
    const result = runShellCommand(step.command, vaultDir);
    if (!result.ok) {
      const written = writeRuntimeConfidenceEvents(vaultDir, [target], {
        actorId,
        evidence: result.summary,
        signalKind: `runbook_exec_failed step ${step.index}`,
        mode: "contradicted_by",
        timestamp: now,
      });
      if (written.length > 0 && options.commit !== false) {
        await commitFiles(vaultDir, written, "record runbook failure");
      }
      const message = `Runbook ${target.page.id} failed at step ${step.index}.`;
      console.log(message);
      throw new Error(message);
    }
  }

  const evidence = `${target.page.path} (${steps.length} step${steps.length === 1 ? "" : "s"})`;
  const written = writeRuntimeConfidenceEvents(vaultDir, [target], {
    actorId,
    evidence,
    signalKind: "runbook_exec",
    mode: "verified",
    timestamp: now,
  });
  if (written.length > 0 && options.commit !== false) {
    await commitFiles(vaultDir, written, "record runbook verification");
  }
  console.log(
    `Runbook ${target.page.id} succeeded with ${steps.length} step${steps.length === 1 ? "" : "s"}.`,
  );
}

async function linkedTestCommand(options: LinkedTestOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  if (!options.linkPages) {
    throw new Error("Use --link-pages to write linked test runtime signals");
  }
  const pageIds = linkedTestPageIds(vaultDir);
  if (pageIds.length === 0) {
    throw new Error("No @akb-page annotations found");
  }
  const targets = pageIds.map((pageId) => {
    const file = resolvePageFile(vaultDir, pageId);
    if (!file) {
      throw new Error(`Linked test references unknown page ${pageId}`);
    }
    return pageFromFile(vaultDir, file);
  });
  const command = options.command ?? "pnpm test";
  const actorId = options.actorId ?? "test:integration";
  const now = parseOptionalNow(options.now) ?? new Date();
  const evidence = options.evidence ?? command;
  const result = runShellCommand(command, vaultDir);
  if (!result.ok) {
    const written = writeRuntimeConfidenceEvents(vaultDir, targets, {
      actorId,
      evidence: result.summary,
      signalKind: "test_integration_failed",
      mode: "contradicted_by",
      timestamp: now,
    });
    if (written.length > 0 && options.commit !== false) {
      await commitFiles(vaultDir, written, "record linked test failure");
    }
    const message = `Linked test command failed for ${targets.length} page${targets.length === 1 ? "" : "s"}.`;
    console.log(message);
    throw new Error(message);
  }

  const written = writeRuntimeConfidenceEvents(vaultDir, targets, {
    actorId,
    evidence,
    signalKind: "test_integration_success",
    mode: "verified",
    timestamp: now,
  });
  if (written.length > 0 && options.commit !== false) {
    await commitFiles(vaultDir, written, "record linked test verification");
  }
  console.log(
    `Linked test command passed for ${targets.length} page${targets.length === 1 ? "" : "s"}.`,
  );
}

async function webhookCiSuccessCommand(
  options: WebhookCiSuccessOptions,
): Promise<void> {
  await webhookCiRuntimeSignalCommand(options, {
    signalKind: "ci_success",
    mode: "verified",
    commitMessage: "record runtime verification",
    outputNoun: "runtime verification",
  });
}

async function webhookCiFailureCommand(
  options: WebhookCiSuccessOptions,
): Promise<void> {
  await webhookCiRuntimeSignalCommand(options, {
    signalKind: "ci_failure",
    mode: "contradicted_by",
    commitMessage: "record runtime contradiction",
    outputNoun: "runtime contradiction",
  });
}

async function webhookCiRuntimeSignalCommand(
  options: WebhookCiSuccessOptions,
  opts: {
    signalKind: string;
    mode: RuntimeSignalMode;
    commitMessage: string;
    outputNoun: string;
  },
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const actorId = options.actorId ?? "ci:github-actions";
  const evidence = options.evidence ?? options.prNumber;
  if (!evidence) {
    throw new Error("Runtime signals require --evidence or --pr-number");
  }
  const changedFiles = new Set(options.changedFile ?? []);
  if (options.changedFilesList) {
    for (const line of readFileSync(
      resolve(vaultDir, options.changedFilesList),
      "utf8",
    ).split(/\r?\n/)) {
      if (line.trim()) {
        changedFiles.add(line.trim());
      }
    }
  }
  if (changedFiles.size === 0) {
    throw new Error("Runtime signals require at least one changed file");
  }

  const targets = scanVaultPages(vaultDir).filter((item) =>
    toStringArray(item.page.frontmatter.references).some((reference) =>
      changedFiles.has(reference),
    ),
  );
  if (targets.length === 0) {
    throw new Error("Runtime signal did not match any pages");
  }
  const written = writeRuntimeConfidenceEvents(vaultDir, targets, {
    actorId,
    evidence,
    signalKind: opts.signalKind,
    mode: opts.mode,
  });
  if (written.length > 0 && options.commit !== false) {
    await commitFiles(vaultDir, written, opts.commitMessage);
  }
  console.log(
    `Recorded ${written.length} ${opts.outputNoun}${written.length === 1 ? "" : "s"}.`,
  );
}

async function watchCommand(options: WatchOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  if (!options.once) {
    throw new Error("This minimal watcher supports --once");
  }
  const signalDir = join(vaultDir, ".akb", "runtime-signals");
  if (!existsSync(signalDir)) {
    console.log("Processed 0 runtime signals.");
    return;
  }

  let processed = 0;
  const written = new Set<string>();
  for (const file of readdirSync(signalDir).sort()) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const path = join(signalDir, file);
    const signal = JSON.parse(readFileSync(path, "utf8")) as {
      kind?: string;
      page_ids?: string[];
      actor_id?: string;
      evidence?: string;
    };
    if (!signal.actor_id || !signal.evidence) {
      throw new Error(`Runtime signal ${file} requires actor_id and evidence`);
    }
    if (!Array.isArray(signal.page_ids) || signal.page_ids.length === 0) {
      throw new Error(`Runtime signal ${file} requires page_ids`);
    }
    const targets = signal.page_ids.map((pageId) => {
      const pageFile = resolvePageFile(vaultDir, pageId);
      if (!pageFile) {
        throw new Error(
          `Runtime signal ${file} references unknown page ${pageId}`,
        );
      }
      return pageFromFile(vaultDir, pageFile);
    });
    const signalKind = signal.kind ?? "runtime_signal";
    for (const writtenPath of writeRuntimeConfidenceEvents(vaultDir, targets, {
      actorId: signal.actor_id,
      evidence: signal.evidence,
      signalKind,
      mode: runtimeSignalMode(signalKind),
    })) {
      written.add(writtenPath);
    }
    rmSync(path);
    processed += 1;
  }
  if (written.size > 0 && options.commit !== false) {
    await commitFiles(vaultDir, [...written], "record runtime signals");
  }
  console.log(
    `Processed ${processed} runtime signal${processed === 1 ? "" : "s"}.`,
  );
}

async function projectionRebuildCommand(
  options: ProjectionRebuildOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  if (!options.confidence && !options.all) {
    throw new Error("Choose a projection to rebuild: --confidence or --all");
  }

  const pages = scanVaultPages(vaultDir);
  if (options.all) {
    const index = new SearchIndex({
      dbPath: join(vaultDir, ".akb", "index.db"),
    });
    try {
      const result = index.rebuild(pages);
      console.log(
        `Rebuilt search projection for ${result.totalPages} page${result.totalPages === 1 ? "" : "s"} and ${result.inserted} chunk set${result.inserted === 1 ? "" : "s"}.`,
      );
    } finally {
      index.close();
    }
  }
  const projection = new ConfidenceProjection({
    dbPath: join(vaultDir, ".akb", "index.db"),
  });
  try {
    const result = projection.rebuild(
      pages.flatMap((item) => {
        const events = loadConfidenceEvents(
          vaultDir,
          item.page.path,
          item.page.id,
        );
        if (events.length === 0) {
          return [];
        }
        return [
          {
            pageId: item.page.id,
            events,
            state: computeConfidenceState(events, {
              pageType:
                typeof item.page.frontmatter.type === "string"
                  ? item.page.frontmatter.type
                  : undefined,
            }),
          },
        ];
      }),
    );
    console.log(
      `Rebuilt confidence projection for ${result.pages} page${result.pages === 1 ? "" : "s"} and ${result.events} event${result.events === 1 ? "" : "s"}.`,
    );
  } finally {
    projection.close();
  }
}

async function verifyCommand(
  pageOrGlob: string,
  options: VerifyOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const targets = resolvePageFiles(vaultDir, pageOrGlob);
  if (targets.length === 0) {
    throw new Error(`No pages matched: ${pageOrGlob}`);
  }

  if (options.dryRun) {
    const threshold = 0.7;
    const issues = targets
      .map((file) => {
        const { page } = pageFromFile(vaultDir, file);
        const events = loadConfidenceEvents(vaultDir, page.path, page.id);
        if (events.length === 0) {
          return { page, score: undefined };
        }
        const state = computeConfidenceState(events, {
          pageType:
            typeof page.frontmatter.type === "string"
              ? page.frontmatter.type
              : undefined,
        });
        return state.score < threshold ? { page, score: state.score } : null;
      })
      .filter((item) => item !== null);

    console.log(
      `Dry run: ${issues.length} page${issues.length === 1 ? "" : "s"} need review below ${threshold.toFixed(2)}.`,
    );
    for (const issue of issues) {
      console.log(
        `  ${issue.page.id}  ${issue.page.path}  score=${issue.score?.toFixed(4) ?? "missing-ledger"}`,
      );
    }
    return;
  }

  const timestamp = new Date().toISOString();
  const written = new Set<string>();
  for (const file of targets) {
    const { page } = pageFromFile(vaultDir, file);
    const actorId = options.byAgent
      ? `agent:${options.byAgent}`
      : humanActorId();
    const event = parseConfidenceEvent({
      id: stableId(
        "evt",
        `${page.id}:verified:${timestamp}:${actorId ?? "human"}:${options.reason ?? ""}`,
      ),
      kind: "verified",
      pageId: page.id,
      timestamp,
      actor: options.byAgent ? "agent" : "human",
      actorId,
      verifierType: options.byAgent ? "agent" : "human",
      verifierId: options.byAgent ?? actorId,
      reason: options.reason,
    });
    const ledgerPath = appendConfidenceEventAndUpdateProjection(
      vaultDir,
      page,
      event,
    );
    written.add(toPosix(relative(vaultDir, ledgerPath)));
  }

  if (written.size > 0 && options.commit !== false) {
    await commitFiles(vaultDir, [...written], `verify ${targets.length} pages`);
  }

  console.log(
    `Verified ${targets.length} page${targets.length === 1 ? "" : "s"}.`,
  );
}

async function supersedeCommand(
  oldPageIdOrPath: string,
  options: SupersedeOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const oldFile = resolvePageFile(vaultDir, oldPageIdOrPath);
  if (!oldFile) {
    throw new Error(`Old page not found: ${oldPageIdOrPath}`);
  }
  const newFile = resolvePageFile(vaultDir, options.by);
  if (!newFile) {
    throw new Error(`Superseding page not found: ${options.by}`);
  }

  const oldPage = pageFromFile(vaultDir, oldFile).page;
  const newPageBefore = pageFromFile(vaultDir, newFile).page;
  if (oldPage.id === newPageBefore.id) {
    throw new Error("A page cannot supersede itself");
  }
  const existingOldState = confidenceStateForPage(vaultDir, oldPage);
  const written = new Set<string>();
  const newPageSupersedes = newPageBefore.frontmatter.supersedes;
  if (
    typeof newPageSupersedes === "string" &&
    newPageSupersedes !== oldPage.id
  ) {
    throw new Error(
      `${newPageBefore.id} already supersedes ${newPageSupersedes}. Use --unlink on that chain before reusing it as a superseder.`,
    );
  }
  if (existingOldState?.supersededBy && !options.unlink) {
    throw new Error(
      `${oldPage.id} is already superseded by ${existingOldState.supersededBy}. Use --unlink to replace the supersession link.`,
    );
  }
  if (existingOldState?.supersededBy && options.unlink) {
    const previousSupersederFile = resolvePageFile(
      vaultDir,
      existingOldState.supersededBy,
    );
    if (!previousSupersederFile) {
      throw new Error(
        `Cannot unlink missing superseder page: ${existingOldState.supersededBy}`,
      );
    }
    const previousSuperseder = pageFromFile(vaultDir, previousSupersederFile);
    if (previousSuperseder.page.frontmatter.supersedes !== oldPage.id) {
      throw new Error(
        `${previousSuperseder.page.id} does not actively supersede ${oldPage.id}`,
      );
    }
    const unlinkTimestamp = new Date().toISOString();
    const unlinkEvent = parseConfidenceEvent({
      id: stableId(
        "evt",
        `${previousSuperseder.page.id}:supersedes_removed:${oldPage.id}:${newPageBefore.id}:${unlinkTimestamp}`,
      ),
      kind: "supersedes_removed",
      pageId: previousSuperseder.page.id,
      timestamp: unlinkTimestamp,
      actor: "human",
      actorId: humanActorId(),
      supersededPageId: oldPage.id,
      replacementPageId: newPageBefore.id,
      reason: options.reason ?? `replaced by ${newPageBefore.id}`,
    });
    written.add(
      toPosix(
        relative(
          vaultDir,
          appendConfidenceEventAndUpdateProjection(
            vaultDir,
            previousSuperseder.page,
            unlinkEvent,
          ),
        ),
      ),
    );
    unlinkSupersedingPage(previousSupersederFile, oldPage.id);
    written.add(previousSuperseder.page.path);
    upsertPageFileInIndex(vaultDir, previousSupersederFile);
  }

  const timestamp = new Date().toISOString();
  const oldEvent = parseConfidenceEvent({
    id: stableId(
      "evt",
      `${oldPage.id}:superseded_by:${newPageBefore.id}:${timestamp}`,
    ),
    kind: "superseded_by",
    pageId: oldPage.id,
    timestamp,
    actor: "human",
    actorId: humanActorId(),
    supersederPageId: newPageBefore.id,
    reason: options.reason,
  });
  const newEvent = parseConfidenceEvent({
    id: stableId(
      "evt",
      `${newPageBefore.id}:supersedes:${oldPage.id}:${timestamp}`,
    ),
    kind: "supersedes",
    pageId: newPageBefore.id,
    timestamp,
    actor: "human",
    actorId: humanActorId(),
    supersededPageId: oldPage.id,
    reason: options.reason,
  });

  written.add(
    toPosix(
      relative(
        vaultDir,
        appendConfidenceEventAndUpdateProjection(vaultDir, oldPage, oldEvent),
      ),
    ),
  );
  written.add(
    toPosix(
      relative(
        vaultDir,
        appendConfidenceEventAndUpdateProjection(
          vaultDir,
          newPageBefore,
          newEvent,
        ),
      ),
    ),
  );

  updateSupersedingPage(vaultDir, newFile, oldPage.id);
  written.add(newPageBefore.path);
  upsertPageFileInIndex(vaultDir, newFile);

  if (options.commit !== false) {
    await commitFiles(vaultDir, [...written], `supersede ${oldPage.id}`);
  }

  console.log(`Superseded ${oldPage.id} by ${newPageBefore.id}.`);
}

async function migrateToV01Command(options: MigrateOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const pages = scanVaultPages(vaultDir);
  const written: string[] = [];
  const migratedRows: Array<{
    pageId: PageId;
    path: string;
    sourceKey: string;
    score: number;
    events: number;
  }> = [];
  let skipped = 0;
  let decayCheckpoints = 0;
  const now = new Date();

  for (const item of pages) {
    const existing = loadConfidenceEvents(
      vaultDir,
      item.page.path,
      item.page.id,
    );
    if (existing.length > 0) {
      skipped += 1;
      continue;
    }

    const sourceKey =
      item.page.frontmatter.source_hash ??
      item.page.frontmatter.source_path ??
      `src_unknown_${item.page.id}`;
    const timestamp = normalizeEventTimestamp(
      item.page.frontmatter.imported_at ?? item.page.frontmatter.created_at,
    );
    const sourceAdded = parseConfidenceEvent({
      id: stableId("evt", `${item.page.id}:${sourceKey}:${timestamp}`),
      kind: "source_added",
      pageId: item.page.id,
      timestamp,
      actor: "system",
      actorId: "akb-migrate",
      sourceId: stableId("src", sourceKey),
      sourceKey,
      sourceWeight: sourceWeightForPage(vaultDir, item.page),
    });
    const ledgerPath = appendConfidenceEventAndUpdateProjection(
      vaultDir,
      item.page,
      sourceAdded,
      { now },
    );
    written.push(toPosix(relative(vaultDir, ledgerPath)));

    const lastVerifiedAt = item.page.frontmatter.last_verified_at;
    if (typeof lastVerifiedAt === "string" && lastVerifiedAt.length > 0) {
      const verified = parseConfidenceEvent({
        id: stableId("evt", `${item.page.id}:verified:${lastVerifiedAt}`),
        kind: "verified",
        pageId: item.page.id,
        timestamp: normalizeEventTimestamp(lastVerifiedAt),
        actor: "human",
        actorId: humanActorId(),
        verifierType: "human",
        verifierId: humanActorId(),
      });
      written.push(
        toPosix(
          relative(
            vaultDir,
            appendConfidenceEventAndUpdateProjection(
              vaultDir,
              item.page,
              verified,
              { now },
            ),
          ),
        ),
      );
    }
    if (appendDecayCheckpointIfDue(vaultDir, item, now)) {
      decayCheckpoints += 1;
      written.push(
        toPosix(
          relative(
            vaultDir,
            ledgerPathForPageLocal(vaultDir, item.page.path, item.page.id),
          ),
        ),
      );
    }
    const events = loadConfidenceEvents(vaultDir, item.page.path, item.page.id);
    const state = computeConfidenceState(events, {
      now,
      pageType:
        typeof item.page.frontmatter.type === "string"
          ? item.page.frontmatter.type
          : undefined,
    });
    migratedRows.push({
      pageId: item.page.id,
      path: item.page.path,
      sourceKey,
      score: state.score,
      events: events.length,
    });
  }

  if (
    migratedRows.length > 0 ||
    !existsSync(join(vaultDir, ".akb", "migration-report.md"))
  ) {
    const reportPath = join(vaultDir, ".akb", "migration-report.md");
    writeFileSync(reportPath, migrationReportMarkdown(migratedRows, skipped));
    written.push(toPosix(relative(vaultDir, reportPath)));
  }
  rebuildConfidenceProjection(vaultDir, scanVaultPages(vaultDir), now);

  if (written.length > 0 && options.commit !== false) {
    await commitFiles(
      vaultDir,
      [...new Set(written)],
      "migrate confidence ledgers",
    );
  }

  console.log(
    `Migrated ${migratedRows.length} page${migratedRows.length === 1 ? "" : "s"} to v0.1 confidence ledgers (${skipped} skipped, ${decayCheckpoints} decay checkpoint${decayCheckpoints === 1 ? "" : "s"}).`,
  );
}

function appendDecayCheckpointIfDue(
  vaultDir: string,
  item: { page: Page; body?: string; bodyStartLine?: number },
  now: Date,
): boolean {
  const events = loadConfidenceEvents(vaultDir, item.page.path, item.page.id);
  if (events.length === 0) {
    return false;
  }
  const before = computeConfidenceState(events, {
    now: new Date(events.at(-1)?.timestamp ?? now.toISOString()),
    pageType:
      typeof item.page.frontmatter.type === "string"
        ? item.page.frontmatter.type
        : undefined,
  });
  const after = computeConfidenceState(events, {
    now,
    pageType:
      typeof item.page.frontmatter.type === "string"
        ? item.page.frontmatter.type
        : undefined,
  });
  const periodicDue = shouldWriteDecayCheckpoint(events, now);
  const thresholdCrossed = crossedConfidenceThreshold(
    before.score,
    after.score,
  );
  if (!periodicDue && !thresholdCrossed) {
    return false;
  }
  const lastEventAt = events.at(-1)?.timestamp ?? now.toISOString();
  appendConfidenceEventAndUpdateProjection(
    vaultDir,
    item.page,
    parseConfidenceEvent({
      id: stableId("evt", `${item.page.id}:decay:${now.toISOString()}`),
      kind: "decay_checkpoint",
      pageId: item.page.id,
      timestamp: now.toISOString(),
      actor: "system",
      actorId: "akb-decay",
      daysSinceLastEvent: daysBetweenIso(lastEventAt, now),
      appliedDecay: Math.max(0, before.score - after.score),
    }),
    { now },
  );
  return true;
}

function appendConfidenceEventAndUpdateProjection(
  vaultDir: string,
  page: Page,
  event: ConfidenceEvent,
  opts: { now?: Date } = {},
): string {
  const ledgerPath = appendConfidenceEvent(vaultDir, page.path, event);
  updateConfidenceProjectionForPage(vaultDir, page, opts.now);
  return ledgerPath;
}

function updateConfidenceProjectionForPage(
  vaultDir: string,
  page: Page,
  now = new Date(),
): void {
  const events = loadConfidenceEvents(vaultDir, page.path, page.id);
  if (events.length === 0) {
    return;
  }
  const projection = new ConfidenceProjection({
    dbPath: join(vaultDir, ".akb", "index.db"),
  });
  try {
    projection.upsertPage({
      pageId: page.id,
      events,
      state: computeConfidenceState(events, {
        now,
        pageType:
          typeof page.frontmatter.type === "string"
            ? page.frontmatter.type
            : undefined,
      }),
    });
  } finally {
    projection.close();
  }
}

function rebuildConfidenceProjection(
  vaultDir: string,
  pages: ReturnType<typeof scanVaultPages>,
  now = new Date(),
): void {
  const projection = new ConfidenceProjection({
    dbPath: join(vaultDir, ".akb", "index.db"),
  });
  try {
    projection.rebuild(
      pages.flatMap((item) => {
        const events = loadConfidenceEvents(
          vaultDir,
          item.page.path,
          item.page.id,
        );
        if (events.length === 0) {
          return [];
        }
        return [
          {
            pageId: item.page.id,
            events,
            state: computeConfidenceState(events, {
              now,
              pageType:
                typeof item.page.frontmatter.type === "string"
                  ? item.page.frontmatter.type
                  : undefined,
            }),
          },
        ];
      }),
    );
  } finally {
    projection.close();
  }
}

function migrationReportMarkdown(
  rows: Array<{
    pageId: PageId;
    path: string;
    sourceKey: string;
    score: number;
    events: number;
  }>,
  skipped: number,
): string {
  const lines = [
    "# akb v0.1 Migration Report",
    "",
    `Migrated pages: ${rows.length}`,
    `Skipped pages: ${skipped}`,
    "",
    "| page_id | path | source key | events | score |",
    "| --- | --- | --- | ---: | ---: |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.pageId} | ${row.path} | ${row.sourceKey} | ${row.events} | ${row.score.toFixed(4)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function confidenceStateForPage(
  vaultDir: string,
  page: Page,
): ConfidenceState | undefined {
  const events = loadConfidenceEvents(vaultDir, page.path, page.id);
  if (events.length === 0) {
    return undefined;
  }
  return computeConfidenceState(events, {
    pageType:
      typeof page.frontmatter.type === "string"
        ? page.frontmatter.type
        : undefined,
  });
}

const sourceTypeWeights: Record<string, number> = {
  markdown: 1,
  git_commit: 0.9,
  code: 0.9,
  github_pr: 0.8,
  github_issue: 0.6,
  meeting: 0.7,
  pdf_academic: 0.8,
  pdf_vendor: 0.5,
  webpage: 0.3,
  chat: 0.4,
};

function sourceWeightForPage(vaultDir: string, page: Page): number {
  const sourceType = page.frontmatter.source_type;
  if (sourceType === "pdf") {
    return pdfSourceWeight(page);
  }
  if (sourceType && sourceType in sourceTypeWeights) {
    const baseWeight = sourceTypeWeights[sourceType];
    if (
      sourceType === "webpage" &&
      isAuthoritySource(vaultDir, page.frontmatter.source_url)
    ) {
      return Math.min(1, baseWeight + 0.3);
    }
    return baseWeight;
  }
  return page.frontmatter.source_hash || page.frontmatter.source_path
    ? 0.8
    : 0.5;
}

function pdfSourceWeight(page: Page): number {
  const subtype = page.frontmatter.source_subtype;
  if (subtype === "academic") {
    return sourceTypeWeights.pdf_academic;
  }
  if (subtype === "vendor" || subtype === "vendor_whitepaper") {
    return sourceTypeWeights.pdf_vendor;
  }
  return page.frontmatter.source_hash || page.frontmatter.source_path
    ? 0.8
    : sourceTypeWeights.pdf_vendor;
}

function isAuthoritySource(
  vaultDir: string,
  sourceUrl: string | undefined,
): boolean {
  if (!sourceUrl) {
    return false;
  }
  const patterns = readAuthorityDomainPatterns(vaultDir);
  if (patterns.length === 0) {
    return false;
  }
  const candidates = authorityCandidates(sourceUrl);
  return patterns.some((pattern) =>
    candidates.some((candidate) => wildcardMatch(pattern, candidate)),
  );
}

function readAuthorityDomainPatterns(vaultDir: string): string[] {
  return readVaultConfig(vaultDir).sources?.authority_domains ?? [];
}

function authorityCandidates(sourceUrl: string): string[] {
  const candidateUrl = sourceUrl.includes("://")
    ? sourceUrl
    : `https://${sourceUrl}`;
  try {
    const url = new URL(candidateUrl);
    return [
      url.hostname.toLowerCase(),
      `${url.hostname}${url.pathname}`.toLowerCase(),
    ];
  } catch {
    return [sourceUrl.toLowerCase()];
  }
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

async function confidenceShowCommand(
  pageIdOrPath: string,
  options: ConfidenceShowOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const file = resolvePageFile(vaultDir, pageIdOrPath);
  if (!file) {
    throw new Error(`Page not found: ${pageIdOrPath}`);
  }
  const { page } = pageFromFile(vaultDir, file);
  const events = loadConfidenceEvents(vaultDir, page.path, page.id);
  if (events.length === 0) {
    throw new Error(`No confidence ledger found for ${page.id}`);
  }
  const now = parseOptionalNow(options.now);
  const state = computeConfidenceState(events, {
    now,
    pageType:
      typeof page.frontmatter.type === "string"
        ? page.frontmatter.type
        : undefined,
  });
  const report = buildConfidenceReport(page, events, state);

  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printConfidenceReport(report);
}

async function confidenceRecomputeCommand(
  pageIdOrPath: string,
  options: ConfidenceRecomputeOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const file = resolvePageFile(vaultDir, pageIdOrPath);
  if (!file) {
    throw new Error(`Page not found: ${pageIdOrPath}`);
  }
  const now = parseOptionalNow(options.now);
  const { page } = pageFromFile(vaultDir, file);
  const events = loadConfidenceEvents(vaultDir, page.path, page.id);
  if (events.length === 0) {
    throw new Error(`No confidence ledger found for ${page.id}`);
  }
  const state = computeConfidenceState(events, {
    now,
    pageType:
      typeof page.frontmatter.type === "string"
        ? page.frontmatter.type
        : undefined,
  });
  const report = buildConfidenceReport(page, events, state, {
    eventsReplayed: events.length,
  });

  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    `Recomputed ${state.pageId} from ${events.length} event${events.length === 1 ? "" : "s"}.`,
  );
  console.log(`  score: ${state.score.toFixed(4)}`);
  console.log(`  sources: ${state.sourceCount}`);
  console.log(`  contradictions: ${state.contradictionCount}`);
  console.log(`  last event: ${state.lastEventAt}`);
  console.log(`  computed at: ${state.computedAt}`);
}

async function confidenceFileCommand(
  filePath: string,
  options: ConfidenceFileOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const now = parseOptionalNow(options.now);
  const file = normalizeFileReference(vaultDir, filePath);
  const pages = confidencePagesForFile(vaultDir, file, now, options.events);
  const report = {
    file,
    page_count: pages.length,
    pages,
  };

  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printConfidenceFileReport(report);
}

async function confidenceSectionsCommand(
  pageIdOrPath: string,
  options: ConfidenceSectionsOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const file = resolvePageFile(vaultDir, pageIdOrPath);
  if (!file) {
    throw new Error(`Page not found: ${pageIdOrPath}`);
  }
  const now = parseOptionalNow(options.now);
  const { page, body, bodyStartLine } = pageFromFile(vaultDir, file);
  const pageConfidence = confidenceSummaryForPage(vaultDir, page, now, false);
  const sections = markdownSections(body, bodyStartLine).map((section) => ({
    section_id: section.section_id,
    heading: section.heading,
    level: section.level,
    line_start: section.line_start,
    line_end: section.line_end,
    score: pageConfidence.score,
    status: pageConfidence.status,
    confidence_source: "page_ledger_inherited",
    derived_marker_count: derivedMarkerCount(section.content),
  }));
  const report = {
    schema_version: "section-confidence/0.1",
    page_id: page.id,
    path: page.path,
    title: page.title,
    computed_at: pageConfidence.computed_at,
    page_score: pageConfidence.score,
    page_status: pageConfidence.status,
    sections,
  };

  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSectionConfidenceReport(report);
}

async function confidenceReportCommand(
  options: ConfidenceReportOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  if (!options.byFile) {
    throw new Error("Choose a confidence report: --by-file");
  }

  const entries = confidenceByFileEntries(
    vaultDir,
    parseOptionalNow(options.now),
  );
  const lintDir = join(vaultDir, ".akb", "lint");
  mkdirSync(lintDir, { recursive: true });
  writeFileSync(
    join(lintDir, "confidence-by-file.md"),
    renderConfidenceByFileReport(entries),
  );
  console.log(
    `Wrote .akb/lint/confidence-by-file.md for ${entries.length} file reference${entries.length === 1 ? "" : "s"}.`,
  );
}

function printSectionConfidenceReport(report: {
  page_id: PageId;
  title: string;
  sections: Array<{
    section_id: string;
    heading: string;
    level: number;
    line_start: number;
    line_end: number;
    score: number | null;
    status: { flags: string[]; reasons: string[] };
    derived_marker_count: number;
  }>;
}): void {
  console.log(`Section confidence for ${report.page_id} "${report.title}"`);
  for (const section of report.sections) {
    console.log(
      `${section.section_id} L${section.line_start}-L${section.line_end} h${section.level} score=${section.score === null ? "missing" : section.score.toFixed(4)} status=${section.status.flags.join(", ") || "OK"} derived=${section.derived_marker_count}`,
    );
    console.log(`  ${section.heading}`);
  }
}

function markdownSections(
  body: string,
  bodyStartLine: number,
): MarkdownSection[] {
  const lines = body.split(/\r?\n/);
  const headings: Array<{
    index: number;
    level: number;
    heading: string;
    line: number;
  }> = [];
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) {
      continue;
    }
    headings.push({
      index,
      level: match[1].length,
      heading: match[2].trim(),
      line: bodyStartLine + index,
    });
  }
  if (headings.length === 0) {
    return [
      {
        section_id: "sec_body",
        heading: "Body",
        level: 0,
        line_start: bodyStartLine,
        line_end: bodyStartLine + Math.max(lines.length - 1, 0),
        content: body,
      },
    ];
  }
  const seen = new Map<string, number>();
  return headings.map((heading, index) => {
    const next = headings[index + 1];
    const baseId = `sec_${sectionSlug(heading.heading)}`;
    const count = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, count);
    return {
      section_id: count === 1 ? baseId : `${baseId}_${count}`,
      heading: heading.heading,
      level: heading.level,
      line_start: heading.line,
      line_end: next ? next.line - 1 : bodyStartLine + lines.length - 1,
      content: lines.slice(heading.index, next?.index).join("\n"),
    };
  });
}

function sectionSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "section"
  );
}

function derivedMarkerCount(value: string): number {
  return value.match(/<!--\s*akb:derived\b/g)?.length ?? 0;
}

function confidenceByFileEntries(
  vaultDir: string,
  now: Date | undefined,
): ConfidenceByFileEntry[] {
  const pagesByReference = new Map<string, Page[]>();
  for (const item of scanVaultPages(vaultDir)) {
    for (const reference of pageFileReferences(item.page)) {
      const pages = pagesByReference.get(reference) ?? [];
      pages.push(item.page);
      pagesByReference.set(reference, pages);
    }
  }
  return [...pagesByReference.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, pages]) => ({
      file,
      pages: pages
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((page) => confidenceSummaryForPage(vaultDir, page, now, false)),
    }));
}

function confidencePagesForFile(
  vaultDir: string,
  file: string,
  now: Date | undefined,
  includeEvents = false,
): ConfidenceFilePageSummary[] {
  return scanVaultPages(vaultDir)
    .map((item) => item.page)
    .filter((page) => pageFileReferences(page).includes(file))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((page) =>
      confidenceSummaryForPage(vaultDir, page, now, includeEvents),
    );
}

function confidenceSummaryForPage(
  vaultDir: string,
  page: Page,
  now: Date | undefined,
  includeEvents: boolean,
): ConfidenceFilePageSummary {
  const events = loadConfidenceEvents(vaultDir, page.path, page.id);
  if (events.length === 0) {
    return {
      page_id: page.id,
      path: page.path,
      title: page.title,
      score: null,
      source_count: 0,
      contradiction_count: 0,
      computed_at: (now ?? new Date()).toISOString(),
      status: {
        flags: ["MISSING_LEDGER"],
        reasons: ["no confidence ledger found"],
      },
      ...(includeEvents ? { events: [] } : {}),
    };
  }
  const state = computeConfidenceState(events, {
    now,
    pageType:
      typeof page.frontmatter.type === "string"
        ? page.frontmatter.type
        : undefined,
  });
  const report = buildConfidenceReport(page, events, state);
  return {
    page_id: report.page_id,
    path: report.path,
    title: report.title,
    score: report.score,
    source_count: report.source_count,
    contradiction_count: report.contradiction_count,
    superseded_by: report.superseded_by,
    last_verified_at: report.last_verified_at,
    last_event_at: report.last_event_at,
    computed_at: report.computed_at,
    status: report.status,
    ...(includeEvents ? { events: report.events } : {}),
  };
}

function printConfidenceFileReport(report: {
  file: string;
  page_count: number;
  pages: ConfidenceFilePageSummary[];
}): void {
  console.log(report.file);
  console.log("");
  if (report.page_count === 0) {
    console.log("Referenced by 0 pages.");
    return;
  }
  console.log(
    `Referenced by ${report.page_count} page${report.page_count === 1 ? "" : "s"}:`,
  );
  for (const page of report.pages) {
    console.log(`${page.page_id} ${page.path}`);
    console.log(
      `  score: ${page.score === null ? "missing" : page.score.toFixed(4)}`,
    );
    console.log(`  status: ${page.status.flags.join(", ") || "OK"}`);
  }
}

function renderConfidenceByFileReport(
  entries: ConfidenceByFileEntry[],
): string {
  const lines = ["# Confidence By File", ""];
  if (entries.length === 0) {
    lines.push("No file references found.", "");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(`## ${entry.file}`, "");
    lines.push("| Page | Path | Score | Status | Last Event |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const page of entry.pages) {
      lines.push(
        `| ${page.page_id} | ${page.path} | ${page.score === null ? "missing" : page.score.toFixed(4)} | ${page.status.flags.join(", ") || "OK"} | ${page.last_event_at ?? ""} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function pageFileReferences(page: Page): string[] {
  return [
    ...new Set(
      toStringArray(page.frontmatter.references).map((reference) =>
        normalizeReferencePath(reference),
      ),
    ),
  ].sort();
}

function normalizeFileReference(vaultDir: string, filePath: string): string {
  const resolved = resolve(vaultDir, filePath);
  const relativePath = toPosix(relative(vaultDir, resolved));
  if (!relativePath.startsWith("../") && relativePath !== "..") {
    return normalizeReferencePath(relativePath);
  }
  return normalizeReferencePath(filePath);
}

function normalizeReferencePath(value: string): string {
  return toPosix(value.trim()).replace(/^\.\//, "");
}

function buildConfidenceReport(
  page: Page,
  events: ConfidenceEvent[],
  state: ConfidenceState,
  options: { eventsReplayed?: number } = {},
) {
  const sortedEvents = [...events].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  const activeSources = activeSourceSummaries(sortedEvents);
  const contradictionEvents = sortedEvents.filter(
    (event) =>
      event.kind === "contradicted_by" || event.kind === "superseded_by",
  );
  const verificationEvents = sortedEvents.filter(
    (event) => event.kind === "verified",
  );
  const manualOverrideEvent = [...sortedEvents]
    .reverse()
    .find((event) => event.kind === "manual_override");
  const timeDecayEvent = sortedEvents.at(-1);
  const pageType =
    typeof page.frontmatter.type === "string" ? page.frontmatter.type : "note";
  const status = confidenceStatus(state);
  const report = {
    page_id: state.pageId,
    path: page.path,
    title: page.title,
    score: state.score,
    source_count: state.sourceCount,
    contradiction_count: state.contradictionCount,
    superseded_by: state.supersededBy,
    last_verified_at: state.lastVerifiedAt,
    last_event_at: state.lastEventAt,
    computed_at: state.computedAt,
    ...(options.eventsReplayed === undefined
      ? {}
      : { events_replayed: options.eventsReplayed }),
    explanation: {
      base: state.explanation.base,
      base_events: manualOverrideEvent ? [manualOverrideEvent.id] : [],
      source_strength: state.explanation.sourceStrength,
      source_strength_events: activeSources.map((source) => source.event_id),
      active_sources: activeSources,
      contradiction_penalty: state.explanation.contradictionPenalty,
      contradiction_penalty_events: contradictionEvents.map(
        (event) => event.id,
      ),
      time_decay: state.explanation.timeDecay,
      time_decay_event: timeDecayEvent?.id,
      time_decay_basis: {
        last_event_at: state.lastEventAt,
        page_type: pageType,
        days_since_last_event: roundForReport(
          daysBetweenIso(state.lastEventAt, new Date(state.computedAt)),
        ),
      },
      verification_boost: state.explanation.verificationBoost,
      verification_boost_events: verificationEvents.map((event) => event.id),
    },
    events: sortedEvents.map(summarizeConfidenceEvent),
    status,
  };
  return report;
}

function printConfidenceReport(
  report: ReturnType<typeof buildConfidenceReport>,
) {
  console.log(`${report.page_id}  "${report.title}"`);
  console.log(`  current score: ${report.score.toFixed(4)}`);
  console.log("");
  console.log("  breakdown:");
  console.log(
    `    base                  +${report.explanation.base.toFixed(4)}${report.explanation.base_events.length > 0 ? `  (${report.explanation.base_events.join(", ")})` : ""}`,
  );
  console.log(
    `    source_strength       +${report.explanation.source_strength.toFixed(4)}  (${formatActiveSources(report.explanation.active_sources)})`,
  );
  console.log(
    `    contradiction_penalty -${report.explanation.contradiction_penalty.toFixed(4)}  (${report.explanation.contradiction_penalty_events.length} event${report.explanation.contradiction_penalty_events.length === 1 ? "" : "s"})`,
  );
  console.log(
    `    time_decay            -${report.explanation.time_decay.toFixed(4)}  (${report.explanation.time_decay_basis.days_since_last_event} days since last_event, type=${report.explanation.time_decay_basis.page_type})`,
  );
  console.log(
    `    verification_boost    +${report.explanation.verification_boost.toFixed(4)}  (${report.explanation.verification_boost_events.length} event${report.explanation.verification_boost_events.length === 1 ? "" : "s"})`,
  );
  console.log("");
  console.log(`  events: ${report.events.length} total`);
  for (const event of report.events) {
    console.log(
      `    ${event.timestamp.slice(0, 10)}  ${event.kind.padEnd(17)} ${event.summary}`,
    );
  }
  console.log("");
  console.log(`  status: ${report.status.flags.join(", ") || "OK"}`);
  for (const reason of report.status.reasons) {
    console.log(`    reason: ${reason}`);
  }
}

function activeSourceSummaries(events: ConfidenceEvent[]) {
  const sources = new Map<string, { eventId: string; weight: number }>();
  for (const event of events) {
    if (event.kind === "source_added") {
      sources.set(event.sourceId, {
        eventId: event.id,
        weight: event.sourceWeight,
      });
    } else if (event.kind === "source_removed") {
      sources.delete(event.sourceId);
    }
  }
  return [...sources.entries()].map(([sourceId, source]) => ({
    event_id: source.eventId,
    source_id: sourceId,
    weight: source.weight,
  }));
}

function formatActiveSources(
  sources: Array<{ source_id: string; weight: number }>,
): string {
  if (sources.length === 0) {
    return "0 active sources";
  }
  return `${sources.length} source${sources.length === 1 ? "" : "s"}: ${sources
    .map((source) => `${source.source_id} w=${source.weight}`)
    .join(", ")}`;
}

function summarizeConfidenceEvent(event: ConfidenceEvent) {
  const base = {
    id: event.id,
    kind: event.kind,
    timestamp: event.timestamp,
    actor: event.actor,
    actor_id: event.actorId,
  };
  if (event.kind === "source_added") {
    return {
      ...base,
      source_id: event.sourceId,
      source_weight: event.sourceWeight,
      summary: `${event.sourceId} (w=${event.sourceWeight})`,
    };
  }
  if (event.kind === "source_removed") {
    return {
      ...base,
      source_id: event.sourceId,
      reason: event.reason,
      summary: `${event.sourceId} removed: ${event.reason}`,
    };
  }
  if (event.kind === "verified") {
    return {
      ...base,
      verifier_type: event.verifierType,
      verifier_id: event.verifierId,
      reason: event.reason,
      summary: event.verifierId ?? event.actorId ?? event.verifierType,
    };
  }
  if (event.kind === "contradicted_by") {
    return {
      ...base,
      by_source_id: event.bySourceId,
      severity: event.severity,
      summary: `${event.bySourceId} (severity=${event.severity})`,
    };
  }
  if (event.kind === "superseded_by") {
    return {
      ...base,
      superseder_page_id: event.supersederPageId,
      reason: event.reason,
      summary: `${event.supersederPageId}${event.reason ? `: ${event.reason}` : ""}`,
    };
  }
  if (event.kind === "supersedes") {
    return {
      ...base,
      superseded_page_id: event.supersededPageId,
      reason: event.reason,
      summary: `${event.supersededPageId}${event.reason ? `: ${event.reason}` : ""}`,
    };
  }
  if (event.kind === "supersedes_removed") {
    return {
      ...base,
      superseded_page_id: event.supersededPageId,
      replacement_page_id: event.replacementPageId,
      reason: event.reason,
      summary: `${event.supersededPageId} removed${event.replacementPageId ? `, replaced by ${event.replacementPageId}` : ""}`,
    };
  }
  if (event.kind === "decay_checkpoint") {
    return {
      ...base,
      days_since_last_event: event.daysSinceLastEvent,
      applied_decay: event.appliedDecay,
      summary: `${roundForReport(event.daysSinceLastEvent)} days, -${event.appliedDecay}`,
    };
  }
  return {
    ...base,
    new_base: event.newBase,
    reason: event.reason,
    summary: `base=${event.newBase}: ${event.reason}`,
  };
}

function confidenceStatus(state: ConfidenceState) {
  const flags: string[] = [];
  const reasons: string[] = [];
  if (state.score < 0.5) {
    flags.push("NEEDS_REVIEW");
    reasons.push("score < 0.5");
  }
  if (state.supersededBy) {
    flags.push("SUPERSEDED");
    reasons.push(`superseded by ${state.supersededBy}`);
  }
  if (
    state.lastVerifiedAt &&
    daysBetweenIso(state.lastVerifiedAt, new Date(state.computedAt)) > 60
  ) {
    flags.push("STALE");
    reasons.push("last verified > 60 days ago");
  }
  return {
    flags,
    reasons,
  };
}

function roundForReport(value: number): number {
  return Math.round(value * 100) / 100;
}

async function compileCommand(options: CompileOptions): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const config = readVaultConfig(vaultDir);
  const sourceRefs = options.allPending
    ? pendingCompileSources(vaultDir)
    : options.source
      ? [options.source]
      : [];
  if (sourceRefs.length === 0) {
    throw new Error("Choose --source <page> or --all-pending");
  }

  const summary = emptyCompileRunSummary();
  for (const sourceRef of sourceRefs) {
    const patch = await compileOneSource(vaultDir, config, sourceRef, options);
    recordCompileSummary(summary, patch, options.dryRun === true);
  }
  if (options.allPending === true) {
    printCompileSummary(summary);
  }
}

async function compileOneSource(
  vaultDir: string,
  config: Config,
  sourceRef: string,
  options: CompileOptions,
): Promise<PatchDocument> {
  const { apiKey, apiKeyEnv } = configuredLlmApiKey(config.llm);
  const patch = await buildCompilePatch(vaultDir, sourceRef, {
    providerName: config.llm?.provider,
    model: options.model ?? config.llm?.model,
    apiKey,
    apiKeyEnv,
    baseUrl: config.llm?.base_url,
  });
  if (options.dryRun) {
    console.log(
      `Dry run ${patch.source?.pageId ?? sourceRef}: ${patch.changes?.length ?? 0} change${patch.changes?.length === 1 ? "" : "s"}.`,
    );
    return patch;
  }
  if (patchExists(vaultDir, patch.id)) {
    throw new Error(`Patch already exists: ${patch.id}`);
  }
  const patchPath = patchPathFor(vaultDir, patch.id, "proposed");
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, stringifyYaml(patch));
  clearCompileDisabled(vaultDir, patch.source?.pageId ?? sourceRef);
  console.log(`Compiled ${patch.source?.pageId ?? sourceRef} -> ${patch.id}`);
  if (patch.compileMeta?.degraded === true) {
    console.log(
      `Warning: compile degraded (${String(patch.compileMeta.degradedReason ?? "unknown reason")}).`,
    );
  }
  for (const change of patch.changes ?? []) {
    const targetPage =
      change.type === "create" ? change.newPageId : change.pageId;
    console.log(`  - ${change.type} ${targetPage} (${change.relation})`);
  }
  return patch;
}

function emptyCompileRunSummary(): CompileRunSummary {
  return {
    total: 0,
    providerSuccess: 0,
    degraded: 0,
    dryRuns: 0,
    byProvider: new Map(),
    degradedReasons: new Map(),
  };
}

function recordCompileSummary(
  summary: CompileRunSummary,
  patch: PatchDocument,
  dryRun: boolean,
): void {
  summary.total += 1;
  if (dryRun) {
    summary.dryRuns += 1;
  }
  const provider = String(patch.compileMeta?.provider ?? "unknown");
  incrementCount(summary.byProvider, provider);
  if (patch.compileMeta?.degraded === true) {
    summary.degraded += 1;
    incrementCount(
      summary.degradedReasons,
      String(patch.compileMeta.degradedReason ?? "unknown reason"),
    );
    return;
  }
  if (provider !== "heuristic") {
    summary.providerSuccess += 1;
  }
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function printCompileSummary(summary: CompileRunSummary): void {
  console.log("Compile summary:");
  console.log(`  total:            ${summary.total}`);
  console.log(`  provider success: ${summary.providerSuccess}`);
  console.log(`  degraded:         ${summary.degraded}`);
  if (summary.dryRuns > 0) {
    console.log(`  dry runs:         ${summary.dryRuns}`);
  }
  console.log("By provider:");
  for (const [provider, count] of sortedCountEntries(summary.byProvider)) {
    console.log(`  ${provider}: ${count}`);
  }
  if (summary.degradedReasons.size > 0) {
    console.log("Degraded reasons:");
    for (const [reason, count] of sortedCountEntries(summary.degradedReasons)) {
      console.log(`  ${reason}: ${count}`);
    }
  }
}

function sortedCountEntries(
  counts: Map<string, number>,
): Array<[string, number]> {
  return [...counts.entries()].sort(
    ([leftKey, leftCount], [rightKey, rightCount]) =>
      rightCount - leftCount || leftKey.localeCompare(rightKey),
  );
}

function compileStatusCommand(): void {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const proposed = listPatchFiles(vaultDir, "proposed").length;
  const applied = listPatchFiles(vaultDir, "applied").length;
  const rejected = listPatchFiles(vaultDir, "rejected").length;
  const compiled = proposed + applied + rejected;
  const degraded = loadAllPatches(vaultDir).filter(
    (patch) => patch.compileMeta?.degraded === true,
  ).length;
  const disabled = compileDisabledSources(vaultDir).size;
  console.log("Sources:");
  console.log(`  compiled:        ${compiled}`);
  console.log(`  pending:         ${pendingCompileSources(vaultDir).length}`);
  console.log(`  degraded:        ${degraded}`);
  console.log(`  compile-disabled: ${disabled}`);
}

async function compileReplayCommand(patchId: string): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const config = readVaultConfig(vaultDir);
  const patch = readPatch(vaultDir, patchId);
  if (!patch.source?.pageId) {
    throw new Error(`Patch has no source page id: ${patchId}`);
  }
  const patchProvider = patch.compileMeta?.provider;
  const providerName =
    patchProvider === "deepseek" ||
    patchProvider === "openai" ||
    patchProvider === "anthropic"
      ? patchProvider
      : undefined;
  const isProviderPatch =
    providerName !== undefined && patch.compileMeta?.degraded !== true;
  const { apiKey, apiKeyEnv } = configuredLlmApiKey(config.llm);
  const model = isProviderPatch
    ? String(
        patch.compileMeta?.modelId ?? config.llm?.model ?? "deepseek-v4-flash",
      )
    : String(patch.compileMeta?.modelId ?? "heuristic-v0.1");
  const replayed = isProviderPatch
    ? await buildCompilePatch(vaultDir, patch.source.pageId, {
        providerName,
        model,
        apiKey,
        apiKeyEnv,
        baseUrl: config.llm?.base_url,
      })
    : buildHeuristicPatchFromVault(vaultDir, patch.source.pageId, {
        model,
        apiKeyEnv,
      });
  if (
    isProviderPatch &&
    (replayed.compileMeta?.provider !== providerName ||
      replayed.compileMeta?.degraded === true)
  ) {
    throw new Error(`Replay requires successful LLM replay for ${patch.id}`);
  }
  if (normalizedCompilePatch(patch) !== normalizedCompilePatch(replayed)) {
    throw new Error(`Replay differed for ${patch.id}`);
  }
  console.log(`Replay matched ${patch.id}.`);
}

function patchListCommand(): void {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  for (const status of ["proposed", "applied", "rejected"] as const) {
    for (const file of listPatchFiles(vaultDir, status)) {
      const patch = parsePatchDocument(parseYaml(readFileSync(file, "utf8")));
      console.log(`${patch.id} ${status}`);
    }
  }
}

function patchShowCommand(patchId: string): void {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const patch = readPatch(vaultDir, patchId);
  const closeReviewChanges = closeReviewChangeLabels(patch);
  if (closeReviewChanges.length > 0) {
    console.log(
      `Close review required: ${closeReviewChanges.join(", ")}. Confirm with patch apply --reviewed after human review.`,
    );
  }
  console.log(stringifyYaml(patch).trimEnd());
}

function closeReviewChangeLabels(patch: PatchDocument): string[] {
  return (patch.changes ?? [])
    .filter((change) => changeNeedsCloseReview(change))
    .map((change) => {
      if (change.type === "create") {
        return `${change.type}:${change.newPageId}`;
      }
      return `${change.type}:${change.pageId}`;
    });
}

function changeNeedsCloseReview(change: PatchChange): boolean {
  if (change.type === "confidence_only") {
    return false;
  }
  return change.needsCloseReview === true || change.classifyConfidence < 0.5;
}

async function patchApplyCommand(
  patchId: string,
  options: PatchApplyOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const patch = readPatch(vaultDir, patchId, "proposed");
  validatePatchForApply(vaultDir, patch);
  const closeReviewChanges = closeReviewChangeLabels(patch);
  if (closeReviewChanges.length > 0 && options.reviewed !== true) {
    throw new Error(
      `Patch ${patch.id} requires --reviewed after close review for low-confidence change(s): ${closeReviewChanges.join(", ")}`,
    );
  }
  const written = new Set<string>();
  for (const change of patch.changes ?? []) {
    if (change.type === "modify") {
      const file = resolvePageFile(vaultDir, change.pageId);
      if (!file) {
        throw new Error(`Patch target page not found: ${change.pageId}`);
      }
      const parsed = pageFromFile(vaultDir, file);
      const nextBody =
        change.operation === "replace_section"
          ? replaceMarkdownSection(
              parsed.body,
              String(change.targetSection ?? ""),
              change.content,
            )
          : change.operation === "insert_after_section"
            ? insertAfterMarkdownSection(
                parsed.body,
                String(change.targetSection ?? ""),
                change.content,
              )
            : `${parsed.body.trimEnd()}\n\n${change.content.trimEnd()}`;
      writeMarkdownFile(file, parsed.page.frontmatter, nextBody);
      written.add(parsed.page.path);
      appendPatchConfidenceEvent(vaultDir, parsed.page, change, patch);
      written.add(
        toPosix(
          relative(
            vaultDir,
            ledgerPathForPageLocal(vaultDir, parsed.page.path, parsed.page.id),
          ),
        ),
      );
      const updated = pageFromFile(vaultDir, file);
      const index = new SearchIndex({
        dbPath: join(vaultDir, ".akb", "index.db"),
      });
      try {
        index.upsertPage(updated.page, updated.body, {
          bodyStartLine: updated.bodyStartLine,
        });
      } finally {
        index.close();
      }
    } else if (change.type === "confidence_only") {
      const file = resolvePageFile(vaultDir, change.pageId);
      if (!file) {
        throw new Error(`Patch target page not found: ${change.pageId}`);
      }
      const { page } = pageFromFile(vaultDir, file);
      appendPatchConfidenceEvent(vaultDir, page, change, patch);
      written.add(
        toPosix(
          relative(
            vaultDir,
            ledgerPathForPageLocal(vaultDir, page.path, page.id),
          ),
        ),
      );
    } else if (change.type === "create") {
      const targetRelative = createChangeRelativePath(change);
      assertCreatePathInsidePages(vaultDir, targetRelative);
      const file = join(vaultDir, targetRelative);
      mkdirSync(dirname(file), { recursive: true });
      const content = ensureFrontmatter(change.content, {
        id: change.newPageId as PageId,
      });
      writeFileSync(file, content);
      written.add(targetRelative);
      const created = pageFromFile(vaultDir, file);
      appendPatchConfidenceEvent(vaultDir, created.page, change, patch);
      written.add(
        toPosix(
          relative(
            vaultDir,
            ledgerPathForPageLocal(
              vaultDir,
              created.page.path,
              created.page.id,
            ),
          ),
        ),
      );
      if (change.supersedes) {
        const supersededFile = resolvePageFile(vaultDir, change.supersedes);
        if (!supersededFile) {
          throw new Error(`Patch target page not found: ${change.supersedes}`);
        }
        const superseded = pageFromFile(vaultDir, supersededFile);
        appendPatchConfidenceEvent(
          vaultDir,
          superseded.page,
          {
            type: "modify",
            pageId: String(superseded.page.id),
            operation: "append_section",
            relation: "supersede",
            classifyConfidence: change.classifyConfidence,
            reasoning: change.reasoning,
            content: "",
            confidenceImpact: {
              kind: "superseded_by",
              supersederPageId: created.page.id,
            },
          },
          patch,
        );
        written.add(
          toPosix(
            relative(
              vaultDir,
              ledgerPathForPageLocal(
                vaultDir,
                superseded.page.path,
                superseded.page.id,
              ),
            ),
          ),
        );
      }
      const index = new SearchIndex({
        dbPath: join(vaultDir, ".akb", "index.db"),
      });
      try {
        index.upsertPage(created.page, created.body, {
          bodyStartLine: created.bodyStartLine,
        });
      } finally {
        index.close();
      }
    }
  }
  patch.status = "applied";
  const proposedPath = patchPathFor(vaultDir, patch.id, "proposed");
  const appliedPath = patchPathFor(vaultDir, patch.id, "applied");
  mkdirSync(dirname(appliedPath), { recursive: true });
  writeFileSync(proposedPath, stringifyYaml(patch));
  renameSync(proposedPath, appliedPath);
  written.add(toPosix(relative(vaultDir, appliedPath)));
  if (options.commit !== false) {
    await commitFiles(vaultDir, [...written], `apply ${patch.id}`);
  }
  console.log(`Applied ${patch.id}.`);
}

async function patchRejectCommand(
  patchId: string,
  options: PatchRejectOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const patch = readPatch(vaultDir, patchId, "proposed");
  patch.status = "rejected";
  patch.rejectedAt = new Date().toISOString();
  if (options.reason) {
    patch.rejectReason = options.reason;
  }
  const proposedPath = patchPathFor(vaultDir, patch.id, "proposed");
  const rejectedPath = patchPathFor(vaultDir, patch.id, "rejected");
  const proposedRelative = toPosix(relative(vaultDir, proposedPath));
  if (existsSync(rejectedPath)) {
    throw new Error(`Rejected patch already exists: ${patch.id}`);
  }
  const proposedWasTracked = isGitTrackedPath(vaultDir, proposedRelative);
  mkdirSync(dirname(rejectedPath), { recursive: true });
  writeFileSync(proposedPath, stringifyYaml(patch));
  renameSync(proposedPath, rejectedPath);
  const written = [toPosix(relative(vaultDir, rejectedPath))];
  if (proposedWasTracked) {
    written.push(proposedRelative);
  }
  if (options.commit !== false) {
    await commitFiles(vaultDir, written, `reject ${patch.id}`);
  }
  console.log(`Rejected ${patch.id}.`);
}

function isGitTrackedPath(vaultDir: string, path: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", path], {
      cwd: vaultDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function lineageCommand(
  target: string | undefined,
  options: { reverse?: string },
): void {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const source = options.reverse;
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  if (source) {
    try {
      console.log(`${source} influenced:`);
      const rows = index.getReverseChunkLineage(source);
      for (const row of rows) {
        console.log(
          `  ${row.chunkId} (${row.method}) <- ${row.sourceChunkId ?? row.sourceUnitId ?? "unknown"} via ${row.patchId}`,
        );
      }
    } finally {
      index.close();
    }
    return;
  }
  if (!target) {
    index.close();
    throw new Error("Choose a page/chunk or --reverse <source>");
  }
  try {
    console.log(`${target}:`);
    if (target.includes(":c")) {
      for (const row of index.getChunkLineage(target)) {
        console.log(
          `  ${target} (${row.method}) <- ${formatLineageSource(index, row.sourceChunkId, row.sourceUnitId)} via ${row.patchId}`,
        );
      }
      return;
    }
    const file = resolvePageFile(vaultDir, target);
    if (!file) {
      throw new Error(`Page not found: ${target}`);
    }
    const { page } = pageFromFile(vaultDir, file);
    for (const chunk of index.getChunksForPage(page.id)) {
      if (chunk.origin.kind !== "derived") {
        continue;
      }
      for (const row of index.getChunkLineage(chunk.id)) {
        console.log(
          `  ${chunk.id} (${row.method}) <- ${formatLineageSource(index, row.sourceChunkId, row.sourceUnitId)} via ${row.patchId}`,
        );
      }
    }
  } finally {
    index.close();
  }
}

function formatLineageSource(
  index: SearchIndex,
  sourceChunkId: string | null,
  sourceUnitId: string | null,
): string {
  if (!sourceChunkId) {
    return sourceUnitId ?? "unknown";
  }
  const sourceChunk = index.getChunkById(sourceChunkId);
  if (!sourceChunk) {
    return sourceChunkId;
  }
  return `${sourceChunkId} L${sourceChunk.lineStart}-L${sourceChunk.lineEnd}`;
}

function assertVault(dir: string): void {
  if (
    !existsSync(join(dir, ".akb", "config.yaml")) ||
    !existsSync(join(dir, "pages"))
  ) {
    throw new Error(`Not an akb vault: ${dir}`);
  }
}

function readVaultConfig(vaultDir: string): Config {
  const configPath = join(vaultDir, ".akb", "config.yaml");
  return ConfigSchema.parse(parseYaml(readFileSync(configPath, "utf8")));
}

function markdownFiles(path: string, recursive = true): string[] {
  if (!existsSync(path)) {
    throw new Error(`Path does not exist: ${path}`);
  }
  const stat = statSync(path);
  if (stat.isFile()) {
    if (extname(path) !== ".md") {
      console.warn(`Skipping non-markdown file: ${path}`);
      return [];
    }
    return [path];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...markdownFiles(next, recursive));
      }
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(next);
    }
  }
  return files.sort();
}

function markdownFilesForIngest(
  path: string,
  recursive: boolean,
  includeHidden: boolean,
): string[] {
  if (!existsSync(path)) {
    throw new Error(`Path does not exist: ${path}`);
  }
  if (!includeHidden && isHiddenName(basename(path))) {
    return [];
  }
  const stat = statSync(path);
  if (stat.isFile()) {
    if (extname(path) !== ".md") {
      console.warn(`Skipping non-markdown file: ${path}`);
      return [];
    }
    return [path];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!includeHidden && isHiddenName(entry.name)) {
      continue;
    }
    const next = join(path, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...markdownFilesForIngest(next, recursive, includeHidden));
      }
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(next);
    }
  }
  return files.sort();
}

function hiddenEntriesForIngest(path: string, recursive: boolean): string[] {
  if (!existsSync(path)) {
    throw new Error(`Path does not exist: ${path}`);
  }
  const stat = statSync(path);
  if (stat.isFile()) {
    return isHiddenName(basename(path)) ? [basename(path)] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const hiddenEntries = new Set<string>();
  const visitDirectory = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = join(directory, entry.name);
      if (isHiddenName(entry.name)) {
        hiddenEntries.add(toPosix(relative(path, next)));
        continue;
      }
      if (entry.isDirectory() && recursive) {
        visitDirectory(next);
      }
    }
  };
  visitDirectory(path);
  return [...hiddenEntries].sort();
}

async function shouldIncludeHiddenEntries(
  hiddenEntries: string[],
  includeHiddenOption: boolean,
): Promise<boolean> {
  if (hiddenEntries.length === 0) {
    return includeHiddenOption;
  }
  console.log("Hidden files/directories found:");
  for (const entry of hiddenEntries) {
    console.log(`  - ${entry}`);
  }
  if (includeHiddenOption) {
    console.log("Including hidden files/directories.");
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Skipping hidden files/directories by default.");
    return false;
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(
      "Import hidden files/directories? [y/N] ",
    );
    const includeHidden = answer.trim().toLowerCase() === "y";
    console.log(
      includeHidden
        ? "Including hidden files/directories."
        : "Skipping hidden files/directories by default.",
    );
    return includeHidden;
  } finally {
    readline.close();
  }
}

function nonHiddenRelativePath(path: string): string {
  return toPosix(path)
    .split("/")
    .map((segment) => {
      if (!isHiddenName(segment)) {
        return segment;
      }
      return segment.replace(/^\.+/, "") || "hidden";
    })
    .join("/");
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

function readUtf8File(path: string): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    return undefined;
  }
}

function ingestProgressLine(
  current: number,
  total: number,
  sourcePath: string,
): string {
  const width = 20;
  const filled =
    total <= 0 ? width : Math.min(width, Math.round((current / total) * width));
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  return `Ingest [${bar}] ${current}/${total} ${toPosix(sourcePath)}`;
}

function pagePathByIdMap(vaultDir: string): Map<PageId, string> {
  const paths = new Map<PageId, string>();
  for (const file of markdownFiles(join(vaultDir, "pages"))) {
    try {
      const pageId = parseMarkdown(readFileSync(file, "utf8")).frontmatter.id;
      if (typeof pageId === "string") {
        paths.set(pageId as PageId, file);
      }
    } catch {}
  }
  return paths;
}

function findPagePathById(
  vaultDir: string,
  pageId: PageId,
): string | undefined {
  for (const file of markdownFiles(join(vaultDir, "pages"))) {
    try {
      if (parseMarkdown(readFileSync(file, "utf8")).frontmatter.id === pageId) {
        return file;
      }
    } catch {}
  }
  return undefined;
}

function resolvePageFile(
  vaultDir: string,
  pageIdOrPath: string,
): string | undefined {
  if (pageIdOrPath.startsWith("page_")) {
    return findPagePathById(vaultDir, pageIdOrPath as PageId);
  }
  const direct = resolve(vaultDir, pageIdOrPath);
  if (existsSync(direct)) {
    return direct;
  }
  const underPages = resolve(vaultDir, "pages", pageIdOrPath);
  if (existsSync(underPages)) {
    return underPages;
  }
  return undefined;
}

function resolvePageFiles(vaultDir: string, pageOrGlob: string): string[] {
  if (hasGlob(pageOrGlob)) {
    const matcher = globToRegExp(toPosix(pageOrGlob));
    return markdownFiles(join(vaultDir, "pages")).filter((file) => {
      const relativePath = toPosix(relative(vaultDir, file));
      return matcher.test(relativePath);
    });
  }
  const file = resolvePageFile(vaultDir, pageOrGlob);
  return file ? [file] : [];
}

function scanVaultPages(
  vaultDir: string,
): Array<{ page: Page; body: string; bodyStartLine: number }> {
  return markdownFiles(join(vaultDir, "pages")).map((file) =>
    pageFromFile(vaultDir, file),
  );
}

function pageLookup(pages: Page[]): Set<string> {
  const lookup = new Set<string>();
  for (const page of pages) {
    for (const target of pageTargets(page)) {
      lookup.add(target);
    }
  }
  return lookup;
}

function pageTargetLookup(pages: Page[]): Map<string, PageId> {
  const lookup = new Map<string, PageId>();
  for (const page of pages) {
    for (const target of pageTargets(page)) {
      lookup.set(target, page.id);
    }
  }
  return lookup;
}

function pageTargets(page: Page): string[] {
  return [
    page.id,
    page.title,
    page.path,
    page.path.replace(/^pages\//, ""),
    page.path.replace(/^pages\//, "").replace(/\.md$/, ""),
    basename(page.path, ".md"),
    ...toStringArray(page.frontmatter.aliases),
  ].map((value) => normalizeWikiTarget(value));
}

function extractWikiLinks(body: string): string[] {
  const links: string[] = [];
  const pattern = /\[\[([^\]]+)]]/g;
  for (const match of body.matchAll(pattern)) {
    const target = match[1]?.split("|")[0]?.split("#")[0]?.trim();
    if (target) {
      links.push(target);
    }
  }
  return links;
}

function normalizeWikiTarget(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\.md$/, "").toLowerCase();
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function findSupersessionCycles(pages: Page[]): PageId[][] {
  const edges = new Map<PageId, PageId>();
  const pageIds = new Set(pages.map((page) => page.id));
  for (const page of pages) {
    const supersedes = page.frontmatter.supersedes;
    if (typeof supersedes === "string" && pageIds.has(supersedes as PageId)) {
      edges.set(page.id, supersedes as PageId);
    }
  }

  const cycles: PageId[][] = [];
  const seen = new Set<PageId>();
  for (const start of edges.keys()) {
    if (seen.has(start)) {
      continue;
    }
    const path: PageId[] = [];
    const indexByPage = new Map<PageId, number>();
    let current: PageId | undefined = start;
    while (current) {
      if (indexByPage.has(current)) {
        const cycle = path.slice(indexByPage.get(current));
        cycles.push([...cycle, current]);
        break;
      }
      if (seen.has(current)) {
        break;
      }
      indexByPage.set(current, path.length);
      path.push(current);
      current = edges.get(current);
    }
    for (const pageId of path) {
      seen.add(pageId);
    }
  }
  return cycles;
}

function isOlderThanDays(
  timestamp: string,
  days: number,
  now = new Date(),
): boolean {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return false;
  }
  return now.getTime() - time > days * 24 * 60 * 60 * 1000;
}

function isAtLeastDaysOld(
  timestamp: string,
  days: number,
  now = new Date(),
): boolean {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return false;
  }
  return now.getTime() - time >= days * 24 * 60 * 60 * 1000;
}

function pageFromFile(
  vaultDir: string,
  file: string,
): { page: Page; body: string; bodyStartLine: number } {
  const content = readFileSync(file, "utf8");
  const parsed = parseMarkdown(content);
  const frontmatter = normalizeFrontmatter(parsed.frontmatter);
  const page = {
    id: frontmatter.id,
    path: toPosix(relative(vaultDir, file)),
    title: frontmatter.title,
    frontmatter,
  };
  return { page, body: parsed.body, bodyStartLine: parsed.bodyStartLine };
}

function updateSupersedingPage(
  vaultDir: string,
  file: string,
  supersededPageId: PageId,
): void {
  const content = readFileSync(file, "utf8");
  const parsed = parseMarkdown(content);
  const frontmatter = normalizeLooseFrontmatter({
    ...parsed.frontmatter,
    supersedes: supersededPageId,
    updated_at: new Date().toISOString().slice(0, 10),
  });
  const body = addSupersedeNotice(parsed.body, supersededPageId);
  writeMarkdownFile(file, frontmatter, body);
  pageFromFile(vaultDir, file);
}

function unlinkSupersedingPage(file: string, supersededPageId: PageId): void {
  const content = readFileSync(file, "utf8");
  const parsed = parseMarkdown(content);
  const nextFrontmatter = { ...parsed.frontmatter };
  delete nextFrontmatter.supersedes;
  const frontmatter = normalizeLooseFrontmatter({
    ...nextFrontmatter,
    updated_at: new Date().toISOString().slice(0, 10),
  });
  writeMarkdownFile(
    file,
    frontmatter,
    removeSupersedeNotice(parsed.body, supersededPageId),
  );
}

function addSupersedeNotice(body: string, supersededPageId: PageId): string {
  const notice = `> Supersedes [[${supersededPageId}]].`;
  if (body.includes(notice)) {
    return body;
  }
  return `${notice}\n\n${body.trimStart()}`;
}

function removeSupersedeNotice(body: string, supersededPageId: PageId): string {
  const noticePattern = new RegExp(
    `^>\\s*Supersedes\\s+\\[\\[${escapeRegExp(supersededPageId)}\\]\\](?:[\\s,.].*)?$`,
  );
  return body
    .split("\n")
    .filter((line) => !noticePattern.test(line))
    .join("\n")
    .replace(/^\s*\n/, "");
}

function upsertPageFileInIndex(vaultDir: string, file: string): void {
  const { page, body, bodyStartLine } = pageFromFile(vaultDir, file);
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  try {
    index.upsertPage(page, body, { bodyStartLine });
  } finally {
    index.close();
  }
}

function writeMarkdownFile(
  file: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  writeFileSync(
    file,
    `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${body.trimEnd()}\n`,
  );
}

function normalizeFrontmatter(
  frontmatter: Record<string, unknown>,
): PageFrontmatter {
  return PageFrontmatterSchema.parse(normalizeLooseFrontmatter(frontmatter));
}

function normalizeLooseFrontmatter(
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = Object.fromEntries(
    Object.entries(frontmatter).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
  return normalized;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function parseRatio(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("must be a number between 0 and 1");
  }
  return parsed;
}

function parseFormat(value: string): "text" | "json" {
  if (value !== "text" && value !== "json") {
    throw new InvalidArgumentError("must be text or json");
  }
  return value;
}

function hasGlob(value: string): boolean {
  return /[*?[\]]/.test(value);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeEventTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(`${value}T00:00:00.000Z`).toISOString();
    }
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function humanActorId(): string {
  return "human:local";
}

function parseOptionalNow(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw new Error(
      `Invalid --now timestamp: ${value} (expected ISO timestamp with timezone)`,
    );
  }
  const now = new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`Invalid --now timestamp: ${value}`);
  }
  return now;
}

function stableId(prefix: "evt" | "src", input: string): string {
  let hash = 0x811c9dc5;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = Math.abs(hash).toString(36).padStart(12, "0").slice(0, 12);
  return `${prefix}_${suffix}`;
}

function shouldWriteDecayCheckpoint(
  events: ReturnType<typeof loadConfidenceEvents>,
  now: Date,
): boolean {
  const lastDecay = [...events]
    .reverse()
    .find((event) => event.kind === "decay_checkpoint");
  if (!lastDecay) {
    return true;
  }
  return daysBetweenIso(lastDecay.timestamp, now) >= 14;
}

function crossedConfidenceThreshold(before: number, after: number): boolean {
  return [0.7, 0.5, 0.3].some(
    (threshold) => before >= threshold && after < threshold,
  );
}

function daysBetweenIso(timestamp: string, now: Date): number {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return 0;
  }
  return Math.max(0, (now.getTime() - time) / (24 * 60 * 60 * 1000));
}

function extractRunbookSteps(
  body: string,
): Array<{ index: number; language: string; command: string }> {
  const steps: Array<{ index: number; language: string; command: string }> = [];
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let language = "";
  let buffer: string[] = [];
  for (const line of lines) {
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence && !inFence) {
      inFence = true;
      language = fence[1]?.toLowerCase() ?? "";
      buffer = [];
      continue;
    }
    if (line.trim() === "```" && inFence) {
      const command = buffer.join("\n").trim();
      if (
        command.length > 0 &&
        ["", "bash", "sh", "shell", "zsh"].includes(language)
      ) {
        steps.push({ index: steps.length + 1, language, command });
      }
      inFence = false;
      language = "";
      buffer = [];
      continue;
    }
    if (inFence) {
      buffer.push(line);
    }
  }
  return steps;
}

function runShellCommand(
  command: string,
  cwd: string,
): { ok: true; summary: string } | { ok: false; summary: string } {
  const shell = process.env.SHELL ?? "/bin/sh";
  const summary = firstCommandLine(command);
  try {
    execFileSync(shell, ["-lc", command], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, summary };
  } catch {
    return { ok: false, summary };
  }
}

function firstCommandLine(command: string): string {
  return (
    command
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "command failed"
  );
}

function linkedTestPageIds(vaultDir: string): PageId[] {
  const pageIds = new Set<PageId>();
  for (const file of linkedTestCandidateFiles(vaultDir)) {
    const content = readUtf8File(file);
    if (!content) {
      continue;
    }
    for (const match of content.matchAll(/@akb-page\s+(page_[a-z0-9]{12})/g)) {
      pageIds.add(PageIdSchema.parse(match[1]));
    }
  }
  return [...pageIds].sort();
}

function linkedTestCandidateFiles(root: string): string[] {
  const ignoredDirectories = new Set([
    ".akb",
    ".git",
    "coverage",
    "dist",
    "node_modules",
  ]);
  const extensions = new Set([
    ".cjs",
    ".cts",
    ".js",
    ".jsx",
    ".md",
    ".mjs",
    ".mts",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
  ]);
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (ignoredDirectories.has(entry)) {
        continue;
      }
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile() && extensions.has(extname(path))) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

type RuntimeSignalMode = "verified" | "contradicted_by";

function runtimeSignalMode(kind: string): RuntimeSignalMode {
  return /(?:failure|failed|error)$/i.test(kind)
    ? "contradicted_by"
    : "verified";
}

function runtimeContradictionSeverity(kind: string): "minor" | "major" {
  if (/^ci_/i.test(kind)) {
    return "minor";
  }
  if (/^test_|^runbook_/i.test(kind)) {
    return "major";
  }
  return /(?:failure|failed|error)$/i.test(kind) ? "minor" : "major";
}

function writeRuntimeConfidenceEvents(
  vaultDir: string,
  targets: Array<{ page: Page; body: string; bodyStartLine: number }>,
  opts: {
    actorId: string;
    evidence: string;
    signalKind: string;
    mode: RuntimeSignalMode;
    timestamp?: Date;
  },
): string[] {
  const timestamp = (opts.timestamp ?? new Date()).toISOString();
  const written: string[] = [];
  for (const target of targets) {
    const event =
      opts.mode === "verified"
        ? parseConfidenceEvent({
            id: stableId(
              "evt",
              `${target.page.id}:${opts.signalKind}:${opts.actorId}:${opts.evidence}:${timestamp}`,
            ),
            kind: "verified",
            pageId: target.page.id,
            timestamp,
            actor: "system",
            actorId: opts.actorId,
            verifierType: "agent",
            verifierId: opts.actorId,
            reason: `${opts.signalKind}: ${opts.evidence}`,
          })
        : parseConfidenceEvent({
            id: stableId(
              "evt",
              `${target.page.id}:${opts.signalKind}:${opts.actorId}:${opts.evidence}:${timestamp}`,
            ),
            kind: "contradicted_by",
            pageId: target.page.id,
            timestamp,
            actor: "system",
            actorId: opts.actorId,
            bySourceId: stableId(
              "src",
              `${opts.signalKind}:${opts.actorId}:${opts.evidence}`,
            ),
            severity: runtimeContradictionSeverity(opts.signalKind),
            reason: `${opts.signalKind}: ${opts.evidence}`,
          });
    written.push(
      toPosix(
        relative(
          vaultDir,
          appendConfidenceEventAndUpdateProjection(
            vaultDir,
            target.page,
            event,
          ),
        ),
      ),
    );
  }
  return written;
}

function pendingCompileSources(vaultDir: string): string[] {
  const patchedSources = new Set(
    loadAllPatches(vaultDir)
      .map((patch) => patch.source?.pageId)
      .filter((value): value is string => typeof value === "string"),
  );
  const disabledSources = compileDisabledSources(vaultDir);
  return scanVaultPages(vaultDir)
    .map((item) => item.page.id)
    .filter((pageId) => !patchedSources.has(pageId))
    .filter((pageId) => !disabledSources.has(pageId));
}

function recordCompileDisabled(
  vaultDir: string,
  pagePaths: string[],
): string[] {
  const disabled = compileDisabledSources(vaultDir);
  const before = disabled.size;
  for (const path of pagePaths) {
    const file = join(vaultDir, path);
    if (existsSync(file)) {
      disabled.add(pageFromFile(vaultDir, file).page.id);
    }
  }
  if (disabled.size === before) {
    return [];
  }
  writeFileSync(
    compileDisabledPath(vaultDir),
    `${JSON.stringify([...disabled].sort(), null, 2)}\n`,
  );
  return [toPosix(relative(vaultDir, compileDisabledPath(vaultDir)))];
}

function clearCompileDisabled(vaultDir: string, pageId: string): void {
  const path = compileDisabledPath(vaultDir);
  if (!existsSync(path)) {
    return;
  }
  const disabled = compileDisabledSources(vaultDir);
  if (!disabled.delete(pageId)) {
    return;
  }
  writeFileSync(path, `${JSON.stringify([...disabled].sort(), null, 2)}\n`);
}

function compileDisabledSources(vaultDir: string): Set<string> {
  const path = compileDisabledPath(vaultDir);
  if (!existsSync(path)) {
    return new Set();
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const currentPages = new Set(
    scanVaultPages(vaultDir).map((item) => String(item.page.id)),
  );
  return new Set(
    Array.isArray(parsed)
      ? parsed
          .filter((value): value is string => typeof value === "string")
          .filter((value) => currentPages.has(value))
      : [],
  );
}

function compileDisabledPath(vaultDir: string): string {
  return join(vaultDir, ".akb", "compile-disabled.json");
}

function buildCompilePatch(
  vaultDir: string,
  sourceRef: string,
  options: {
    providerName?: LlmProviderName;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
  } = {},
): Promise<PatchDocument> {
  const sourceFile = resolvePageFile(vaultDir, sourceRef);
  if (!sourceFile) {
    throw new Error(`Compile source not found: ${sourceRef}`);
  }
  const model = options.model ?? "heuristic-v0.1";
  const source = pageFromFile(vaultDir, sourceFile);
  return buildProviderCompilePatch({
    source,
    candidates: scanVaultPages(vaultDir),
    providerName: options.providerName,
    model,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv,
  }) as Promise<PatchDocument>;
}

function buildHeuristicPatchFromVault(
  vaultDir: string,
  sourceRef: string,
  options: { model?: string; apiKeyEnv?: string } = {},
): PatchDocument {
  const sourceFile = resolvePageFile(vaultDir, sourceRef);
  if (!sourceFile) {
    throw new Error(`Compile source not found: ${sourceRef}`);
  }
  const model = options.model ?? "heuristic-v0.1";
  return buildHeuristicCompilePatch({
    source: pageFromFile(vaultDir, sourceFile),
    candidates: scanVaultPages(vaultDir),
    model,
    apiKeyEnv: options.apiKeyEnv,
  }) as PatchDocument;
}

function patchPathFor(
  vaultDir: string,
  patchId: string,
  status: "proposed" | "applied" | "rejected",
): string {
  if (status === "proposed") {
    return join(vaultDir, ".akb", "patches", `${patchId}.yaml`);
  }
  return join(vaultDir, ".akb", "patches", status, `${patchId}.yaml`);
}

function listPatchFiles(
  vaultDir: string,
  status: "proposed" | "applied" | "rejected",
): string[] {
  const dir =
    status === "proposed"
      ? join(vaultDir, ".akb", "patches")
      : join(vaultDir, ".akb", "patches", status);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => join(dir, file))
    .filter((file) => statSync(file).isFile())
    .sort();
}

function readPatch(
  vaultDir: string,
  patchId: string,
  status?: "proposed" | "applied" | "rejected",
): PatchDocument {
  const statuses = status
    ? [status]
    : (["proposed", "applied", "rejected"] as const);
  for (const candidateStatus of statuses) {
    const path = patchPathFor(vaultDir, patchId, candidateStatus);
    if (existsSync(path)) {
      return parsePatchDocument(parseYaml(readFileSync(path, "utf8")));
    }
  }
  throw new Error(`Patch not found: ${patchId}`);
}

function loadAllPatches(vaultDir: string): PatchDocument[] {
  return (["proposed", "applied", "rejected"] as const).flatMap((status) =>
    listPatchFiles(vaultDir, status).map((file) =>
      parsePatchDocument(parseYaml(readFileSync(file, "utf8"))),
    ),
  );
}

function patchExists(vaultDir: string, patchId: string): boolean {
  return (["proposed", "applied", "rejected"] as const).some((status) =>
    existsSync(patchPathFor(vaultDir, patchId, status)),
  );
}

function parsePatchDocument(value: unknown): PatchDocument {
  if (!isRecord(value)) {
    throw new Error("Invalid patch: expected YAML object");
  }
  if (typeof value.id !== "string" || !/^patch_[a-z0-9_]+$/i.test(value.id)) {
    throw new Error("Invalid patch: invalid id");
  }
  if (
    value.status !== "proposed" &&
    value.status !== "applied" &&
    value.status !== "rejected"
  ) {
    throw new Error("Invalid patch: invalid status");
  }
  if (value.source !== undefined && !isRecord(value.source)) {
    throw new Error("Invalid patch: source must be an object");
  }
  if (
    isRecord(value.source) &&
    typeof value.source.pageId === "string" &&
    !isValidPageId(value.source.pageId)
  ) {
    throw new Error("Invalid patch: invalid source pageId");
  }
  if (!Array.isArray(value.changes)) {
    throw new Error("Invalid patch: changes must be an array");
  }
  for (const change of value.changes) {
    parsePatchChange(change);
  }
  return value as unknown as PatchDocument;
}

function parsePatchChange(change: unknown): PatchChange {
  if (!isRecord(change)) {
    throw new Error("Invalid patch: change must be an object");
  }
  if (change.type === "modify") {
    if (!isValidPageId(change.pageId)) {
      throw new Error("Invalid patch: invalid change pageId");
    }
    if (
      change.operation !== "append_section" &&
      change.operation !== "replace_section" &&
      change.operation !== "insert_after_section"
    ) {
      throw new Error("Invalid patch: unsupported modify operation");
    }
    if (
      (change.operation === "replace_section" ||
        change.operation === "insert_after_section") &&
      (typeof change.targetSection !== "string" ||
        change.targetSection.trim().length === 0)
    ) {
      throw new Error(
        "Invalid patch: section operation requires targetSection",
      );
    }
    if (typeof change.relation !== "string" || change.relation.length === 0) {
      throw new Error("Invalid patch: missing relation");
    }
    if (typeof change.content !== "string") {
      throw new Error("Invalid patch: modify content must be a string");
    }
    if (
      typeof change.classifyConfidence !== "number" ||
      !Number.isFinite(change.classifyConfidence) ||
      change.classifyConfidence < 0 ||
      change.classifyConfidence > 1
    ) {
      throw new Error("Invalid patch: classifyConfidence must be 0-1");
    }
    if (typeof change.reasoning !== "string") {
      throw new Error("Invalid patch: reasoning must be a string");
    }
    if (
      change.needsCloseReview !== undefined &&
      typeof change.needsCloseReview !== "boolean"
    ) {
      throw new Error("Invalid patch: needsCloseReview must be a boolean");
    }
    return change as PatchChange;
  }
  if (change.type === "confidence_only") {
    if (!isValidPageId(change.pageId)) {
      throw new Error("Invalid patch: invalid change pageId");
    }
    if (change.relation !== "duplicate") {
      throw new Error(
        "Invalid patch: confidence_only relation must be duplicate",
      );
    }
    if (!isRecord(change.confidenceImpact)) {
      throw new Error("Invalid patch: confidence_only requires impact");
    }
    return change as PatchChange;
  }
  if (change.type === "create") {
    if (!isValidPageId(change.newPageId)) {
      throw new Error("Invalid patch: invalid newPageId");
    }
    if (change.relation !== "new" && change.relation !== "supersede") {
      throw new Error("Invalid patch: unsupported create relation");
    }
    if (change.path !== undefined && typeof change.path !== "string") {
      throw new Error("Invalid patch: create path must be a string");
    }
    if (typeof change.content !== "string") {
      throw new Error("Invalid patch: create content must be a string");
    }
    if (
      typeof change.classifyConfidence !== "number" ||
      !Number.isFinite(change.classifyConfidence) ||
      change.classifyConfidence < 0 ||
      change.classifyConfidence > 1
    ) {
      throw new Error("Invalid patch: classifyConfidence must be 0-1");
    }
    if (typeof change.reasoning !== "string") {
      throw new Error("Invalid patch: reasoning must be a string");
    }
    if (change.supersedes !== undefined && !isValidPageId(change.supersedes)) {
      throw new Error("Invalid patch: invalid supersedes pageId");
    }
    if (
      change.needsCloseReview !== undefined &&
      typeof change.needsCloseReview !== "boolean"
    ) {
      throw new Error("Invalid patch: needsCloseReview must be a boolean");
    }
    if (change.relation === "supersede" && !change.supersedes) {
      throw new Error("Invalid patch: supersede create requires supersedes");
    }
    if (
      change.confidenceImpact !== undefined &&
      !isRecord(change.confidenceImpact)
    ) {
      throw new Error("Invalid patch: confidenceImpact must be an object");
    }
    return change as PatchChange;
  }
  throw new Error("Invalid patch: unsupported change type");
}

function validatePatchForApply(vaultDir: string, patch: PatchDocument): void {
  if (patch.status !== "proposed") {
    throw new Error(`Invalid patch: ${patch.id} is not proposed`);
  }
  const createPageIds = new Set<string>();
  const createPaths = new Set<string>();
  for (const change of patch.changes ?? []) {
    validateSupersededByImpactTarget(vaultDir, change);
    if (change.type === "create") {
      if (createPageIds.has(change.newPageId)) {
        throw new Error(
          `Invalid patch: duplicate create page id ${change.newPageId}`,
        );
      }
      createPageIds.add(change.newPageId);
      if (findPagePathById(vaultDir, change.newPageId as PageId)) {
        throw new Error(
          `Invalid patch: page already exists ${change.newPageId}`,
        );
      }
      const targetRelative = createChangeRelativePath(change);
      assertCreatePathInsidePages(vaultDir, targetRelative);
      if (createPaths.has(targetRelative)) {
        throw new Error(
          `Invalid patch: duplicate create path ${targetRelative}`,
        );
      }
      createPaths.add(targetRelative);
      if (existsSync(join(vaultDir, targetRelative))) {
        throw new Error(`Invalid patch: target path exists ${targetRelative}`);
      }
      const content = ensureFrontmatter(change.content, {
        id: change.newPageId as PageId,
      });
      const frontmatter = normalizeFrontmatter(
        parseMarkdown(content).frontmatter,
      );
      if (frontmatter.id !== change.newPageId) {
        throw new Error("Invalid patch: create content id mismatch");
      }
      if (change.supersedes && !resolvePageFile(vaultDir, change.supersedes)) {
        throw new Error(
          `Invalid patch: target page not found ${change.supersedes}`,
        );
      }
      if (change.relation === "new" && change.supersedes) {
        throw new Error("Invalid patch: new create cannot supersede");
      }
      if (change.relation === "supersede") {
        const impact = change.confidenceImpact;
        if (
          !isRecord(impact) ||
          impact.kind !== "supersedes" ||
          impact.supersededPageId !== change.supersedes
        ) {
          throw new Error(
            "Invalid patch: supersede create requires matching confidenceImpact",
          );
        }
      }
      for (const source of extractDerivedSources(change.content)) {
        if (source.includes(":c")) {
          if (!sourceChunkExists(vaultDir, source)) {
            throw new Error(
              `Invalid patch: unresolved derived source ${source}`,
            );
          }
        } else if (!lineageUnitExists(patch, source)) {
          throw new Error(`Invalid patch: unresolved derived source ${source}`);
        }
      }
      continue;
    }
    const targetFile = resolvePageFile(vaultDir, change.pageId);
    if (!targetFile) {
      throw new Error(`Invalid patch: target page not found ${change.pageId}`);
    }
    if (change.type === "modify") {
      validatePatchConfidenceImpact(change.confidenceImpact);
      const parsed = pageFromFile(vaultDir, targetFile);
      if (
        (change.operation === "replace_section" ||
          change.operation === "insert_after_section") &&
        findMarkdownSection(parsed.body, change.targetSection).start === -1
      ) {
        throw new Error(
          `Invalid patch: target section not found ${change.targetSection}`,
        );
      }
      for (const source of extractDerivedSources(change.content)) {
        if (source.includes(":c")) {
          if (!sourceChunkExists(vaultDir, source)) {
            throw new Error(
              `Invalid patch: unresolved derived source ${source}`,
            );
          }
        } else if (!lineageUnitExists(patch, source)) {
          throw new Error(`Invalid patch: unresolved derived source ${source}`);
        }
      }
    }
  }
  for (const unit of patch.lineage?.units ?? []) {
    if (unit.sourcePageId && !isValidPageId(unit.sourcePageId)) {
      throw new Error("Invalid patch: invalid lineage sourcePageId");
    }
    for (const chunkId of unit.sourceChunkIds ?? []) {
      if (!sourceChunkExists(vaultDir, chunkId)) {
        throw new Error(`Invalid patch: unresolved lineage source ${chunkId}`);
      }
    }
  }
}

function validateSupersededByImpactTarget(
  vaultDir: string,
  change: PatchChange,
): void {
  const impact = change.confidenceImpact;
  if (
    change.type === "create" &&
    change.supersedes &&
    change.relation === "supersede"
  ) {
    assertPageIsNotAlreadySuperseded(vaultDir, change.supersedes);
    return;
  }
  if (!isRecord(impact) || impact.kind !== "superseded_by") {
    return;
  }
  const pageId =
    change.type === "create" ? impact.supersededPageId : change.pageId;
  if (typeof pageId !== "string") {
    return;
  }
  assertPageIsNotAlreadySuperseded(vaultDir, pageId);
}

function assertPageIsNotAlreadySuperseded(
  vaultDir: string,
  pageId: string,
): void {
  const file = resolvePageFile(vaultDir, pageId);
  if (!file) {
    return;
  }
  const page = pageFromFile(vaultDir, file).page;
  const state = confidenceStateForPage(vaultDir, page);
  if (state?.supersededBy) {
    throw new Error(
      `Invalid patch: ${pageId} is already superseded by ${state.supersededBy}`,
    );
  }
}

function validatePatchConfidenceImpact(
  impact: Record<string, unknown> | undefined,
): void {
  if (impact === undefined) {
    return;
  }
  if (impact.kind === "source_added") {
    if (
      typeof impact.sourceWeight !== "number" ||
      impact.sourceWeight < 0 ||
      impact.sourceWeight > 1
    ) {
      throw new Error("Invalid patch: sourceWeight must be 0-1");
    }
    return;
  }
  if (impact.kind === "contradicted_by") {
    if (impact.severity !== "minor" && impact.severity !== "major") {
      throw new Error(
        "Invalid patch: contradiction severity must be minor or major",
      );
    }
    return;
  }
  if (impact.kind === "superseded_by") {
    if (!isValidPageId(impact.supersederPageId)) {
      throw new Error("Invalid patch: invalid supersederPageId");
    }
    return;
  }
  if (impact.kind === "supersedes") {
    if (!isValidPageId(impact.supersededPageId)) {
      throw new Error("Invalid patch: invalid supersededPageId");
    }
    return;
  }
  throw new Error("Invalid patch: unsupported confidenceImpact kind");
}

function extractDerivedSources(content: string): string[] {
  const sources: string[] = [];
  for (const marker of content.matchAll(/<!--\s*akb:derived\s+([^>]+)-->/g)) {
    const attrs = marker[1];
    const source = attrs.match(/source=("[^"]*"|[^\s]+)/)?.[1];
    if (!source) {
      continue;
    }
    sources.push(
      ...source
        .replace(/^"|"$/g, "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  return sources;
}

function replaceMarkdownSection(
  body: string,
  targetSection: string,
  replacement: string,
): string {
  const lines = body.split("\n");
  const { start, end } = findMarkdownSection(body, targetSection);
  if (start === -1) {
    throw new Error(`Invalid patch: target section not found ${targetSection}`);
  }
  return [
    ...lines.slice(0, start),
    ...replacement.trimEnd().split("\n"),
    ...lines.slice(end),
  ].join("\n");
}

function insertAfterMarkdownSection(
  body: string,
  targetSection: string,
  insertion: string,
): string {
  const lines = body.split("\n");
  const { start, end } = findMarkdownSection(body, targetSection);
  if (start === -1) {
    throw new Error(`Invalid patch: target section not found ${targetSection}`);
  }
  const before = lines.slice(0, end);
  while (before.length > 0 && before.at(-1)?.trim() === "") {
    before.pop();
  }
  return [
    ...before,
    "",
    ...insertion.trimEnd().split("\n"),
    "",
    ...lines.slice(end),
  ].join("\n");
}

function findMarkdownSection(
  body: string,
  targetSection: string | undefined,
): { start: number; end: number } {
  if (!targetSection) {
    return { start: -1, end: -1 };
  }
  const lines = body.split("\n");
  const target = normalizeSectionTitle(targetSection);
  let fenceMarker: "`" | "~" | undefined;
  let fenceLength = 0;
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const fence = lines[index].match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1][0] as "`" | "~";
      if (!fenceMarker) {
        fenceMarker = marker;
        fenceLength = fence[1].length;
      } else if (marker === fenceMarker && fence[1].length >= fenceLength) {
        fenceMarker = undefined;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceMarker) {
      continue;
    }
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    if (start === -1) {
      if (normalizeSectionTitle(match[2]) === target) {
        start = index;
        level = match[1].length;
      }
      continue;
    }
    if (match[1].length <= level) {
      return { start, end: index };
    }
  }
  return start === -1 ? { start: -1, end: -1 } : { start, end: lines.length };
}

function normalizeSectionTitle(value: string): string {
  return value
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase();
}

function lineageUnitExists(patch: PatchDocument, unitId: string): boolean {
  return (patch.lineage?.units ?? []).some((unit) => unit.id === unitId);
}

function sourceChunkExists(vaultDir: string, chunkId: string): boolean {
  const pageId = chunkId.split(":")[0];
  if (!isValidPageId(pageId)) {
    return false;
  }
  const file = resolvePageFile(vaultDir, pageId);
  if (!file) {
    return false;
  }
  const { page, body, bodyStartLine } = pageFromFile(vaultDir, file);
  return chunkByHeaders(page.id, body, { bodyStartLine }).some(
    (chunk) => chunk.id === chunkId,
  );
}

function sourceUnitExists(
  sourceUnitId: string,
  knownPageIds: Set<string>,
  knownLineageUnitIds: Set<string>,
): boolean {
  if (knownLineageUnitIds.has(sourceUnitId) || knownPageIds.has(sourceUnitId)) {
    return true;
  }
  const pagePrefix = sourceUnitId.split(":")[0];
  return isValidPageId(pagePrefix) && knownPageIds.has(pagePrefix);
}

function createChangeRelativePath(
  change: Extract<PatchChange, { type: "create" }>,
): string {
  const rawPath =
    typeof change.path === "string" && change.path.length > 0
      ? change.path
      : `pages/${change.newPageId}.md`;
  const normalized = toPosix(rawPath);
  if (
    normalized.startsWith("/") ||
    !normalized.startsWith("pages/") ||
    normalized.includes("../") ||
    normalized.includes("/..") ||
    !normalized.endsWith(".md")
  ) {
    throw new Error("Invalid patch: invalid create path");
  }
  return normalized;
}

function assertCreatePathInsidePages(
  vaultDir: string,
  targetRelative: string,
): void {
  const pagesRoot = realpathSync(join(vaultDir, "pages"));
  const targetParent = join(vaultDir, dirname(targetRelative));
  let existingAncestor = targetParent;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error("Invalid patch: invalid create path");
    }
    existingAncestor = parent;
  }
  const ancestorRealPath = realpathSync(existingAncestor);
  if (
    ancestorRealPath !== pagesRoot &&
    !ancestorRealPath.startsWith(`${pagesRoot}/`)
  ) {
    throw new Error("Invalid patch: invalid create path");
  }
}

function normalizedCompilePatch(patch: PatchDocument): string {
  const compileMeta = { ...patch.compileMeta };
  const promptHashes = isRecord(compileMeta.promptHashes)
    ? compileMeta.promptHashes
    : {};
  return JSON.stringify({
    source: patch.source,
    compileMeta: {
      provider: compileMeta.provider,
      modelId: compileMeta.modelId,
      resolvedModelId: compileMeta.resolvedModelId,
      promptHashes: {
        segment: promptHashes.segment,
        classify: promptHashes.classify,
        synthesize: promptHashes.synthesize,
      },
      pipelineVersion: compileMeta.pipelineVersion,
      segmentCount: compileMeta.segmentCount,
      llmCallCount: compileMeta.llmCallCount,
      degraded: compileMeta.degraded,
      createdAt: "<timestamp>",
    },
    changes: (patch.changes ?? []).map((change) =>
      change.type === "modify"
        ? {
            ...change,
            content: normalizeVolatileCompileText(change.content),
          }
        : change.type === "create"
          ? {
              ...change,
              content: normalizeVolatileCompileText(change.content),
            }
          : change,
    ),
    lineage: {
      ...patch.lineage,
      derivedChunks: (patch.lineage?.derivedChunks ?? []).map((chunk) =>
        normalizeVolatileDerivedChunk(chunk),
      ),
    },
  });
}

function changeCreatesPage(change: PatchChange): boolean {
  const raw = change as unknown as Record<string, unknown>;
  return (
    raw.type === "create" ||
    typeof raw.newPageId === "string" ||
    ("operation" in change && change.relation === "new")
  );
}

function compileChangeTargetPage(change: PatchChange): string | undefined {
  if (change.type === "create") {
    return change.supersedes ?? change.newPageId;
  }
  return change.pageId;
}

function normalizeVolatileCompileText(value: string): string {
  return value.replace(/compiledAt="[^"]+"/g, 'compiledAt="<timestamp>"');
}

function normalizeVolatileDerivedChunk(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const derivedFrom = isRecord(value.derivedFrom)
    ? { ...value.derivedFrom, compiledAt: "<timestamp>" }
    : value.derivedFrom;
  return { ...value, derivedFrom };
}

function appendPatchConfidenceEvent(
  vaultDir: string,
  page: Page,
  change: PatchChange,
  patch: PatchDocument,
): void {
  const impact = change.confidenceImpact ?? {};
  const timestamp = new Date().toISOString();
  const sourceId =
    typeof patch.source?.sourceId === "string"
      ? patch.source.sourceId
      : stableId("src", patch.id);
  if (impact.kind === "source_added" || change.relation === "duplicate") {
    appendConfidenceEventAndUpdateProjection(
      vaultDir,
      page,
      parseConfidenceEvent({
        id: stableId("evt", `${patch.id}:${page.id}:source_added:${timestamp}`),
        kind: "source_added",
        pageId: page.id,
        timestamp,
        actor: "system",
        actorId: "akb-patch",
        sourceId,
        sourceWeight:
          typeof impact.sourceWeight === "number" ? impact.sourceWeight : 0.7,
      }),
    );
  } else if (impact.kind === "contradicted_by") {
    appendConfidenceEventAndUpdateProjection(
      vaultDir,
      page,
      parseConfidenceEvent({
        id: stableId(
          "evt",
          `${patch.id}:${page.id}:contradicted_by:${timestamp}`,
        ),
        kind: "contradicted_by",
        pageId: page.id,
        timestamp,
        actor: "system",
        actorId: "akb-patch",
        bySourceId: sourceId,
        severity: impact.severity === "major" ? "major" : "minor",
      }),
    );
  } else if (
    impact.kind === "superseded_by" &&
    isValidPageId(impact.supersederPageId)
  ) {
    appendConfidenceEventAndUpdateProjection(
      vaultDir,
      page,
      parseConfidenceEvent({
        id: stableId(
          "evt",
          `${patch.id}:${page.id}:superseded_by:${timestamp}`,
        ),
        kind: "superseded_by",
        pageId: page.id,
        timestamp,
        actor: "system",
        actorId: "akb-patch",
        supersederPageId: impact.supersederPageId,
        reason: typeof impact.reason === "string" ? impact.reason : undefined,
      }),
    );
  } else if (
    impact.kind === "supersedes" &&
    isValidPageId(impact.supersededPageId)
  ) {
    appendConfidenceEventAndUpdateProjection(
      vaultDir,
      page,
      parseConfidenceEvent({
        id: stableId("evt", `${patch.id}:${page.id}:supersedes:${timestamp}`),
        kind: "supersedes",
        pageId: page.id,
        timestamp,
        actor: "system",
        actorId: "akb-patch",
        supersededPageId: impact.supersededPageId,
        reason: typeof impact.reason === "string" ? impact.reason : undefined,
      }),
    );
  }
}

function ledgerPathForPageLocal(
  vaultDir: string,
  pagePath: string,
  pageId: PageId | string,
): string {
  return join(vaultDir, dirname(pagePath), `.${pageId}.ledger.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`Invalid or missing string field: ${field}`);
  }
  return fieldValue;
}

function recordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const fieldValue = value[field];
  if (!isRecord(fieldValue)) {
    throw new Error(`Invalid or missing object field: ${field}`);
  }
  return fieldValue;
}

function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  const fieldValue = value[field];
  if (!Array.isArray(fieldValue)) {
    throw new Error(`Invalid or missing array field: ${field}`);
  }
  return fieldValue;
}

function cliOptionValue(name: string): string | undefined {
  const index = currentArgv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = currentArgv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function isValidPageId(value: unknown): value is PageId {
  return PageIdSchema.safeParse(value).success;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
