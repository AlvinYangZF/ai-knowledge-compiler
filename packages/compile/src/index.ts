import type { Page } from "@akb/core";
import { chunkByHeaders } from "@akb/search-engine";

export interface CompilePageInput {
  page: Page;
  body: string;
  bodyStartLine: number;
}

export interface BuildCompilePatchOptions {
  source: CompilePageInput;
  candidates: CompilePageInput[];
  model?: string;
  deepseekApiKey?: string;
  now?: Date;
}

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof fetch;
}

export interface DeepSeekChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekJsonCall {
  messages: DeepSeekChatMessage[];
  responseSchemaName: string;
}

export interface DeepSeekJsonResult {
  content: string;
  model: string;
}

export interface CompilePatchDocument {
  id: string;
  status: "proposed" | "applied" | "rejected";
  source: { sourceId: string; pageId: string; ingestPath: string };
  compileMeta: {
    provider: "deepseek" | "heuristic";
    modelId: string;
    apiKeyEnv: "DEEPSEEK_API_KEY";
    promptHashes: {
      segment: string;
      locate: string;
      classify: string;
      synthesize: string;
      emit: string;
    };
    pipelineVersion: "compile/0.1";
    stages: Array<{
      name: "segment" | "locate" | "classify" | "synthesize" | "emit";
      provider: "deterministic" | "deepseek" | "heuristic";
      degraded: boolean;
    }>;
    segmentCount: number;
    llmCallCount: number;
    elapsedMs: number;
    degraded: boolean;
    degradedReason?: string;
    temperature: 0;
    createdAt: string;
  };
  changes: CompilePatchChange[];
  lineage: {
    units: Array<{
      id: string;
      sourcePageId: string;
      sourceChunkIds: string[];
      kind: string;
    }>;
    derivedChunks: Array<Record<string, unknown>>;
  };
}

export type CompilePatchChange =
  | {
      type: "modify";
      pageId: string;
      operation: "append_section";
      relation: "extend";
      classifyConfidence: number;
      reasoning: string;
      content: string;
      confidenceImpact: Record<string, unknown>;
    }
  | {
      type: "confidence_only";
      pageId: string;
      relation: "duplicate";
      confidenceImpact: Record<string, unknown>;
    }
  | {
      type: "create";
      newPageId: string;
      path?: string;
      relation: "new" | "supersede";
      classifyConfidence: number;
      reasoning: string;
      supersedes?: string;
      content: string;
      confidenceImpact?: Record<string, unknown>;
    };

const PIPELINE_STAGES = [
  "segment",
  "locate",
  "classify",
  "synthesize",
  "emit",
] as const;

const providerSecrets = new WeakMap<DeepSeekCompileProvider, string>();

