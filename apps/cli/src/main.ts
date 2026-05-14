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
import type { Page, PageFrontmatter, PageId } from "@akb/core";
import { ConfigSchema, PageFrontmatterSchema } from "@akb/core";
import { loadGoldenSet, runEval } from "@akb/eval-harness";
import { commitFiles, initVault } from "@akb/git-store";
import { ensureFrontmatter, parseMarkdown } from "@akb/markdown-engine";
import { serveMcp } from "@akb/mcp-server";
import { SearchIndex } from "@akb/search-engine";
import { Command, InvalidArgumentError } from "commander";
import { stringify as stringifyYaml } from "yaml";

interface IngestOptions {
  tag?: string[];
  force?: boolean;
  commit?: boolean;
}

interface IndexOptions {
  rebuild?: boolean;
}

interface SearchOptions {
  topK?: number;
  format?: "text" | "json";
}

interface EvalOptions {
  set?: string;
  output?: string;
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
    .action(searchCommand);
  program
    .command("eval")
    .option("--set <path>", "golden set path")
    .option("--output <path>", "write JSON report")
    .action(evalCommand);
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
  const files = markdownFiles(source);
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
    const results = index.search(query, { topK: options.topK ?? 5 });
    const elapsedMs = Math.round(performance.now() - start);
    if (options.format === "json") {
      console.log(
        JSON.stringify({ query, results, elapsed_ms: elapsedMs }, null, 2),
      );
      return;
    }
    for (const [offset, result] of results.entries()) {
      console.log(
        `[${offset + 1}] ${result.page_id}  ${result.path}  L${result.citation.line_start}-L${result.citation.line_end}  score=${result.score.toFixed(2)}`,
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
    console.log(`  recall@5:     ${report.recall_at_5.toFixed(2)}`);
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

function assertVault(dir: string): void {
  if (
    !existsSync(join(dir, ".akb", "config.yaml")) ||
    !existsSync(join(dir, "pages"))
  ) {
    throw new Error(`Not an akb vault: ${dir}`);
  }
}

function markdownFiles(path: string): string[] {
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
      files.push(...markdownFiles(next));
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

function normalizeFrontmatter(
  frontmatter: Record<string, unknown>,
): PageFrontmatter {
  const normalized = Object.fromEntries(
    Object.entries(frontmatter).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
  return PageFrontmatterSchema.parse(normalized);
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

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
