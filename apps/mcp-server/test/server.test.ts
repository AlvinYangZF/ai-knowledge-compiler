import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfidenceProjection,
  computeConfidenceState,
  parseConfidenceEvent,
} from "@akb/confidence";
import type { Page } from "@akb/core";
import { SearchIndex } from "@akb/search-engine";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAkbMcpServer, startHttpMcpServer } from "../src/server.js";

describe("akb MCP server", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "akb-mcp-"));
    mkdirSync(join(dir, ".akb"), { recursive: true });
    mkdirSync(join(dir, "pages"), { recursive: true });
    writeFileSync(
      join(dir, "pages", "mcp.md"),
      [
        "---",
        "id: page_mcp000000000",
        "title: MCP Search Page",
        "tags:",
        "  - mcp",
        "---",
        "# MCP Search Page",
        "",
        "MCP search returns citation data.",
      ].join("\n"),
    );
    const index = new SearchIndex({ dbPath: join(dir, ".akb", "index.db") });
    const page: Page = {
      id: "page_mcp000000000" as never,
      path: "pages/mcp.md",
      title: "MCP Search Page",
      frontmatter: {
        id: "page_mcp000000000" as never,
        title: "MCP Search Page",
        tags: ["mcp"],
        aliases: [],
      },
    };
    index.upsertPage(
      page,
      "# MCP Search Page\n\nMCP search returns citation data.",
      {
        bodyStartLine: 7,
      },
    );
    index.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes search_knowledge and get_page over an MCP client transport", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createAkbMcpServer(dir);
    const client = new Client({ name: "akb-test-client", version: "0.0.0" });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["get_page", "search_knowledge"]);

    const search = await client.callTool({
      name: "search_knowledge",
      arguments: { query: "citation data", top_k: 3 },
    });
    const searchPayload = JSON.parse(
      search.content[0].type === "text" ? search.content[0].text : "",
    );
    expect(searchPayload.results[0].page_id).toBe("page_mcp000000000");
    expect(searchPayload.results[0].citation.line_start).toBeGreaterThanOrEqual(
      7,
    );

    const page = await client.callTool({
      name: "get_page",
      arguments: { page_id_or_path: "page_mcp000000000" },
    });
    const pagePayload = JSON.parse(
      page.content[0].type === "text" ? page.content[0].text : "",
    );
    expect(pagePayload.frontmatter.title).toBe("MCP Search Page");
    expect(pagePayload.content).toContain("---");
    expect(pagePayload.line_count).toBe(9);

    await client.close();
    await server.close();
  });

  it("returns confidence-aware ranked search payloads", async () => {
    const ledgerPath = join(dir, "pages", ".page_mcp000000000.ledger.jsonl");
    const event = parseConfidenceEvent({
      id: "evt_mcp000000001",
      kind: "source_added",
      pageId: "page_mcp000000000",
      timestamp: "2026-05-01T00:00:00.000Z",
      actor: "system",
      actorId: "akb-test",
      sourceId: "src_mcp000000001",
      sourceWeight: 0.1,
    });
    writeFileSync(ledgerPath, `${JSON.stringify(event)}\n`);
    const projection = new ConfidenceProjection({
      dbPath: join(dir, ".akb", "index.db"),
    });
    projection.rebuild([
      {
        pageId: event.pageId,
        events: [event],
        state: computeConfidenceState([event]),
      },
    ]);
    projection.close();
    rmSync(ledgerPath);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createAkbMcpServer(dir);
    const client = new Client({ name: "akb-test-client", version: "0.0.0" });

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const search = await client.callTool({
        name: "search_knowledge",
        arguments: { query: "citation data", top_k: 1 },
      });
      const payload = JSON.parse(
        search.content[0].type === "text" ? search.content[0].text : "",
      );

      expect(payload.results[0]).toHaveProperty("final_score");
      expect(payload.results[0]).toHaveProperty("component_scores.confidence");
      expect(payload.results[0].flags).toContain("NEEDS_REVIEW");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("exposes search_knowledge over streamable HTTP", async () => {
    const httpServer = await startHttpMcpServer({ cwd: dir, port: 0 });
    const address = httpServer.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("HTTP server did not expose a TCP address");
    }
    const client = new Client({
      name: "akb-http-test-client",
      version: "0.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "search_knowledge",
        arguments: { query: "citation data", top_k: 1 },
      });
      const payload = JSON.parse(
        result.content[0].type === "text" ? result.content[0].text : "",
      );
      expect(payload.results[0].page_id).toBe("page_mcp000000000");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("opens the index path declared in .akb/config.yaml", async () => {
    writeFileSync(
      join(dir, ".akb", "config.yaml"),
      [
        'version: "0.0"',
        "workspace:",
        '  name: "configured"',
        '  vault_dir: "."',
        "index:",
        '  engine: "sqlite-fts5"',
        '  path: ".akb/custom-index.db"',
        "mcp:",
        '  host: "127.0.0.1"',
        "  port: 8765",
      ].join("\n"),
    );
    const index = new SearchIndex({
      dbPath: join(dir, ".akb", "custom-index.db"),
    });
    index.upsertPage(
      {
        id: "page_custom00000" as never,
        path: "pages/custom.md",
        title: "Configured Index Page",
        frontmatter: {
          id: "page_custom00000" as never,
          title: "Configured Index Page",
          tags: [],
          aliases: [],
        },
      },
      "# Configured Index Page\n\nconfigured-only-token",
    );
    index.close();

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createAkbMcpServer(dir);
    const client = new Client({
      name: "akb-config-test-client",
      version: "0.0.0",
    });

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: "search_knowledge",
        arguments: { query: "configured-only-token", top_k: 1 },
      });
      const payload = JSON.parse(
        result.content[0].type === "text" ? result.content[0].text : "",
      );
      expect(payload.results[0].page_id).toBe("page_custom00000");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
