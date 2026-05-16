#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
import { ConfigSchema, PageFrontmatterSchema } from "@akb/core";
import { loadGoldenSet, runEval } from "@akb/eval-harness";
import { commitFiles, initVault } from "@akb/git-store";
import { ensureFrontmatter, parseMarkdown } from "@akb/markdown-engine";
import { serveMcp } from "@akb/mcp-server";
import { type RankConfidenceState, rankSearchResults } from "@akb/ranker";
import { SearchIndex } from "@akb/search-engine";
import { Command, InvalidArgumentError } from "commander";
import { stringify as stringifyYaml } from "yaml";

interface IngestOptions {
  tag?: string[];
  force?: boolean;
  commit?: boolean;
  recursive?: boolean;
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

interface ProjectionRebuildOptions {
  confidence?: boolean;
  all?: boolean;
}

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
  const projection = program.command("projection");
  projection
    .command("rebuild")
    .option("--confidence", "rebuild confidence ledger projection")
    .option("--all", "rebuild all supported projections")
    .action(projectionRebuildCommand);
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
    if (states.has(result.page_id)) {
      continue;
    }
    const events = loadConfidenceEvents(vaultDir, result.path, result.page_id);
    if (events.length === 0) {
      continue;
    }
    const state = computeConfidenceState(events);
    states.set(result.page_id, {
      score: state.score,
      supersededBy: state.supersededBy,
      lastVerifiedAt: state.lastVerifiedAt,
      lastEventAt: state.lastEventAt,
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
      });
    }
    return states;
  } catch {
    return new Map();
  } finally {
    projection.close();
  }
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

function stableId(prefix: "evt" | "src", input: string): string {
  let hash = 0x811c9dc5;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = Math.abs(hash).toString(36).padStart(12, "0").slice(0, 12);
  return `${prefix}_${suffix}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
