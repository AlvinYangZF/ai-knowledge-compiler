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
  baseUrl?: string;
  apiKeyEnv?: string;
  deepseekApiKey?: string;
  provider?: CompileJsonProvider;
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

export interface CompileJsonProvider {
  readonly model?: string;
  completeJson(call: DeepSeekJsonCall): Promise<DeepSeekJsonResult>;
}

export interface CompilePatchDocument {
  id: string;
  status: "proposed" | "applied" | "rejected";
  source: { sourceId: string; pageId: string; ingestPath: string };
  compileMeta: {
    provider: "deepseek" | "heuristic";
    modelId: string;
    apiKeyEnv: string;
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
      relation: "extend" | "merge" | "contradict";
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

export async function buildCompilePatch(
  opts: BuildCompilePatchOptions,
): Promise<CompilePatchDocument> {
  const model = opts.model ?? "deepseek-v4-flash";
  const provider =
    opts.provider ??
    (opts.deepseekApiKey
      ? new DeepSeekCompileProvider({
          apiKey: opts.deepseekApiKey,
          baseUrl: opts.baseUrl,
          model,
        })
      : undefined);
  if (!provider) {
    return buildHeuristicCompilePatch(opts);
  }

  try {
    return await buildDeepSeekCompilePatch(opts, provider);
  } catch (error) {
    const patch = buildHeuristicCompilePatch(opts);
    patch.compileMeta.degradedReason = `DeepSeek compile failed: ${sanitizedErrorMessage(error, opts.deepseekApiKey)}`;
    return patch;
  }
}

async function buildDeepSeekCompilePatch(
  opts: BuildCompilePatchOptions,
  provider: CompileJsonProvider,
): Promise<CompilePatchDocument> {
  const started = Date.now();
  const model = provider.model ?? opts.model ?? "deepseek-v4-flash";
  const timestamp = (opts.now ?? new Date()).toISOString();
  const patchId = `patch_${opts.source.page.id}`;
  let resolvedModel = model;
  const sourceChunks = chunkByHeaders(opts.source.page.id, opts.source.body, {
    bodyStartLine: opts.source.bodyStartLine,
  });
  let llmCallCount = 0;

  const segmentPrompt = JSON.stringify({
    task: "segment",
    sourcePage: opts.source.page,
    chunks: sourceChunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
    })),
  });
  const segmentResult = await provider.completeJson({
    responseSchemaName: "segment",
    messages: compileMessages(
      "Segment the source into semantic units. Return JSON only.",
      segmentPrompt,
    ),
  });
  resolvedModel = segmentResult.model || resolvedModel;
  const segment = parseJsonObject(segmentResult.content, "segment");
  llmCallCount += 1;
  const units = parseSemanticUnits(segment, opts.source.page.id, sourceChunks);

  const target = locateCompileTarget(opts.source, opts.candidates);
  const targetChunks = target
    ? chunkByHeaders(target.page.id, target.body, {
        bodyStartLine: target.bodyStartLine,
      })
    : [];
  const classifyPrompt = JSON.stringify({
    task: "classify",
    units,
    candidatePage: target
      ? {
          page: target.page,
          body: target.body,
        }
      : undefined,
  });
  const classifyResult = await provider.completeJson({
    responseSchemaName: "classify",
    messages: compileMessages(
      "Classify the relation as new, extend, merge, contradict, supersede, or duplicate. Return JSON only.",
      classifyPrompt,
    ),
  });
  resolvedModel = classifyResult.model || resolvedModel;
  const classify = parseJsonObject(classifyResult.content, "classify");
  llmCallCount += 1;
  const relation = parseCompileRelation(classify.relation);
  const classifyConfidence = parseConfidence(classify.confidence);
  const reasoning =
    typeof classify.reasoning === "string"
      ? classify.reasoning
      : "DeepSeek relation classification";

  let changes: CompilePatchChange[];
  if (relation === "duplicate" && target) {
    changes = [
      {
        type: "confidence_only",
        pageId: target.page.id,
        relation: "duplicate",
        confidenceImpact: {
          kind: "source_added",
          sourceWeight: 0.8,
        },
      },
    ];
  } else {
    const synthesizePrompt = JSON.stringify({
      task: "synthesize",
      patchId,
      relation,
      classifyConfidence,
      reasoning,
      sourcePage: opts.source.page,
      units,
      candidatePage: target
        ? {
            page: target.page,
            body: target.body,
          }
        : undefined,
    });
    const synthesizeResult = await provider.completeJson({
      responseSchemaName: "synthesize",
      messages: compileMessages(
        "Generate patch changes for the classified relation. Return JSON only.",
        synthesizePrompt,
      ),
    });
    resolvedModel = synthesizeResult.model || resolvedModel;
    const synthesize = parseJsonObject(synthesizeResult.content, "synthesize");
    llmCallCount += 1;
    changes = parsePatchChanges(synthesize, {
      relation,
      classifyConfidence,
      reasoning,
      target,
      source: opts.source,
    });
  }

  const promptHashes = {
    segment: stablePromptHash("segment/deepseek-v0.1"),
    locate: stablePromptHash("locate/deterministic-v0.1"),
    classify: stablePromptHash("classify/deepseek-v0.1"),
    synthesize: stablePromptHash("synthesize/deepseek-v0.1"),
    emit: stablePromptHash("emit/deterministic-v0.1"),
  };

  return {
    id: patchId,
    status: "proposed",
    source: {
      sourceId: stableId("src", opts.source.page.id),
      pageId: opts.source.page.id,
      ingestPath: opts.source.page.path,
    },
    compileMeta: {
      provider: "deepseek",
      modelId: resolvedModel,
      apiKeyEnv: opts.apiKeyEnv ?? "DEEPSEEK_API_KEY",
      promptHashes,
      pipelineVersion: "compile/0.1",
      stages: [
        { name: "segment", provider: "deepseek", degraded: false },
        { name: "locate", provider: "deterministic", degraded: false },
        { name: "classify", provider: "deepseek", degraded: false },
        { name: "synthesize", provider: "deepseek", degraded: false },
        { name: "emit", provider: "deterministic", degraded: false },
      ],
      segmentCount: units.length,
      llmCallCount,
      elapsedMs: Math.max(0, Date.now() - started),
      degraded: false,
      temperature: 0,
      createdAt: timestamp,
    },
    changes,
    lineage: {
      units: units.map((unit) => ({
        id: unit.id,
        sourcePageId: opts.source.page.id,
        sourceChunkIds: unit.sourceChunkIds,
        kind: unit.kind,
      })),
      derivedChunks: derivedChunksForChanges({
        changes,
        units,
        targetChunks,
        promptHash: promptHashes.synthesize,
        model,
        timestamp,
      }),
    },
  };
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
      score:
        lexicalRelatedness(source, item) + explicitTitleMention(source, item),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.item.page.id).localeCompare(String(b.item.page.id)) ||
        a.item.page.path.localeCompare(b.item.page.path),
    );
  const target =
    candidates.find((candidate) => explicitRelation(source, candidate.item))
      ?.item ??
    candidates.find((candidate) => isDuplicateContent(source, candidate.item))
      ?.item ??
    candidates[0]?.item;
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
    const relation = heuristicRelation(source, target);
    if (relation === "duplicate") {
      changes.push({
        type: "confidence_only",
        pageId: target.page.id,
        relation: "duplicate",
        confidenceImpact: {
          kind: "source_added",
          sourceWeight: 0.7,
        },
      });
    } else if (relation === "supersede") {
      const newPageId = stablePageId(
        `${source.page.id}:supersedes:${target.page.id}`,
      );
      changes.push({
        type: "create",
        newPageId,
        path: `pages/compiled/${slugify(source.page.title)}.md`,
        relation: "supersede",
        classifyConfidence: 0.72,
        reasoning: `${source.page.title} explicitly supersedes ${target.page.title}`,
        supersedes: target.page.id,
        content: [
          "---",
          `id: ${newPageId}`,
          `title: ${source.page.title}`,
          `supersedes: ${target.page.id}`,
          "---",
          `# ${source.page.title}`,
          "",
          `> Supersedes [[${target.page.id}]].`,
          "",
          `<!-- akb:derived source=${source.page.id}:c0 method=supersede patch=${patchId} promptHash="${synthesizePromptHash}" modelId="${model}" compiledAt="${timestamp}" -->`,
          source.body.trim(),
        ].join("\n"),
        confidenceImpact: {
          kind: "supersedes",
          supersededPageId: target.page.id,
        },
      });
    } else if (relation === "contradict") {
      changes.push({
        type: "modify",
        pageId: target.page.id,
        operation: "append_section",
        relation: "contradict",
        classifyConfidence: 0.68,
        reasoning: `${source.page.title} explicitly conflicts with ${target.page.title}`,
        content: [
          `## Contradiction: ${source.page.title}`,
          "",
          "> [!contradiction] Conflicting source",
          `> <!-- akb:derived source=${source.page.id}:c0 method=contradict patch=${patchId} promptHash="${synthesizePromptHash}" modelId="${model}" compiledAt="${timestamp}" -->`,
          `> ${source.body.trim().replace(/\n+/g, " ")}`,
        ].join("\n"),
        confidenceImpact: {
          kind: "contradicted_by",
          severity: "major",
        },
      });
    } else {
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
    }
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
      apiKeyEnv: opts.apiKeyEnv ?? "DEEPSEEK_API_KEY",
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
        : `${opts.apiKeyEnv ?? "DEEPSEEK_API_KEY"} not set`,
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
      derivedChunks:
        target && changes[0]?.type !== "confidence_only"
          ? [
              {
                chunkId:
                  changes[0]?.type === "create"
                    ? `${changes[0].newPageId}:c0`
                    : targetChunkId,
                derivedFrom: {
                  sourceUnitIds: [`${source.page.id}:su0`],
                  sourceChunkIds: [`${source.page.id}:c0`],
                  method:
                    changes[0]?.relation === "supersede"
                      ? "supersede"
                      : changes[0]?.relation === "contradict"
                        ? "contradict"
                        : "extend",
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

interface SemanticUnit {
  id: string;
  sourceChunkIds: string[];
  text: string;
  kind: string;
  lineRange?: { start: number; end: number };
}

function compileMessages(system: string, user: string): DeepSeekChatMessage[] {
  return [
    { role: "system", content: `${system}\nOutput ONLY JSON.` },
    { role: "user", content: user },
  ];
}

function parseJsonObject(
  content: string,
  schemaName: string,
): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${schemaName} response must be a JSON object`);
  }
  return parsed;
}

function parseSemanticUnits(
  payload: Record<string, unknown>,
  sourcePageId: string,
  sourceChunks: Array<{
    id: string;
    text: string;
    lineStart: number;
    lineEnd: number;
  }>,
): SemanticUnit[] {
  const chunkIds = new Set(sourceChunks.map((chunk) => chunk.id));
  const rawUnits = Array.isArray(payload.units) ? payload.units : [];
  const units = rawUnits.flatMap((unit, index): SemanticUnit[] => {
    if (!isRecord(unit)) {
      return [];
    }
    const sourceChunkIds = toStringArray(unit.sourceChunkIds).filter((id) =>
      chunkIds.has(id),
    );
    if (sourceChunkIds.length === 0) {
      return [];
    }
    return [
      {
        id:
          typeof unit.id === "string" ? unit.id : `${sourcePageId}:su${index}`,
        sourceChunkIds,
        text: typeof unit.text === "string" ? unit.text : "",
        kind: typeof unit.kind === "string" ? unit.kind : "claim_cluster",
      },
    ];
  });
  if (units.length > 0) {
    return units;
  }
  return sourceChunks.map((chunk, index) => ({
    id: `${sourcePageId}:su${index}`,
    sourceChunkIds: [chunk.id],
    text: chunk.text,
    kind: "claim_cluster",
    lineRange: { start: chunk.lineStart, end: chunk.lineEnd },
  }));
}

function locateCompileTarget(
  source: CompilePageInput,
  candidates: CompilePageInput[],
): CompilePageInput | undefined {
  return candidates
    .filter((item) => item.page.id !== source.page.id)
    .map((item) => ({
      item,
      score:
        lexicalRelatedness(source, item) + explicitTitleMention(source, item),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.item.page.id).localeCompare(String(b.item.page.id)) ||
        a.item.page.path.localeCompare(b.item.page.path),
    )[0]?.item;
}

function parseCompileRelation(value: unknown): CompileRelation {
  if (
    value === "new" ||
    value === "extend" ||
    value === "merge" ||
    value === "contradict" ||
    value === "supersede" ||
    value === "duplicate"
  ) {
    return value;
  }
  throw new Error("classify response has unsupported relation");
}

type CompileRelation =
  | "new"
  | "extend"
  | "merge"
  | "contradict"
  | "supersede"
  | "duplicate";

function parseConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.5;
}

function parsePatchChanges(
  payload: Record<string, unknown>,
  context: {
    relation: CompileRelation;
    classifyConfidence: number;
    reasoning: string;
    target?: CompilePageInput;
    source: CompilePageInput;
  },
): CompilePatchChange[] {
  const rawChanges = Array.isArray(payload.changes) ? payload.changes : [];
  const changes = rawChanges.flatMap((change): CompilePatchChange[] => {
    if (!isRecord(change) || typeof change.type !== "string") {
      return [];
    }
    if (change.type === "modify") {
      const pageId =
        context.target?.page.id ??
        (typeof change.pageId === "string" ? change.pageId : undefined);
      const content = typeof change.content === "string" ? change.content : "";
      if (!pageId || !isLineageMarkedContent(content)) {
        return [];
      }
      return [
        {
          type: "modify",
          pageId,
          operation: "append_section",
          relation:
            change.relation === "merge" ||
            change.relation === "contradict" ||
            change.relation === "extend"
              ? change.relation
              : context.relation === "merge" ||
                  context.relation === "contradict" ||
                  context.relation === "extend"
                ? context.relation
                : "extend",
          classifyConfidence:
            typeof change.classifyConfidence === "number"
              ? parseConfidence(change.classifyConfidence)
              : context.classifyConfidence,
          reasoning:
            typeof change.reasoning === "string"
              ? change.reasoning
              : context.reasoning,
          content,
          confidenceImpact: isRecord(change.confidenceImpact)
            ? change.confidenceImpact
            : {
                kind:
                  context.relation === "contradict"
                    ? "contradicted_by"
                    : "source_added",
                sourceWeight: 0.8,
              },
        },
      ];
    }
    if (change.type === "create") {
      const newPageId =
        typeof change.newPageId === "string"
          ? change.newPageId
          : stablePageId(`${context.source.page.id}:new`);
      const content = typeof change.content === "string" ? change.content : "";
      const relation = change.relation === "supersede" ? "supersede" : "new";
      const supersedes =
        typeof change.supersedes === "string" ? change.supersedes : undefined;
      const confidenceImpact = isRecord(change.confidenceImpact)
        ? change.confidenceImpact
        : relation === "supersede" && context.target
          ? {
              kind: "supersedes",
              supersededPageId: context.target.page.id,
            }
          : { kind: "source_added", sourceWeight: 0.8 };
      if (
        !isValidCompilePageId(newPageId) ||
        !isLineageMarkedContent(content) ||
        !isSafeCompileCreatePath(change.path) ||
        (relation === "supersede" &&
          (!isValidCompilePageId(supersedes) ||
            confidenceImpact.kind !== "supersedes" ||
            confidenceImpact.supersededPageId !== supersedes))
      ) {
        return [];
      }
      return [
        {
          type: "create",
          newPageId,
          path:
            typeof change.path === "string"
              ? change.path
              : `pages/compiled/${slugify(context.source.page.title)}.md`,
          relation,
          classifyConfidence:
            typeof change.classifyConfidence === "number"
              ? parseConfidence(change.classifyConfidence)
              : context.classifyConfidence,
          reasoning:
            typeof change.reasoning === "string"
              ? change.reasoning
              : context.reasoning,
          supersedes,
          content,
          confidenceImpact,
        },
      ];
    }
    return [];
  });
  if (changes.length > 0) {
    return changes;
  }
  throw new Error("synthesize response produced no valid patch changes");
}

function derivedChunksForChanges(opts: {
  changes: CompilePatchChange[];
  units: SemanticUnit[];
  targetChunks: Array<{ id: string }>;
  promptHash: string;
  model: string;
  timestamp: string;
}): Array<Record<string, unknown>> {
  const sourceUnitIds = opts.units.map((unit) => unit.id);
  const sourceChunkIds = [
    ...new Set(opts.units.flatMap((unit) => unit.sourceChunkIds)),
  ];
  return opts.changes.flatMap((change): Array<Record<string, unknown>> => {
    if (change.type === "confidence_only") {
      return [];
    }
    const chunkId =
      change.type === "create"
        ? `${change.newPageId}:c0`
        : `${change.pageId}:c${opts.targetChunks.length}`;
    return [
      {
        chunkId,
        derivedFrom: {
          sourceUnitIds,
          sourceChunkIds,
          method: change.relation,
          promptHash: opts.promptHash,
          modelId: opts.model,
          compiledAt: opts.timestamp,
        },
      },
    ];
  });
}

function isLineageMarkedContent(content: string): boolean {
  return content.includes("akb:derived");
}

function isValidCompilePageId(value: unknown): value is string {
  return typeof value === "string" && /^page_[a-z0-9]{12}$/.test(value);
}

function isSafeCompileCreatePath(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    typeof value === "string" &&
    value.startsWith("pages/") &&
    !value.includes("..") &&
    !value.startsWith("/") &&
    value.endsWith(".md")
  );
}

function sanitizedErrorMessage(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) {
    message = message.split(secret).join("[redacted]");
  }
  message = message.replace(/Authorization\s+Bearer\s+\S+/gi, "[redacted]");
  message = message.replace(/Bearer\s+\S+/gi, "[redacted]");
  message = message.replace(/https?:\/\/\S+/gi, "[redacted-url]");
  return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function explicitTitleMention(
  source: CompilePageInput,
  target: CompilePageInput,
): number {
  return `${source.page.title}\n${source.body}`
    .toLowerCase()
    .includes(target.page.title.toLowerCase())
    ? 100
    : 0;
}

function heuristicRelation(
  source: CompilePageInput,
  target: CompilePageInput,
): "extend" | "contradict" | "supersede" | "duplicate" {
  const explicit = explicitRelation(source, target);
  if (explicit) {
    return explicit;
  }
  if (isDuplicateContent(source, target)) {
    return "duplicate";
  }
  return "extend";
}

function explicitRelation(
  source: CompilePageInput,
  target: CompilePageInput,
): "contradict" | "supersede" | undefined {
  const text = `${source.page.title}\n${source.body}`.toLowerCase();
  const targetTerms = termsForPage(target.page, target.body);
  const mentionsTarget =
    text.includes(target.page.title.toLowerCase()) ||
    [...targetTerms].some((term) => text.includes(term));
  if (
    mentionsTarget &&
    /\b(supersedes|supersede|replaces|replacement)\b/.test(text)
  ) {
    return "supersede";
  }
  if (
    mentionsTarget &&
    /\b(contradicts|contradict|conflicts|conflict)\b/.test(text)
  ) {
    return "contradict";
  }
  return undefined;
}

function isDuplicateContent(
  source: CompilePageInput,
  target: CompilePageInput,
): boolean {
  const sourceFingerprint = contentFingerprint(source.body);
  return (
    sourceFingerprint.length > 0 &&
    sourceFingerprint === contentFingerprint(target.body)
  );
}

function contentFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/^# [^\n]*\n+/u, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stablePageId(input: string): string {
  return `page_${stableId("src", input).slice("src_".length)}`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "compiled-page";
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
