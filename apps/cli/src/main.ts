#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildHeuristicCompilePatch,
  type CompilePageInput,
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
import type { Page, PageFrontmatter, PageId, SearchResult } from "@akb/core";
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
  commit?: boolean;
  recursive?: boolean;
  compile?: boolean;
}

interface IndexOptions {
  rebuild?: boolean;
}

interface SearchOptions {
  topK?: number;
  format?: "text" | "json";
  includeSuperseded?: boolean;
}

interface EvalOptions {
  set?: string;
  output?: string;
}

interface EvalCompileOptions {
  set?: string;
  output?: string;
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
  kind: "relation" | "target" | "create_page" | "delete_content";
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

interface ProjectionRebuildOptions {
  confidence?: boolean;
  all?: boolean;
}

interface LintReport {
  lowConfidence: Array<{ page: Page; score: number }>;
  stale: Array<{ page: Page; lastVerifiedAt: string }>;
  orphanPages: Page[];
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

interface CompileOptions {
  source?: string;
  allPending?: boolean;
  dryRun?: boolean;
  model?: string;
}

interface PatchApplyOptions {
  commit?: boolean;
}

interface PatchDocument {
  id: string;
  status: "proposed" | "applied" | "rejected";
  source?: { sourceId?: string; pageId?: string; ingestPath?: string };
  compileMeta?: Record<string, unknown>;
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
      operation: "append_section";
      relation: string;
      classifyConfidence: number;
      reasoning: string;
      content: string;
      confidenceImpact?: Record<string, unknown>;
    }
  | {
      type: "confidence_only";
      pageId: string;
      relation: "duplicate";
      confidenceImpact: Record<string, unknown>;
    };

let currentArgv = process.argv;

export async function run(argv = process.argv): Promise<void> {
  currentArgv = argv;
  const program = new Command();
  program
    .name("akb")
    .description("AI-native knowledge compiler")
    .version("0.0.0");
  program.command("init").argument("<name>").action(initCommand);
  program
    .command("ingest")
    .argument("<path>")
    .option("--tag <tag>", "add a tag to imported pages", collect, [])
    .option("--force", "overwrite existing page file")
    .option("--compile", "compile imported pages into reviewable patches")
    .option("--no-compile", "skip compile after ingest")
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
    .option("--format <format>", "text or json", parseFormat, "text")
    .option("--include-superseded", "include historical superseded pages")
    .action(searchCommand);
  const evalCmd = program
    .command("eval")
    .option("--set <path>", "golden set path")
    .option("--output <path>", "write JSON report")
    .action(evalCommand);
  evalCmd
    .command("compile")
    .option("--set <path>", "compile golden set path")
    .option("--output <path>", "write JSON report")
    .action(evalCompileCommand);
  program.command("lint").action(lintCommand);
  program
    .command("decay")
    .option("--run", "write sparse decay checkpoints")
    .option("--now <timestamp>", "clock timestamp for deterministic runs")
    .option("--no-commit", "skip git commit")
    .action(decayCommand);
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
    .option("--no-commit", "skip git commit")
    .action(patchApplyCommand);
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
  const files = markdownFiles(source, options.recursive ?? true);
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  const written: string[] = [];
  const removed: string[] = [];

  try {
    for (const file of files) {
      const relativeSource = statSync(source).isDirectory()
        ? relative(source, file)
        : basename(file);
      const targetRelative = toPosix(join("pages", relativeSource));
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
      const existingPath = findPagePathById(vaultDir, importedId);
      if (existingPath && resolve(existingPath) !== resolve(target)) {
        if (!options.force) {
          throw new Error(
            `Page id already exists in ${toPosix(relative(vaultDir, existingPath))}: ${importedId}. Use --force to replace it.`,
          );
        }
        rmSync(existingPath, { force: true });
        removed.push(toPosix(relative(vaultDir, existingPath)));
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, finalContent);
      const { page, body, bodyStartLine } = pageFromFile(vaultDir, target);
      index.upsertPage(page, body, { bodyStartLine });
      written.push(targetRelative);
    }
  } finally {
    index.close();
  }

  if (written.length > 0 && options.commit !== false) {
    await commitFiles(
      vaultDir,
      [...written, ...removed],
      `ingest ${written.length === 1 ? basename(written[0]) : `${written.length} pages`}`,
    );
  }
  console.log(
    `Ingested ${written.length} page${written.length === 1 ? "" : "s"}.`,
  );
  if (options.compile === true) {
    for (const path of written) {
      await compileCommand({ source: path });
    }
  }
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
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  try {
    const topK = options.topK ?? 5;
    const rawResults = index.search(query, { topK: Math.max(topK * 10, 50) });
    const results = rankSearchResults({
      rawResults,
      confidenceState: rankConfidenceStateForResults(vaultDir, rawResults),
      options: { includeSuperseded: options.includeSuperseded === true },
    }).slice(0, topK);
    const elapsedMs = Math.round(performance.now() - start);
    if (options.format === "json") {
      console.log(
        JSON.stringify({ query, results, elapsed_ms: elapsedMs }, null, 2),
      );
      return;
    }
    for (const [offset, result] of results.entries()) {
      const flags =
        result.flags.length > 0 ? ` flags=${result.flags.join(",")}` : "";
      console.log(
        `[${offset + 1}] ${result.page_id}  ${result.path}  L${result.citation.line_start}-L${result.citation.line_end}  score=${result.final_score.toFixed(2)} bm25=${result.score.toFixed(2)}${flags}`,
      );
      console.log(`    ${result.title}`);
      console.log(`    > ${result.snippet.replace(/\s+/g, " ")}`);
      console.log("");
    }
    console.log(`${results.length} results in ${elapsedMs}ms.`);
  } finally {
    index.close();
  }
}

function rankConfidenceStateForResults(
  vaultDir: string,
  results: SearchResult[],
): Map<PageId, RankConfidenceState> {
  const states = loadProjectedRankConfidenceState(
    vaultDir,
    results.map((result) => result.page_id),
  );
  for (const result of results) {
    const events = loadConfidenceEvents(vaultDir, result.path, result.page_id);
    if (events.length === 0) {
      continue;
    }
    const latestLedgerEventAt = [...events]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .at(-1)?.timestamp;
    const projected = states.get(result.page_id);
    if (
      projected &&
      latestLedgerEventAt &&
      projected.lastEventAt &&
      projected.lastEventAt >= latestLedgerEventAt
    ) {
      continue;
    }
    const state = computeConfidenceState(events);
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

  for (const item of items) {
    const patch = buildCompileEvalPatch(vaultDir, goldenPath, item);
    const changes = patch.changes ?? [];
    for (const expected of item.expect.relations) {
      relationChecks += 1;
      const expectedRelations =
        expected.relationIn ?? (expected.relation ? [expected.relation] : []);
      const relationMatched = changes.find(
        (change) =>
          "relation" in change && expectedRelations.includes(change.relation),
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
          actualTargetPage:
            actual && "pageId" in actual ? actual.pageId : undefined,
          kind: "relation",
        });
      }

      if (expected.againstPage) {
        targetChecks += 1;
        const candidates = changes.filter(
          (change) =>
            "pageId" in change && change.pageId === expected.againstPage,
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
            actualTargetPage:
              actual && "pageId" in actual ? actual.pageId : undefined,
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

  const failedItemIds = new Set(failures.map((failure) => failure.id));
  const report = {
    total: items.length,
    relation_checks: relationChecks,
    relation_passes: relationPasses,
    target_checks: targetChecks,
    target_passes: targetPasses,
    passed: items.length - failedItemIds.size,
    failed: failedItemIds.size,
    failure_count: failures.length,
    relation_accuracy:
      relationChecks === 0 ? 1 : relationPasses / relationChecks,
    target_accuracy: targetChecks === 0 ? 1 : targetPasses / targetChecks,
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
  const candidates =
    item.setup.existingPages.length > 0
      ? item.setup.existingPages.map((ref) =>
          compileEvalPageInput(vaultDir, goldenPath, ref),
        )
      : scanVaultPages(vaultDir).filter(
          (candidate) => candidate.page.id !== source.page.id,
        );
  return buildHeuristicCompilePatch({
    source,
    candidates,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  }) as PatchDocument;
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

async function lintCommand(): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const report = buildLintReport(vaultDir);
  writeLintReports(vaultDir, report);
  printLintReport(report);
  if (
    report.brokenWikiLinks.length > 0 ||
    report.supersessionCycles.length > 0
  ) {
    process.exitCode = 1;
  }
}

function buildLintReport(vaultDir: string): LintReport {
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
  );

  const lowConfidence: LintReport["lowConfidence"] = [];
  const stale: LintReport["stale"] = [];
  const brokenWikiLinks: LintReport["brokenWikiLinks"] = [];
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
    if (state?.lastVerifiedAt && isOlderThanDays(state.lastVerifiedAt, 180)) {
      stale.push({ page: item.page, lastVerifiedAt: state.lastVerifiedAt });
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
    orphanPages,
    brokenWikiLinks,
    supersessionCycles: findSupersessionCycles(pages.map((item) => item.page)),
  };
}

function printLintReport(report: LintReport): void {
  console.log("Confidence issues:");
  if (report.lowConfidence.length === 0 && report.stale.length === 0) {
    console.log("  none");
  }
  for (const issue of report.lowConfidence) {
    console.log(
      `  warn low-confidence ${issue.page.id} ${issue.page.path} score=${issue.score.toFixed(4)}`,
    );
  }
  for (const issue of report.stale) {
    console.log(
      `  warn stale ${issue.page.id} ${issue.page.path} last_verified_at=${issue.lastVerifiedAt}`,
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
  for (const page of report.orphanPages) {
    lines.push(
      `- ${page.id}: add incoming/outgoing wiki links or mark it intentionally standalone.`,
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
          appendConfidenceEvent(vaultDir, item.page.path, event),
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

async function webhookCiSuccessCommand(
  options: WebhookCiSuccessOptions,
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
  const written = writeRuntimeVerifiedEvents(vaultDir, targets, {
    actorId,
    evidence,
    signalKind: "ci_success",
  });
  if (written.length > 0 && options.commit !== false) {
    await commitFiles(vaultDir, written, "record runtime verification");
  }
  console.log(
    `Recorded ${written.length} runtime verification${written.length === 1 ? "" : "s"}.`,
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
    for (const writtenPath of writeRuntimeVerifiedEvents(vaultDir, targets, {
      actorId: signal.actor_id,
      evidence: signal.evidence,
      signalKind: signal.kind ?? "runtime_signal",
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
    const actorId = options.byAgent ? `agent:${options.byAgent}` : undefined;
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
      verifierId: options.byAgent,
      reason: options.reason,
    });
    const ledgerPath = appendConfidenceEvent(vaultDir, page.path, event);
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
    supersededPageId: oldPage.id,
    reason: options.reason,
  });

  const written = new Set<string>();
  written.add(
    toPosix(
      relative(
        vaultDir,
        appendConfidenceEvent(vaultDir, oldPage.path, oldEvent),
      ),
    ),
  );
  written.add(
    toPosix(
      relative(
        vaultDir,
        appendConfidenceEvent(vaultDir, newPageBefore.path, newEvent),
      ),
    ),
  );

  updateSupersedingPage(vaultDir, newFile, oldPage.id);
  written.add(newPageBefore.path);
  const { page, body, bodyStartLine } = pageFromFile(vaultDir, newFile);
  const index = new SearchIndex({ dbPath: join(vaultDir, ".akb", "index.db") });
  try {
    index.upsertPage(page, body, { bodyStartLine });
  } finally {
    index.close();
  }

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
  let skipped = 0;

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
      String(item.page.id);
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
      sourceWeight:
        item.page.frontmatter.source_hash || item.page.frontmatter.source_path
          ? 0.8
          : 0.5,
    });
    const ledgerPath = appendConfidenceEvent(
      vaultDir,
      item.page.path,
      sourceAdded,
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
        verifierType: "human",
      });
      appendConfidenceEvent(vaultDir, item.page.path, verified);
    }
  }

  if (written.length > 0 && options.commit !== false) {
    await commitFiles(vaultDir, written, "migrate confidence ledgers");
  }

  console.log(
    `Migrated ${written.length} page${written.length === 1 ? "" : "s"} to v0.1 confidence ledgers (${skipped} skipped).`,
  );
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
  const sourceRefs = options.allPending
    ? pendingCompileSources(vaultDir)
    : options.source
      ? [options.source]
      : [];
  if (sourceRefs.length === 0) {
    throw new Error("Choose --source <page> or --all-pending");
  }

  for (const sourceRef of sourceRefs) {
    const patch = buildCompilePatch(vaultDir, sourceRef, options.model);
    if (options.dryRun) {
      console.log(
        `Dry run ${patch.source?.pageId ?? sourceRef}: ${patch.changes?.length ?? 0} change${patch.changes?.length === 1 ? "" : "s"}.`,
      );
      continue;
    }
    if (patchExists(vaultDir, patch.id)) {
      throw new Error(`Patch already exists: ${patch.id}`);
    }
    const patchPath = patchPathFor(vaultDir, patch.id, "proposed");
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, stringifyYaml(patch));
    console.log(`Compiled ${patch.source?.pageId ?? sourceRef} -> ${patch.id}`);
    for (const change of patch.changes ?? []) {
      console.log(`  - ${change.type} ${change.pageId} (${change.relation})`);
    }
  }
}

function compileStatusCommand(): void {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const proposed = listPatchFiles(vaultDir, "proposed").length;
  const applied = listPatchFiles(vaultDir, "applied").length;
  const rejected = listPatchFiles(vaultDir, "rejected").length;
  const compiled = proposed + applied + rejected;
  console.log("Sources:");
  console.log(`  compiled:        ${compiled}`);
  console.log(`  pending:         ${pendingCompileSources(vaultDir).length}`);
  console.log("  degraded:        0");
  console.log("  compile-disabled: 0");
}

function compileReplayCommand(patchId: string): void {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const patch = readPatch(vaultDir, patchId);
  if (!patch.source?.pageId) {
    throw new Error(`Patch has no source page id: ${patchId}`);
  }
  const replayed = buildCompilePatch(
    vaultDir,
    patch.source.pageId,
    String(patch.compileMeta?.modelId ?? "heuristic-v0.1"),
  );
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
  console.log(stringifyYaml(patch).trimEnd());
}

async function patchApplyCommand(
  patchId: string,
  options: PatchApplyOptions,
): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const patch = readPatch(vaultDir, patchId, "proposed");
  validatePatchForApply(vaultDir, patch);
  const written = new Set<string>();
  for (const change of patch.changes ?? []) {
    if (change.type === "modify") {
      const file = resolvePageFile(vaultDir, change.pageId);
      if (!file) {
        throw new Error(`Patch target page not found: ${change.pageId}`);
      }
      const parsed = pageFromFile(vaultDir, file);
      writeMarkdownFile(
        file,
        parsed.page.frontmatter,
        `${parsed.body.trimEnd()}\n\n${change.content.trimEnd()}`,
      );
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

function readUtf8File(path: string): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    return undefined;
  }
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

function isOlderThanDays(timestamp: string, days: number): boolean {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return false;
  }
  return Date.now() - time > days * 24 * 60 * 60 * 1000;
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

function addSupersedeNotice(body: string, supersededPageId: PageId): string {
  const notice = `> Supersedes [[${supersededPageId}]].`;
  if (body.includes(notice)) {
    return body;
  }
  return `${notice}\n\n${body.trimStart()}`;
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

function writeRuntimeVerifiedEvents(
  vaultDir: string,
  targets: Array<{ page: Page; body: string; bodyStartLine: number }>,
  opts: { actorId: string; evidence: string; signalKind: string },
): string[] {
  const timestamp = new Date().toISOString();
  const written: string[] = [];
  for (const target of targets) {
    const event = parseConfidenceEvent({
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
    });
    written.push(
      toPosix(
        relative(
          vaultDir,
          appendConfidenceEvent(vaultDir, target.page.path, event),
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
  return scanVaultPages(vaultDir)
    .map((item) => item.page.id)
    .filter((pageId) => !patchedSources.has(pageId));
}

function buildCompilePatch(
  vaultDir: string,
  sourceRef: string,
  model = "heuristic-v0.1",
): PatchDocument {
  const sourceFile = resolvePageFile(vaultDir, sourceRef);
  if (!sourceFile) {
    throw new Error(`Compile source not found: ${sourceRef}`);
  }
  const source = pageFromFile(vaultDir, sourceFile);
  return buildHeuristicCompilePatch({
    source,
    candidates: scanVaultPages(vaultDir),
    model,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
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
  if (!isValidPageId(change.pageId)) {
    throw new Error("Invalid patch: invalid change pageId");
  }
  if (change.type === "modify") {
    if (change.operation !== "append_section") {
      throw new Error("Invalid patch: unsupported modify operation");
    }
    if (typeof change.relation !== "string" || change.relation.length === 0) {
      throw new Error("Invalid patch: missing relation");
    }
    if (typeof change.content !== "string") {
      throw new Error("Invalid patch: modify content must be a string");
    }
    if (
      typeof change.classifyConfidence !== "number" ||
      change.classifyConfidence < 0 ||
      change.classifyConfidence > 1
    ) {
      throw new Error("Invalid patch: classifyConfidence must be 0-1");
    }
    if (typeof change.reasoning !== "string") {
      throw new Error("Invalid patch: reasoning must be a string");
    }
    return change as PatchChange;
  }
  if (change.type === "confidence_only") {
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
  throw new Error("Invalid patch: unsupported change type");
}

function validatePatchForApply(vaultDir: string, patch: PatchDocument): void {
  if (patch.status !== "proposed") {
    throw new Error(`Invalid patch: ${patch.id} is not proposed`);
  }
  for (const change of patch.changes ?? []) {
    if (!resolvePageFile(vaultDir, change.pageId)) {
      throw new Error(`Invalid patch: target page not found ${change.pageId}`);
    }
    if (change.type === "modify") {
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
    appendConfidenceEvent(
      vaultDir,
      page.path,
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
    appendConfidenceEvent(
      vaultDir,
      page.path,
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
    appendConfidenceEvent(
      vaultDir,
      page.path,
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
    appendConfidenceEvent(
      vaultDir,
      page.path,
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
