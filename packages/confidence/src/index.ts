import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type PageId, PageIdSchema } from "@akb/core";
import { z } from "zod";

export type SourceId = string & { readonly __brand: "SourceId" };
export type ConfidenceEventId = string & {
  readonly __brand: "ConfidenceEventId";
};

const SourceIdSchema = z
  .string()
  .regex(/^src_[a-z0-9]{12}$/)
  .transform((value) => value as SourceId);

const ConfidenceEventIdSchema = z
  .string()
  .regex(/^evt_[a-z0-9]{12}$/)
  .transform((value) => value as ConfidenceEventId);

const EventBaseSchema = z.object({
  id: ConfidenceEventIdSchema,
  pageId: PageIdSchema,
  timestamp: z.string().datetime(),
  actor: z.enum(["human", "agent", "system"]),
  actorId: z.string().min(1).optional(),
});

export const ConfidenceEventSchema = z
  .discriminatedUnion("kind", [
    EventBaseSchema.extend({
      kind: z.literal("source_added"),
      sourceId: SourceIdSchema,
      sourceWeight: z.number().min(0).max(1),
    }),
    EventBaseSchema.extend({
      kind: z.literal("source_removed"),
      sourceId: SourceIdSchema,
      reason: z.string().min(1),
    }),
    EventBaseSchema.extend({
      kind: z.literal("verified"),
      verifierType: z.enum(["human", "agent"]),
      verifierId: z.string().min(1).optional(),
      reason: z.string().min(1).optional(),
    }),
    EventBaseSchema.extend({
      kind: z.literal("contradicted_by"),
      bySourceId: SourceIdSchema,
      severity: z.enum(["minor", "major"]),
    }),
    EventBaseSchema.extend({
      kind: z.literal("superseded_by"),
      supersederPageId: PageIdSchema,
    }),
    EventBaseSchema.extend({
      kind: z.literal("supersedes"),
      supersededPageId: PageIdSchema,
    }),
    EventBaseSchema.extend({
      kind: z.literal("decay_checkpoint"),
      daysSinceLastEvent: z.number().nonnegative(),
      appliedDecay: z.number().nonnegative(),
    }),
    EventBaseSchema.extend({
      kind: z.literal("manual_override"),
      reason: z.string().min(1),
      newBase: z.number().min(0).max(1),
    }),
  ])
  .superRefine((event, ctx) => {
    if (event.actor === "agent" && !event.actorId) {
      ctx.addIssue({
        code: "custom",
        message: "agent confidence events require actorId",
        path: ["actorId"],
      });
    }
    if (
      event.kind === "verified" &&
      event.verifierType === "agent" &&
      !event.actorId
    ) {
      ctx.addIssue({
        code: "custom",
        message: "agent verified events require actorId",
        path: ["actorId"],
      });
    }
  });

export type ConfidenceEvent = z.infer<typeof ConfidenceEventSchema>;

export interface ConfidenceState {
  pageId: PageId;
  score: number;
  sourceCount: number;
  contradictionCount: number;
  lastVerifiedAt?: string;
  lastEventAt: string;
  supersededBy?: PageId;
  computedAt: string;
  explanation: {
    base: number;
    sourceStrength: number;
    contradictionPenalty: number;
    timeDecay: number;
    verificationBoost: number;
  };
}

export interface ComputeConfidenceOptions {
  now?: Date;
  pageType?: string;
  base?: number;
}

export function parseConfidenceEvent(value: unknown): ConfidenceEvent {
  return ConfidenceEventSchema.parse(value);
}

export function ledgerPathForPage(
  vaultDir: string,
  pagePath: string,
  pageId: PageId | string,
): string {
  return join(vaultDir, dirname(pagePath), `.${pageId}.ledger.jsonl`);
}

