import { describe, expect, it } from "vitest";
import { chunkByHeaders } from "../src/chunking.js";

describe("chunkByHeaders", () => {
  it("returns empty array for empty body", () => {
    expect(chunkByHeaders("page_x" as never, "")).toEqual([]);
  });

  it("returns single chunk when body has no headers", () => {
    const chunks = chunkByHeaders(
      "page_x" as never,
      "Just some text.\nAnother line.",
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(2);
  });

  it("splits at H1, H2, H3 headers", () => {
    const body = [
      "# Section A",
      "Body of A.",
      "## Subsection A1",
      "More text.",
      "# Section B",
      "Body of B.",
    ].join("\n");
    const chunks = chunkByHeaders("page_x" as never, body);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => [chunk.lineStart, chunk.lineEnd])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("does not split at H4 or deeper", () => {
    expect(
      chunkByHeaders("page_x" as never, "# A\nx\n#### sub\ny"),
    ).toHaveLength(1);
  });

  it("does not split at header-looking lines inside fenced code blocks", () => {
    const body = [
      "# A",
      "```bash",
      "# not a markdown header",
      "echo ok",
      "```",
      "## B",
      "text",
    ].join("\n");
    const chunks = chunkByHeaders("page_x" as never, body);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(5);
    expect(chunks[1].lineStart).toBe(6);
  });

  it("handles leading text before first header", () => {
    const chunks = chunkByHeaders(
      "page_x" as never,
      "intro line\n# Section\nbody",
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(1);
  });

  it("applies bodyStartLine so citations match the physical markdown file", () => {
    const chunks = chunkByHeaders("page_x" as never, "# Section\nbody", {
      bodyStartLine: 7,
    });
    expect(chunks[0].lineStart).toBe(7);
    expect(chunks[0].lineEnd).toBe(8);
  });

  it("further splits sections exceeding maxTokens", () => {
    const chunks = chunkByHeaders(
      "page_x" as never,
      `# Big\n${"word ".repeat(1000)}`,
      { maxTokens: 400 },
    );
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(480);
    }
  });

  it("assigns sequential chunk ids", () => {
    const chunks = chunkByHeaders("page_x" as never, "# A\nx\n# B\ny\n# C\nz");
    expect(chunks.map((chunk) => chunk.id)).toEqual([
      "page_x:c0",
      "page_x:c1",
      "page_x:c2",
    ]);
  });
});
