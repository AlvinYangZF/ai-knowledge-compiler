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

  it("supersedes one page with another page and records both ledger events", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const oldSource = join(dir, "old.md");
    const newSource = join(dir, "new.md");
    writeFileSync(
      oldSource,
      [
        "---",
        "id: page_old000000001",
        "title: Old Threshold Model",
        'created_at: "2026-01-01"',
        'source_path: "./old.md"',
        "---",
        "# Old Threshold Model",
        "",
        "The old model uses a fixed threshold.",
      ].join("\n"),
    );
    writeFileSync(
      newSource,
      [
        "---",
        "id: page_new000000001",
        "title: New Adaptive Model",
        'created_at: "2026-05-01"',
        'source_path: "./new.md"',
        "---",
        "# New Adaptive Model",
        "",
        "The new model adapts the threshold to workload pressure.",
      ].join("\n"),
    );
    runCli(["ingest", oldSource, "--no-commit"], vault);
    runCli(["ingest", newSource, "--no-commit"], vault);
    runCli(["migrate", "to-v0.1", "--no-commit"], vault);

    const output = runCli(
      [
        "supersede",
        "page_old000000001",
        "--by",
        "page_new000000001",
        "--reason",
        "adaptive model supersedes fixed threshold",
        "--no-commit",
      ],
      vault,
    );

    const oldEvents = readFileSync(
      join(vault, "pages", ".page_old000000001.ledger.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const newEvents = readFileSync(
      join(vault, "pages", ".page_new000000001.ledger.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const newPage = readFileSync(join(vault, "pages", "new.md"), "utf8");

    expect(output).toContain(
      "Superseded page_old000000001 by page_new000000001",
    );
    expect(oldEvents.at(-1)).toMatchObject({
      kind: "superseded_by",
      pageId: "page_old000000001",
      supersederPageId: "page_new000000001",
      reason: "adaptive model supersedes fixed threshold",
    });
    expect(newEvents.at(-1)).toMatchObject({
      kind: "supersedes",
      pageId: "page_new000000001",
      supersededPageId: "page_old000000001",
      reason: "adaptive model supersedes fixed threshold",
    });
    expect(newPage).toContain("supersedes: page_old000000001");
    expect(newPage).toContain("> Supersedes [[page_old000000001]].");

    const oldReport = JSON.parse(
      runCli(
        ["confidence", "show", "page_old000000001", "--format", "json"],
        vault,
      ),
    );
    expect(oldReport.superseded_by).toBe("page_new000000001");
  });

  it("applies confidence-aware ranking to search JSON output", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const oldSource = join(dir, "old-search.md");
    const newSource = join(dir, "new-search.md");
    writeFileSync(
      oldSource,
      [
        "---",
        "id: page_oldsearch001",
        "title: Old Search Result",
        'source_path: "./old-search.md"',
        "---",
        "# Old Search Result",
        "",
        "Threshold threshold threshold policy.",
      ].join("\n"),
    );
    writeFileSync(
      newSource,
      [
        "---",
        "id: page_newsearch001",
        "title: New Search Result",
        'source_path: "./new-search.md"',
        "---",
        "# New Search Result",
        "",
        "Threshold policy.",
      ].join("\n"),
    );
    runCli(["ingest", oldSource, "--no-commit"], vault);
    runCli(["ingest", newSource, "--no-commit"], vault);
    runCli(["migrate", "to-v0.1", "--no-commit"], vault);
    runCli(
      [
        "supersede",
        "page_oldsearch001",
        "--by",
        "page_newsearch001",
        "--no-commit",
      ],
      vault,
    );
    runCli(["index", "--rebuild"], vault);

    const ranked = JSON.parse(
      runCli(["search", "threshold", "--format", "json"], vault),
    );
    expect(
      ranked.results.map((item: { page_id: string }) => item.page_id),
    ).toContain("page_newsearch001");
    expect(
      ranked.results.map((item: { page_id: string }) => item.page_id),
    ).not.toContain("page_oldsearch001");
    expect(ranked.results[0]).toHaveProperty("final_score");
    expect(ranked.results[0]).toHaveProperty("component_scores.confidence");
    expect(ranked.results[0]).toHaveProperty("flags");

    const withHistory = JSON.parse(
      runCli(
        ["search", "threshold", "--format", "json", "--include-superseded"],
        vault,
      ),
    );
    const oldResult = withHistory.results.find(
      (item: { page_id: string }) => item.page_id === "page_oldsearch001",
    );
    expect(oldResult.flags).toContain("SUPERSEDED");
  });

  it("rebuilds confidence projection and uses it for search ranking", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "projection.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_projsearch01",
        "title: Projection Search",
        "---",
        "# Projection Search",
        "",
        "Projection-backed confidence search should flag weak sources.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);
    const ledgerPath = join(vault, "pages", ".page_projsearch01.ledger.jsonl");
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        id: "evt_projsearch01",
        kind: "source_added",
        pageId: "page_projsearch01",
        timestamp: "2026-05-01T12:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_projsearch01",
        sourceWeight: 0.1,
      })}\n`,
    );

    const output = runCli(["projection", "rebuild", "--confidence"], vault);
    rmSync(ledgerPath);
    runCli(["index", "--rebuild"], vault);
    const ranked = JSON.parse(
      runCli(["search", "projection", "--format", "json"], vault),
    );

    expect(output).toContain("Rebuilt confidence projection");
    expect(ranked.results[0].page_id).toBe("page_projsearch01");
    expect(ranked.results[0].flags).toContain("NEEDS_REVIEW");
    expect(ranked.results[0].component_scores.confidence).toBeLessThan(0.5);
  });

  it("lint reports low-confidence warnings without failing", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "weak.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_lintweak0001",
        "title: Weak Source",
        "---",
        "# Weak Source",
        "",
        "This page has a weak source but no structural errors.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);
    writeFileSync(
      join(vault, "pages", ".page_lintweak0001.ledger.jsonl"),
      `${JSON.stringify({
        id: "evt_lintweak0001",
        kind: "source_added",
        pageId: "page_lintweak0001",
        timestamp: "2026-05-01T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_lintweak0001",
        sourceWeight: 0.1,
      })}\n`,
    );
    runCli(["projection", "rebuild", "--confidence"], vault);

    const output = runCli(["lint"], vault);

    expect(output).toContain("Confidence issues");
    expect(output).toContain("page_lintweak0001");
    expect(output).toContain("low-confidence");
  });

  it("lint fails on broken wikilinks and supersession cycles", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const first = join(dir, "first.md");
    const second = join(dir, "second.md");
    writeFileSync(
      first,
      [
        "---",
        "id: page_cycle0000001",
        "title: First Cycle Page",
        "supersedes: page_cycle0000002",
        "---",
        "# First Cycle Page",
        "",
        "This references [[Missing Page]].",
      ].join("\n"),
    );
    writeFileSync(
      second,
      [
        "---",
        "id: page_cycle0000002",
        "title: Second Cycle Page",
        "supersedes: page_cycle0000001",
        "---",
        "# Second Cycle Page",
        "",
        "This closes the supersession cycle.",
      ].join("\n"),
    );
    runCli(["ingest", first, "--no-commit"], vault);
    runCli(["ingest", second, "--no-commit"], vault);

    const output = runCliFailure(["lint"], vault);

    expect(output).toContain("Broken wiki links");
    expect(output).toContain("Missing Page");
    expect(output).toContain("Supersession cycles");
    expect(output).toContain("page_cycle0000001");
  });

  it("records runtime verification signals from webhook and watch", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "runbook.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_runtime00001",
        "title: Runtime Signal Page",
        "references:",
        "  - src/runtime.ts",
        "---",
        "# Runtime Signal Page",
        "",
        "Runtime signal target.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);

    const webhook = runCli(
      [
        "webhook",
        "ci-success",
        "--actor-id",
        "ci:github-actions",
        "--changed-file",
        "src/runtime.ts",
        "--evidence",
        "https://ci.example/run/1",
        "--no-commit",
      ],
      vault,
    );
    expect(webhook).toContain("Recorded 1 runtime verification");

    const signalDir = join(vault, ".akb", "runtime-signals");
    mkdirSync(signalDir, { recursive: true });
    writeFileSync(
      join(signalDir, "signal.json"),
      JSON.stringify({
        kind: "deploy_success",
        page_ids: ["page_runtime00001"],
        actor_id: "deploy-bot",
        evidence: "deploy-42",
      }),
    );
    const watch = runCli(["watch", "--once", "--no-commit"], vault);
    expect(watch).toContain("Processed 1 runtime signal");
    expect(existsSync(join(signalDir, "signal.json"))).toBe(false);

    const ledger = readFileSync(
      join(vault, "pages", ".page_runtime00001.ledger.jsonl"),
      "utf8",
    );
    expect(ledger.match(/"kind":"verified"/g)?.length).toBe(2);
  });

  it("decay writes sparse checkpoints when confidence crosses a threshold", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "old-runbook.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_decay0000001",
        "title: Old Runbook",
        "type: runbook",
        "---",
        "# Old Runbook",
        "",
        "Old operational steps.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);
    writeFileSync(
      join(vault, "pages", ".page_decay0000001.ledger.jsonl"),
      `${JSON.stringify({
        id: "evt_decay0000010",
        kind: "source_added",
        pageId: "page_decay0000001",
        timestamp: "2025-01-01T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_decay0000010",
        sourceWeight: 0.8,
      })}\n`,
    );

    const output = runCli(
      ["decay", "--run", "--now", "2026-05-16T00:00:00.000Z", "--no-commit"],
      vault,
    );

    expect(output).toContain("Wrote 1 decay checkpoint");
    const ledger = readFileSync(
      join(vault, "pages", ".page_decay0000001.ledger.jsonl"),
      "utf8",
    );
    expect(ledger).toContain('"kind":"decay_checkpoint"');
  });

  it("compiles a related source into a proposed patch without touching markdown and applies lineage", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const existing = join(dir, "gc.md");
    const incoming = join(dir, "gc-update.md");
    writeFileSync(
      existing,
      [
        "---",
        "id: page_compile00001",
        "title: GC Strategy",
        "aliases:",
        "  - garbage collection",
        "---",
        "# GC Strategy",
        "",
        "GC uses a fixed 10% free block threshold.",
      ].join("\n"),
    );
    writeFileSync(
      incoming,
      [
        "---",
        "id: page_compile00002",
        "title: Adaptive GC Update",
        "tags:",
        "  - garbage collection",
        "---",
        "# Adaptive GC Update",
        "",
        "New measurements show garbage collection should use an adaptive threshold.",
      ].join("\n"),
    );
    runCli(["ingest", existing, "--no-commit"], vault);
    runCli(["ingest", incoming, "--no-commit"], vault);
    const before = readFileSync(join(vault, "pages", "gc.md"), "utf8");

    const output = runCli(["compile", "--source", "page_compile00002"], vault);

    expect(output).toContain("Compiled page_compile00002");
    expect(readFileSync(join(vault, "pages", "gc.md"), "utf8")).toBe(before);
    const patchPath = join(
      vault,
      ".akb",
      "patches",
      "patch_page_compile00002.yaml",
    );
    expect(existsSync(patchPath)).toBe(true);
    const patch = readFileSync(patchPath, "utf8");
    expect(patch).toContain("status: proposed");
    expect(patch).toContain("relation: extend");

    const status = runCli(["compile", "status"], vault);
    expect(status).toContain("compiled:");

    const replay = runCli(
      ["compile", "replay", "patch_page_compile00002"],
      vault,
    );
    expect(replay).toContain("Replay matched patch_page_compile00002");

    const applyOutput = runCli(
      ["patch", "apply", "patch_page_compile00002", "--no-commit"],
      vault,
    );
    expect(applyOutput).toContain("Applied patch_page_compile00002");
    const applied = readFileSync(join(vault, "pages", "gc.md"), "utf8");
    expect(applied).toContain("<!-- akb:derived");
    expect(
      existsSync(
        join(
          vault,
          ".akb",
          "patches",
          "applied",
          "patch_page_compile00002.yaml",
        ),
      ),
    ).toBe(true);

    const lineage = runCli(["lineage", "page_compile00001"], vault);
    expect(lineage).toContain("page_compile00001");
    expect(lineage).toContain("page_compile00002:c0");
    expect(lineage).toContain("L");
    const reverse = runCli(
      ["lineage", "--reverse", "page_compile00002"],
      vault,
    );
    expect(reverse).toContain("page_compile00001");
  });

  it("rejects duplicate compile and invalid patches without partial writes", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const first = join(dir, "first.md");
    const second = join(dir, "second.md");
    writeFileSync(
      first,
      [
        "---",
        "id: page_atomic000001",
        "title: Atomic Target",
        "---",
        "# Atomic Target",
        "",
        "Atomic patch target.",
      ].join("\n"),
    );
    writeFileSync(
      second,
      [
        "---",
        "id: page_atomic000002",
        "title: Atomic Source",
        "tags:",
        "  - atomic",
        "---",
        "# Atomic Source",
        "",
        "Atomic patch source mentions target.",
      ].join("\n"),
    );
    runCli(["ingest", first, "--no-commit"], vault);
    runCli(["ingest", second, "--no-commit"], vault);
    runCli(["compile", "--source", "page_atomic000002"], vault);
    expect(
      runCliFailure(["compile", "--source", "page_atomic000002"], vault),
    ).toContain("Patch already exists");

    const patchPath = join(vault, ".akb", "patches", "patch_bad.yaml");
    writeFileSync(
      patchPath,
      [
        "id: patch_bad",
        "status: proposed",
        "source:",
        "  pageId: page_atomic000002",
        "  sourceId: src_atomic000001",
        "changes:",
        "  - type: modify",
        "    pageId: page_atomic000001",
        "    operation: append_section",
        "    relation: extend",
        "    classifyConfidence: 0.7",
        "    reasoning: bad patch first change",
        "    content: |",
        "      ## Should Not Land",
        "      <!-- akb:derived source=page_atomic000002:c0 method=extend patch=patch_bad -->",
        "      This must not be written.",
        "    confidenceImpact:",
        "      kind: source_added",
        "      sourceWeight: 0.8",
        "  - type: modify",
        "    pageId: ../README.md",
        "    operation: append_section",
        "    relation: extend",
        "    classifyConfidence: 0.7",
        "    reasoning: invalid target",
        "    content: bad",
        "lineage:",
        "  units:",
        "    - id: page_atomic000002:su0",
        "      sourcePageId: page_atomic000002",
        "      sourceChunkIds:",
        "        - page_atomic000002:c0",
      ].join("\n"),
    );
    const before = readFileSync(join(vault, "pages", "first.md"), "utf8");
    const failure = runCliFailure(["patch", "apply", "patch_bad"], vault);

    expect(failure).toContain("Invalid patch");
    expect(readFileSync(join(vault, "pages", "first.md"), "utf8")).toBe(before);
    expect(
      existsSync(join(vault, "pages", ".page_atomic000001.ledger.jsonl")),
    ).toBe(false);
  });

  it("rejects patches with unresolved derived source chunks", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const target = join(dir, "target.md");
    const source = join(dir, "source.md");
    writeFileSync(
      target,
      [
        "---",
        "id: page_chunk0000010",
        "title: Chunk Target",
        "---",
        "# Chunk Target",
        "",
        "Target page.",
      ].join("\n"),
    );
    writeFileSync(
      source,
      [
        "---",
        "id: page_chunk0000020",
        "title: Chunk Source",
        "---",
        "# Chunk Source",
        "",
        "Only one chunk exists.",
      ].join("\n"),
    );
    runCli(["ingest", target, "--no-commit"], vault);
    runCli(["ingest", source, "--no-commit"], vault);
    writeFileSync(
      join(vault, ".akb", "patches", "patch_bad_chunk.yaml"),
      [
        "id: patch_bad_chunk",
        "status: proposed",
        "source:",
        "  pageId: page_chunk0000020",
        "  sourceId: src_chunk0000010",
        "changes:",
        "  - type: modify",
        "    pageId: page_chunk0000010",
        "    operation: append_section",
        "    relation: extend",
        "    classifyConfidence: 0.7",
        "    reasoning: invalid chunk source",
        "    content: |",
        "      ## Invalid Chunk",
        "      <!-- akb:derived source=page_chunk0000020:c999 method=extend patch=patch_bad_chunk -->",
        "      This must not apply.",
        "    confidenceImpact:",
        "      kind: source_added",
        "      sourceWeight: 0.8",
        "lineage:",
        "  units:",
        "    - id: page_chunk0000020:su0",
        "      sourcePageId: page_chunk0000020",
        "      sourceChunkIds:",
        "        - page_chunk0000020:c999",
      ].join("\n"),
    );

    const failure = runCliFailure(["patch", "apply", "patch_bad_chunk"], vault);

    expect(failure).toContain("unresolved derived source");
  });

  it("rejects unmapped runtime webhook signals", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const failure = runCliFailure(
      [
        "webhook",
        "ci-success",
        "--changed-file",
        "src/unknown.ts",
        "--pr-number",
        "42",
        "--no-commit",
      ],
      vault,
    );

    expect(failure).toContain("did not match any pages");
  });
});