export class DeepSeekCompileProvider {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DeepSeekProviderOptions) {
    if (opts.apiKey.length === 0) {
      throw new Error("DeepSeek API key is required");
    }
    providerSecrets.set(this, opts.apiKey);
    this.baseUrl = opts.baseUrl ?? "https://api.deepseek.com";
    this.model = opts.model ?? "deepseek-v4-flash";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 2;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async completeJson(call: DeepSeekJsonCall): Promise<DeepSeekJsonResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${providerSecrets.get(this) ?? ""}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: this.model,
              messages: call.messages,
              temperature: 0,
              response_format: {
                type: "json_object",
              },
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new DeepSeekHttpError(response.status);
        }
        const payload = (await response.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          throw new Error(
            `DeepSeek response missing ${call.responseSchemaName} JSON content`,
          );
        }
        return {
          content,
          model: payload.model ?? this.model,
        };
      } catch (error) {
        lastError = error;
        if (attempt === this.retries || !shouldRetryDeepSeekError(error)) {
          break;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

class DeepSeekHttpError extends Error {
  constructor(readonly status: number) {
    super(`DeepSeek request failed: HTTP ${status}`);
  }
}

function shouldRetryDeepSeekError(error: unknown): boolean {
  if (error instanceof DeepSeekHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

export function buildHeuristicCompilePatch(
  opts: BuildCompilePatchOptions,
): CompilePatchDocument {
  const model = opts.model ?? "deepseek-v4-flash";
  const timestamp = (opts.now ?? new Date()).toISOString();
  const source = opts.source;
  const candidates = opts.candidates
    .filter((item) => item.page.id !== source.page.id)
    .map((item) => ({
      item,
      score: lexicalRelatedness(source, item),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const target = candidates[0]?.item;
  const patchId = `patch_${source.page.id}`;
  const synthesizePromptHash = stablePromptHash("synthesize/heuristic-v0.1");
  const targetChunkId = target
    ? `${target.page.id}:c${
        chunkByHeaders(target.page.id, target.body, {
          bodyStartLine: target.bodyStartLine,
        }).length
      }`
    : undefined;
  const changes: CompilePatchChange[] = [];

  if (target) {
    changes.push({
      type: "modify",
      pageId: target.page.id,
      operation: "append_section",
      relation: "extend",
      classifyConfidence: 0.7,
      reasoning: `${source.page.title} shares terms with ${target.page.title}`,
      content: [
        `## ${source.page.title} (compiled)`,
        "",
        `<!-- akb:derived source=${source.page.id}:c0 method=extend patch=${patchId} promptHash="${synthesizePromptHash}" modelId="${model}" compiledAt="${timestamp}" -->`,
        source.body.trim(),
      ].join("\n"),
      confidenceImpact: {
        kind: "source_added",
        sourceWeight: 0.8,
      },
    });
  } else {
    changes.push({
      type: "confidence_only",
      pageId: source.page.id,
      relation: "duplicate",
      confidenceImpact: {
        kind: "source_added",
        sourceWeight: 0.7,
      },
    });
  }

  const degraded = true;
  return {
    id: patchId,
    status: "proposed",
    source: {
      sourceId: stableId("src", source.page.id),
      pageId: source.page.id,
      ingestPath: source.page.path,
    },
    compileMeta: {
      provider: "heuristic",
      modelId: model,
      apiKeyEnv: "DEEPSEEK_API_KEY",
      promptHashes: Object.fromEntries(
        PIPELINE_STAGES.map((stage) => [
          stage,
          stablePromptHash(`${stage}/heuristic-v0.1`),
        ]),
      ) as CompilePatchDocument["compileMeta"]["promptHashes"],
      pipelineVersion: "compile/0.1",
      stages: PIPELINE_STAGES.map((name) => ({
        name,
        provider:
          name === "locate" || name === "emit" ? "deterministic" : "heuristic",
        degraded: name !== "locate" && name !== "emit",
      })),
      segmentCount: 1,
      llmCallCount: 0,
      elapsedMs: 0,
      degraded,
      degradedReason: opts.deepseekApiKey
        ? "DeepSeek provider not implemented; used heuristic fallback"
        : "DEEPSEEK_API_KEY not set",
      temperature: 0,
      createdAt: timestamp,
    },
    changes,
    lineage: {
      units: [
        {
          id: `${source.page.id}:su0`,
          sourcePageId: source.page.id,
          sourceChunkIds: [`${source.page.id}:c0`],
          kind: "claim_cluster",
        },
      ],
      derivedChunks: target
        ? [
            {
              chunkId: targetChunkId,
              derivedFrom: {
                sourceUnitIds: [`${source.page.id}:su0`],
                sourceChunkIds: [`${source.page.id}:c0`],
                method: "extend",
                promptHash: synthesizePromptHash,
                modelId: model,
                compiledAt: timestamp,
              },
            },
          ]
        : [],
    },
  };
}

function lexicalRelatedness(
  source: CompilePageInput,
  target: CompilePageInput,
): number {
  const sourceTerms = termsForPage(source.page, source.body);
  const targetTerms = termsForPage(target.page, target.body);
  let score = 0;
  for (const term of sourceTerms) {
    if (targetTerms.has(term)) {
      score += 1;
    }
  }
  return score;
}

function termsForPage(page: Page, body: string): Set<string> {
  return new Set(
    [
      page.title,
      ...toStringArray(page.frontmatter.aliases),
      ...toStringArray(page.frontmatter.tags),
      body,
    ]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 3),
  );
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stablePromptHash(input: string): string {
  return `sha256:${stableId("src", input).slice("src_".length)}`;
}

function stableId(prefix: "src", input: string): string {
  let hash = 0x811c9dc5;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = Math.abs(hash).toString(36).padStart(12, "0").slice(0, 12);
  return `${prefix}_${suffix}`;
}
