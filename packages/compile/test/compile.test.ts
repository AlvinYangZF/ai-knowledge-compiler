import { describe, expect, it } from "vitest";
import {
  buildHeuristicCompilePatch,
  type CompilePageInput,
  DeepSeekCompileProvider,
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

  it("emits confidence-only changes for duplicate target pages", () => {
    const source = page(
      "page_compilepkg11",
      "Wear Leveling Copy",
      "Wear leveling spreads erase cycles across blocks.",
    );
    const target = page(
      "page_compilepkg12",
      "Wear Leveling",
      "Wear leveling spreads erase cycles across blocks.",
    );

    const patch = buildHeuristicCompilePatch({
      source,
      candidates: [target],
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.changes[0]).toMatchObject({
      type: "confidence_only",
      pageId: "page_compilepkg12",
      relation: "duplicate",
      confidenceImpact: {
        kind: "source_added",
      },
    });
    expect(patch.lineage.derivedChunks).toEqual([]);
  });

  it("prefers exact duplicate targets over higher-scored related candidates", () => {
    const source = page(
      "page_compilepkg13",
      "Wear Leveling Copy",
      "Wear leveling spreads erase cycles across blocks.",
    );
    const mentioned = page(
      "page_compilepkg14",
      "Wear Leveling Copy",
      "Wear leveling copy target has related wording but different content.",
    );
    const duplicate = page(
      "page_compilepkg15",
      "Wear Leveling",
      "Wear leveling spreads erase cycles across blocks.",
    );

    const patch = buildHeuristicCompilePatch({
      source,
      candidates: [mentioned, duplicate],
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.changes[0]).toMatchObject({
      type: "confidence_only",
      pageId: "page_compilepkg15",
      relation: "duplicate",
    });
  });

  it("does not collapse heading-only semantic differences into duplicates", () => {
    const source = page(
      "page_compilepkg16",
      "Tradeoff Copy",
      "# Pros\nFast\n# Cons\nSlow",
    );
    const target = page(
      "page_compilepkg17",
      "Tradeoff",
      "# Cons\nFast\n# Pros\nSlow",
    );

    const patch = buildHeuristicCompilePatch({
      source,
      candidates: [target],
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.changes[0]).toMatchObject({
      type: "modify",
      pageId: "page_compilepkg17",
      relation: "extend",
    });
  });

  it("keeps explicit conflict signals ahead of duplicate matching", () => {
    const source = page(
      "page_compilepkg18",
      "GC Conflict",
      "This contradicts Garbage Collection.\nGC uses adaptive threshold.",
    );
    const target = page(
      "page_compilepkg19",
      "Garbage Collection",
      "GC uses adaptive threshold.",
    );

    const patch = buildHeuristicCompilePatch({
      source,
      candidates: [target],
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.changes[0]).toMatchObject({
      type: "modify",
      pageId: "page_compilepkg19",
      relation: "contradict",
    });
  });

  it("emits contradiction notes for explicit conflicting sources", () => {
    const source = page(
      "page_compilepkg04",
      "Adaptive GC Update",
      "This contradicts the fixed threshold guidance. Use a 5% threshold instead.",
    );
    const target = page(
      "page_compilepkg05",
      "Garbage Collection",
      "Garbage collection uses a fixed 10% threshold.",
    );

    const patch = buildHeuristicCompilePatch({
      source,
      candidates: [target],
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.changes[0]).toMatchObject({
      type: "modify",
      pageId: "page_compilepkg05",
      relation: "contradict",
      confidenceImpact: {
        kind: "contradicted_by",
        severity: "major",
      },
    });
    expect(patch.changes[0]).toHaveProperty("content");
    expect(JSON.stringify(patch.changes[0])).toContain("[!contradiction]");
    expect(patch.lineage.derivedChunks[0].derivedFrom.method).toBe(
      "contradict",
    );
  });

  it("emits create supersede changes for explicit replacement sources", () => {
    const source = page(
      "page_compilepkg06",
      "Adaptive GC",
      "This supersedes Garbage Collection. Adaptive thresholds replace the fixed threshold model.",
    );
    const target = page(
      "page_compilepkg07",
      "Garbage Collection",
      "Garbage collection uses a fixed threshold.",
    );

    const patch = buildHeuristicCompilePatch({
      source,
      candidates: [target],
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.changes[0]).toMatchObject({
      type: "create",
      relation: "supersede",
      supersedes: "page_compilepkg07",
      confidenceImpact: {
        kind: "supersedes",
        supersededPageId: "page_compilepkg07",
      },
    });
    expect(JSON.stringify(patch.changes[0])).toContain(
      "Supersedes [[page_compilepkg07]]",
    );
    expect(patch.lineage.derivedChunks[0].derivedFrom.method).toBe("supersede");
  });

  it("breaks equal relatedness ties deterministically", () => {
    const source = page(
      "page_compilepkg08",
      "GC Source",
      "Garbage collection note.",
    );
    const later = page(
      "page_compilepkg10",
      "Garbage Collection B",
      "Garbage collection target.",
    );
    const earlier = page(
      "page_compilepkg09",
      "Garbage Collection A",
      "Garbage collection target.",
    );

    const patch = buildHeuristicCompilePatch({
      source,
      candidates: [later, earlier],
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.changes[0]).toMatchObject({
      type: "modify",
      pageId: "page_compilepkg09",
    });
  });

  it("calls DeepSeek chat completions with deterministic compile settings", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = new DeepSeekCompileProvider({
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      timeoutMs: 1000,
      retries: 0,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            model: "deepseek-v4-pro",
            choices: [{ message: { content: '{"relation":"extend"}' } }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as typeof fetch,
    });

    const result = await provider.completeJson({
      responseSchemaName: "classify",
      messages: [
        { role: "system", content: "Return JSON only." },
        { role: "user", content: "Classify this source." },
      ],
    });

    expect(result).toEqual({
      content: '{"relation":"extend"}',
      model: "deepseek-v4-pro",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(requests[0].init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      model: "deepseek-v4-pro",
      temperature: 0,
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(provider)).not.toContain("test-key");
    expect(Object.keys(provider)).not.toContain("apiKey");
  });

  it("retries transient DeepSeek failures but not auth failures", async () => {
    let transientCalls = 0;
    const transientProvider = new DeepSeekCompileProvider({
      apiKey: "retry-key",
      retries: 1,
      fetch: (async () => {
        transientCalls += 1;
        return new Response(
          transientCalls === 1
            ? "temporary"
            : JSON.stringify({
                choices: [{ message: { content: '{"ok":true}' } }],
              }),
          {
            status: transientCalls === 1 ? 500 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as typeof fetch,
    });

    await expect(
      transientProvider.completeJson({
        responseSchemaName: "retry",
        messages: [{ role: "user", content: "json" }],
      }),
    ).resolves.toMatchObject({ content: '{"ok":true}' });
    expect(transientCalls).toBe(2);

    let authCalls = 0;
    const authProvider = new DeepSeekCompileProvider({
      apiKey: "bad-key",
      retries: 2,
      fetch: (async () => {
        authCalls += 1;
        return new Response("unauthorized", { status: 401 });
      }) as typeof fetch,
    });

    await expect(
      authProvider.completeJson({
        responseSchemaName: "auth",
        messages: [{ role: "user", content: "json" }],
      }),
    ).rejects.toThrow("HTTP 401");
    expect(authCalls).toBe(1);
  });
});
