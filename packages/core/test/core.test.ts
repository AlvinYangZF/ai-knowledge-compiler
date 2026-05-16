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
