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

  it("defaults optional frontmatter arrays", () => {
    const frontmatter = PageFrontmatterSchema.parse({
      id: "page_abc123def456",
      title: "GC Strategy",
    });

    expect(frontmatter.tags).toEqual([]);
    expect(frontmatter.aliases).toEqual([]);
  });
});
