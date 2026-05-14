import { describe, expect, it } from "vitest";
import {
  ensureFrontmatter,
  extractTitle,
  generatePageId,
  parseMarkdown,
  sourceHash,
} from "../src/index.js";

describe("markdown-engine", () => {
  it("parses frontmatter and reports the physical body start line", () => {
    const parsed = parseMarkdown(
      "---\nid: page_abc123def456\ntitle: Demo\n---\n# Demo\nbody",
    );

    expect(parsed.frontmatter.id).toBe("page_abc123def456");
    expect(parsed.bodyStartLine).toBe(5);
    expect(parsed.body).toBe("# Demo\nbody");
  });

  it("returns bodyStartLine 1 when no frontmatter exists", () => {
    const parsed = parseMarkdown("# Demo\nbody");

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.bodyStartLine).toBe(1);
  });

  it("generates v0.0 page ids", () => {
    expect(generatePageId()).toMatch(/^page_[a-z0-9]{12}$/);
  });

  it("extracts the first H1 and falls back to the filename stem", () => {
    expect(extractTitle("intro\n# First\n# Second", "fallback.md")).toBe(
      "First",
    );
    expect(extractTitle("no heading", "design-note.md")).toBe("design-note");
  });

  it("adds missing frontmatter without overwriting existing fields", () => {
    const output = ensureFrontmatter(
      "---\ntitle: Existing\n---\n# Existing\nbody",
      {
        id: "page_abc123def456" as never,
        title: "Default",
        created_at: "2026-05-13",
      },
      {
        tags: ["storage"],
        sourcePath: "./notes/gc.md",
        now: new Date("2026-05-13T10:30:00Z"),
      },
    );

    const parsed = parseMarkdown(output);
    expect(parsed.frontmatter.title).toBe("Existing");
    expect(parsed.frontmatter.id).toBe("page_abc123def456");
    expect(parsed.frontmatter.tags).toEqual(["storage"]);
    expect(parsed.frontmatter.source_path).toBe("./notes/gc.md");
  });

  it("computes source hashes with the required prefix", () => {
    expect(sourceHash("hello")).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
