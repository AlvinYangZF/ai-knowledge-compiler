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
