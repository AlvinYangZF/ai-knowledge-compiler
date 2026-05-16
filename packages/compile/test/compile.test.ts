import { describe, expect, it } from "vitest";
import {
  buildHeuristicCompilePatch,
  type CompilePageInput,
} from "../src/index.js";

function page(id: string, title: string, body: string): CompilePageInput {
  return {
    page: {
      id,
      path: `pages/${title.toLowerCase().replaceAll(" ", "-")}.md`,
      title,
      frontmatter: { id, title },
    },
    body,
    bodyStartLine: 1,
  } as CompilePageInput;
}

describe("compile pipeline", () => {
  it("emits a staged degraded patch when DeepSeek credentials are absent", () => {
    const source = page(
      "page_compilepkg01",
      "Compile Package",
      "Garbage collection compile package note.",
    );
    const target = page(
      "page_compilepkg02",
      "Garbage Collection",
      "Garbage collection target page.",
    );

    const patch = buildHeuristicCompilePatch({
      source,
      candidates: [target],
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.id).toBe("patch_page_compilepkg01");
    expect(patch.compileMeta.provider).toBe("heuristic");
    expect(patch.compileMeta.modelId).toBe("deepseek-v4-flash");
    expect(patch.compileMeta.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(patch.compileMeta.temperature).toBe(0);
    expect(patch.compileMeta.degraded).toBe(true);
    expect(patch.compileMeta.degradedReason).toContain("DEEPSEEK_API_KEY");
    expect(patch.compileMeta.stages.map((stage) => stage.name)).toEqual([
      "segment",
      "locate",
      "classify",
      "synthesize",
      "emit",
    ]);
    expect(patch.changes[0]).toMatchObject({
      type: "modify",
      pageId: "page_compilepkg02",
      relation: "extend",
    });
    expect(patch.lineage.units[0].sourceChunkIds).toEqual([
      "page_compilepkg01:c0",
    ]);
  });

  it("does not claim DeepSeek execution until the provider is implemented", () => {
    const source = page("page_compilepkg03", "New Source", "Standalone note.");

    const patch = buildHeuristicCompilePatch({
      source,
      candidates: [],
      model: "deepseek-v4-pro",
      deepseekApiKey: "test-key",
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.compileMeta.provider).toBe("heuristic");
    expect(patch.compileMeta.modelId).toBe("deepseek-v4-pro");
    expect(patch.compileMeta.degraded).toBe(true);
    expect(patch.compileMeta.degradedReason).toContain("not implemented");
    expect(patch.compileMeta.llmCallCount).toBe(0);
    expect(patch.changes[0]).toMatchObject({
      type: "confidence_only",
      pageId: "page_compilepkg03",
      relation: "duplicate",
    });
  });
});
