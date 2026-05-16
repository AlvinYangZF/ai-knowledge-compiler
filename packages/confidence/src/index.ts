import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type PageId, PageIdSchema } from "@akb/core";
import Database from "better-sqlite3";
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
      sourceKey: z.string().min(1).optional(),
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
      reason: z.string().min(1).optional(),
    }),
    EventBaseSchema.extend({
      kind: z.literal("superseded_by"),
      supersederPageId: PageIdSchema,
      reason: z.string().min(1).optional(),
    }),
    EventBaseSchema.extend({
      kind: z.literal("supersedes"),
      supersededPageId: PageIdSchema,
      reason: z.string().min(1).optional(),
    }),
    EventBaseSchema.extend({
      kind: z.literal("supersedes_removed"),
      supersededPageId: PageIdSchema,
      replacementPageId: PageIdSchema.optional(),
      reason: z.string().min(1).optional(),
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
      (event.kind === "verified" || event.kind === "contradicted_by") &&
      !event.actorId
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${event.kind} confidence events require actorId`,
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

export interface ProjectedConfidencePage {
  pageId: PageId;
  events: ConfidenceEvent[];
  state: ConfidenceState;
}

export interface ConfidenceProjectionRebuildResult {
  pages: number;
  events: number;
}

export type ProjectedConfidenceState = Pick<
  ConfidenceState,
  | "pageId"
  | "score"
  | "sourceCount"
  | "contradictionCount"
  | "lastVerifiedAt"
  | "lastEventAt"
  | "supersededBy"
  | "computedAt"
>;

export interface ConfidenceProjectionOptions {
  dbPath: string;
  readonly?: boolean;
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
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
  const lastVerificationResetByActorType = new Map<string, string>();
  let decayAnchorAt = events.at(-1)?.timestamp ?? now.toISOString();

  for (const event of events) {
    if (event.pageId !== pageId) {
      throw new Error("Cannot compute confidence state across multiple pages");
    }

    if (event.kind === "source_added") {
      sourceWeights.set(event.sourceId, event.sourceWeight);
    } else if (event.kind === "source_removed") {
      sourceWeights.delete(event.sourceId);
    } else if (event.kind === "verified") {
      const weight = verificationRuleFor(event);
      if (daysBetween(event.timestamp, now) <= 30) {
        verificationBoost += weight.boost;
      }
      const previousReset = lastVerificationResetByActorType.get(
        weight.actorType,
      );
      if (
        previousReset === undefined ||
        daysBetween(previousReset, new Date(event.timestamp)) >=
          weight.resetWindowDays
      ) {
        lastVerifiedAt = event.timestamp;
        decayAnchorAt = event.timestamp;
        lastVerificationResetByActorType.set(weight.actorType, event.timestamp);
      }
    } else if (event.kind === "contradicted_by") {
      decayAnchorAt = event.timestamp;
      contradictionCount += 1;
      contradictionPenalty += event.severity === "major" ? 0.35 : 0.1;
    } else if (event.kind === "superseded_by") {
      decayAnchorAt = event.timestamp;
      supersededBy = event.supersederPageId;
      contradictionPenalty += 0.6;
    } else if (event.kind === "manual_override") {
      decayAnchorAt = event.timestamp;
      manualBase = event.newBase;
    } else {
      decayAnchorAt = event.timestamp;
    }
  }

  contradictionPenalty = Math.min(0.6, contradictionPenalty);
  verificationBoost = Math.min(0.25, verificationBoost);
  const sourceStrength =
    1 -
    Math.exp(
      -[...sourceWeights.values()].reduce((sum, weight) => sum + weight, 0) /
        1.5,
    );
  const lastEventAt = events.at(-1)?.timestamp ?? now.toISOString();
  const timeDecay = computeTimeDecay(
    decayAnchorAt,
    now,
    opts.pageType ?? "note",
  );
  const uncappedScore = clamp01(
    manualBase +
      sourceStrength -
      contradictionPenalty -
      timeDecay +
      verificationBoost,
  );
  const score = supersededBy ? Math.min(uncappedScore, 0.3) : uncappedScore;

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

export class ConfidenceProjection {
  private readonly db: Database.Database;

  constructor(opts: ConfidenceProjectionOptions) {
    this.db = new Database(opts.dbPath, { readonly: opts.readonly ?? false });
    if (!opts.readonly) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.ensureSchema();
    }
  }

  rebuild(
    pages: Iterable<ProjectedConfidencePage>,
  ): ConfidenceProjectionRebuildResult {
    const items = [...pages];
    let eventCount = 0;
    const write = this.db.transaction(() => {
      this.db.prepare("DELETE FROM confidence_events").run();
      this.db.prepare("DELETE FROM confidence_state").run();
      const insertEvent = this.db.prepare(`
        INSERT INTO confidence_events (
          id, page_id, kind, timestamp, actor, actor_id, payload
        ) VALUES (
          @id, @pageId, @kind, @timestamp, @actor, @actorId, @payload
        )
      `);
      const insertState = this.db.prepare(`
        INSERT INTO confidence_state (
          page_id, score, source_count, contradiction_count,
          last_verified_at, last_event_at, superseded_by, computed_at
        ) VALUES (
          @pageId, @score, @sourceCount, @contradictionCount,
          @lastVerifiedAt, @lastEventAt, @supersededBy, @computedAt
        )
      `);

      for (const item of items) {
        for (const event of item.events) {
          insertEvent.run({
            id: event.id,
            pageId: event.pageId,
            kind: event.kind,
            timestamp: event.timestamp,
            actor: event.actor,
            actorId: event.actorId ?? null,
            payload: JSON.stringify(event),
          });
          eventCount += 1;
        }
        insertState.run({
          pageId: item.state.pageId,
          score: item.state.score,
          sourceCount: item.state.sourceCount,
          contradictionCount: item.state.contradictionCount,
          lastVerifiedAt: item.state.lastVerifiedAt ?? null,
          lastEventAt: item.state.lastEventAt,
          supersededBy: item.state.supersededBy ?? null,
          computedAt: item.state.computedAt,
        });
      }
    });
    write();
    return { pages: items.length, events: eventCount };
  }

  upsertPage(item: ProjectedConfidencePage): ConfidenceProjectionRebuildResult {
    const write = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM confidence_events WHERE page_id = ?")
        .run(item.pageId);
      this.db
        .prepare("DELETE FROM confidence_state WHERE page_id = ?")
        .run(item.pageId);
      const insertEvent = this.db.prepare(`
        INSERT INTO confidence_events (
          id, page_id, kind, timestamp, actor, actor_id, payload
        ) VALUES (
          @id, @pageId, @kind, @timestamp, @actor, @actorId, @payload
        )
      `);
      const insertState = this.db.prepare(`
        INSERT INTO confidence_state (
          page_id, score, source_count, contradiction_count,
          last_verified_at, last_event_at, superseded_by, computed_at
        ) VALUES (
          @pageId, @score, @sourceCount, @contradictionCount,
          @lastVerifiedAt, @lastEventAt, @supersededBy, @computedAt
        )
      `);
      for (const event of item.events) {
        insertEvent.run({
          id: event.id,
          pageId: event.pageId,
          kind: event.kind,
          timestamp: event.timestamp,
          actor: event.actor,
          actorId: event.actorId ?? null,
          payload: JSON.stringify(event),
        });
      }
      insertState.run({
        pageId: item.state.pageId,
        score: item.state.score,
        sourceCount: item.state.sourceCount,
        contradictionCount: item.state.contradictionCount,
        lastVerifiedAt: item.state.lastVerifiedAt ?? null,
        lastEventAt: item.state.lastEventAt,
        supersededBy: item.state.supersededBy ?? null,
        computedAt: item.state.computedAt,
      });
    });
    write();
    return { pages: 1, events: item.events.length };
  }

  getStates(pageIds: Iterable<PageId>): Map<PageId, ProjectedConfidenceState> {
    if (!this.hasProjectionTables()) {
      return new Map();
    }
    const get = this.db.prepare(`
      SELECT
        page_id, score, source_count, contradiction_count,
        last_verified_at, last_event_at, superseded_by, computed_at
      FROM confidence_state
      WHERE page_id = ?
    `);
    const states = new Map<PageId, ProjectedConfidenceState>();
    for (const pageId of pageIds) {
      const row = get.get(pageId) as ConfidenceStateRow | undefined;
      if (!row) {
        continue;
      }
      states.set(pageId, {
        pageId: row.page_id as PageId,
        score: row.score,
        sourceCount: row.source_count,
        contradictionCount: row.contradiction_count,
        lastVerifiedAt: row.last_verified_at ?? undefined,
        lastEventAt: row.last_event_at,
        supersededBy: row.superseded_by
          ? (row.superseded_by as PageId)
          : undefined,
        computedAt: row.computed_at,
      });
    }
    return states;
  }

  getEvents(pageId: PageId): ConfidenceEvent[] {
    if (!this.hasProjectionTables()) {
      return [];
    }
    return (
      this.db
        .prepare(
          "SELECT payload FROM confidence_events WHERE page_id = ? ORDER BY timestamp, id",
        )
        .all(pageId) as Array<{ payload: string }>
    ).map((row) => parseConfidenceEvent(JSON.parse(row.payload)));
  }

  close(): void {
    this.db.close();
  }

  private ensureSchema(): void {
    this.db.exec(CONFIDENCE_PROJECTION_SQL);
  }

  private hasProjectionTables(): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('confidence_events', 'confidence_state')",
      )
      .get() as { count: number };
    return row.count === 2;
  }
}

interface ConfidenceStateRow {
  page_id: string;
  score: number;
  source_count: number;
  contradiction_count: number;
  last_verified_at: string | null;
  last_event_at: string;
  superseded_by: string | null;
  computed_at: string;
}

const CONFIDENCE_PROJECTION_SQL = `
CREATE TABLE IF NOT EXISTS confidence_events (
    id              TEXT PRIMARY KEY,
    page_id         TEXT NOT NULL,
    kind            TEXT NOT NULL,
    timestamp       TEXT NOT NULL,
    actor           TEXT NOT NULL,
    actor_id        TEXT,
    payload         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conf_events_page_time
  ON confidence_events(page_id, timestamp);

CREATE TABLE IF NOT EXISTS confidence_state (
    page_id              TEXT PRIMARY KEY,
    score                REAL NOT NULL,
    source_count         INTEGER NOT NULL,
    contradiction_count  INTEGER NOT NULL,
    last_verified_at     TEXT,
    last_event_at        TEXT NOT NULL,
    superseded_by        TEXT,
    computed_at          TEXT NOT NULL
);
`;

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

function verificationRuleFor(
  event: Extract<ConfidenceEvent, { kind: "verified" }>,
): { actorType: string; boost: number; resetWindowDays: number } {
  const actorId = event.actorId ?? "";
  if (actorId.startsWith("human:")) {
    return { actorType: "human", boost: 0.05, resetWindowDays: 0 };
  }
  if (actorId === "ci:github-actions") {
    return {
      actorType: "ci:github-actions",
      boost: 0.03,
      resetWindowDays: 14,
    };
  }
  if (actorId.startsWith("ci:")) {
    return { actorType: "ci:other", boost: 0.02, resetWindowDays: 14 };
  }
  if (actorId === "agent:claude-code") {
    return {
      actorType: "agent:claude-code",
      boost: 0.02,
      resetWindowDays: 7,
    };
  }
  if (actorId.startsWith("agent:")) {
    return { actorType: "agent:other", boost: 0.01, resetWindowDays: 7 };
  }
  if (actorId === "runbook-exec") {
    return { actorType: "runbook-exec", boost: 0.04, resetWindowDays: 0 };
  }
  if (actorId === "test:integration") {
    return { actorType: "test:integration", boost: 0.04, resetWindowDays: 0 };
  }
  if (actorId === "test:unit") {
    return { actorType: "test:unit", boost: 0.02, resetWindowDays: 14 };
  }
  if (event.verifierType === "agent") {
    return { actorType: "agent:other", boost: 0.01, resetWindowDays: 7 };
  }
  return { actorType: "unpatterned", boost: 0.01, resetWindowDays: 7 };
}

function daysBetween(from: string, to: Date): number {
  const fromTime = new Date(from).getTime();
  if (!Number.isFinite(fromTime)) {
    return 0;
  }
  return Math.max(0, (to.getTime() - fromTime) / (24 * 60 * 60 * 1000));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
