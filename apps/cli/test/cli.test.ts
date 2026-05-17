import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfidenceProjection } from "@akb/confidence";
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

function runCliWithEnvAsync(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", tsxLoader, cli, ...args],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function runCliWithEnvFailureAsync(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  try {
    await runCliWithEnvAsync(args, cwd, env);
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
  throw new Error("Expected command to fail");
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

    const hybridJson = JSON.parse(
      runCli(
        ["search", "garbage collection", "--hybrid", "--format", "json"],
        vault,
      ),
    );
    expect(hybridJson.retrieval_mode).toBe("hybrid");
    expect(hybridJson.results[0].hybrid_score).toBeGreaterThan(0);
    expect(hybridJson.results[0].vector_score).toBeGreaterThan(0);

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

  it("answers questions with citations from ranked retrieval", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "gc-answer.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_answer000001",
        "title: Answer Source",
        "---",
        "# Answer Source",
        "",
        "Garbage collection reclaims NAND blocks when free block count is low.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);

    const payload = JSON.parse(
      runCli(
        ["ask", "garbage collection reclaims blocks?", "--format", "json"],
        vault,
      ),
    );

    expect(payload.degraded).toBe(true);
    expect(payload.answer).toContain("Garbage collection reclaims NAND blocks");
    expect(payload.citations[0]).toMatchObject({
      page_id: "page_answer000001",
      title: "Answer Source",
    });
    expect(payload.citations[0].line_start).toBeGreaterThan(1);

    const text = runCli(["ask", "garbage collection reclaims blocks?"], vault);
    expect(text).toContain("Extractive answer");
    expect(text).toContain("[1] page_answer000001");
    expect(text).toContain("Warning:");
  });

  it("generates ask answers with configured DeepSeek citations", async () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "gc-generated-answer.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_askllm000001",
        "title: Generated Answer Source",
        "---",
        "# Generated Answer Source",
        "",
        "Garbage collection reclaims NAND blocks when free block count is low.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);

    const requests: unknown[] = [];
    const requestMeta: Array<{
      method?: string;
      url?: string;
      authorization?: string;
    }> = [];
    const server = createServer((request, response) => {
      requestMeta.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "deepseek-v4-pro-routed",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer:
                      "Garbage collection reclaims NAND blocks when free block count is low. [1]",
                    used_refs: [1],
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-pro"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      const payload = JSON.parse(
        await runCliWithEnvAsync(
          ["ask", "garbage collection reclaims blocks?", "--format", "json"],
          vault,
          { AKB_TEST_DEEPSEEK_KEY: "test-key" },
        ),
      );

      expect(payload.degraded).toBe(false);
      expect(payload.answer).toContain("free block count is low. [1]");
      expect(payload.answer_provider).toBe("deepseek");
      expect(payload.answer_model).toBe("deepseek-v4-pro-routed");
      expect(payload.citations[0]).toMatchObject({
        ref: 1,
        page_id: "page_askllm000001",
      });
      expect(requests).toHaveLength(1);
      expect(requestMeta[0]).toMatchObject({
        method: "POST",
        url: "/chat/completions",
        authorization: "Bearer test-key",
      });
      expect(requests[0]).toMatchObject({
        model: "deepseek-v4-pro",
        temperature: 0,
        response_format: { type: "json_object" },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retries ask retrieval with acronym keywords before calling the LLM", async () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "architecture.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_askfallback1",
        "title: Architecture",
        "---",
        "# Architecture",
        "",
        "The FTL coordinates logical to physical address mapping in the system architecture.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);

    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "deepseek-v4-pro-routed",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer:
                      "FTL coordinates logical to physical address mapping in the system architecture. [1]",
                    used_refs: [1],
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-pro"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      const payload = JSON.parse(
        await runCliWithEnvAsync(
          [
            "ask",
            "FTL 是什么？请根据知识库总结它在系统架构中的作用",
            "--format",
            "json",
          ],
          vault,
          { AKB_TEST_DEEPSEEK_KEY: "test-key" },
        ),
      );

      expect(payload.degraded).toBe(false);
      expect(payload.no_evidence).toBe(false);
      expect(payload.retrieval_query).toBe("FTL");
      expect(payload.retrieval_fallback).toBe(true);
      expect(payload.answer_provider).toBe("deepseek");
      expect(payload.answer_model).toBe("deepseek-v4-pro-routed");
      expect(payload.answer).toContain("FTL coordinates");
      expect(payload.citations[0]).toMatchObject({
        page_id: "page_askfallback1",
      });
      expect(requests).toHaveLength(1);

      const text = await runCliWithEnvAsync(
        ["ask", "FTL 是什么？请根据知识库总结它在系统架构中的作用"],
        vault,
        { AKB_TEST_DEEPSEEK_KEY: "test-key" },
      );
      expect(text).toContain(
        'Retrieval fallback: used "FTL" after no results for the original question.',
      );
      expect(text).toContain(
        "Generated answer (deepseek, deepseek-v4-pro-routed):",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("generates ask answers with configured Anthropic citations", async () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "gc-anthropic-answer.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_askanthropic",
        "title: Anthropic Answer Source",
        "---",
        "# Anthropic Answer Source",
        "",
        "Garbage collection reclaims NAND blocks when free block count is low.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);

    const requestMeta: Array<{
      method?: string;
      url?: string;
      apiKey?: string;
      anthropicVersion?: string;
    }> = [];
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      requestMeta.push({
        method: request.method,
        url: request.url,
        apiKey: request.headers["x-api-key"] as string | undefined,
        anthropicVersion: request.headers["anthropic-version"] as
          | string
          | undefined,
      });
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  answer:
                    "Garbage collection reclaims NAND blocks when free block count is low. [1]",
                  used_refs: [1],
                }),
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          '  provider: "anthropic"',
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "claude-sonnet-4-20250514"',
          '  api_key_env: "AKB_TEST_ANTHROPIC_KEY"',
          "",
        ].join("\n"),
      );

      const payload = JSON.parse(
        await runCliWithEnvAsync(
          ["ask", "garbage collection reclaims blocks?", "--format", "json"],
          vault,
          { AKB_TEST_ANTHROPIC_KEY: "anthropic-test-key" },
        ),
      );

      expect(payload.degraded).toBe(false);
      expect(payload.answer_provider).toBe("anthropic");
      expect(payload.answer_model).toBe("claude-sonnet-4-20250514");
      expect(requestMeta[0]).toMatchObject({
        method: "POST",
        url: "/messages",
        apiKey: "anthropic-test-key",
        anthropicVersion: "2023-06-01",
      });
      expect(requests[0]).toMatchObject({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        temperature: 0,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("falls back when generated ask answers cite unavailable refs", async () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "gc-bad-citation.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_askbadref001",
        "title: Bad Citation Source",
        "---",
        "# Bad Citation Source",
        "",
        "Garbage collection reclaims NAND blocks when free block count is low.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);

    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "deepseek-v4-pro-routed",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer:
                      "Garbage collection reclaims NAND blocks when free block count is low. [999]",
                    used_refs: [999],
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-pro"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      const payload = JSON.parse(
        await runCliWithEnvAsync(
          ["ask", "garbage collection reclaims blocks?", "--format", "json"],
          vault,
          { AKB_TEST_DEEPSEEK_KEY: "test-key" },
        ),
      );

      expect(payload.degraded).toBe(true);
      expect(payload.degraded_reason).toContain("cited unavailable ref");
      expect(payload.answer).toContain("Garbage collection reclaims");
      expect(payload.answer).toContain("[1]");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not fall back to extractive answers when generated ask reports no answer", async () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "gc-no-answer.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_asknoanswer1",
        "title: No Answer Source",
        "---",
        "# No Answer Source",
        "",
        "Garbage collection reclaims NAND blocks when free block count is low.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);

    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "deepseek-v4-pro-routed",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: null,
                    used_refs: [],
                    no_answer: true,
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-pro"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      const payload = JSON.parse(
        await runCliWithEnvAsync(
          ["ask", "garbage collection reclaims blocks?", "--format", "json"],
          vault,
          { AKB_TEST_DEEPSEEK_KEY: "test-key" },
        ),
      );

      expect(payload.degraded).toBe(false);
      expect(payload.answer).toBeNull();
      expect(payload.no_evidence).toBe(false);
      expect(payload.answer_no_evidence).toBe(true);
      expect(payload.citations).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not fabricate ask answers without evidence", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);

    const payload = JSON.parse(
      runCli(["ask", "missing topic", "--format", "json"], vault),
    );

    expect(payload.answer).toBeNull();
    expect(payload.no_evidence).toBe(true);
    expect(payload.citations).toEqual([]);
    expect(payload.degraded_reason).toContain("No indexed knowledge matched");

    const text = runCli(["ask", "missing topic"], vault);
    expect(text).toContain("No evidence found.");
    expect(text).toContain("LLM not called: no indexed evidence matched.");
  });

  it("builds a context pack with citations, confidence, content, and patches", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const target = join(dir, "gc-context.md");
    const source = join(dir, "gc-source.md");
    writeFileSync(
      target,
      [
        "---",
        "id: page_ctxpack00001",
        "title: Garbage Collection Context",
        "references:",
        "  - src/gc.ts",
        "---",
        "# Garbage Collection Context",
        "",
        "Garbage collection reclaims blocks using valid page counts.",
      ].join("\n"),
    );
    writeFileSync(
      source,
      [
        "---",
        "id: page_ctxsource001",
        "title: Patch Source",
        "---",
        "# Patch Source",
        "",
        "New source material extends the garbage collection context.",
      ].join("\n"),
    );
    runCli(["ingest", target, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_ctxpack00001.ledger.jsonl"),
      `${JSON.stringify({
        id: "evt_ctxpack00001",
        kind: "source_added",
        pageId: "page_ctxpack00001",
        timestamp: "2026-05-01T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_ctxpack00001",
        sourceWeight: 1,
      })}\n`,
    );
    mkdirSync(join(vault, ".akb", "patches"), { recursive: true });
    writeFileSync(
      join(vault, ".akb", "patches", "patch_context_pack.yaml"),
      [
        "id: patch_context_pack",
        "status: proposed",
        "source:",
        "  pageId: page_ctxsource001",
        "compileMeta:",
        "  degraded: true",
        "changes:",
        "  - type: modify",
        "    pageId: page_ctxpack00001",
        "    operation: append_section",
        "    relation: extend",
        "    classifyConfidence: 0.8",
        "    reasoning: adds fresh GC context",
        "    content: |",
        "      ## Updated GC Context",
        "      New source material.",
      ].join("\n"),
    );
    runCli(["index", "--rebuild"], vault);

    const pack = JSON.parse(
      runCli(
        [
          "context",
          "pack",
          "garbage collection",
          "--top-k",
          "1",
          "--format",
          "json",
          "--now",
          "2026-05-17T00:00:00.000Z",
        ],
        vault,
      ),
    );

    expect(pack.schema_version).toBe("context-pack/0.1");
    expect(pack.query).toBe("garbage collection");
    expect(pack.generated_at).toBe("2026-05-17T00:00:00.000Z");
    expect(pack.pages).toHaveLength(1);
    expect(pack.pages[0]).toMatchObject({
      ref: 1,
      page_id: "page_ctxpack00001",
      path: "pages/gc-context.md",
      title: "Garbage Collection Context",
    });
    expect(pack.pages[0].citation.line_start).toBeGreaterThan(0);
    expect(pack.pages[0].citation.line_end).toBeGreaterThanOrEqual(
      pack.pages[0].citation.line_start,
    );
    expect(pack.pages[0].confidence.score).toBeGreaterThan(0.7);
    expect(pack.pages[0].confidence.status.flags).toEqual([]);
    expect(pack.pages[0].content).toContain("# Garbage Collection Context");
    expect(pack.pages[0].patches).toEqual([
      expect.objectContaining({
        id: "patch_context_pack",
        status: "proposed",
        degraded: true,
      }),
    ]);

    const output = runCli(
      [
        "context",
        "pack",
        "garbage collection",
        "--top-k",
        "1",
        "--output",
        ".akb/context/gc.json",
        "--now",
        "2026-05-17T00:00:00.000Z",
      ],
      vault,
    );
    expect(output).toContain(
      "Wrote context pack .akb/context/gc.json with 1 page.",
    );
    const written = JSON.parse(
      readFileSync(join(vault, ".akb", "context", "gc.json"), "utf8"),
    );
    expect(written.pages[0].page_id).toBe("page_ctxpack00001");
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

  it("prints ingest progress with the total markdown file count", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "first.md"), "# First\n\nFirst note.");
    writeFileSync(join(source, "second.md"), "# Second\n\nSecond note.");

    const output = runCli(
      ["ingest", source, "--recursive", "--no-compile", "--no-commit"],
      vault,
    );

    expect(output).toContain("Found 2 markdown files to ingest.");
    expect(output).toContain("Ingest [##########----------] 1/2 first.md");
    expect(output).toContain("Ingest [####################] 2/2 second.md");
    expect(output).toContain("Ingested 2 pages");
  });

  it("can compile ingested directory pages with bounded concurrency", async () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const target = join(dir, "target.md");
    writeFileSync(
      target,
      [
        "---",
        "id: page_conctarget01",
        "title: Garbage Collection",
        "---",
        "# Garbage Collection",
        "",
        "Garbage collection target page.",
      ].join("\n"),
    );
    runCli(["ingest", target, "--no-commit", "--no-compile"], vault);

    const source = join(dir, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "first.md"),
      [
        "---",
        "id: page_concsource01",
        "title: First GC Update",
        "---",
        "# First GC Update",
        "",
        "Garbage collection source one.",
      ].join("\n"),
    );
    writeFileSync(
      join(source, "second.md"),
      [
        "---",
        "id: page_concsource02",
        "title: Second GC Update",
        "---",
        "# Second GC Update",
        "",
        "Garbage collection source two.",
      ].join("\n"),
    );

    let activeRequests = 0;
    let maxActiveRequests = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        const payload = JSON.parse(body) as {
          messages?: Array<{ content?: string }>;
        };
        const system = payload.messages?.[0]?.content ?? "";
        const user = JSON.parse(payload.messages?.[1]?.content ?? "{}") as {
          patchId?: string;
          sourcePage?: { id?: string; title?: string };
        };
        const sourcePageId = user.sourcePage?.id ?? "page_concsource01";
        let content: unknown;
        if (system.includes("Segment the source")) {
          content = {
            units: [
              {
                id: `${sourcePageId}:su0`,
                sourceChunkIds: [`${sourcePageId}:c0`],
                text: "Garbage collection update.",
                kind: "claim_cluster",
              },
            ],
          };
        } else if (system.includes("Classify the relation")) {
          content = {
            relation: "extend",
            confidence: 0.82,
            reasoning: "Related garbage collection update.",
          };
        } else {
          content = {
            changes: [
              {
                type: "modify",
                pageId: "page_conctarget01",
                operation: "append_section",
                relation: "extend",
                classifyConfidence: 0.82,
                reasoning: "Merged concurrent source.",
                content: [
                  `## ${user.sourcePage?.title ?? "GC Update"} (compiled)`,
                  "",
                  `<!-- akb:derived source=${sourcePageId}:su0 method=extend patch=${user.patchId ?? `patch_${sourcePageId}`} promptHash="sha256:test" modelId="deepseek-v4-pro" compiledAt="2026-05-16T00:00:00.000Z" -->`,
                  "Garbage collection update.",
                ].join("\n"),
                confidenceImpact: {
                  kind: "source_added",
                  sourceWeight: 0.8,
                },
              },
            ],
          };
        }
        setTimeout(() => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              model: "deepseek-v4-pro-routed",
              choices: [{ message: { content: JSON.stringify(content) } }],
            }),
            () => {
              activeRequests -= 1;
            },
          );
        }, 40);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-pro"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      const output = await runCliWithEnvAsync(
        [
          "ingest",
          source,
          "--recursive",
          "--no-commit",
          "--compile-concurrency",
          "2",
        ],
        vault,
        { AKB_TEST_DEEPSEEK_KEY: "test-key" },
      );

      expect(output).toContain(
        "Compiling 2 imported pages with concurrency 2.",
      );
      expect(maxActiveRequests).toBeGreaterThan(1);
      expect(
        existsSync(
          join(vault, ".akb", "patches", "patch_page_concsource01.yaml"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(vault, ".akb", "patches", "patch_page_concsource02.yaml"),
        ),
      ).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("prints a compile summary with degraded reason counts after batch ingest", async () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "summary-source");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "target.md"),
      [
        "---",
        "id: page_sumtarget001",
        "title: Summary GC Target",
        "---",
        "# Summary GC Target",
        "",
        "Garbage collection target page.",
      ].join("\n"),
    );
    runCli(
      ["ingest", join(source, "target.md"), "--no-commit", "--no-compile"],
      vault,
    );
    writeFileSync(
      join(source, "good.md"),
      [
        "---",
        "id: page_sumsource001",
        "title: Good GC Summary Source",
        "---",
        "# Good GC Summary Source",
        "",
        "Garbage collection provider success update.",
      ].join("\n"),
    );
    writeFileSync(
      join(source, "bad.md"),
      [
        "---",
        "id: page_sumsource002",
        "title: Bad GC Summary Source",
        "---",
        "# Bad GC Summary Source",
        "",
        "Garbage collection degraded update.",
      ].join("\n"),
    );

    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ content?: string }>;
        };
        const system = payload.messages?.[0]?.content ?? "";
        const user = JSON.parse(payload.messages?.[1]?.content ?? "{}") as {
          patchId?: string;
          sourcePage?: { id?: string; title?: string };
          units?: Array<{ id?: string }>;
        };
        const sourcePageId =
          user.sourcePage?.id ??
          user.units?.[0]?.id?.replace(/:su\d+$/, "") ??
          "page_sumsource001";
        let content: unknown;
        if (system.includes("Segment the source")) {
          content = {
            units: [
              {
                id: `${sourcePageId}:su0`,
                sourceChunkIds: [`${sourcePageId}:c0`],
                text: "Garbage collection summary update.",
                kind: "claim_cluster",
              },
            ],
          };
        } else if (system.includes("Classify the relation")) {
          content =
            sourcePageId === "page_sumsource002"
              ? {
                  relation: "related",
                  confidence: 0.7,
                  reasoning: "Intentionally invalid relation.",
                }
              : {
                  relation: "extend",
                  confidence: 0.82,
                  reasoning: "Related garbage collection update.",
                };
        } else {
          content = {
            changes: [
              {
                type: "modify",
                pageId: "page_sumtarget001",
                operation: "append_section",
                relation: "extend",
                classifyConfidence: 0.82,
                reasoning: "Merged summary source.",
                content: [
                  `## ${user.sourcePage?.title ?? "GC Update"} (compiled)`,
                  "",
                  `<!-- akb:derived source=${sourcePageId}:su0 method=extend patch=${user.patchId ?? `patch_${sourcePageId}`} promptHash="sha256:test" modelId="deepseek-v4-pro" compiledAt="2026-05-16T00:00:00.000Z" -->`,
                  "Garbage collection summary update.",
                ].join("\n"),
                confidenceImpact: {
                  kind: "source_added",
                  sourceWeight: 0.8,
                },
              },
            ],
          };
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "deepseek-v4-pro-routed",
            choices: [{ message: { content: JSON.stringify(content) } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-pro"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      const output = await runCliWithEnvAsync(
        [
          "ingest",
          source,
          "--recursive",
          "--force",
          "--no-commit",
          "--compile-concurrency",
          "1",
        ],
        vault,
        { AKB_TEST_DEEPSEEK_KEY: "test-key" },
      );

      expect(output).toContain("Compile summary:");
      expect(output).toContain("  total:            3");
      expect(output).toContain("  provider success: 2");
      expect(output).toContain("  degraded:         1");
      expect(output).toContain("By provider:");
      expect(output).toContain("  deepseek: 2");
      expect(output).toContain("  heuristic: 1");
      expect(output).toContain("Degraded reasons:");
      expect(output).toContain(
        "DeepSeek classify returned invalid relation after repair",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("prints a compile summary for all pending sources", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const first = join(dir, "pending-one.md");
    const second = join(dir, "pending-two.md");
    writeFileSync(
      first,
      [
        "---",
        "id: page_sumallpend01",
        "title: Pending One",
        "---",
        "# Pending One",
        "",
        "Garbage collection pending source one.",
      ].join("\n"),
    );
    writeFileSync(
      second,
      [
        "---",
        "id: page_sumallpend02",
        "title: Pending Two",
        "---",
        "# Pending Two",
        "",
        "Garbage collection pending source two.",
      ].join("\n"),
    );
    runCli(["ingest", first, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", second, "--no-commit", "--no-compile"], vault);
    rmSync(join(vault, ".akb", "compile-disabled.json"), { force: true });

    const output = runCli(["compile", "--all-pending"], vault);

    expect(output).toContain("Compile summary:");
    expect(output).toContain("  total:            2");
    expect(output).toContain("  provider success: 0");
    expect(output).toContain("  degraded:         2");
    expect(output).toContain("By provider:");
    expect(output).toContain("  heuristic: 2");
    expect(output).toContain("Degraded reasons:");
    expect(output).toContain("llm.api_key_env not configured for deepseek: 2");
  });

  it("skips hidden ingest entries by default and reports them", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "source");
    mkdirSync(join(source, ".secret"), { recursive: true });
    writeFileSync(join(source, "visible.md"), "# Visible\n\nVisible note.");
    writeFileSync(join(source, ".hidden.md"), "# Hidden\n\nHidden note.");
    writeFileSync(
      join(source, ".secret", "child.md"),
      "# Secret Child\n\nSecret note.",
    );

    const output = runCli(
      ["ingest", source, "--recursive", "--no-compile", "--no-commit"],
      vault,
    );

    expect(output).toContain("Hidden files/directories found:");
    expect(output).toContain("  - .hidden.md");
    expect(output).toContain("  - .secret");
    expect(output).toContain("Skipping hidden files/directories by default.");
    expect(output).toContain("Found 1 markdown file to ingest.");
    expect(existsSync(join(vault, "pages", "visible.md"))).toBe(true);
    expect(existsSync(join(vault, "pages", ".hidden.md"))).toBe(false);
    expect(existsSync(join(vault, "pages", "hidden.md"))).toBe(false);
    expect(existsSync(join(vault, "pages", ".secret", "child.md"))).toBe(false);
  });

  it("can include hidden ingest entries as non-hidden target paths", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "source");
    mkdirSync(join(source, ".secret"), { recursive: true });
    writeFileSync(join(source, "visible.md"), "# Visible\n\nVisible note.");
    writeFileSync(join(source, ".hidden.md"), "# Hidden\n\nHidden note.");
    writeFileSync(
      join(source, ".secret", "child.md"),
      "# Secret Child\n\nSecret note.",
    );

    const output = runCli(
      [
        "ingest",
        source,
        "--recursive",
        "--include-hidden",
        "--no-compile",
        "--no-commit",
      ],
      vault,
    );

    expect(output).toContain("Including hidden files/directories.");
    expect(output).toContain("Found 3 markdown files to ingest.");
    expect(existsSync(join(vault, "pages", "visible.md"))).toBe(true);
    expect(existsSync(join(vault, "pages", "hidden.md"))).toBe(true);
    expect(existsSync(join(vault, "pages", "secret", "child.md"))).toBe(true);
    expect(existsSync(join(vault, "pages", ".hidden.md"))).toBe(false);
    expect(existsSync(join(vault, "pages", ".secret", "child.md"))).toBe(false);
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
    const event = JSON.parse(
      readFileSync(ledgerPath, "utf8").trim().split("\n")[0],
    );

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
    expect(existsSync(join(vault, ".akb", "migration-report.md"))).toBe(true);
    expect(
      readFileSync(join(vault, ".akb", "migration-report.md"), "utf8"),
    ).toContain("page_migrate00010");
  });

  it("migration records unknown source keys, decay checkpoints, and projection state", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(vault, "pages", "unknown-old.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_migunknown01",
        "title: Unknown Old Source",
        "type: runbook",
        'created_at: "2024-01-01"',
        'last_verified_at: "2024-01-02"',
        "---",
        "# Unknown Old Source",
        "",
        "This old page should receive migration decay metadata.",
      ].join("\n"),
    );
    runCli(["index", "--rebuild"], vault);

    const output = runCli(["migrate", "to-v0.1", "--no-commit"], vault);
    const ledger = readFileSync(
      join(vault, "pages", ".page_migunknown01.ledger.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const report = readFileSync(
      join(vault, ".akb", "migration-report.md"),
      "utf8",
    );
    const ranked = JSON.parse(
      runCli(["search", "migration decay", "--format", "json"], vault),
    );

    expect(output).toContain("decay checkpoint");
    expect(ledger[0].kind).toBe("source_added");
    expect(ledger[0].sourceKey).toBe("src_unknown_page_migunknown01");
    expect(report).toContain("src_unknown_page_migunknown01");
    expect(ledger.some((event) => event.kind === "verified")).toBe(true);
    expect(ledger.some((event) => event.kind === "decay_checkpoint")).toBe(
      true,
    );
    const projection = new ConfidenceProjection({
      dbPath: join(vault, ".akb", "index.db"),
      readonly: true,
    });
    try {
      const projectedEvents = projection.getEvents(
        "page_migunknown01" as never,
      );
      const projectedState = projection
        .getStates(["page_migunknown01" as never])
        .get("page_migunknown01" as never);
      expect(projectedEvents).toHaveLength(ledger.length);
      expect(projectedState?.score).toBeLessThan(0.7);
      expect(ranked.results[0].component_scores.confidence).toBe(
        projectedState?.score,
      );
    } finally {
      projection.close();
    }

    const reportBeforeRerun = readFileSync(
      join(vault, ".akb", "migration-report.md"),
      "utf8",
    );
    const ledgerBeforeRerun = readFileSync(
      join(vault, "pages", ".page_migunknown01.ledger.jsonl"),
      "utf8",
    );
    const secondOutput = runCli(["migrate", "to-v0.1", "--no-commit"], vault);
    expect(secondOutput).toContain("0 pages");
    expect(
      readFileSync(join(vault, ".akb", "migration-report.md"), "utf8"),
    ).toBe(reportBeforeRerun);
    expect(
      readFileSync(
        join(vault, "pages", ".page_migunknown01.ledger.jsonl"),
        "utf8",
      ),
    ).toBe(ledgerBeforeRerun);
  });

  it("uses source type and authority config for migrated source weights", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    writeFileSync(
      join(vault, ".akb", "config.yaml"),
      [
        'version: "0.0"',
        "workspace:",
        '  name: "vault"',
        '  vault_dir: "."',
        "index:",
        '  engine: "sqlite-fts5"',
        '  path: ".akb/index.db"',
        "mcp:",
        '  host: "127.0.0.1"',
        "  port: 8765",
        "sources:",
        "  authority_domains:",
        '    - "*.usenix.org"',
        "",
      ].join("\n"),
    );
    const authority = join(dir, "authority.md");
    const chat = join(dir, "chat.md");
    const unknown = join(dir, "unknown.md");
    const nonAuthority = join(dir, "non-authority.md");
    const academicPdf = join(dir, "academic-pdf.md");
    const vendorPdf = join(dir, "vendor-pdf.md");
    const vendorAliasPdf = join(dir, "vendor-alias-pdf.md");
    const plainPdf = join(dir, "plain-pdf.md");
    const legacyAcademicPdf = join(dir, "legacy-academic-pdf.md");
    writeFileSync(
      authority,
      [
        "---",
        "id: page_authweight01",
        "title: Authority Source",
        "source_type: webpage",
        "source_url: www.usenix.org/conference/fast26/paper",
        "---",
        "# Authority Source",
        "",
        "Known authority webpage source.",
      ].join("\n"),
    );
    writeFileSync(
      chat,
      [
        "---",
        "id: page_chatweight01",
        "title: Chat Source",
        "source_type: chat",
        "---",
        "# Chat Source",
        "",
        "Chat source.",
      ].join("\n"),
    );
    writeFileSync(
      unknown,
      [
        "---",
        "id: page_unknownsrc01",
        "title: Unknown Source Type",
        "source_type: confluence",
        "---",
        "# Unknown Source Type",
        "",
        "Unknown source type should not break old vaults.",
      ].join("\n"),
    );
    writeFileSync(
      nonAuthority,
      [
        "---",
        "id: page_weblow000001",
        "title: Low Authority Webpage",
        "source_type: webpage",
        "source_url: https://example.com/post",
        "---",
        "# Low Authority Webpage",
        "",
        "Unknown webpage source.",
      ].join("\n"),
    );
    writeFileSync(
      academicPdf,
      [
        "---",
        "id: page_pdfacademic1",
        "title: Academic PDF",
        "source_type: pdf",
        "source_subtype: academic",
        "---",
        "# Academic PDF",
        "",
        "Academic PDF source.",
      ].join("\n"),
    );
    writeFileSync(
      vendorPdf,
      [
        "---",
        "id: page_pdfvendor001",
        "title: Vendor PDF",
        "source_type: pdf",
        "source_subtype: vendor_whitepaper",
        "---",
        "# Vendor PDF",
        "",
        "Vendor PDF source.",
      ].join("\n"),
    );
    writeFileSync(
      vendorAliasPdf,
      [
        "---",
        "id: page_pdfvendor002",
        "title: Vendor Alias PDF",
        "source_type: pdf",
        "source_subtype: vendor",
        "---",
        "# Vendor Alias PDF",
        "",
        "Vendor alias PDF source.",
      ].join("\n"),
    );
    writeFileSync(
      plainPdf,
      [
        "---",
        "id: page_pdfplain0001",
        "title: Plain PDF",
        "source_type: pdf",
        "---",
        "# Plain PDF",
        "",
        "Plain PDF source keeps sourced fallback weight.",
      ].join("\n"),
    );
    writeFileSync(
      legacyAcademicPdf,
      [
        "---",
        "id: page_pdflegacy001",
        "title: Legacy Academic PDF",
        "source_type: pdf_academic",
        "---",
        "# Legacy Academic PDF",
        "",
        "Legacy academic PDF source.",
      ].join("\n"),
    );
    runCli(["ingest", authority, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", chat, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", unknown, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", nonAuthority, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", academicPdf, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", vendorPdf, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", vendorAliasPdf, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", plainPdf, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", legacyAcademicPdf, "--no-commit", "--no-compile"], vault);

    runCli(["migrate", "to-v0.1"], vault);
    const authorityEvent = JSON.parse(
      readFileSync(
        join(vault, "pages", ".page_authweight01.ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")[0],
    );
    const chatEvent = JSON.parse(
      readFileSync(
        join(vault, "pages", ".page_chatweight01.ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")[0],
    );
    const unknownEvent = JSON.parse(
      readFileSync(
        join(vault, "pages", ".page_unknownsrc01.ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")[0],
    );
    const nonAuthorityEvent = JSON.parse(
      readFileSync(
        join(vault, "pages", ".page_weblow000001.ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")[0],
    );
    const academicPdfEvent = JSON.parse(
      readFileSync(
        join(vault, "pages", ".page_pdfacademic1.ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")[0],
    );
    const vendorPdfEvent = JSON.parse(
      readFileSync(
        join(vault, "pages", ".page_pdfvendor001.ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")[0],
    );
    const vendorAliasPdfEvent = JSON.parse(
      readFileSync(
        join(vault, "pages", ".page_pdfvendor002.ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")[0],
    );
    const plainPdfEvent = JSON.parse(
      readFileSync(
        join(vault, "pages", ".page_pdfplain0001.ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")[0],
    );
    const legacyAcademicPdfEvent = JSON.parse(
      readFileSync(
        join(vault, "pages", ".page_pdflegacy001.ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")[0],
    );

    expect(authorityEvent.sourceWeight).toBe(0.6);
    expect(chatEvent.sourceWeight).toBe(0.4);
    expect(unknownEvent.sourceWeight).toBe(0.8);
    expect(nonAuthorityEvent.sourceWeight).toBe(0.3);
    expect(academicPdfEvent.sourceWeight).toBe(0.8);
    expect(vendorPdfEvent.sourceWeight).toBe(0.5);
    expect(vendorAliasPdfEvent.sourceWeight).toBe(0.5);
    expect(plainPdfEvent.sourceWeight).toBe(0.8);
    expect(legacyAcademicPdfEvent.sourceWeight).toBe(0.8);
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

  it("shows confidence for pages that reference a code file", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const runbook = join(dir, "deploy-runbook.md");
    const checklist = join(dir, "deploy-checklist.md");
    writeFileSync(
      runbook,
      [
        "---",
        "id: page_fileconf0001",
        "title: Deploy Runbook",
        "references:",
        "  - src/deploy.ts",
        "---",
        "# Deploy Runbook",
        "",
        "Deploy runbook references deployment code.",
      ].join("\n"),
    );
    writeFileSync(
      checklist,
      [
        "---",
        "id: page_fileconf0002",
        "title: Deploy Checklist",
        "references:",
        "  - src/deploy.ts",
        "---",
        "# Deploy Checklist",
        "",
        "Deploy checklist references deployment code.",
      ].join("\n"),
    );
    runCli(["ingest", runbook, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", checklist, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_fileconf0001.ledger.jsonl"),
      `${JSON.stringify({
        id: "evt_fileconf0001",
        kind: "source_added",
        pageId: "page_fileconf0001",
        timestamp: "2026-05-01T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_fileconf0001",
        sourceWeight: 1,
      })}\n${JSON.stringify({
        id: "evt_fileconf0002",
        kind: "verified",
        pageId: "page_fileconf0001",
        timestamp: "2026-05-10T00:00:00.000Z",
        actor: "agent",
        actorId: "agent:codex",
        verifierType: "agent",
        verifierId: "agent:codex",
        reason: "code file reviewed",
      })}\n`,
    );
    writeFileSync(
      join(vault, "pages", ".page_fileconf0002.ledger.jsonl"),
      `${JSON.stringify({
        id: "evt_fileconf0003",
        kind: "source_added",
        pageId: "page_fileconf0002",
        timestamp: "2026-05-01T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_fileconf0002",
        sourceWeight: 0.1,
      })}\n`,
    );

    const report = JSON.parse(
      runCli(
        [
          "confidence",
          "file",
          "src/deploy.ts",
          "--format",
          "json",
          "--events",
          "--now",
          "2026-05-17T00:00:00.000Z",
        ],
        vault,
      ),
    );

    expect(report.file).toBe("src/deploy.ts");
    expect(report.page_count).toBe(2);
    const runbookReport = report.pages.find(
      (page: { page_id: string }) => page.page_id === "page_fileconf0001",
    );
    const checklistReport = report.pages.find(
      (page: { page_id: string }) => page.page_id === "page_fileconf0002",
    );
    expect(runbookReport.score).toBeGreaterThan(0.7);
    expect(runbookReport.status.flags).toEqual([]);
    expect(runbookReport.events).toHaveLength(2);
    expect(checklistReport.score).toBeLessThan(0.5);
    expect(checklistReport.status.flags).toContain("NEEDS_REVIEW");

    const text = runCli(
      [
        "confidence",
        "file",
        "src/deploy.ts",
        "--now",
        "2026-05-17T00:00:00.000Z",
      ],
      vault,
    );
    expect(text).toContain("src/deploy.ts");
    expect(text).toContain("Referenced by 2 pages");
    expect(text).toContain("page_fileconf0001 pages/deploy-runbook.md");
    expect(text).toContain("page_fileconf0002 pages/deploy-checklist.md");
    expect(text).toContain("NEEDS_REVIEW");
  });

  it("writes a confidence-by-file report", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "file-report.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_filereport01",
        "title: File Report",
        "references:",
        "  - src/deploy.ts",
        "---",
        "# File Report",
        "",
        "File report references deployment code.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_filereport01.ledger.jsonl"),
      `${JSON.stringify({
        id: "evt_filereport01",
        kind: "source_added",
        pageId: "page_filereport01",
        timestamp: "2026-05-01T00:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_filereport01",
        sourceWeight: 0.8,
      })}\n`,
    );

    const output = runCli(["confidence", "report", "--by-file"], vault);
    const report = readFileSync(
      join(vault, ".akb", "lint", "confidence-by-file.md"),
      "utf8",
    );

    expect(output).toContain(
      "Wrote .akb/lint/confidence-by-file.md for 1 file reference.",
    );
    expect(report).toContain("# Confidence By File");
    expect(report).toContain("## src/deploy.ts");
    expect(report).toContain("page_filereport01");
    expect(report).toContain("pages/file-report.md");
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

    const projection = new ConfidenceProjection({
      dbPath: join(vault, ".akb", "index.db"),
      readonly: true,
    });
    try {
      const projectedEvents = projection.getEvents(
        "page_verify000001" as never,
      );
      const projectedState = projection
        .getStates(["page_verify000001" as never])
        .get("page_verify000001" as never);
      expect(projectedEvents).toHaveLength(events.length);
      expect(projectedEvents.at(-1)?.kind).toBe("verified");
      expect(projectedState?.lastVerifiedAt).toBe(events.at(-1).timestamp);
    } finally {
      projection.close();
    }
  });

  it("records human verification events with an explicit actor id", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "human-verify.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_humanverify1",
        "title: Human Verify",
        'created_at: "2026-05-01"',
        'source_path: "./human-verify.md"',
        "---",
        "# Human Verify",
        "",
        "This page should receive a human verification actor id.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);
    runCli(["migrate", "to-v0.1", "--no-commit"], vault);

    runCli(
      [
        "verify",
        "page_humanverify1",
        "--reason",
        "reviewed locally",
        "--no-commit",
      ],
      vault,
    );

    const events = readFileSync(
      join(vault, "pages", ".page_humanverify1.ledger.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events.at(-1)).toMatchObject({
      kind: "verified",
      actor: "human",
      actorId: "human:local",
      verifierType: "human",
      verifierId: "human:local",
    });
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
      actorId: "human:local",
      supersederPageId: "page_new000000001",
      reason: "adaptive model supersedes fixed threshold",
    });
    expect(newEvents.at(-1)).toMatchObject({
      kind: "supersedes",
      pageId: "page_new000000001",
      actorId: "human:local",
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
    expect(oldReport.score).toBeLessThanOrEqual(0.3);
  });

  it("rejects replacing an existing supersession without unlink", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    for (const [filename, pageId, title] of [
      ["old.md", "page_chainold0001", "Old Model"],
      ["new.md", "page_chainnew0001", "New Model"],
      ["next.md", "page_chainnext001", "Next Model"],
    ]) {
      writeFileSync(
        join(dir, filename),
        [
          "---",
          `id: ${pageId}`,
          `title: ${title}`,
          'created_at: "2026-05-01"',
          `source_path: "./${filename}"`,
          "---",
          `# ${title}`,
          "",
          `${title} content.`,
        ].join("\n"),
      );
      runCli(["ingest", join(dir, filename), "--no-commit"], vault);
    }
    runCli(["migrate", "to-v0.1", "--no-commit"], vault);
    runCli(
      [
        "supersede",
        "page_chainold0001",
        "--by",
        "page_chainnew0001",
        "--no-commit",
      ],
      vault,
    );

    const failure = runCliFailure(
      [
        "supersede",
        "page_chainold0001",
        "--by",
        "page_chainnext001",
        "--no-commit",
      ],
      vault,
    );

    expect(failure).toContain("already superseded");
    expect(failure).toContain("--unlink");

    const unlinkOutput = runCli(
      [
        "supersede",
        "page_chainold0001",
        "--by",
        "page_chainnext001",
        "--unlink",
        "--no-commit",
      ],
      vault,
    );
    expect(unlinkOutput).toContain(
      "Superseded page_chainold0001 by page_chainnext001",
    );

    const oldReport = JSON.parse(
      runCli(
        ["confidence", "show", "page_chainold0001", "--format", "json"],
        vault,
      ),
    );
    const previousReport = JSON.parse(
      runCli(
        ["confidence", "show", "page_chainnew0001", "--format", "json"],
        vault,
      ),
    );
    const previousSuperseder = readFileSync(
      join(vault, "pages", "new.md"),
      "utf8",
    );
    const nextSuperseder = readFileSync(
      join(vault, "pages", "next.md"),
      "utf8",
    );

    expect(oldReport.superseded_by).toBe("page_chainnext001");
    expect(previousReport.events.at(-1)).toMatchObject({
      kind: "supersedes_removed",
      superseded_page_id: "page_chainold0001",
      replacement_page_id: "page_chainnext001",
    });
    expect(previousSuperseder).not.toContain("supersedes: page_chainold0001");
    expect(previousSuperseder).not.toContain(
      "> Supersedes [[page_chainold0001]].",
    );
    expect(nextSuperseder).toContain("supersedes: page_chainold0001");
    expect(nextSuperseder).toContain("> Supersedes [[page_chainold0001]].");
  });

  it("rejects reusing a page that already supersedes another page", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    for (const [filename, pageId, title] of [
      ["old-a.md", "page_reuseold0001", "Old A"],
      ["old-b.md", "page_reuseold0002", "Old B"],
      ["new.md", "page_reusenew0001", "Reusable New"],
    ]) {
      writeFileSync(
        join(dir, filename),
        [
          "---",
          `id: ${pageId}`,
          `title: ${title}`,
          'created_at: "2026-05-01"',
          `source_path: "./${filename}"`,
          "---",
          `# ${title}`,
          "",
          `${title} content.`,
        ].join("\n"),
      );
      runCli(["ingest", join(dir, filename), "--no-commit"], vault);
    }
    runCli(["migrate", "to-v0.1", "--no-commit"], vault);
    runCli(
      [
        "supersede",
        "page_reuseold0001",
        "--by",
        "page_reusenew0001",
        "--no-commit",
      ],
      vault,
    );

    const failure = runCliFailure(
      [
        "supersede",
        "page_reuseold0002",
        "--by",
        "page_reusenew0001",
        "--no-commit",
      ],
      vault,
    );

    expect(failure).toContain("already supersedes page_reuseold0001");
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
    const projection = new ConfidenceProjection({
      dbPath: join(vault, ".akb", "index.db"),
      readonly: true,
    });
    try {
      const oldState = projection
        .getStates(["page_oldsearch001" as never])
        .get("page_oldsearch001" as never);
      const newEvents = projection.getEvents("page_newsearch001" as never);
      expect(oldState?.supersededBy).toBe("page_newsearch001");
      expect(newEvents.at(-1)?.kind).toBe("supersedes");
    } finally {
      projection.close();
    }
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

  it("rebuilds all projections after deleting the index database", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "projection-all.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_projall00001",
        "title: Projection All",
        "---",
        "# Projection All",
        "",
        "<!-- akb:derived source=page_projall00001:c0 method=summary -->",
        "Projection all rebuild restores searchable derived content.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_projall00001.ledger.jsonl"),
      `${JSON.stringify({
        id: "evt_projall00001",
        kind: "source_added",
        pageId: "page_projall00001",
        timestamp: "2026-05-01T12:00:00.000Z",
        actor: "system",
        actorId: "akb-test",
        sourceId: "src_projall00001",
        sourceWeight: 0.9,
      })}\n`,
    );
    rmSync(join(vault, ".akb", "index.db"), { force: true });

    const output = runCli(["projection", "rebuild", "--all"], vault);
    const ranked = JSON.parse(
      runCli(["search", "projection all", "--format", "json"], vault),
    );
    const lineage = runCli(["lineage", "page_projall00001"], vault);

    expect(output).toContain("Rebuilt search projection");
    expect(output).toContain("Rebuilt confidence projection");
    expect(ranked.results[0].page_id).toBe("page_projall00001");
    expect(ranked.results[0].component_scores.confidence).toBeGreaterThan(0.5);
    expect(lineage).toContain("page_projall00001:c0");
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

  it("lint uses an injected clock for decay-based warnings", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "old-runbook.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_lintdecay001",
        "title: Old Runbook",
        "type: runbook",
        "---",
        "# Old Runbook",
        "",
        "This runbook has not been refreshed in a long time.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_lintdecay001.ledger.jsonl"),
      [
        JSON.stringify({
          id: "evt_lintdecay001",
          kind: "source_added",
          pageId: "page_lintdecay001",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          sourceId: "src_lintdecay001",
          sourceWeight: 0.8,
        }),
        JSON.stringify({
          id: "evt_lintdecay002",
          kind: "verified",
          pageId: "page_lintdecay001",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "human",
          actorId: "reviewer",
          verifierType: "human",
        }),
        "",
      ].join("\n"),
    );
    runCli(["projection", "rebuild", "--confidence"], vault);
    rmSync(join(vault, "pages", ".page_lintdecay001.ledger.jsonl"));

    const output = runCli(["lint", "--now", "2026-08-01T00:00:00.000Z"], vault);
    const report = readFileSync(
      join(vault, ".akb", "lint", "low-confidence.md"),
      "utf8",
    );
    const staleReport = readFileSync(
      join(vault, ".akb", "lint", "stale.md"),
      "utf8",
    );

    expect(output).toContain("page_lintdecay001");
    expect(output).toContain("stale");
    expect(report).toContain("page_lintdecay001");
    expect(staleReport).toContain("page_lintdecay001");
  });

  it("lint fails CI gate for ADRs unverified for 100 days", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "old-decision.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_lintadr00001",
        "title: Old Decision",
        "type: decision",
        "---",
        "# Old Decision",
        "",
        "This architecture decision needs periodic confirmation.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_lintadr00001.ledger.jsonl"),
      [
        JSON.stringify({
          id: "evt_lintadr00001",
          kind: "source_added",
          pageId: "page_lintadr00001",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          sourceId: "src_lintadr00001",
          sourceWeight: 0.8,
        }),
        JSON.stringify({
          id: "evt_lintadr00002",
          kind: "verified",
          pageId: "page_lintadr00001",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "human",
          actorId: "reviewer",
          verifierType: "human",
        }),
        "",
      ].join("\n"),
    );
    runCli(["projection", "rebuild", "--confidence"], vault);

    const failure = runCliFailure(
      ["lint", "--now", "2026-04-12T00:00:00.000Z"],
      vault,
    );
    const staleReport = readFileSync(
      join(vault, ".akb", "lint", "stale.md"),
      "utf8",
    );

    expect(failure).toContain("error stale-ci-gate");
    expect(failure).toContain("page_lintadr00001");
    expect(staleReport).toContain("CI gate");
  });

  it("lint CI gate uses first evidence for never-verified ADRs", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "never-verified-decision.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_lintadr00002",
        "title: Never Verified Decision",
        "type: decision",
        "---",
        "# Never Verified Decision",
        "",
        "This architecture decision has no verification event.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_lintadr00002.ledger.jsonl"),
      [
        JSON.stringify({
          id: "evt_lintadr00003",
          kind: "source_added",
          pageId: "page_lintadr00002",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          sourceId: "src_lintadr00002",
          sourceWeight: 0.8,
        }),
        JSON.stringify({
          id: "evt_lintadr00004",
          kind: "decay_checkpoint",
          pageId: "page_lintadr00002",
          timestamp: "2026-04-10T00:00:00.000Z",
          actor: "system",
          actorId: "akb-decay",
          daysSinceLastEvent: 99,
          appliedDecay: 0.1,
        }),
        "",
      ].join("\n"),
    );
    runCli(["projection", "rebuild", "--confidence"], vault);

    const failure = runCliFailure(
      ["lint", "--now", "2026-04-11T00:00:00.000Z"],
      vault,
    );

    expect(failure).toContain("error stale-ci-gate");
    expect(failure).toContain("page_lintadr00002");
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

  it("lint fails on unresolved active contradictions", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "contradiction.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_lintcontra01",
        "title: Lint Contradiction",
        "---",
        "# Lint Contradiction",
        "",
        "This page has an unresolved contradiction.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_lintcontra01.ledger.jsonl"),
      [
        JSON.stringify({
          id: "evt_lintcontra01",
          kind: "source_added",
          pageId: "page_lintcontra01",
          timestamp: "2026-05-01T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          sourceId: "src_lintcontra01",
          sourceWeight: 0.8,
        }),
        JSON.stringify({
          id: "evt_lintcontra02",
          kind: "contradicted_by",
          pageId: "page_lintcontra01",
          timestamp: "2026-05-02T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          bySourceId: "src_lintcontra02",
          severity: "major",
        }),
        "",
      ].join("\n"),
    );

    const failure = runCliFailure(["lint"], vault);
    const report = readFileSync(
      join(vault, ".akb", "lint", "unresolved-contradictions.md"),
      "utf8",
    );

    expect(failure).toContain("unresolved contradiction");
    expect(report).toContain("page_lintcontra01");
  });

  it("lint allows superseded contradictions", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "resolved-contradiction.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_lintresolve1",
        "title: Resolved Contradiction",
        "superseded_by: page_lintsupers01",
        "---",
        "# Resolved Contradiction",
        "",
        "This page has a resolved contradiction.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_lintresolve1.ledger.jsonl"),
      [
        JSON.stringify({
          id: "evt_lintresolve1",
          kind: "source_added",
          pageId: "page_lintresolve1",
          timestamp: "2026-05-01T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          sourceId: "src_lintresolve1",
          sourceWeight: 0.8,
        }),
        JSON.stringify({
          id: "evt_lintresolve2",
          kind: "contradicted_by",
          pageId: "page_lintresolve1",
          timestamp: "2026-05-02T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          bySourceId: "src_lintresolve2",
          severity: "major",
        }),
        JSON.stringify({
          id: "evt_lintresolve3",
          kind: "superseded_by",
          pageId: "page_lintresolve1",
          timestamp: "2026-05-03T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          supersederPageId: "page_lintsupers01",
        }),
        "",
      ].join("\n"),
    );

    const output = runCli(["lint"], vault);
    const report = readFileSync(
      join(vault, ".akb", "lint", "unresolved-contradictions.md"),
      "utf8",
    );

    expect(output).not.toContain("unresolved contradiction");
    expect(report).toContain("No issues found.");
  });

  it("lint allows re-verified contradictions", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "verified-contradiction.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_lintverify01",
        "title: Verified Contradiction",
        "---",
        "# Verified Contradiction",
        "",
        "This page has a re-verified contradiction.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, "pages", ".page_lintverify01.ledger.jsonl"),
      [
        JSON.stringify({
          id: "evt_lintverify01",
          kind: "source_added",
          pageId: "page_lintverify01",
          timestamp: "2026-05-01T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          sourceId: "src_lintverify01",
          sourceWeight: 0.8,
        }),
        JSON.stringify({
          id: "evt_lintverify02",
          kind: "contradicted_by",
          pageId: "page_lintverify01",
          timestamp: "2026-05-02T00:00:00.000Z",
          actor: "system",
          actorId: "akb-test",
          bySourceId: "src_lintverify02",
          severity: "major",
        }),
        JSON.stringify({
          id: "evt_lintverify03",
          kind: "verified",
          pageId: "page_lintverify01",
          timestamp: "2026-05-03T00:00:00.000Z",
          actor: "human",
          actorId: "reviewer",
          verifierType: "human",
          verifierId: "reviewer",
          reason: "Reviewed stronger evidence.",
        }),
        "",
      ].join("\n"),
    );

    const output = runCli(["lint"], vault);
    const report = readFileSync(
      join(vault, ".akb", "lint", "unresolved-contradictions.md"),
      "utf8",
    );

    expect(output).not.toContain("unresolved contradiction");
    expect(report).toContain("No issues found.");
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

  it("records runtime contradiction signals from webhook and watch failures", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "runtime-failure.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_rtfail000001",
        "title: Runtime Failure Page",
        "references:",
        "  - src/runtime-failure.ts",
        "---",
        "# Runtime Failure Page",
        "",
        "Runtime failure signal target.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);

    const webhook = runCli(
      [
        "webhook",
        "ci-failure",
        "--actor-id",
        "ci:github-actions",
        "--changed-file",
        "src/runtime-failure.ts",
        "--evidence",
        "https://ci.example/run/2",
        "--no-commit",
      ],
      vault,
    );
    expect(webhook).toContain("Recorded 1 runtime contradiction");

    const signalDir = join(vault, ".akb", "runtime-signals");
    mkdirSync(signalDir, { recursive: true });
    writeFileSync(
      join(signalDir, "failure.json"),
      JSON.stringify({
        kind: "test_failure",
        page_ids: ["page_rtfail000001"],
        actor_id: "test:integration",
        evidence: "test-run-42",
      }),
    );
    const watch = runCli(["watch", "--once", "--no-commit"], vault);
    expect(watch).toContain("Processed 1 runtime signal");

    const ledger = readFileSync(
      join(vault, "pages", ".page_rtfail000001.ledger.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const contradictions = ledger.filter(
      (event) => event.kind === "contradicted_by",
    );
    expect(contradictions).toHaveLength(2);
    expect(contradictions[0]).toMatchObject({
      actor: "system",
      actorId: "ci:github-actions",
      severity: "minor",
      reason: "ci_failure: https://ci.example/run/2",
    });
    expect(contradictions[1]).toMatchObject({
      actorId: "test:integration",
      severity: "major",
      reason: "test_failure: test-run-42",
    });

    const projection = new ConfidenceProjection({
      dbPath: join(vault, ".akb", "index.db"),
      readonly: true,
    });
    try {
      const state = projection
        .getStates(["page_rtfail000001" as never])
        .get("page_rtfail000001" as never);
      expect(state?.contradictionCount).toBe(2);
    } finally {
      projection.close();
    }
  });

  it("records runbook execution success as runtime verification", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "runbook-exec.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_runbook00001",
        "title: Executable Runbook",
        "type: runbook",
        "---",
        "# Executable Runbook",
        "",
        "```bash",
        "printf runbook-ok",
        "```",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);

    const output = runCli(
      [
        "runbook",
        "exec",
        "page_runbook00001",
        "--now",
        "2026-05-17T00:00:00.000Z",
        "--no-commit",
      ],
      vault,
    );

    expect(output).toContain(
      "Runbook page_runbook00001 succeeded with 1 step.",
    );
    const ledger = readFileSync(
      join(vault, "pages", ".page_runbook00001.ledger.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(ledger.at(-1)).toMatchObject({
      kind: "verified",
      pageId: "page_runbook00001",
      timestamp: "2026-05-17T00:00:00.000Z",
      actorId: "runbook-exec",
      verifierId: "runbook-exec",
      reason: "runbook_exec: pages/runbook-exec.md (1 step)",
    });
  });

  it("records runbook execution failure as runtime contradiction", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "runbook-fail.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_runbookfail1",
        "title: Failing Runbook",
        "type: runbook",
        "---",
        "# Failing Runbook",
        "",
        "```bash",
        "exit 7",
        "```",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);

    const output = runCliFailure(
      [
        "runbook",
        "exec",
        "page_runbookfail1",
        "--now",
        "2026-05-17T00:00:00.000Z",
        "--no-commit",
      ],
      vault,
    );

    expect(output).toContain("Runbook page_runbookfail1 failed at step 1.");
    const ledger = readFileSync(
      join(vault, "pages", ".page_runbookfail1.ledger.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(ledger.at(-1)).toMatchObject({
      kind: "contradicted_by",
      pageId: "page_runbookfail1",
      timestamp: "2026-05-17T00:00:00.000Z",
      actorId: "runbook-exec",
      severity: "major",
      reason: "runbook_exec_failed step 1: exit 7",
    });
  });

  it("records linked test success as runtime verification", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "linked-test-page.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_testlink0001",
        "title: Linked Test Page",
        "---",
        "# Linked Test Page",
        "",
        "Behavior covered by an external test.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit"], vault);
    writeFileSync(
      join(vault, "linked.test.ts"),
      "// @akb-page page_testlink0001\n",
    );

    const output = runCli(
      [
        "test",
        "--link-pages",
        "--command",
        "true",
        "--now",
        "2026-05-17T00:00:00.000Z",
        "--no-commit",
      ],
      vault,
    );

    expect(output).toContain("Linked test command passed for 1 page.");
    const ledger = readFileSync(
      join(vault, "pages", ".page_testlink0001.ledger.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(ledger.at(-1)).toMatchObject({
      kind: "verified",
      pageId: "page_testlink0001",
      timestamp: "2026-05-17T00:00:00.000Z",
      actorId: "test:integration",
      verifierId: "test:integration",
      reason: "test_integration_success: true",
    });
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

  it("replays DeepSeek-backed compile patches through the configured provider", async () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const existing = join(dir, "gc-llm-target.md");
    const incoming = join(dir, "gc-llm-update.md");
    writeFileSync(
      existing,
      [
        "---",
        "id: page_compilellm01",
        "title: Garbage Collection",
        "aliases:",
        "  - garbage collection",
        "---",
        "# Garbage Collection",
        "",
        "## Threshold Policy",
        "",
        "Garbage collection uses a fixed threshold policy.",
      ].join("\n"),
    );
    writeFileSync(
      incoming,
      [
        "---",
        "id: page_compilellm02",
        "title: Adaptive GC",
        "tags:",
        "  - garbage collection",
        "---",
        "# Adaptive GC",
        "",
        "Adaptive garbage collection changes threshold policy.",
      ].join("\n"),
    );
    runCli(["ingest", existing, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", incoming, "--no-commit", "--no-compile"], vault);

    const requests: Array<{
      model?: string;
      messages?: Array<{ content?: string }>;
    }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          model?: string;
          messages?: Array<{ content?: string }>;
        };
        requests.push(payload);
        const system = payload.messages?.[0]?.content ?? "";
        let content: unknown;
        if (system.includes("Segment the source")) {
          content = {
            units: [
              {
                id: "su_gc",
                sourceChunkIds: ["page_compilellm02:c0"],
                text: "Adaptive garbage collection changes threshold policy.",
                kind: "claim_cluster",
                lineRange: { start: 1, end: 1 },
              },
            ],
          };
        } else if (system.includes("Classify the relation")) {
          content = {
            relation: "merge",
            confidence: 0.91,
            reasoning: "Both pages describe garbage collection thresholds.",
          };
        } else {
          content = {
            changes: [
              {
                type: "modify",
                pageId: "page_compilellm01",
                operation: "replace_section",
                targetSection: "Threshold Policy",
                relation: "merge",
                classifyConfidence: 0.91,
                reasoning: "Merged threshold policy update.",
                content:
                  '## Threshold Policy\n\n<!-- akb:derived source=su_gc method=merge patch=patch_page_compilellm02 promptHash="sha256:llm" modelId="deepseek-v4-pro" compiledAt="2026-05-16T00:00:00.000Z" -->\nAdaptive garbage collection changes threshold policy.',
                confidenceImpact: {
                  kind: "source_added",
                  sourceWeight: 0.8,
                },
              },
            ],
          };
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "deepseek-v4-pro-routed",
            choices: [{ message: { content: JSON.stringify(content) } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-pro"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      const compileOutput = await runCliWithEnvAsync(
        ["compile", "--source", "page_compilellm02"],
        vault,
        { AKB_TEST_DEEPSEEK_KEY: "test-key" },
      );
      expect(compileOutput).toContain(
        "Compiled page_compilellm02 -> patch_page_compilellm02",
      );
      const patch = readFileSync(
        join(vault, ".akb", "patches", "patch_page_compilellm02.yaml"),
        "utf8",
      );
      expect(patch).toContain("provider: deepseek");
      expect(patch).toContain("modelId: deepseek-v4-pro");
      expect(patch).toContain("resolvedModelId: deepseek-v4-pro-routed");
      expect(patch).toContain("degraded: false");
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-other"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      const replayOutput = await runCliWithEnvAsync(
        ["compile", "replay", "patch_page_compilellm02"],
        vault,
        { AKB_TEST_DEEPSEEK_KEY: "test-key" },
      );

      expect(replayOutput).toContain("Replay matched patch_page_compilellm02");
      expect(requests).toHaveLength(6);
      expect(requests.map((request) => request.model)).toEqual([
        "deepseek-v4-pro",
        "deepseek-v4-pro",
        "deepseek-v4-pro",
        "deepseek-v4-pro",
        "deepseek-v4-pro",
        "deepseek-v4-pro",
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects degraded replay for DeepSeek-backed compile patches", async () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const existing = join(dir, "gc-llm-target.md");
    const incoming = join(dir, "gc-llm-update.md");
    writeFileSync(
      existing,
      [
        "---",
        "id: page_replayllm001",
        "title: Garbage Collection",
        "aliases:",
        "  - garbage collection",
        "---",
        "# Garbage Collection",
        "",
        "Garbage collection uses a fixed threshold policy.",
      ].join("\n"),
    );
    writeFileSync(
      incoming,
      [
        "---",
        "id: page_replayllm002",
        "title: Adaptive GC",
        "tags:",
        "  - garbage collection",
        "---",
        "# Adaptive GC",
        "",
        "Adaptive garbage collection changes threshold policy.",
      ].join("\n"),
    );
    runCli(["ingest", existing, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", incoming, "--no-commit", "--no-compile"], vault);

    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ content?: string }>;
        };
        const system = payload.messages?.[0]?.content ?? "";
        let content: unknown;
        if (system.includes("Segment the source")) {
          content = {
            units: [
              {
                id: "su_gc",
                sourceChunkIds: ["page_replayllm002:c0"],
                text: "Adaptive garbage collection changes threshold policy.",
                kind: "claim_cluster",
              },
            ],
          };
        } else if (system.includes("Classify the relation")) {
          content = {
            relation: "merge",
            confidence: 0.91,
            reasoning: "Both pages describe garbage collection thresholds.",
          };
        } else {
          content = {
            changes: [
              {
                type: "modify",
                pageId: "page_replayllm001",
                operation: "append_section",
                relation: "merge",
                classifyConfidence: 0.91,
                reasoning: "Merged threshold policy update.",
                content:
                  '## Adaptive GC (compiled)\n\n<!-- akb:derived source=su_gc method=merge patch=patch_page_replayllm002 promptHash="sha256:llm" modelId="deepseek-v4-pro" compiledAt="2026-05-16T00:00:00.000Z" -->\nAdaptive garbage collection changes threshold policy.',
                confidenceImpact: {
                  kind: "source_added",
                  sourceWeight: 0.8,
                },
              },
            ],
          };
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "deepseek-v4-pro-routed",
            choices: [{ message: { content: JSON.stringify(content) } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-pro"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      await runCliWithEnvAsync(
        ["compile", "--source", "page_replayllm002"],
        vault,
        { AKB_TEST_DEEPSEEK_KEY: "test-key" },
      );
      writeFileSync(
        join(vault, ".akb", "config.yaml"),
        [
          'version: "0.0"',
          "workspace:",
          '  name: "vault"',
          '  vault_dir: "."',
          "index:",
          '  engine: "sqlite-fts5"',
          '  path: ".akb/index.db"',
          "mcp:",
          '  host: "127.0.0.1"',
          "  port: 8765",
          "llm:",
          `  base_url: "http://127.0.0.1:${address.port}"`,
          '  model: "deepseek-v4-pro"',
          '  api_key_env: "AKB_TEST_DEEPSEEK_KEY"',
          "",
        ].join("\n"),
      );

      const failure = await runCliWithEnvFailureAsync(
        ["compile", "replay", "patch_page_replayllm002"],
        vault,
        {},
      );

      expect(failure).toContain(
        "Replay requires successful LLM replay for patch_page_replayllm002",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses llm config for compile metadata", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    writeFileSync(
      join(vault, ".akb", "config.yaml"),
      [
        'version: "0.0"',
        "workspace:",
        '  name: "vault"',
        '  vault_dir: "."',
        "index:",
        '  engine: "sqlite-fts5"',
        '  path: ".akb/index.db"',
        "mcp:",
        '  host: "127.0.0.1"',
        "  port: 8765",
        "llm:",
        '  base_url: "https://deepseek.test"',
        '  model: "deepseek-v4-pro"',
        "",
      ].join("\n"),
    );
    const source = join(dir, "compile-config.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_compilecfg01",
        "title: Compile Config",
        "---",
        "# Compile Config",
        "",
        "Standalone compile config source.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);

    const output = runCli(["compile", "--source", "page_compilecfg01"], vault);
    const patch = readFileSync(
      join(vault, ".akb", "patches", "patch_page_compilecfg01.yaml"),
      "utf8",
    );

    expect(patch).toContain("modelId: deepseek-v4-pro");
    expect(patch).toContain("apiKeyEnv: DEEPSEEK_API_KEY");
    expect(patch).toContain("degradedReason: DEEPSEEK_API_KEY not set");
    expect(output).toContain("Warning: compile degraded");
  });

  it("applies duplicate compile patches without changing markdown", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const existing = join(dir, "wear.md");
    const duplicate = join(dir, "wear-copy.md");
    const body = "Wear leveling spreads erase cycles across blocks.";
    writeFileSync(
      existing,
      [
        "---",
        "id: page_dupcompile01",
        "title: Wear Leveling",
        "---",
        "# Wear Leveling",
        "",
        body,
      ].join("\n"),
    );
    writeFileSync(
      duplicate,
      [
        "---",
        "id: page_dupcompile02",
        "title: Wear Leveling Copy",
        "---",
        "# Wear Leveling Copy",
        "",
        body,
      ].join("\n"),
    );
    runCli(["ingest", existing, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", duplicate, "--no-commit", "--no-compile"], vault);
    const targetPath = join(vault, "pages", "wear.md");
    const before = readFileSync(targetPath, "utf8");

    runCli(["compile", "--source", "page_dupcompile02"], vault);
    const patch = readFileSync(
      join(vault, ".akb", "patches", "patch_page_dupcompile02.yaml"),
      "utf8",
    );
    expect(patch).toContain("type: confidence_only");
    expect(patch).toContain("pageId: page_dupcompile01");
    expect(patch).toContain("relation: duplicate");

    runCli(["patch", "apply", "patch_page_dupcompile02", "--no-commit"], vault);
    expect(readFileSync(targetPath, "utf8")).toBe(before);
    const ledger = readFileSync(
      join(vault, "pages", ".page_dupcompile01.ledger.jsonl"),
      "utf8",
    );
    expect(ledger).toContain('"kind":"source_added"');
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
      [
        "eval",
        "compile",
        "--set",
        ".akb/eval/compile-golden.yaml",
        "--baseline",
        ".akb/eval/compile-report.json",
        "--max-relation-regression",
        "0.08",
      ],
      vault,
    );
    expect(failure).toContain("FAILED");
    expect(failure).toContain("expected supersede");
    expect(failure).toContain("relation accuracy regression");
  });

  it("passes compile eval supersede targets for create changes", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const fixtureDir = join(vault, ".akb", "eval", "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, "gc-old.md"),
      [
        "---",
        "id: page_evalold00001",
        "title: Garbage Collection",
        "---",
        "# Garbage Collection",
        "",
        "GC uses fixed thresholds.",
      ].join("\n"),
    );
    writeFileSync(
      join(fixtureDir, "gc-new.md"),
      [
        "---",
        "id: page_evalnew00001",
        "title: Adaptive GC",
        "---",
        "# Adaptive GC",
        "",
        "This supersedes Garbage Collection. Adaptive thresholds replace fixed thresholds.",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, ".akb", "eval", "compile-golden.yaml"),
      [
        'version: "1.0"',
        "items:",
        "  - id: c_supersede",
        "    setup:",
        "      existingPages:",
        "        - fixtures/gc-old.md",
        "      newSource: fixtures/gc-new.md",
        "    expect:",
        "      relations:",
        "        - againstPage: page_evalold00001",
        "          relation: supersede",
        "      mustCreatePage: true",
        "      mustNotDeleteContent: true",
      ].join("\n"),
    );

    const output = runCli(
      ["eval", "compile", "--set", ".akb/eval/compile-golden.yaml"],
      vault,
    );

    expect(output).toContain("relation accuracy: 1/1");
    expect(output).toContain("target accuracy:   1/1");
  });

  it("reports compile eval lineage integrity", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const fixtureDir = join(vault, ".akb", "eval", "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, "gc-old.md"),
      [
        "---",
        "id: page_evalbadlin01",
        "title: Garbage Collection",
        "---",
        "# Garbage Collection",
        "",
        "GC uses fixed thresholds.",
      ].join("\n"),
    );
    writeFileSync(
      join(fixtureDir, "gc-new.md"),
      [
        "---",
        "id: page_evalbadlin02",
        "title: Adaptive GC",
        "---",
        "# Adaptive GC",
        "",
        "Adaptive garbage collection updates threshold policy.",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, ".akb", "eval", "compile-golden.yaml"),
      [
        'version: "1.0"',
        "items:",
        "  - id: c_lineage",
        "    setup:",
        "      existingPages:",
        "        - fixtures/gc-old.md",
        "      newSource: fixtures/gc-new.md",
        "    expect:",
        "      relations:",
        "        - againstPage: page_evalbadlin01",
        "          relation: extend",
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

    expect(output).toContain("lineage integrity: 1/1");
    expect(report.schema_version).toBe("compile-eval/0.1");
    expect(report.lineage_integrity).toBe(1);
  });

  it("validates compile eval lineage against scanned vault candidates", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const target = join(dir, "vault-target.md");
    writeFileSync(
      target,
      [
        "---",
        "id: page_evalvault001",
        "title: Vault Candidate",
        "aliases:",
        "  - garbage collection",
        "---",
        "# Vault Candidate",
        "",
        "GC uses fixed thresholds.",
      ].join("\n"),
    );
    runCli(["ingest", target, "--no-commit", "--no-compile"], vault);
    const fixtureDir = join(vault, ".akb", "eval", "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, "gc-new.md"),
      [
        "---",
        "id: page_evalvault002",
        "title: Adaptive GC",
        "tags:",
        "  - garbage collection",
        "---",
        "# Adaptive GC",
        "",
        "Adaptive garbage collection updates threshold policy.",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, ".akb", "eval", "compile-golden.yaml"),
      [
        'version: "1.0"',
        "items:",
        "  - id: c_scanned_lineage",
        "    setup:",
        "      existingPages: []",
        "      newSource: fixtures/gc-new.md",
        "    expect:",
        "      relations:",
        "        - againstPage: page_evalvault001",
        "          relation: extend",
      ].join("\n"),
    );

    const output = runCli(
      ["eval", "compile", "--set", ".akb/eval/compile-golden.yaml"],
      vault,
    );

    expect(output).toContain("lineage integrity: 1/1");
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

  it("requires explicit review before applying low-confidence patches", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const target = join(dir, "review-target.md");
    writeFileSync(
      target,
      [
        "---",
        "id: page_review000001",
        "title: Review Target",
        "---",
        "# Review Target",
        "",
        "Low confidence patch target.",
      ].join("\n"),
    );
    runCli(["ingest", target, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, ".akb", "patches", "patch_low_review.yaml"),
      [
        "id: patch_low_review",
        "status: proposed",
        "changes:",
        "  - type: modify",
        "    pageId: page_review000001",
        "    operation: append_section",
        "    relation: extend",
        "    classifyConfidence: 0.49",
        "    reasoning: uncertain low-confidence relation",
        "    needsCloseReview: true",
        "    content: |",
        "      ## Low Confidence Addition",
        "      Low confidence content.",
        "    confidenceImpact:",
        "      kind: source_added",
        "      sourceWeight: 0.5",
      ].join("\n"),
    );

    const shown = runCli(["patch", "show", "patch_low_review"], vault);
    expect(shown).toContain("Close review required");
    expect(shown).toContain("needsCloseReview: true");

    const failure = runCliFailure(
      ["patch", "apply", "patch_low_review", "--no-commit"],
      vault,
    );
    expect(failure).toContain("requires --reviewed");
    expect(
      readFileSync(join(vault, "pages", "review-target.md"), "utf8"),
    ).not.toContain("Low Confidence Addition");

    runCli(
      ["patch", "apply", "patch_low_review", "--reviewed", "--no-commit"],
      vault,
    );
    expect(
      readFileSync(join(vault, "pages", "review-target.md"), "utf8"),
    ).toContain("Low Confidence Addition");
  });

  it("rejects proposed patches without writing markdown or confidence ledger", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const target = join(dir, "reject-target.md");
    writeFileSync(
      target,
      [
        "---",
        "id: page_reject000001",
        "title: Reject Target",
        "---",
        "# Reject Target",
        "",
        "Rejected patch target.",
      ].join("\n"),
    );
    runCli(["ingest", target, "--no-commit", "--no-compile"], vault);
    const before = readFileSync(
      join(vault, "pages", "reject-target.md"),
      "utf8",
    );
    writeFileSync(
      join(vault, ".akb", "patches", "patch_reject_me.yaml"),
      [
        "id: patch_reject_me",
        "status: proposed",
        "changes:",
        "  - type: modify",
        "    pageId: page_reject000001",
        "    operation: append_section",
        "    relation: extend",
        "    classifyConfidence: 0.9",
        "    reasoning: should be rejected",
        "    content: |",
        "      ## Should Not Land",
        "      Rejected content.",
        "    confidenceImpact:",
        "      kind: source_added",
        "      sourceWeight: 0.8",
      ].join("\n"),
    );

    const output = runCli(
      [
        "patch",
        "reject",
        "patch_reject_me",
        "--reason",
        "not relevant",
        "--no-commit",
      ],
      vault,
    );
    const rejectedPatch = readFileSync(
      join(vault, ".akb", "patches", "rejected", "patch_reject_me.yaml"),
      "utf8",
    );

    expect(output).toContain("Rejected patch_reject_me");
    expect(
      existsSync(join(vault, ".akb", "patches", "patch_reject_me.yaml")),
    ).toBe(false);
    expect(rejectedPatch).toContain("status: rejected");
    expect(rejectedPatch).toContain("rejectReason: not relevant");
    expect(readFileSync(join(vault, "pages", "reject-target.md"), "utf8")).toBe(
      before,
    );
    expect(
      existsSync(join(vault, "pages", ".page_reject000001.ledger.jsonl")),
    ).toBe(false);

    const list = runCli(["patch", "list"], vault);
    expect(list).toContain("patch_reject_me rejected");
    expect(
      runCliFailure(["patch", "apply", "patch_reject_me"], vault),
    ).toContain("Patch not found");
  });

  it("reject commits remove tracked proposed patches", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const patchPath = join(
      vault,
      ".akb",
      "patches",
      "patch_tracked_reject.yaml",
    );
    writeFileSync(
      patchPath,
      ["id: patch_tracked_reject", "status: proposed", "changes: []"].join(
        "\n",
      ),
    );
    execFileSync("git", ["add", ".akb/patches/patch_tracked_reject.yaml"], {
      cwd: vault,
    });
    execFileSync("git", ["commit", "-m", "track proposed patch"], {
      cwd: vault,
      stdio: "ignore",
    });

    runCli(["patch", "reject", "patch_tracked_reject"], vault);

    const status = execFileSync("git", ["status", "--short"], {
      cwd: vault,
      encoding: "utf8",
    });
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: vault,
      encoding: "utf8",
    });
    expect(status).toBe("");
    expect(tree).not.toContain(".akb/patches/patch_tracked_reject.yaml");
    expect(tree).toContain(".akb/patches/rejected/patch_tracked_reject.yaml");
  });

  it("reject commits untracked proposed patches from compile output", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    writeFileSync(
      join(vault, ".akb", "patches", "patch_untracked_reject.yaml"),
      ["id: patch_untracked_reject", "status: proposed", "changes: []"].join(
        "\n",
      ),
    );

    runCli(["patch", "reject", "patch_untracked_reject"], vault);

    const status = execFileSync("git", ["status", "--short"], {
      cwd: vault,
      encoding: "utf8",
    });
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: vault,
      encoding: "utf8",
    });
    expect(status).toBe("");
    expect(tree).not.toContain(".akb/patches/patch_untracked_reject.yaml");
    expect(tree).toContain(".akb/patches/rejected/patch_untracked_reject.yaml");
  });

  it("rejects non-finite patch classify confidence", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const target = join(dir, "nan-target.md");
    writeFileSync(
      target,
      [
        "---",
        "id: page_nanpatch0001",
        "title: NaN Patch Target",
        "---",
        "# NaN Patch Target",
        "",
        "Non-finite confidence target.",
      ].join("\n"),
    );
    runCli(["ingest", target, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, ".akb", "patches", "patch_nan_conf.yaml"),
      [
        "id: patch_nan_conf",
        "status: proposed",
        "changes:",
        "  - type: modify",
        "    pageId: page_nanpatch0001",
        "    operation: append_section",
        "    relation: extend",
        "    classifyConfidence: .nan",
        "    reasoning: non-finite confidence",
        "    content: bad",
      ].join("\n"),
    );

    const failure = runCliFailure(
      ["patch", "apply", "patch_nan_conf", "--no-commit"],
      vault,
    );

    expect(failure).toContain("classifyConfidence must be 0-1");
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

  it("applies merge patches by replacing only the target section", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "merge-target.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_mergetarget1",
        "title: Merge Target",
        "---",
        "# Merge Target",
        "",
        "Intro stays.",
        "",
        "## Trigger Conditions",
        "",
        "Old fixed threshold.",
        "",
        "## Untouched Section",
        "",
        "This section must remain.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, ".akb", "patches", "patch_merge_replace.yaml"),
      [
        "id: patch_merge_replace",
        "status: proposed",
        "source:",
        "  pageId: page_mergetarget1",
        "changes:",
        "  - type: modify",
        "    pageId: page_mergetarget1",
        "    operation: replace_section",
        '    targetSection: "Trigger Conditions"',
        "    relation: merge",
        "    classifyConfidence: 0.9",
        '    reasoning: "merge threshold wording"',
        "    content: |",
        "      ## Trigger Conditions",
        "",
        '      <!-- akb:derived source=page_mergetarget1:c1 method=merge patch=patch_merge_replace promptHash="sha256:test" modelId="deepseek-v4-pro" compiledAt="2026-05-16T00:00:00.000Z" -->',
        "      New adaptive threshold.",
        "    confidenceImpact:",
        "      kind: source_added",
        "      sourceWeight: 0.8",
        "lineage:",
        "  units:",
        "    - id: su_merge",
        "      sourcePageId: page_mergetarget1",
        "      sourceChunkIds:",
        "        - page_mergetarget1:c1",
        "      kind: claim_cluster",
        "  derivedChunks: []",
      ].join("\n"),
    );

    runCli(["patch", "apply", "patch_merge_replace", "--no-commit"], vault);
    const updated = readFileSync(
      join(vault, "pages", "merge-target.md"),
      "utf8",
    );

    expect(updated).toContain("Intro stays.");
    expect(updated).toContain("New adaptive threshold.");
    expect(updated).not.toContain("Old fixed threshold.");
    expect(updated).toContain("## Untouched Section");
    expect(updated).toContain("This section must remain.");
  });

  it("rejects missing replace_section targets before partial writes", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const first = join(dir, "replace-first.md");
    const second = join(dir, "replace-second.md");
    writeFileSync(
      first,
      [
        "---",
        "id: page_replaaaa0001",
        "title: Replace First",
        "---",
        "# Replace First",
        "",
        "First body.",
      ].join("\n"),
    );
    writeFileSync(
      second,
      [
        "---",
        "id: page_replbbbb0001",
        "title: Replace Second",
        "---",
        "# Replace Second",
        "",
        "## Present",
        "",
        "Second body.",
      ].join("\n"),
    );
    runCli(["ingest", first, "--no-commit", "--no-compile"], vault);
    runCli(["ingest", second, "--no-commit", "--no-compile"], vault);
    const before = readFileSync(
      join(vault, "pages", "replace-first.md"),
      "utf8",
    );
    writeFileSync(
      join(vault, ".akb", "patches", "patch_replace_missing.yaml"),
      [
        "id: patch_replace_missing",
        "status: proposed",
        "changes:",
        "  - type: modify",
        "    pageId: page_replaaaa0001",
        "    operation: append_section",
        "    relation: extend",
        "    classifyConfidence: 0.8",
        "    reasoning: valid first change",
        "    content: |",
        "      ## Should Not Land",
        "      <!-- akb:derived source=page_replaaaa0001:c0 method=extend patch=patch_replace_missing -->",
        "      This must not apply.",
        "  - type: modify",
        "    pageId: page_replbbbb0001",
        "    operation: replace_section",
        "    targetSection: Missing",
        "    relation: merge",
        "    classifyConfidence: 0.8",
        "    reasoning: missing target",
        "    content: |",
        "      ## Missing",
        "      <!-- akb:derived source=page_replbbbb0001:c1 method=merge patch=patch_replace_missing -->",
        "      Replacement.",
      ].join("\n"),
    );

    const failure = runCliFailure(
      ["patch", "apply", "patch_replace_missing", "--no-commit"],
      vault,
    );

    expect(failure).toContain("target section not found");
    expect(readFileSync(join(vault, "pages", "replace-first.md"), "utf8")).toBe(
      before,
    );
  });

  it("ignores headings inside fenced code when replacing sections", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "fenced-target.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_fencedrep001",
        "title: Fenced Target",
        "---",
        "# Fenced Target",
        "",
        "```",
        "## Trigger Conditions",
        "not a real heading",
        "```",
        "",
        "## Trigger Conditions",
        "",
        "Real old section.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, ".akb", "patches", "patch_replace_fenced.yaml"),
      [
        "id: patch_replace_fenced",
        "status: proposed",
        "changes:",
        "  - type: modify",
        "    pageId: page_fencedrep001",
        "    operation: replace_section",
        "    targetSection: Trigger Conditions",
        "    relation: merge",
        "    classifyConfidence: 0.8",
        "    reasoning: fenced heading ignored",
        "    content: |",
        "      ## Trigger Conditions",
        "      <!-- akb:derived source=page_fencedrep001:c1 method=merge patch=patch_replace_fenced -->",
        "      Real new section.",
      ].join("\n"),
    );

    runCli(["patch", "apply", "patch_replace_fenced", "--no-commit"], vault);
    const updated = readFileSync(
      join(vault, "pages", "fenced-target.md"),
      "utf8",
    );

    expect(updated).toContain("```");
    expect(updated).toContain("not a real heading");
    expect(updated).toContain("Real new section.");
    expect(updated).not.toContain("Real old section.");
  });

  it("applies contradiction patches after the target section without removing claims", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "insert-target.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_insertsec001",
        "title: Insert Target",
        "---",
        "# Insert Target",
        "",
        "## Trigger Conditions",
        "",
        "Original claim remains.",
        "",
        "## Later Section",
        "",
        "Later content remains.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    writeFileSync(
      join(vault, ".akb", "patches", "patch_insert_after.yaml"),
      [
        "id: patch_insert_after",
        "status: proposed",
        "changes:",
        "  - type: modify",
        "    pageId: page_insertsec001",
        "    operation: insert_after_section",
        "    targetSection: Trigger Conditions",
        "    relation: contradict",
        "    classifyConfidence: 0.8",
        "    reasoning: conflict after target",
        "    content: |",
        "      > [!contradiction] Conflicting source",
        "      > <!-- akb:derived source=page_insertsec001:c1 method=contradict patch=patch_insert_after -->",
        "      > New source disagrees.",
        "    confidenceImpact:",
        "      kind: contradicted_by",
        "      severity: major",
      ].join("\n"),
    );

    runCli(["patch", "apply", "patch_insert_after", "--no-commit"], vault);
    const updated = readFileSync(
      join(vault, "pages", "insert-target.md"),
      "utf8",
    );

    expect(updated).toMatch(
      /Original claim remains\.\n\n> \[!contradiction\] Conflicting source\n> <!-- akb:derived/,
    );
    expect(updated).toContain("## Later Section");
    expect(updated).toContain("Later content remains.");
    expect(
      readFileSync(
        join(vault, "pages", ".page_insertsec001.ledger.jsonl"),
        "utf8",
      ),
    ).toContain('"kind":"contradicted_by"');
  });

  it("rejects invalid confidence impact before writing modify content", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "bad-impact.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_badimpact001",
        "title: Bad Impact",
        "---",
        "# Bad Impact",
        "",
        "Original body.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    const before = readFileSync(join(vault, "pages", "bad-impact.md"), "utf8");
    writeFileSync(
      join(vault, ".akb", "patches", "patch_bad_impact.yaml"),
      [
        "id: patch_bad_impact",
        "status: proposed",
        "changes:",
        "  - type: modify",
        "    pageId: page_badimpact001",
        "    operation: append_section",
        "    relation: extend",
        "    classifyConfidence: 0.8",
        "    reasoning: invalid confidence impact",
        "    content: |",
        "      ## Should Not Land",
        "      <!-- akb:derived source=page_badimpact001:c0 method=extend patch=patch_bad_impact -->",
        "      This must not apply.",
        "    confidenceImpact:",
        "      kind: source_added",
        "      sourceWeight: 2",
      ].join("\n"),
    );

    const failure = runCliFailure(
      ["patch", "apply", "patch_bad_impact", "--no-commit"],
      vault,
    );

    expect(failure).toContain("Invalid patch");
    expect(readFileSync(join(vault, "pages", "bad-impact.md"), "utf8")).toBe(
      before,
    );
  });

  it("keeps mixed fence markers from exposing fake insertion targets", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "mixed-fence.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_mixedfence01",
        "title: Mixed Fence",
        "---",
        "# Mixed Fence",
        "",
        "~~~",
        "```",
        "## Fake Target",
        "```",
        "~~~",
        "",
        "## Real Target",
        "",
        "Real body.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);
    const before = readFileSync(join(vault, "pages", "mixed-fence.md"), "utf8");
    writeFileSync(
      join(vault, ".akb", "patches", "patch_mixed_fence.yaml"),
      [
        "id: patch_mixed_fence",
        "status: proposed",
        "changes:",
        "  - type: modify",
        "    pageId: page_mixedfence01",
        "    operation: insert_after_section",
        "    targetSection: Fake Target",
        "    relation: contradict",
        "    classifyConfidence: 0.8",
        "    reasoning: fake target in fence",
        "    content: |",
        "      > [!contradiction] Should not land",
        "      > <!-- akb:derived source=page_mixedfence01:c0 method=contradict patch=patch_mixed_fence -->",
        "      > This must not apply.",
        "    confidenceImpact:",
        "      kind: contradicted_by",
        "      severity: major",
      ].join("\n"),
    );

    const failure = runCliFailure(
      ["patch", "apply", "patch_mixed_fence", "--no-commit"],
      vault,
    );

    expect(failure).toContain("target section not found");
    expect(readFileSync(join(vault, "pages", "mixed-fence.md"), "utf8")).toBe(
      before,
    );
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

  it("rejects create supersede patches for pages already superseded", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    for (const [filename, pageId, title] of [
      ["old-superseded.md", "page_patchold0001", "Patch Old"],
      ["current-superseder.md", "page_patchcur0001", "Patch Current"],
    ]) {
      writeFileSync(
        join(dir, filename),
        [
          "---",
          `id: ${pageId}`,
          `title: ${title}`,
          'source_path: "./fixture.md"',
          "---",
          `# ${title}`,
          "",
          `${title} content.`,
        ].join("\n"),
      );
      runCli(["ingest", join(dir, filename), "--no-commit"], vault);
    }
    runCli(["migrate", "to-v0.1", "--no-commit"], vault);
    runCli(
      [
        "supersede",
        "page_patchold0001",
        "--by",
        "page_patchcur0001",
        "--no-commit",
      ],
      vault,
    );

    writeFileSync(
      join(vault, ".akb", "patches", "patch_resupersede.yaml"),
      [
        "id: patch_resupersede",
        "status: proposed",
        "changes:",
        "  - type: create",
        "    newPageId: page_patchnew0001",
        "    path: pages/patch-new.md",
        "    relation: supersede",
        "    supersedes: page_patchold0001",
        "    classifyConfidence: 0.8",
        "    reasoning: should not replace an existing supersession",
        "    content: |",
        "      # Patch New",
        "      <!-- akb:derived source=page_patchold0001:c0 method=supersede patch=patch_resupersede -->",
        "      New replacement content.",
        "    confidenceImpact:",
        "      kind: supersedes",
        "      supersededPageId: page_patchold0001",
      ].join("\n"),
    );

    const failure = runCliFailure(
      ["patch", "apply", "patch_resupersede", "--no-commit"],
      vault,
    );

    expect(failure).toContain("already superseded");
    expect(existsSync(join(vault, "pages", "patch-new.md"))).toBe(false);
  });

  it("rejects modify patches that re-supersede an already superseded page", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    for (const [filename, pageId, title] of [
      ["old-mod-superseded.md", "page_modold000001", "Modify Old"],
      ["current-mod-superseder.md", "page_modcur000001", "Modify Current"],
      ["next-mod-superseder.md", "page_modnext00001", "Modify Next"],
    ]) {
      writeFileSync(
        join(dir, filename),
        [
          "---",
          `id: ${pageId}`,
          `title: ${title}`,
          'source_path: "./fixture.md"',
          "---",
          `# ${title}`,
          "",
          `${title} content.`,
        ].join("\n"),
      );
      runCli(["ingest", join(dir, filename), "--no-commit"], vault);
    }
    runCli(["migrate", "to-v0.1", "--no-commit"], vault);
    runCli(
      [
        "supersede",
        "page_modold000001",
        "--by",
        "page_modcur000001",
        "--no-commit",
      ],
      vault,
    );
    const before = readFileSync(
      join(vault, "pages", "old-mod-superseded.md"),
      "utf8",
    );

    writeFileSync(
      join(vault, ".akb", "patches", "patch_resupersede_modify.yaml"),
      [
        "id: patch_resupersede_modify",
        "status: proposed",
        "changes:",
        "  - type: modify",
        "    pageId: page_modold000001",
        "    operation: append_section",
        "    relation: supersede",
        "    classifyConfidence: 0.8",
        "    reasoning: should not re-supersede",
        "    content: |",
        "      ## Should Not Land",
        "      This content must not be written.",
        "    confidenceImpact:",
        "      kind: superseded_by",
        "      supersederPageId: page_modnext00001",
      ].join("\n"),
    );

    const failure = runCliFailure(
      ["patch", "apply", "patch_resupersede_modify", "--no-commit"],
      vault,
    );

    expect(failure).toContain("already superseded");
    expect(
      readFileSync(join(vault, "pages", "old-mod-superseded.md"), "utf8"),
    ).toBe(before);
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

  it("rejects runtime signals without evidence or valid page mapping", () => {
    const vault = join(dir, "vault");
    runCli(["init", "vault"], dir);
    const source = join(dir, "runtime-reject.md");
    writeFileSync(
      source,
      [
        "---",
        "id: page_rtreject0001",
        "title: Runtime Reject",
        "references:",
        "  - src/runtime-reject.ts",
        "---",
        "# Runtime Reject",
        "",
        "Runtime rejection target.",
      ].join("\n"),
    );
    runCli(["ingest", source, "--no-commit", "--no-compile"], vault);

    expect(
      runCliFailure(
        [
          "webhook",
          "ci-success",
          "--changed-file",
          "src/runtime-reject.ts",
          "--no-commit",
        ],
        vault,
      ),
    ).toContain("Runtime signals require --evidence or --pr-number");

    const signalDir = join(vault, ".akb", "runtime-signals");
    mkdirSync(signalDir, { recursive: true });
    writeFileSync(
      join(signalDir, "missing-evidence.json"),
      JSON.stringify({
        kind: "deploy_success",
        page_ids: ["page_rtreject0001"],
        actor_id: "deploy-bot",
      }),
    );
    expect(runCliFailure(["watch", "--once", "--no-commit"], vault)).toContain(
      "requires actor_id and evidence",
    );

    rmSync(join(signalDir, "missing-evidence.json"));
    writeFileSync(
      join(signalDir, "unknown-page.json"),
      JSON.stringify({
        kind: "deploy_success",
        page_ids: ["page_missing00001"],
        actor_id: "deploy-bot",
        evidence: "deploy-42",
      }),
    );
    expect(runCliFailure(["watch", "--once", "--no-commit"], vault)).toContain(
      "references unknown page page_missing00001",
    );
  });
});
