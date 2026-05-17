import { describe, expect, it } from "vitest";
import {
  AnthropicCompileProvider,
  buildCompilePatch,
  buildHeuristicCompilePatch,
  type CompilePageInput,
  DeepSeekCompileProvider,
  OpenAICompileProvider,
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
  it("builds a DeepSeek-backed patch from staged JSON responses", async () => {
    const calls: string[] = [];
    const provider = {
      model: "deepseek-v4-pro",
      completeJson: async (call: { responseSchemaName: string }) => {
        calls.push(call.responseSchemaName);
        if (call.responseSchemaName === "segment") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              units: [
                {
                  id: "su_gc",
                  sourceChunkIds: ["page_compilepkg20:c0"],
                  text: "Adaptive garbage collection changes threshold policy.",
                  kind: "claim_cluster",
                  lineRange: { start: 1, end: 1 },
                },
              ],
            }),
          };
        }
        if (call.responseSchemaName === "classify") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              relation: "merge",
              confidence: 0.91,
              reasoning: "Both pages describe garbage collection thresholds.",
            }),
          };
        }
        return {
          model: "deepseek-v4-pro-routed",
          content: JSON.stringify({
            changes: [
              {
                type: "modify",
                pageId: "page_compilepkg21",
                operation: "replace_section",
                targetSection: "Threshold Policy",
                relation: "merge",
                classifyConfidence: 0.91,
                reasoning: "Merged threshold policy update.",
                content:
                  '## Threshold Policy\n\n<!-- akb:derived source=su_gc method=merge patch=patch_page_compilepkg20 promptHash="sha256:llm" modelId="deepseek-v4-pro" compiledAt="2026-05-16T00:00:00.000Z" -->\nAdaptive garbage collection changes threshold policy.',
                confidenceImpact: {
                  kind: "source_added",
                  sourceWeight: 0.8,
                },
              },
            ],
          }),
        };
      },
    };

    const patch = await buildCompilePatch({
      source: page(
        "page_compilepkg20",
        "Adaptive GC",
        "Adaptive garbage collection changes threshold policy.",
      ),
      candidates: [
        page(
          "page_compilepkg21",
          "Garbage Collection",
          "# Garbage Collection\n\n## Threshold Policy\n\nGarbage collection uses threshold policy.",
        ),
      ],
      model: "deepseek-v4-pro",
      provider,
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(calls).toEqual(["segment", "classify", "synthesize"]);
    expect(patch.compileMeta.provider).toBe("deepseek");
    expect(patch.compileMeta.degraded).toBe(false);
    expect(patch.compileMeta.modelId).toBe("deepseek-v4-pro");
    expect(patch.compileMeta.resolvedModelId).toBe("deepseek-v4-pro-routed");
    expect(patch.compileMeta.llmCallCount).toBe(3);
    expect(patch.compileMeta.stages).toEqual([
      { name: "segment", provider: "deepseek", degraded: false },
      { name: "locate", provider: "deterministic", degraded: false },
      { name: "classify", provider: "deepseek", degraded: false },
      { name: "synthesize", provider: "deepseek", degraded: false },
      { name: "emit", provider: "deterministic", degraded: false },
    ]);
    expect(patch.changes[0]).toMatchObject({
      type: "modify",
      pageId: "page_compilepkg21",
      operation: "replace_section",
      targetSection: "Threshold Policy",
      relation: "merge",
    });
    expect(patch.lineage.units).toEqual([
      {
        id: "su_gc",
        sourcePageId: "page_compilepkg20",
        sourceChunkIds: ["page_compilepkg20:c0"],
        kind: "claim_cluster",
      },
    ]);
    expect(patch.lineage.derivedChunks[0]).toMatchObject({
      chunkId: "page_compilepkg21:c1",
      derivedFrom: {
        sourceUnitIds: ["su_gc"],
        sourceChunkIds: ["page_compilepkg20:c0"],
        method: "merge",
        modelId: "deepseek-v4-pro",
      },
    });
  });

  it("falls back when DeepSeek synthesis omits valid patch changes", async () => {
    const provider = {
      model: "deepseek-v4-pro",
      completeJson: async (call: { responseSchemaName: string }) => {
        if (call.responseSchemaName === "segment") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              units: [
                {
                  id: "su_bad",
                  sourceChunkIds: ["page_compilepkg22:c0"],
                  text: "GC update.",
                  kind: "claim_cluster",
                },
              ],
            }),
          };
        }
        if (call.responseSchemaName === "classify") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              relation: "extend",
              confidence: 0.8,
              reasoning: "Related GC update.",
            }),
          };
        }
        return {
          model: "deepseek-v4-pro",
          content: JSON.stringify({ changes: [] }),
        };
      },
    };

    const patch = await buildCompilePatch({
      source: page("page_compilepkg22", "GC Update", "GC update."),
      candidates: [
        page("page_compilepkg23", "Garbage Collection", "GC target."),
      ],
      provider,
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.compileMeta.provider).toBe("heuristic");
    expect(patch.compileMeta.degraded).toBe(true);
    expect(patch.compileMeta.degradedReason).toContain(
      "DeepSeek compile failed",
    );
  });

  it("keeps DeepSeek modify changes scoped to the located target page", async () => {
    const provider = {
      model: "deepseek-v4-pro",
      completeJson: async (call: { responseSchemaName: string }) => {
        if (call.responseSchemaName === "segment") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              units: [
                {
                  id: "su_scope",
                  sourceChunkIds: ["page_compilepkg24:c0"],
                  text: "GC update.",
                  kind: "claim_cluster",
                },
              ],
            }),
          };
        }
        if (call.responseSchemaName === "classify") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              relation: "extend",
              confidence: 0.8,
              reasoning: "Related GC update.",
            }),
          };
        }
        return {
          model: "deepseek-v4-pro",
          content: JSON.stringify({
            changes: [
              {
                type: "modify",
                pageId: "page_compilepkg26",
                operation: "append_section",
                relation: "extend",
                classifyConfidence: 0.8,
                reasoning: "Malicious target switch.",
                content:
                  '## GC Update\n\n<!-- akb:derived source=su_scope method=extend patch=patch_page_compilepkg24 promptHash="sha256:llm" modelId="deepseek-v4-pro" compiledAt="2026-05-16T00:00:00.000Z" -->\nGC update.',
              },
            ],
          }),
        };
      },
    };

    const patch = await buildCompilePatch({
      source: page("page_compilepkg24", "GC Update", "GC update."),
      candidates: [
        page(
          "page_compilepkg25",
          "Garbage Collection",
          "GC target with update terms.",
        ),
        page("page_compilepkg26", "Unrelated", "Different page."),
      ],
      provider,
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.compileMeta.provider).toBe("deepseek");
    expect(patch.changes[0]).toMatchObject({
      type: "modify",
      pageId: "page_compilepkg25",
    });
  });

  it("marks low-confidence DeepSeek classifications for close review", async () => {
    const provider = {
      model: "deepseek-v4-pro",
      completeJson: async (call: { responseSchemaName: string }) => {
        if (call.responseSchemaName === "segment") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              units: [
                {
                  id: "su_lowconf",
                  sourceChunkIds: ["page_compilepkg33:c0"],
                  text: "Ambiguous GC update.",
                  kind: "claim_cluster",
                },
              ],
            }),
          };
        }
        if (call.responseSchemaName === "classify") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              relation: "extend",
              confidence: 0.49,
              reasoning: "Ambiguous relation.",
            }),
          };
        }
        return {
          model: "deepseek-v4-pro",
          content: JSON.stringify({
            changes: [
              {
                type: "modify",
                pageId: "page_compilepkg34",
                operation: "append_section",
                relation: "extend",
                classifyConfidence: 0.8,
                reasoning: "Ambiguous relation.",
                content:
                  '## Ambiguous GC Update\n\n<!-- akb:derived source=su_lowconf method=extend patch=patch_page_compilepkg33 promptHash="sha256:llm" modelId="deepseek-v4-pro" compiledAt="2026-05-16T00:00:00.000Z" -->\nAmbiguous GC update.',
              },
            ],
          }),
        };
      },
    };

    const patch = await buildCompilePatch({
      source: page("page_compilepkg33", "Ambiguous GC", "Ambiguous GC update."),
      candidates: [
        page("page_compilepkg34", "Garbage Collection", "GC target."),
      ],
      provider,
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.compileMeta.provider).toBe("deepseek");
    expect(patch.changes[0]).toMatchObject({
      classifyConfidence: 0.49,
      needsCloseReview: true,
    });
  });

  it("falls back when DeepSeek synthesized content lacks derived markers", async () => {
    const provider = {
      model: "deepseek-v4-pro",
      completeJson: async (call: { responseSchemaName: string }) => {
        if (call.responseSchemaName === "segment") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              units: [
                {
                  id: "su_nomarker",
                  sourceChunkIds: ["page_compilepkg27:c0"],
                  text: "GC update.",
                  kind: "claim_cluster",
                },
              ],
            }),
          };
        }
        if (call.responseSchemaName === "classify") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              relation: "extend",
              confidence: 0.8,
              reasoning: "Related GC update.",
            }),
          };
        }
        return {
          model: "deepseek-v4-pro",
          content: JSON.stringify({
            changes: [
              {
                type: "modify",
                pageId: "page_compilepkg28",
                operation: "append_section",
                relation: "extend",
                classifyConfidence: 0.8,
                reasoning: "Missing marker.",
                content: "## GC Update\n\nGC update.",
              },
            ],
          }),
        };
      },
    };

    const patch = await buildCompilePatch({
      source: page("page_compilepkg27", "GC Update", "GC update."),
      candidates: [
        page("page_compilepkg28", "Garbage Collection", "GC target."),
      ],
      provider,
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.compileMeta.provider).toBe("heuristic");
    expect(patch.compileMeta.degradedReason).toContain(
      "DeepSeek compile failed",
    );
  });

  it("falls back with sanitized errors when DeepSeek provider fails", async () => {
    const patch = await buildCompilePatch({
      source: page("page_compilepkg29", "GC Secret", "GC secret update."),
      candidates: [
        page("page_compilepkg30", "Garbage Collection", "GC target."),
      ],
      deepseekApiKey: "secret-test-key",
      provider: {
        model: "deepseek-v4-pro",
        completeJson: async () => {
          throw new Error(
            "Authorization Bearer secret-test-key failed at https://signed.example/token",
          );
        },
      },
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.compileMeta.provider).toBe("heuristic");
    expect(patch.compileMeta.degradedReason).toContain("[redacted]");
    expect(patch.compileMeta.degradedReason).not.toContain("secret-test-key");
    expect(patch.compileMeta.degradedReason).not.toContain("Bearer");
  });

  it("falls back when DeepSeek create changes are schema-incompatible", async () => {
    const provider = {
      model: "deepseek-v4-pro",
      completeJson: async (call: { responseSchemaName: string }) => {
        if (call.responseSchemaName === "segment") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              units: [
                {
                  id: "su_badcreate",
                  sourceChunkIds: ["page_compilepkg31:c0"],
                  text: "New topic.",
                  kind: "concept",
                },
              ],
            }),
          };
        }
        if (call.responseSchemaName === "classify") {
          return {
            model: "deepseek-v4-pro",
            content: JSON.stringify({
              relation: "supersede",
              confidence: 0.8,
              reasoning: "Replacement.",
            }),
          };
        }
        return {
          model: "deepseek-v4-pro",
          content: JSON.stringify({
            changes: [
              {
                type: "create",
                newPageId: "not-a-page-id",
                relation: "supersede",
                content:
                  '---\nid: not-a-page-id\n---\n<!-- akb:derived source=su_badcreate method=supersede patch=patch_page_compilepkg31 promptHash="sha256:llm" modelId="deepseek-v4-pro" compiledAt="2026-05-16T00:00:00.000Z" -->\nNew topic.',
              },
            ],
          }),
        };
      },
    };

    const patch = await buildCompilePatch({
      source: page("page_compilepkg31", "New Topic", "New topic."),
      candidates: [page("page_compilepkg32", "Old Topic", "Old topic.")],
      provider,
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(patch.compileMeta.provider).toBe("heuristic");
    expect(patch.compileMeta.degradedReason).toContain(
      "DeepSeek compile failed",
    );
  });

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
    expect(patch.compileMeta.apiKeyEnv).toBeUndefined();
    expect(patch.compileMeta.temperature).toBe(0);
    expect(patch.compileMeta.degraded).toBe(true);
    expect(patch.compileMeta.degradedReason).toContain(
      "llm.api_key not configured for deepseek",
    );
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

  it("does not claim provider execution when building a heuristic patch directly", () => {
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
    expect(patch.compileMeta.degradedReason).toContain(
      "Provider-backed compile was not run",
    );
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

  it("calls OpenAI chat completions with direct API key credentials", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = new OpenAICompileProvider({
      apiKey: "openai-test-key",
      model: "gpt-4.1-mini",
      timeoutMs: 1000,
      retries: 0,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            model: "gpt-4.1-mini",
            choices: [{ message: { content: '{"ok":true}' } }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as typeof fetch,
    });

    const result = await provider.completeJson({
      responseSchemaName: "openai",
      messages: [{ role: "user", content: "Return JSON." }],
    });

    expect(result).toEqual({
      content: '{"ok":true}',
      model: "gpt-4.1-mini",
    });
    expect(requests[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0].init.headers).toMatchObject({
      Authorization: "Bearer openai-test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      model: "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(provider)).not.toContain("openai-test-key");
  });

  it("calls Anthropic messages with direct API key credentials", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = new AnthropicCompileProvider({
      apiKey: "anthropic-test-key",
      model: "claude-sonnet-4-20250514",
      timeoutMs: 1000,
      retries: 0,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: '{"ok":true}' }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as typeof fetch,
    });

    const result = await provider.completeJson({
      responseSchemaName: "anthropic",
      messages: [
        { role: "system", content: "Return JSON only." },
        { role: "user", content: "Classify this source." },
      ],
    });

    expect(result).toEqual({
      content: '{"ok":true}',
      model: "claude-sonnet-4-20250514",
    });
    expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0].init.headers).toMatchObject({
      "x-api-key": "anthropic-test-key",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      temperature: 0,
      system: "Return JSON only.",
      messages: [{ role: "user", content: "Classify this source." }],
    });
    expect(JSON.stringify(provider)).not.toContain("anthropic-test-key");
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
