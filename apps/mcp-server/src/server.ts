import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { join, resolve } from "node:path";
import { SearchIndex } from "@akb/search-engine";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parse as parseYaml } from "yaml";
import * as z from "zod/v4";

export interface ServeMcpOptions {
  cwd?: string;
  transport?: "stdio" | "http";
  port?: number;
}

export async function serveMcp(opts: ServeMcpOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const transport = opts.transport ?? "stdio";
  if (transport === "http") {
    await startHttpMcpServer({ cwd, port: opts.port ?? 8765 });
    return;
  }

  const server = createAkbMcpServer(cwd);
  await server.connect(new StdioServerTransport());
}

export function createAkbMcpServer(cwd = process.cwd()): McpServer {
  const index = new SearchIndex({
    dbPath: getIndexPath(cwd),
    readonly: true,
  });
  const server = new McpServer({ name: "akb", version: "0.0.0" });

  server.registerTool(
    "search_knowledge",
    {
      description:
        "Search the local knowledge vault using BM25. Returns page snippets with citation info (page_id + line range).",
      inputSchema: {
        query: z
          .string()
          .describe("Search query in natural language or keywords."),
        top_k: z.number().int().min(1).max(20).default(5),
      },
    },
    async ({ query, top_k }) => {
      const started = performance.now();
      const results = index.search(query, { topK: top_k });
      const payload = {
        query,
        results,
        elapsed_ms: Math.round(performance.now() - started),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_page",
    {
      description:
        "Retrieve the full content of a knowledge page by id or path. Use this after search_knowledge when you need more context than the snippet.",
      inputSchema: {
        page_id_or_path: z.string(),
      },
    },
    async ({ page_id_or_path }) => {
      const found = index.getPageByIdOrPath(page_id_or_path);
      if (!found) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Page not found: ${page_id_or_path}` },
          ],
        };
      }
      const physicalPath = join(cwd, found.page.path);
      const content = existsSync(physicalPath)
        ? readFileSync(physicalPath, "utf8")
        : found.body;
      const payload = {
        page_id: found.page.id,
        path: found.page.path,
        frontmatter: found.page.frontmatter,
        content,
        line_count: content.length === 0 ? 0 : content.split(/\r?\n/).length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  const close = async () => {
    index.close();
    await server.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  return server;
}

export async function startHttpMcpServer(opts: {
  cwd?: string;
  port?: number;
}): Promise<HttpServer> {
  const cwd = opts.cwd ?? process.cwd();
  const port = opts.port ?? getMcpPort(cwd);
  const httpServer = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
      );
      return;
    }

    try {
      const body = await readJsonBody(req);
      const server = createAkbMcpServer(cwd);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      console.error("MCP HTTP error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  await new Promise<void>((resolvePromise) => {
    httpServer.listen(port, "127.0.0.1", () => resolvePromise());
  });
  console.error(
    `akb MCP HTTP server listening on http://127.0.0.1:${port}/mcp`,
  );
  return httpServer;
}

async function readJsonBody(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

interface VaultConfig {
  index?: {
    path?: string;
  };
  mcp?: {
    port?: number;
  };
}

function getIndexPath(cwd: string): string {
  return resolve(cwd, readVaultConfig(cwd).index?.path ?? ".akb/index.db");
}

function getMcpPort(cwd: string): number {
  return readVaultConfig(cwd).mcp?.port ?? 8765;
}

function readVaultConfig(cwd: string): VaultConfig {
  const configPath = join(cwd, ".akb", "config.yaml");
  if (!existsSync(configPath)) {
    return {};
  }
  return (parseYaml(readFileSync(configPath, "utf8")) ?? {}) as VaultConfig;
}
