import { describe, expect, it } from "vitest";
import { ConfigSchema, PageFrontmatterSchema } from "../src/index.js";

describe("core schemas", () => {
  it("validates v0.0 config files", () => {
    const config = ConfigSchema.parse({
      version: "0.0",
      workspace: { name: "demo", vault_dir: "." },
      index: { engine: "sqlite-fts5", path: ".akb/index.db" },
      mcp: { host: "127.0.0.1", port: 8765 },
    });

    expect(config.workspace.name).toBe("demo");
  });

  it("validates v0.1 source and llm config extensions", () => {
    const config = ConfigSchema.parse({
      version: "0.0",
      workspace: { name: "demo", vault_dir: "." },
      index: { engine: "sqlite-fts5", path: ".akb/index.db" },
      mcp: { host: "127.0.0.1", port: 8765 },
      sources: { authority_domains: ["*.usenix.org"] },
      llm: { provider: "deepseek" },
    });

    expect(config.sources?.authority_domains).toEqual(["*.usenix.org"]);
    expect(config.llm?.model).toBe("deepseek-v4-flash");
    expect(config.llm?.api_key_env).toBe("DEEPSEEK_API_KEY");
  });

  it("defaults provider-specific llm endpoints and api key env vars", () => {
    const openai = ConfigSchema.parse({
      version: "0.0",
      workspace: { name: "demo", vault_dir: "." },
      index: { engine: "sqlite-fts5", path: ".akb/index.db" },
      mcp: { host: "127.0.0.1", port: 8765 },
      llm: { provider: "openai" },
    });
    const anthropic = ConfigSchema.parse({
      version: "0.0",
      workspace: { name: "demo", vault_dir: "." },
      index: { engine: "sqlite-fts5", path: ".akb/index.db" },
      mcp: { host: "127.0.0.1", port: 8765 },
      llm: { provider: "anthropic" },
    });

    expect(openai.llm).toMatchObject({
      provider: "openai",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      api_key_env: "OPENAI_API_KEY",
    });
    expect(anthropic.llm).toMatchObject({
      provider: "anthropic",
      base_url: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-20250514",
      api_key_env: "ANTHROPIC_API_KEY",
    });
  });

  it("rejects direct llm api keys in config files", () => {
    expect(() =>
      ConfigSchema.parse({
        version: "0.0",
        workspace: { name: "demo", vault_dir: "." },
        index: { engine: "sqlite-fts5", path: ".akb/index.db" },
        mcp: { host: "127.0.0.1", port: 8765 },
        llm: { provider: "deepseek", api_key: "deepseek-test-key" },
      }),
    ).toThrow(/api_key/);
  });

  it("defaults optional frontmatter arrays", () => {
    const frontmatter = PageFrontmatterSchema.parse({
      id: "page_abc123def456",
      title: "GC Strategy",
    });

    expect(frontmatter.tags).toEqual([]);
    expect(frontmatter.aliases).toEqual([]);
  });

  it("validates v0.1 source metadata frontmatter", () => {
    const frontmatter = PageFrontmatterSchema.parse({
      id: "page_abc123def456",
      title: "FAST Paper",
      source_type: "webpage",
      source_url: "https://www.usenix.org/conference/fast26/paper",
    });

    expect(frontmatter.source_type).toBe("webpage");
  });
});