export function appendConfidenceEvent(
  vaultDir: string,
  pagePath: string,
  event: ConfidenceEvent,
): string {
  const path = ledgerPathForPage(vaultDir, pagePath, event.pageId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  return path;
}

export function loadConfidenceEvents(
  vaultDir: string,
  pagePath: string,
  pageId: PageId | string,
): ConfidenceEvent[] {
  const path = ledgerPathForPage(vaultDir, pagePath, pageId);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseConfidenceEvent(JSON.parse(line)));
}

export function computeConfidenceState(
  inputEvents: ConfidenceEvent[],
  opts: ComputeConfidenceOptions = {},
): ConfidenceState {
  if (inputEvents.length === 0) {
    throw new Error("Cannot compute confidence state without events");
  }

  const events = [...inputEvents].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  const pageId = events[0].pageId;
  const now = opts.now ?? new Date();
  const base = opts.base ?? 0.25;
  const sourceWeights = new Map<string, number>();
  let contradictionPenalty = 0;
  let contradictionCount = 0;
  let verificationBoost = 0;
  let lastVerifiedAt: string | undefined;
  let supersededBy: PageId | undefined;
  let manualBase = base;

  for (const event of events) {
    if (event.pageId !== pageId) {
      throw new Error("Cannot compute confidence state across multiple pages");
    }

    if (event.kind === "source_added") {
      sourceWeights.set(event.sourceId, event.sourceWeight);
    } else if (event.kind === "source_removed") {
      sourceWeights.delete(event.sourceId);
    } else if (event.kind === "verified") {
      lastVerifiedAt = event.timestamp;
      verificationBoost = 0.15;
    } else if (event.kind === "contradicted_by") {
      contradictionCount += 1;
      contradictionPenalty += event.severity === "major" ? 0.35 : 0.1;
    } else if (event.kind === "superseded_by") {
      supersededBy = event.supersederPageId;
      contradictionPenalty += 0.6;
    } else if (event.kind === "manual_override") {
      manualBase = event.newBase;
    }
  }

  contradictionPenalty = Math.min(0.6, contradictionPenalty);
  const sourceStrength =
    1 -
    Math.exp(
      -[...sourceWeights.values()].reduce((sum, weight) => sum + weight, 0) /
        1.5,
    );
  const lastEventAt = events.at(-1)?.timestamp ?? now.toISOString();
  const timeDecay = computeTimeDecay(lastEventAt, now, opts.pageType ?? "note");
  const score = clamp01(
    manualBase +
      sourceStrength -
      contradictionPenalty -
      timeDecay +
      verificationBoost,
  );

  return {
    pageId,
    score: round(score),
    sourceCount: sourceWeights.size,
    contradictionCount,
    lastVerifiedAt,
    lastEventAt,
    supersededBy,
    computedAt: now.toISOString(),
    explanation: {
      base: manualBase,
      sourceStrength: round(sourceStrength),
      contradictionPenalty: round(contradictionPenalty),
      timeDecay: round(timeDecay),
      verificationBoost,
    },
  };
}

function computeTimeDecay(
  lastEventAt: string,
  now: Date,
  pageType: string,
): number {
  const { halfLifeDays, ceiling } = decayProfile(pageType);
  const elapsedMs = Math.max(
    0,
    now.getTime() - new Date(lastEventAt).getTime(),
  );
  const daysSince = elapsedMs / (24 * 60 * 60 * 1000);
  return (1 - 2 ** (-daysSince / halfLifeDays)) * ceiling;
}

function decayProfile(pageType: string): {
  halfLifeDays: number;
  ceiling: number;
} {
  switch (pageType) {
    case "decision":
      return { halfLifeDays: 365, ceiling: 0.15 };
    case "architecture":
      return { halfLifeDays: 180, ceiling: 0.2 };
    case "module":
      return { halfLifeDays: 90, ceiling: 0.3 };
    case "concept":
      return { halfLifeDays: 730, ceiling: 0.1 };
    case "runbook":
    case "api":
      return { halfLifeDays: 60, ceiling: 0.4 };
    case "meeting":
      return { halfLifeDays: 30, ceiling: 0.5 };
    default:
      return { halfLifeDays: 120, ceiling: 0.3 };
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
