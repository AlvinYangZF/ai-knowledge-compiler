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
  appendConfidenceEvent,
  ConfidenceProjection,
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
}

interface ConfidenceRecomputeOptions extends ConfidenceShowOptions {
  now?: string;
}

interface ProjectionRebuildOptions {
  confidence?: boolean;
  all?: boolean;
}

interface LintReport {
  lowConfidence: Array<{ page: Page; score: number }>;
  stale: Array<{ page: Page; lastVerifiedAt: string }>;
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

export async function run(argv = process.argv): Promise<void> {
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
  program
    .command("eval")
    .option("--set <path>", "golden set path")
    .option("--output <path>", "write JSON report")
    .action(evalCommand);
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
    ".akb/index.db\n.akb/index.db-*\n",
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

async function lintCommand(): Promise<void> {
  const vaultDir = process.cwd();
  assertVault(vaultDir);
  const report = buildLintReport(vaultDir);
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

  for (const item of pages) {
    const state = confidence.get(item.page.id);
    if (state && state.score < 0.5) {
      lowConfidence.push({ page: item.page, score: state.score });
    }
    if (state?.lastVerifiedAt && isOlderThanDays(state.lastVerifiedAt, 180)) {
      stale.push({ page: item.page, lastVerifiedAt: state.lastVerifiedAt });
    }
    for (const target of extractWikiLinks(item.body)) {
      if (!lookup.has(normalizeWikiTarget(target))) {
        brokenWikiLinks.push({ page: item.page, target });
      }
    }
  }

  return {
    lowConfidence,
    stale,
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
  const state = computeConfidenceState(events, {
    pageType:
      typeof page.frontmatter.type === "string"
        ? page.frontmatter.type
        : undefined,
  });
  const report = {
    page_id: state.pageId,
    score: state.score,
    source_count: state.sourceCount,
    contradiction_count: state.contradictionCount,
    superseded_by: state.supersededBy,
    last_verified_at: state.lastVerifiedAt,
    last_event_at: state.lastEventAt,
    computed_at: state.computedAt,
    explanation: {
      base: state.explanation.base,
      source_strength: state.explanation.sourceStrength,
      contradiction_penalty: state.explanation.contradictionPenalty,
      time_decay: state.explanation.timeDecay,
      verification_boost: state.explanation.verificationBoost,
    },
  };

  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`${page.title} (${state.pageId})`);
  console.log(`  score: ${state.score.toFixed(4)}`);
  console.log(`  sources: ${state.sourceCount}`);
  console.log(`  contradictions: ${state.contradictionCount}`);
  console.log(`  last event: ${state.lastEventAt}`);
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
  const report = {
    page_id: state.pageId,
    events_replayed: events.length,
    score: state.score,
    source_count: state.sourceCount,
    contradiction_count: state.contradictionCount,
    superseded_by: state.supersededBy,
    last_verified_at: state.lastVerifiedAt,
    last_event_at: state.lastEventAt,
    computed_at: state.computedAt,
    explanation: {
      base: state.explanation.base,
      source_strength: state.explanation.sourceStrength,
      contradiction_penalty: state.explanation.contradictionPenalty,
      time_decay: state.explanation.timeDecay,
      verification_boost: state.explanation.verificationBoost,
    },
  };

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
    for (const value of [
      page.id,
      page.title,
      page.path,
      page.path.replace(/^pages\//, ""),
      page.path.replace(/^pages\//, "").replace(/\.md$/, ""),
      basename(page.path, ".md"),
      ...toStringArray(page.frontmatter.aliases),
    ]) {
      lookup.add(normalizeWikiTarget(value));
    }
  }
  return lookup;
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
  const candidates = scanVaultPages(vaultDir)
    .filter((item) => item.page.id !== source.page.id)
    .map((item) => ({
      item,
      score: lexicalRelatedness(source, item),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const target = candidates[0]?.item;
  const patchId = `patch_${source.page.id}`;
  const timestamp = new Date().toISOString();
  const synthesizePromptHash = stablePromptHash("synthesize/heuristic-v0.1");
  const targetChunkId = target
    ? `${target.page.id}:c${
        chunkByHeaders(target.page.id, target.body, {
          bodyStartLine: target.bodyStartLine,
        }).length
      }`
    : undefined;
  const changes: PatchChange[] = [];
  if (target) {
    changes.push({
      type: "modify",
      pageId: target.page.id,
      operation: "append_section",
      relation: "extend",
      classifyConfidence: 0.7,
      reasoning: `${source.page.title} shares terms with ${target.page.title}`,
      content: [
        `## ${source.page.title} (compiled)`,
        "",
        `<!-- akb:derived source=${source.page.id}:c0 method=extend patch=${patchId} promptHash="${synthesizePromptHash}" modelId="${model}" compiledAt="${timestamp}" -->`,
        source.body.trim(),
      ].join("\n"),
      confidenceImpact: {
        kind: "source_added",
        sourceWeight: 0.8,
      },
    });
  } else {
    changes.push({
      type: "confidence_only",
      pageId: source.page.id,
      relation: "duplicate",
      confidenceImpact: {
        kind: "source_added",
        sourceWeight: 0.7,
      },
    });
  }
  return {
    id: patchId,
    status: "proposed",
    source: {
      sourceId: stableId("src", source.page.id),
      pageId: source.page.id,
      ingestPath: source.page.path,
    },
    compileMeta: {
      provider: "heuristic",
      modelId: model,
      promptHashes: {
        segment: stablePromptHash("segment/heuristic-v0.1"),
        classify: stablePromptHash("classify/heuristic-v0.1"),
        synthesize: stablePromptHash("synthesize/heuristic-v0.1"),
      },
      pipelineVersion: "compile/0.1",
      segmentCount: 1,
      llmCallCount: 0,
      elapsedMs: 0,
      degraded: !process.env.DEEPSEEK_API_KEY,
      createdAt: timestamp,
    },
    changes,
    lineage: {
      units: [
        {
          id: `${source.page.id}:su0`,
          sourcePageId: source.page.id,
          sourceChunkIds: [`${source.page.id}:c0`],
          kind: "claim_cluster",
        },
      ],
      derivedChunks: target
        ? [
            {
              chunkId: targetChunkId,
              derivedFrom: {
                sourceUnitIds: [`${source.page.id}:su0`],
                sourceChunkIds: [`${source.page.id}:c0`],
                method: "extend",
                promptHash: synthesizePromptHash,
                modelId: model,
                compiledAt: timestamp,
              },
            },
          ]
        : [],
    },
  };
}

function lexicalRelatedness(
  source: { page: Page; body: string },
  target: { page: Page; body: string },
): number {
  const sourceTerms = termsForPage(source.page, source.body);
  const targetTerms = termsForPage(target.page, target.body);
  let score = 0;
  for (const term of sourceTerms) {
    if (targetTerms.has(term)) {
      score += 1;
    }
  }
  return score;
}

function termsForPage(page: Page, body: string): Set<string> {
  return new Set(
    [
      page.title,
      ...toStringArray(page.frontmatter.aliases),
      ...toStringArray(page.frontmatter.tags),
      body,
    ]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 3),
  );
}

function stablePromptHash(input: string): string {
  return `sha256:${stableId("src", input).slice("src_".length)}`;
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
  return JSON.stringify({
    source: patch.source,
    compileMeta: {
      ...patch.compileMeta,
      createdAt: "<timestamp>",
      elapsedMs: undefined,
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

function isValidPageId(value: unknown): value is PageId {
  return PageIdSchema.safeParse(value).success;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
