import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
    expect(readFileSync(join(vault, ".gitignore"), "utf8")).toContain(
      ".akb/lint/",
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

    runCli(["ingest", first, "--no-compile"], vault);
    const failure = runCliFailure(["ingest", second], vault);

    expect(failure).toContain("Page id already exists");
    expect(readFileSync(join(vault, "pages", "first.md"), "utf8")).toContain(
      "first body",
    );

    runCli(["ingest", second, "--force", "--no-compile"], vault);
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

  it("recomputes confidence state by replaying the JSONL ledger", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "recompute.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_recompute001",
        "title: Confidence Recompute",
        'created_at: "2026-05-01"',
        'source_path: "./recompute.md"',
        "---",
        "# Confidence Recompute",
        "",
        "This page should be replayable from its confidence ledger.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);

    const sourceAdded = {
      id: "evt_recompute001",
      kind: "source_added",
      pageId: "page_recompute001",
      timestamp: "2026-05-01T00:00:00.000Z",
      actor: "system",
      actorId: "akb-test",
      sourceId: "src_recompute001",
      sourceWeight: 0.8,
    };
    const contradicted = {
      id: "evt_recompute002",
      kind: "contradicted_by",
      pageId: "page_recompute001",
      timestamp: "2026-05-02T00:00:00.000Z",
      actor: "system",
      actorId: "akb-test",
      bySourceId: "src_recompute002",
      severity: "major",
    };
    const ledgerPath = join(vault, "pages", ".page_recompute001.ledger.jsonl");
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(sourceAdded)}\n${JSON.stringify(contradicted)}\n`,
    );

    const contradictedReport = JSON.parse(
      runCli(
        [
          "confidence",
          "recompute",
          "page_recompute001",
          "--format",
          "json",
          "--now",
          "2026-05-16T00:00:00.000Z",
        ],
        vault,
      ),
    );
    expect(contradictedReport.events_replayed).toBe(2);
    expect(contradictedReport.contradiction_count).toBe(1);

    const repeatedReport = JSON.parse(
      runCli(
        [
          "confidence",
          "recompute",
          "page_recompute001",
          "--format",
          "json",
          "--now",
          "2026-05-16T00:00:00.000Z",
        ],
        vault,
      ),
    );
    expect(repeatedReport).toEqual(contradictedReport);

    runCli(["projection", "rebuild", "--confidence"], vault);
    writeFileSync(ledgerPath, `${JSON.stringify(sourceAdded)}\n`);
    const replayedEarlierState = JSON.parse(
      runCli(
        [
          "confidence",
          "recompute",
          "page_recompute001",
          "--format",
          "json",
          "--now",
          "2026-05-16T00:00:00.000Z",
        ],
        vault,
      ),
    );

    expect(replayedEarlierState.events_replayed).toBe(1);
    expect(replayedEarlierState.contradiction_count).toBe(0);
    expect(replayedEarlierState.computed_at).toBe("2026-05-16T00:00:00.000Z");
    expect(replayedEarlierState.score).toBeGreaterThan(
      contradictedReport.score,
    );

    const invalidNow = runCliFailure(
      [
        "confidence",
        "recompute",
        "page_recompute001",
        "--now",
        "2026-05-16T00:00:00",
      ],
      vault,
    );
    expect(invalidNow).toContain("Invalid --now timestamp");
  });

  it("explains confidence score components with source events", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "explain.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_explain00001",
        "title: Confidence Explain",
        'type: "module"',
        'created_at: "2026-01-01"',
        "---",
        "# Confidence Explain",
        "",
        "This page should expose confidence score evidence.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);

    const events = [
      {
        id: "evt_explain00001",
        kind: "source_added",
        pageId: "page_explain00001",
        timestamp: "2026-01-01T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_explain00001",
        sourceWeight: 0.8,
      },
      {
        id: "evt_explain00002",
        kind: "source_removed",
        pageId: "page_explain00001",
        timestamp: "2026-01-15T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_explain00001",
        reason: "source superseded",
      },
      {
        id: "evt_explain00003",
        kind: "source_added",
        pageId: "page_explain00001",
        timestamp: "2026-01-20T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_explain00003",
        sourceWeight: 0.9,
      },
      {
        id: "evt_explain00004",
        kind: "verified",
        pageId: "page_explain00001",
        timestamp: "2026-02-01T00:00:00.000Z",
        actor: "agent",
        actorId: "ci:github-actions",
        verifierType: "agent",
        verifierId: "ci:github-actions",
        reason: "linked CI passed",
      },
      {
        id: "evt_explain00005",
        kind: "contradicted_by",
        pageId: "page_explain00001",
        timestamp: "2026-03-01T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        bySourceId: "src_explain00002",
        severity: "minor",
      },
      {
        id: "evt_explain00006",
        kind: "manual_override",
        pageId: "page_explain00001",
        timestamp: "2026-03-15T00:00:00.000Z",
        actor: "human",
        actorId: "alvin",
        reason: "temporary audit downgrade",
        newBase: 0.4,
      },
      {
        id: "evt_explain00007",
        kind: "manual_override",
        pageId: "page_explain00001",
        timestamp: "2026-04-01T00:00:00.000Z",
        actor: "human",
        actorId: "alvin",
        reason: "audit completed",
        newBase: 0.6,
      },
    ];
    writeFileSync(
      join(vault, "pages", ".page_explain00001.ledger.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    const report = JSON.parse(
      runCli(
        [
          "confidence",
          "show",
          "page_explain00001",
          "--format",
          "json",
          "--now",
          "2026-05-16T00:00:00.000Z",
        ],
        vault,
      ),
    );

    expect(report.events).toHaveLength(7);
    expect(report.events[0]).toMatchObject({
      id: "evt_explain00001",
      kind: "source_added",
      source_id: "src_explain00001",
      source_weight: 0.8,
    });
    expect(report.explanation.source_strength_events).toEqual([
      "evt_explain00003",
    ]);
    expect(report.explanation.active_sources).toEqual([
      {
        event_id: "evt_explain00003",
        source_id: "src_explain00003",
        weight: 0.9,
      },
    ]);
    expect(report.explanation.base_events).toEqual(["evt_explain00007"]);
    expect(report.explanation.verification_boost_events).toEqual([
      "evt_explain00004",
    ]);
    expect(report.explanation.contradiction_penalty_events).toEqual([
      "evt_explain00005",
    ]);
    expect(report.explanation.time_decay_event).toBe("evt_explain00007");
    expect(report.computed_at).toBe("2026-05-16T00:00:00.000Z");
    expect(report.status.flags).toContain("STALE");

    const repeatedReport = JSON.parse(
      runCli(
        [
          "confidence",
          "show",
          "page_explain00001",
          "--format",
          "json",
          "--now",
          "2026-05-16T00:00:00.000Z",
        ],
        vault,
      ),
    );
    expect(repeatedReport).toEqual(report);

    const text = runCli(
      [
        "confidence",
        "show",
        "page_explain00001",
        "--now",
        "2026-05-16T00:00:00.000Z",
      ],
      vault,
    );
    expect(text).toContain("breakdown:");
    expect(text).toContain("events: 7 total");
    expect(text).toContain("source_added");
    expect(text).toContain("status:");
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
    expect(report.explanation.verification_boost).toBe(0.02);
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
    const sourceAdded = {
      id: "evt_projsearch01",
      kind: "source_added",
      pageId: "page_projsearch01",
      timestamp: "2026-05-01T12:00:00.000Z",
      actor: "system",
      actorId: "akb-test",
      sourceId: "src_projsearch01",
      sourceWeight: 0.1,
    };
    const contradicted = {
      id: "evt_projsearch02",
      kind: "contradicted_by",
      pageId: "page_projsearch01",
      timestamp: new Date().toISOString(),
      actor: "system",
      actorId: "akb-test",
      bySourceId: "src_projsearch02",
      severity: "major",
    };
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(sourceAdded)}\n${JSON.stringify(contradicted)}\n`,
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
    expect(ranked.results[0].flags).toContain("RECENTLY_CONTRADICTED");
    expect(ranked.results[0].component_scores.confidence).toBeLessThan(0.5);
  });

  it("search flags recently major contradicted pages from JSONL fallback", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "contradicted.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_recentmajor0",
        "title: Recent Major Contradiction",
        "---",
        "# Recent Major Contradiction",
        "",
        "contradiction target content.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);
    writeFileSync(
      join(vault, "pages", ".page_recentmajor0.ledger.jsonl"),
      [
        JSON.stringify({
          id: "evt_recentmaj001",
          kind: "source_added",
          pageId: "page_recentmajor0",
          timestamp: "2026-05-01T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          sourceId: "src_recentmaj001",
          sourceWeight: 0.8,
        }),
        JSON.stringify({
          id: "evt_recentmaj002",
          kind: "contradicted_by",
          pageId: "page_recentmajor0",
          timestamp: new Date().toISOString(),
          actor: "system",
          actorId: "akb-test",
          bySourceId: "src_recentmaj002",
          severity: "major",
        }),
      ].join("\n"),
    );

    const payload = JSON.parse(
      runCli(["search", "contradiction target", "--format", "json"], vault),
    );

    expect(payload.results[0].flags).toContain("RECENTLY_CONTRADICTED");
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
    expect(existsSync(join(vault, ".akb", "lint", "low-confidence.md"))).toBe(
      true,
    );
  });

  it("lint reports orphan pages and writes suggestion reports", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const linked = join(dir, "linked.md");
    const hub = join(dir, "hub.md");
    const orphan = join(dir, "orphan.md");
    const selfLinked = join(dir, "self-linked.md");
    writeFileSync(
      linked,
      [
        "---",
        "id: page_linked000001",
        "title: Linked Page",
        "---",
        "# Linked Page",
        "",
        "This page links back to [[Hub Page]].",
      ].join("\n"),
    );
    writeFileSync(
      hub,
      [
        "---",
        "id: page_hub000000001",
        "title: Hub Page",
        "---",
        "# Hub Page",
        "",
        "This page links to [[Linked Page]].",
      ].join("\n"),
    );
    writeFileSync(
      orphan,
      [
        "---",
        "id: page_orphan000001",
        "title: Orphan Page",
        "---",
        "# Orphan Page",
        "",
        "This page has no incoming or outgoing wiki links.",
      ].join("\n"),
    );
    writeFileSync(
      selfLinked,
      [
        "---",
        "id: page_selflink0001",
        "title: Self Linked",
        "---",
        "# Self Linked",
        "",
        "This page only links to [[Self Linked]].",
      ].join("\n"),
    );
    runCli(["ingest", linked, "--no-commit"], vault);
    runCli(["ingest", hub, "--no-commit"], vault);
    runCli(["ingest", orphan, "--no-commit"], vault);
    runCli(["ingest", selfLinked, "--no-commit"], vault);

    const output = runCli(["lint"], vault);
    const orphanReport = readFileSync(
      join(vault, ".akb", "lint", "orphan-pages.md"),
      "utf8",
    );
    const suggestions = readFileSync(
      join(vault, ".akb", "lint", "suggestions.md"),
      "utf8",
    );

    expect(output).toContain("orphan pages");
    expect(orphanReport).toContain("page_orphan000001");
    expect(orphanReport).toContain("page_selflink0001");
    expect(orphanReport).not.toContain("page_hub000000001");
    expect(suggestions).toContain("page_orphan000001");
  });

  it("lint reports high derived ratio and orphaned lineage", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "source.md");
    const derived = join(dir, "derived.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_lintsrc00001",
        "title: Lint Source",
        "---",
        "# Lint Source",
        "",
        "Original source claim.",
      ].join("\n"),
    );
    writeFileSync(
      derived,
      [
        "---",
        "id: page_lintder00001",
        "title: Lint Derived",
        "---",
        "# Lint Derived",
        "",
        "<!-- akb:derived source=page_lintsrc00001:c0 method=summary -->",
        "Synthesized derived claim.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", derived, "--no-commit", "--no-compile"], vault);
    rmSync(join(vault, "pages", "source.md"));

    const output = runCli(["lint"], vault);
    const derivedReport = readFileSync(
      join(vault, ".akb", "lint", "derived-ratio.md"),
      "utf8",
    );
    const orphanedLineageReport = readFileSync(
      join(vault, ".akb", "lint", "orphaned-lineage.md"),
      "utf8",
    );

    expect(output).toContain("high derived ratio");
    expect(output).toContain("orphaned lineage");
    expect(derivedReport).toContain("page_lintder00001");
    expect(orphanedLineageReport).toContain("page_lintsrc00001:c0");

    writeFileSync(
      derived,
      [
        "---",
        "id: page_lintder00001",
        "title: Lint Derived",
        "---",
        "# Lint Derived",
        "",
        "<!-- akb:derived source=page_lintsrc00001 method=summary -->",
        "Synthesized derived claim.",
      ].join("\n"),
    );
    runCli(
      ["ingest", derived, "--force", "--no-commit", "--no-compile"],
      vault,
    );
    const unitOutput = runCli(["lint"], vault);
    const unitReport = readFileSync(
      join(vault, ".akb", "lint", "orphaned-lineage.md"),
      "utf8",
    );
    expect(unitOutput).toContain("orphaned lineage");
    expect(unitReport).toContain("page_lintsrc00001");
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
    runCli(["ingest", existing, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", incoming, "--no-commit", "--no-compile"], vault);
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

    const legacyPatch = patch
      .replace(/\n {2}apiKeyEnv: DEEPSEEK_API_KEY\n/, "\n")
      .replace(/\n {4}locate: sha256:[a-z0-9]+\n/, "\n")
      .replace(/\n {4}emit: sha256:[a-z0-9]+\n/, "\n")
      .replace(/\n {2}stages:\n(?: {4}- .+\n(?: {6}.+\n)+)+/, "\n")
      .replace(/\n {2}temperature: 0\n/, "\n");
    writeFileSync(patchPath, legacyPatch);
    const legacyReplay = runCli(
      ["compile", "replay", "patch_page_compile00002"],
      vault,
    );
    expect(legacyReplay).toContain("Replay matched patch_page_compile00002");

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

  it("applies heuristic contradiction and supersede compile patches", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const target = join(dir, "gc.md");
    const contradiction = join(dir, "gc-conflict.md");
    const supersede = join(dir, "adaptive-gc.md");
    writeFileSync(
      target,
      [
        "---",
        "id: page_gctarget0001",
        "title: Garbage Collection",
        "---",
        "# Garbage Collection",
        "",
        "Garbage collection uses a fixed 10% threshold.",
      ].join("\n"),
    );
    writeFileSync(
      contradiction,
      [
        "---",
        "id: page_contra000001",
        "title: GC Conflict",
        "---",
        "# GC Conflict",
        "",
        "This contradicts Garbage Collection. Use a 5% threshold instead.",
      ].join("\n"),
    );
    writeFileSync(
      supersede,
      [
        "---",
        "id: page_supers000001",
        "title: Adaptive GC",
        "---",
        "# Adaptive GC",
        "",
        "This supersedes Garbage Collection. Adaptive thresholds replace the fixed threshold model.",
      ].join("\n"),
    );
    runCli(["ingest", target, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", contradiction, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", supersede, "--no-commit", "--no-compile"], vault);

    const contradictOutput = runCli(
      ["compile", "--source", "page_contra000001"],
      vault,
    );
    expect(contradictOutput).toContain("modify page_gctarget0001 (contradict)");
    runCli(["patch", "apply", "patch_page_contra000001", "--no-commit"], vault);
    expect(readFileSync(join(vault, "pages", "gc.md"), "utf8")).toContain(
      "[!contradiction]",
    );
    expect(
      readFileSync(
        join(vault, "pages", ".page_gctarget0001.ledger.jsonl"),
        "utf8",
      ),
    ).toContain('"kind":"contradicted_by"');

    const supersedeOutput = runCli(
      ["compile", "--source", "page_supers000001"],
      vault,
    );
    expect(supersedeOutput).toContain("create ");
    expect(supersedeOutput).toContain("(supersede)");
    const supersedePatch = readFileSync(
      join(vault, ".akb", "patches", "patch_page_supers000001.yaml"),
      "utf8",
    );
    expect(supersedePatch).toContain("path: pages/compiled/adaptive-gc.md");
    runCli(["patch", "apply", "patch_page_supers000001", "--no-commit"], vault);
    expect(existsSync(join(vault, "pages", "compiled", "adaptive-gc.md"))).toBe(
      true,
    );
    expect(
      readFileSync(join(vault, "pages", "compiled", "adaptive-gc.md"), "utf8"),
    ).toContain("supersedes: page_gctarget0001");
    expect(
      readFileSync(
        join(vault, "pages", ".page_gctarget0001.ledger.jsonl"),
        "utf8",
      ),
    ).toContain('"kind":"superseded_by"');
  });

  it("ingest compiles by default and tracks compile-disabled sources", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const autoSource = join(dir, "auto-compile.md");
    const disabledSource = join(dir, "disabled-compile.md");
    writeFileSync(
      autoSource,
      [
        "---",
        "id: page_autocompile1",
        "title: Auto Compile",
        "---",
        "# Auto Compile",
        "",
        "Auto compile standalone source.",
      ].join("\n"),
    );
    writeFileSync(
      disabledSource,
      [
        "---",
        "id: page_compileoff01",
        "title: Compile Disabled",
        "---",
        "# Compile Disabled",
        "",
        "Compile disabled standalone source.",
      ].join("\n"),
    );

    const autoOutput = runCli(["ingest", autoSource, "--no-commit"], vault);
    expect(autoOutput).toContain("Compiled page_autocompile1");
    expect(
      existsSync(
        join(vault, ".akb", "patches", "patch_page_autocompile1.yaml"),
      ),
    ).toBe(true);

    const disabledOutput = runCli(
      ["ingest", disabledSource, "--no-compile", "--no-commit"],
      vault,
    );
    expect(disabledOutput).not.toContain("Compiled page_compileoff01");

    writeFileSync(
      disabledSource,
      [
        "---",
        "id: page_compileoff02",
        "title: Compile Disabled Replacement",
        "---",
        "# Compile Disabled Replacement",
        "",
        "Replacement source should clean stale disabled ids.",
      ].join("\n"),
    );
    runCli(
      ["ingest", disabledSource, "--force", "--no-compile", "--no-commit"],
      vault,
    );

    const status = runCli(["compile", "status"], vault);
    expect(status).toContain("compiled:");
    expect(status).toContain("degraded:        1");
    expect(status).toContain("compile-disabled: 1");
    expect(
      readFileSync(join(vault, ".akb", "compile-disabled.json"), "utf8"),
    ).not.toContain("page_compileoff01");

    const manualOutput = runCli(
      ["compile", "--source", "page_compileoff02"],
      vault,
    );
    expect(manualOutput).toContain("Compiled page_compileoff02");
    const afterManualCompile = runCli(["compile", "status"], vault);
    expect(afterManualCompile).toContain("compile-disabled: 0");
  });

  it("runs compile eval golden gates", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const fixtureDir = join(vault, ".akb", "eval", "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    const existing = join(fixtureDir, "eval-gc.md");
    const incoming = join(fixtureDir, "eval-gc-update.md");
    writeFileSync(
      existing,
      [
        "---",
        "id: page_evalcompile1",
        "title: Eval GC Strategy",
        "aliases:",
        "  - garbage collection",
        "---",
        "# Eval GC Strategy",
        "",
        "GC uses fixed thresholds.",
      ].join("\n"),
    );
    writeFileSync(
      incoming,
      [
        "---",
        "id: page_evalcompile2",
        "title: Eval Adaptive GC",
        "tags:",
        "  - garbage collection",
        "---",
        "# Eval Adaptive GC",
        "",
        "Adaptive garbage collection updates threshold policy.",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, ".akb", "eval", "compile-golden.yaml"),
      [
        'version: "1.0"',
        "items:",
        "  - id: c001",
        '    description: "adaptive GC should extend existing GC page"',
        "    setup:",
        "      existingPages:",
        "        - fixtures/eval-gc.md",
        "      newSource: fixtures/eval-gc-update.md",
        "    expect:",
        "      relations:",
        "        - againstPage: page_evalcompile1",
        "          relation: extend",
        "      mustNotCreatePage: true",
      ].join("\n"),
    );

    const output = runCli(
      [
        "eval",
        "compile",
        "--set",
        ".akb/eval/compile-golden.yaml",
        "--output",
        ".akb/eval/compile-report.json",
      ],
      vault,
    );
    const report = JSON.parse(
      readFileSync(join(vault, ".akb", "eval", "compile-report.json"), "utf8"),
    );
    expect(output).toContain("Compile eval: 1 items");
    expect(output).toContain("relation accuracy: 1/1");
    expect(report.relation_accuracy).toBe(1);
    expect(report.target_accuracy).toBe(1);

    writeFileSync(
      join(vault, ".akb", "eval", "compile-golden.yaml"),
      [
        'version: "1.0"',
        "items:",
        "  - id: c001",
        "    setup:",
        "      existingPages:",
        "        - fixtures/eval-gc.md",
        "      newSource: fixtures/eval-gc-update.md",
        "    expect:",
        "      relations:",
        "        - againstPage: page_evalcompile1",
        "          relation: supersede",
      ].join("\n"),
    );
    const failure = runCliFailure(
      ["eval", "compile", "--set", ".akb/eval/compile-golden.yaml"],
      vault,
    );
    expect(failure).toContain("FAILED");
    expect(failure).toContain("expected supersede");
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
    runCli(["ingest", first, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", second, "--no-commit", "--no-compile"], vault);
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

  it("applies create patches and records supersede confidence events", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const existing = join(dir, "old-gc.md");
    writeFileSync(
      existing,
      [
        "---",
        "id: page_oldcreate001",
        "title: Old GC",
        "---",
        "# Old GC",
        "",
        "Old garbage collection threshold.",
      ].join("\n"),
    );
    runCli(["ingest", existing, "--no-commit", "--no-compile"], vault);
    const patchPath = join(vault, ".akb", "patches", "patch_create.yaml");
    writeFileSync(
      patchPath,
      [
        "id: patch_create",
        "status: proposed",
        "source:",
        "  pageId: page_oldcreate001",
        "changes:",
        "  - type: create",
        "    newPageId: page_newcreate001",
        "    path: pages/adaptive-gc.md",
        "    relation: supersede",
        "    classifyConfidence: 0.91",
        "    reasoning: Adaptive GC supersedes the old threshold model.",
        "    supersedes: page_oldcreate001",
        "    content: |",
        "      ---",
        "      id: page_newcreate001",
        "      title: Adaptive GC",
        "      supersedes: page_oldcreate001",
        "      ---",
        "      # Adaptive GC",
        "      ",
        "      <!-- akb:derived source=page_oldcreate001:c0 method=supersede -->",
        "      Adaptive garbage collection replaces the old threshold model.",
        "    confidenceImpact:",
        "      kind: supersedes",
        "      supersededPageId: page_oldcreate001",
      ].join("\n"),
    );

    const output = runCli(
      ["patch", "apply", "patch_create", "--no-commit"],
      vault,
    );

    expect(output).toContain("Applied patch_create");
    expect(
      readFileSync(join(vault, "pages", "adaptive-gc.md"), "utf8"),
    ).toContain("id: page_newcreate001");
    expect(
      readFileSync(
        join(vault, "pages", ".page_newcreate001.ledger.jsonl"),
        "utf8",
      ),
    ).toContain('"kind":"supersedes"');
    expect(
      readFileSync(
        join(vault, "pages", ".page_oldcreate001.ledger.jsonl"),
        "utf8",
      ),
    ).toContain('"kind":"superseded_by"');
    expect(
      existsSync(
        join(vault, ".akb", "patches", "applied", "patch_create.yaml"),
      ),
    ).toBe(true);
  });

  it("rejects unsafe or inconsistent create patches before writing pages", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const existing = join(dir, "old-gc.md");
    writeFileSync(
      existing,
      [
        "---",
        "id: page_oldunsafe001",
        "title: Old Unsafe",
        "---",
        "# Old Unsafe",
        "",
        "Old unsafe source.",
      ].join("\n"),
    );
    runCli(["ingest", existing, "--no-commit", "--no-compile"], vault);

    const duplicatePatch = join(
      vault,
      ".akb",
      "patches",
      "patch_dupe_create.yaml",
    );
    writeFileSync(
      duplicatePatch,
      [
        "id: patch_dupe_create",
        "status: proposed",
        "changes:",
        "  - type: create",
        "    newPageId: page_newunsafe001",
        "    path: pages/unsafe-one.md",
        "    relation: new",
        "    classifyConfidence: 0.8",
        "    reasoning: duplicate id one",
        "    content: |",
        "      # Unsafe One",
        "  - type: create",
        "    newPageId: page_newunsafe001",
        "    path: pages/unsafe-two.md",
        "    relation: new",
        "    classifyConfidence: 0.8",
        "    reasoning: duplicate id two",
        "    content: |",
        "      # Unsafe Two",
      ].join("\n"),
    );
    expect(
      runCliFailure(["patch", "apply", "patch_dupe_create"], vault),
    ).toContain("duplicate create page id");
    expect(existsSync(join(vault, "pages", "unsafe-one.md"))).toBe(false);

    const mismatchPatch = join(
      vault,
      ".akb",
      "patches",
      "patch_bad_relation.yaml",
    );
    writeFileSync(
      mismatchPatch,
      [
        "id: patch_bad_relation",
        "status: proposed",
        "changes:",
        "  - type: create",
        "    newPageId: page_newunsafe002",
        "    path: pages/unsafe-relation.md",
        "    relation: new",
        "    supersedes: page_oldunsafe001",
        "    classifyConfidence: 0.8",
        "    reasoning: inconsistent supersede fields",
        "    content: |",
        "      # Unsafe Relation",
      ].join("\n"),
    );
    expect(
      runCliFailure(["patch", "apply", "patch_bad_relation"], vault),
    ).toContain("new create cannot supersede");
    expect(existsSync(join(vault, "pages", "unsafe-relation.md"))).toBe(false);

    const outsideDir = join(dir, "outside");
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(vault, "pages", "outside-link"));
    const symlinkPatch = join(vault, ".akb", "patches", "patch_symlink.yaml");
    writeFileSync(
      symlinkPatch,
      [
        "id: patch_symlink",
        "status: proposed",
        "changes:",
        "  - type: create",
        "    newPageId: page_newunsafe003",
        "    path: pages/outside-link/escape.md",
        "    relation: new",
        "    classifyConfidence: 0.8",
        "    reasoning: symlink traversal attempt",
        "    content: |",
        "      # Escape",
      ].join("\n"),
    );
    expect(runCliFailure(["patch", "apply", "patch_symlink"], vault)).toContain(
      "invalid create path",
    );
    expect(existsSync(join(outsideDir, "escape.md"))).toBe(false);
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
