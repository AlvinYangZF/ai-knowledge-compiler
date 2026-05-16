import type { PageId, SearchResult } from "@akb/core";

export type ResultFlag =
  | "NEEDS_REVIEW"
  | "RECENTLY_CONTRADICTED"
  | "STALE"
  | "SUPERSEDED";

export interface RankWeights {
  relevance: number;
  confidence: number;
  freshness: number;
  access: number;
}

export interface RankConfidenceState {
  score: number;
  supersededBy?: PageId;
  lastVerifiedAt?: string;
  lastEventAt?: string;
  recentMajorContradictedAt?: string;
}

export interface RankOptions {
  includeSuperseded?: boolean;
}

export interface RankInput {
  rawResults: SearchResult[];
  confidenceState: Map<PageId, RankConfidenceState>;
  pageAccessLog?: Map<PageId, Date>;
  weights?: Partial<RankWeights>;
  options?: RankOptions;
  now?: Date;
}

export interface RankedSearchResult extends SearchResult {
  final_score: number;
  component_scores: {
    relevance: number;
    confidence: number;
    freshness: number;
    access_recency: number;
  };
  flags: ResultFlag[];
}

const DEFAULT_WEIGHTS: RankWeights = {
  relevance: 0.55,
  confidence: 0.25,
  freshness: 0.1,
  access: 0.1,
};

export function rankSearchResults(input: RankInput): RankedSearchResult[] {
  const weights = normalizeWeights({ ...DEFAULT_WEIGHTS, ...input.weights });
  const now = input.now ?? new Date();
  const ranked: RankedSearchResult[] = [];

  for (const result of input.rawResults) {
    const state = input.confidenceState.get(result.page_id);
    const isSuperseded = state?.supersededBy !== undefined;
    if (isSuperseded && input.options?.includeSuperseded !== true) {
      continue;
    }

    const confidence = clamp01(state?.score ?? 0.7);
    const freshness = freshnessScore(state?.lastEventAt, now);
    const accessRecency = accessRecencyScore(
      input.pageAccessLog?.get(result.page_id),
      now,
    );
    const relevance = clamp01(result.score);
    const flags = flagsForState(state, confidence, now);
    let finalScore =
      relevance * weights.relevance +
      confidence * weights.confidence +
      freshness * weights.freshness +
      accessRecency * weights.access;

    if (isSuperseded) {
      finalScore *= 0.5;
    }

    ranked.push({
      ...result,
      final_score: round(finalScore),
      component_scores: {
        relevance: round(relevance),
        confidence: round(confidence),
        freshness: round(freshness),
        access_recency: round(accessRecency),
      },
      flags,
    });
  }

  return ranked.sort((a, b) => b.final_score - a.final_score);
}

function flagsForState(
  state: RankConfidenceState | undefined,
  confidence: number,
  now: Date,
): ResultFlag[] {
  const flags: ResultFlag[] = [];
  if (confidence < 0.5) {
    flags.push("NEEDS_REVIEW");
  }
  if (state?.supersededBy !== undefined) {
    flags.push("SUPERSEDED");
  }
  if (isRecentMajorContradiction(state?.recentMajorContradictedAt, now)) {
    flags.push("RECENTLY_CONTRADICTED");
  }
  if (isStale(state?.lastVerifiedAt, now)) {
    flags.push("STALE");
  }
  return flags;
}

function isRecentMajorContradiction(
  timestamp: string | undefined,
  now: Date,
): boolean {
  if (!timestamp) {
    return false;
  }
  return daysBetween(timestamp, now) <= 30;
}

function freshnessScore(lastEventAt: string | undefined, now: Date): number {
  if (!lastEventAt) {
    return 0.5;
  }
  const days = daysBetween(lastEventAt, now);
  return clamp01(Math.exp(-days / 180));
}

function accessRecencyScore(accessedAt: Date | undefined, now: Date): number {
  if (!accessedAt) {
    return 0.5;
  }
  const days = Math.max(
    0,
    (now.getTime() - accessedAt.getTime()) / (24 * 60 * 60 * 1000),
  );
  return clamp01(Math.exp(-days / 30));
}

function isStale(lastVerifiedAt: string | undefined, now: Date): boolean {
  if (!lastVerifiedAt) {
    return false;
  }
  return daysBetween(lastVerifiedAt, now) > 240;
}

function daysBetween(timestamp: string, now: Date): number {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return 0;
  }
  return Math.max(0, (now.getTime() - time) / (24 * 60 * 60 * 1000));
}

function normalizeWeights(weights: RankWeights): RankWeights {
  const total =
    weights.relevance + weights.confidence + weights.freshness + weights.access;
  if (total <= 0) {
    return DEFAULT_WEIGHTS;
  }
  return {
    relevance: weights.relevance / total,
    confidence: weights.confidence / total,
    freshness: weights.freshness / total,
    access: weights.access / total,
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
