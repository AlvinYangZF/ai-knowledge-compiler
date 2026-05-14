import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = join(import.meta.dirname, "../src/main.ts");
const tsxLoader = import.meta.resolve("tsx");

function runCli(args: string[], cwd: string): string {
  return execFileSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCliFailure(args: string[], cwd: string): string {
  try {
    runCli(args, cwd);
  } catch (error) {
    const failure = error as { stderr?: Buffer; stdout?: Buffer };
    return `${failure.stdout?.toString("utf8") ?? ""}${failure.stderr?.toString("utf8") ?? ""}`;
  }
  throw new Error("Expected command to fail");
}

describe("akb CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "akb-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("akb init creates a git-backed vault", () => {
    const output = runCli(["init", "demo-vault"], dir);
    const vault = join(dir, "demo-vault");

    expect(output).toContain("Initialized vault");
    expect(existsSync(join(vault, ".git"))).toBe(true);
    expect(existsSync(join(vault, ".akb", "config.yaml"))).toBe(true);
    expect(readFileSync(join(vault, ".gitignore"), "utf8")).toContain(
      ".akb/index.db",
    );
    expect(existsSync(join(vault, "pages", ".gitkeep"))).toBe(true);
  });

  it("runs ingest, index, search, and eval in one local vault", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "gc.md");
    writeFileSync(
      source,
      [
        "# Garbage Collection Strategy",
        "",
        "Greedy garbage collection reclaims NAND blocks.",
      ].join("\n"),
    );

    runCli(["ingest", source, "--tag", "storage"], vault);
    runCli(["index", "--rebuild"], vault);
    const json = JSON.parse(
      runCli(["search", "garbage collection", "--format", "json"], vault),
    );

    expect(json.results[0].title).toBe("Garbage Collection Strategy");
    expect(json.results[0].citation.line_start).toBeGreaterThan(1);

    const pageId = json.results[0].page_id;
    writeFileSync(
      join(vault, ".akb", "eval", "golden.yaml"),
      [
        `version: "1.0"`,
        "items:",
        "  - id: q001",
        "    query: garbage collection",
        "    must_hit_pages:",
        `      - ${pageId}`,
      ].join("\n"),
    );
    expect(runCli(["eval"], vault)).toContain("must-hit pass rate");
  });

  it("skips empty and non-UTF-8 markdown files during ingest", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const empty = join(dir, "empty.md");
    const bad = join(dir, "bad.md");
    writeFileSync(empty, "");
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0xfd]));

    const emptyOutput = runCli(["ingest", empty, "--no-commit"], vault);
    const badOutput = runCli(["ingest", bad, "--no-commit"], vault);

    expect(emptyOutput).toContain("Ingested 0 pages");
    expect(badOutput).toContain("Ingested 0 pages");
    expect(existsSync(join(vault, "pages", "empty.md"))).toBe(false);
    expect(existsSync(join(vault, "pages", "bad.md"))).toBe(false);
  });

  it("rejects duplicate page ids unless force is used", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const first = join(dir, "first.md");
    const second = join(dir, "second.md");
    const frontmatter = [
      "---",
      "id: page_dup000000000",
      "title: Duplicate",
      "---",
      "# Duplicate",
      "",
    ].join("\n");
    writeFileSync(first, `${frontmatter}first body`);
    writeFileSync(second, `${frontmatter}second body`);

    runCli(["ingest", first], vault);
    const failure = runCliFailure(["ingest", second], vault);

    expect(failure).toContain("Page id already exists");
    expect(readFileSync(join(vault, "pages", "first.md"), "utf8")).toContain(
      "first body",
    );

    runCli(["ingest", second, "--force"], vault);
    expect(existsSync(join(vault, "pages", "first.md"))).toBe(false);
    expect(readFileSync(join(vault, "pages", "second.md"), "utf8")).toContain(
      "second body",
    );
  });
});
