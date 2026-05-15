import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
    const evalOutput = runCli(["eval"], vault);
    expect(evalOutput).toContain("precision@5");
    expect(evalOutput).toContain("precision@10");
    expect(evalOutput).toContain("recall@5");
    expect(evalOutput).toContain("recall@10");
    expect(evalOutput).toContain("must-hit pass rate");
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

  it("supports non-recursive directory ingest", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "source");
    mkdirSync(join(source, "nested"), { recursive: true });
    writeFileSync(join(source, "top.md"), "# Top\n\nTop-level note.");
    writeFileSync(
      join(source, "nested", "child.md"),
      "# Child\n\nNested note.",
    );

    const output = runCli(
      ["ingest", source, "--no-recursive", "--no-commit"],
      vault,
    );

    expect(output).toContain("Ingested 1 page");
    expect(existsSync(join(vault, "pages", "top.md"))).toBe(true);
    expect(existsSync(join(vault, "pages", "nested", "child.md"))).toBe(false);
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

  it("migrates v0.0 pages to confidence ledgers and shows confidence", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "confidence.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_migrate00010",
        "title: Confidence Migration",
        'created_at: "2026-05-01"',
        'imported_at: "2026-05-10T12:00:00.000Z"',
        'source_path: "./confidence.md"',
        'source_hash: "sha256:confidence-source"',
        "---",
        "# Confidence Migration",
        "",
        "This page should receive a source_added ledger event.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);

    const migrateOutput = runCli(["migrate", "to-v0.1"], vault);
    const ledgerPath = join(vault, "pages", ".page_migrate00010.ledger.jsonl");
    const ledger = readFileSync(ledgerPath, "utf8").trim();
    const event = JSON.parse(ledger);

    expect(migrateOutput).toContain("Migrated 1 page");
    expect(event.kind).toBe("source_added");
    expect(event.pageId).toBe("page_migrate00010");
    expect(event.timestamp).toBe("2026-05-10T12:00:00.000Z");
    expect(event.sourceWeight).toBe(0.8);

    const report = JSON.parse(
      runCli(
        ["confidence", "show", "page_migrate00010", "--format", "json"],
        vault,
      ),
    );
    expect(report.page_id).toBe("page_migrate00010");
    expect(report.source_count).toBe(1);
    expect(report.score).toBeGreaterThan(0);
    expect(report.explanation.source_strength).toBeGreaterThan(0);
  });

  it("verifies a page by appending a confidence ledger event", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "verify.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_verify000001",
        "title: Verify Me",
        'created_at: "2026-05-01"',
        'source_path: "./verify.md"',
        "---",
        "# Verify Me",
        "",
        "This page should receive a verified ledger event.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);
    runCli(["migrate", "to-v0.1", "--no-commit"], vault);

    const output = runCli(
      [
        "verify",
        "page_verify000001",
        "--by-agent",
        "claude-code",
        "--reason",
        "agent ran the documented workflow",
        "--no-commit",
      ],
      vault,
    );
    const ledgerPath = join(vault, "pages", ".page_verify000001.ledger.jsonl");
    const events = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(output).toContain("Verified 1 page");
    expect(events.at(-1)).toMatchObject({
      kind: "verified",
      pageId: "page_verify000001",
      actor: "agent",
      actorId: "agent:claude-code",
      verifierType: "agent",
      verifierId: "claude-code",
      reason: "agent ran the documented workflow",
    });

    const report = JSON.parse(
      runCli(
        ["confidence", "show", "page_verify000001", "--format", "json"],
        vault,
      ),
    );
    expect(report.last_verified_at).toBe(events.at(-1).timestamp);
    expect(report.explanation.verification_boost).toBe(0.15);
  });

  it("reports low-confidence pages during verify dry-run without writing events", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "stale.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_stale0000001",
        "title: Stale Runbook",
        'created_at: "2025-01-01"',
        'source_path: "./stale.md"',
        "---",
        "# Stale Runbook",
        "",
        "This old runbook should be flagged by dry-run.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);
    runCli(["migrate", "to-v0.1", "--no-commit"], vault);
    const ledgerPath = join(vault, "pages", ".page_stale0000001.ledger.jsonl");
    const before = readFileSync(ledgerPath, "utf8");

    const output = runCli(["verify", "page_stale0000001", "--dry-run"], vault);

    expect(output).toContain("Dry run");
    expect(output).toContain("page_stale0000001");
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
  });
});
