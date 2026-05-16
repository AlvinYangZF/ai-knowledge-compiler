import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendConfidenceEvent,
  ConfidenceProjection,
  computeConfidenceState,
  ledgerPathForPage,
  loadConfidenceEvents,
  parseConfidenceEvent,
} from "../src/index.js";

describe("confidence ledger", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "akb-confidence-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores page ledger events as append-only JSONL next to markdown pages", () => {
    const event = parseConfidenceEvent({
      id: "evt_000000000001",
      kind: "source_added",
      pageId: "page_conf00000000",
      timestamp: "2026-05-15T12:00:00.000Z",
      actor: "system",
      actorId: "akb-ingest",
      sourceId: "src_000000000001",
      sourceWeight: 0.8,
    });

    const path = appendConfidenceEvent(dir, "pages/storage/gc.md", event);
    const contents = readFileSync(path, "utf8").trim().split("\n");

    expect(path).toBe(
      join(dir, "pages", "storage", ".page_conf00000000.ledger.jsonl"),
    );
    expect(contents).toHaveLength(1);
    expect(
      loadConfidenceEvents(dir, "pages/storage/gc.md", event.pageId),
    ).toEqual([event]);
  });

  it("rejects unverifiable agent verified events without actorId", () => {
    expect(() =>
      parseConfidenceEvent({
        id: "evt_000000000002",
        kind: "verified",
        pageId: "page_conf00000000",
        timestamp: "2026-05-15T12:00:00.000Z",
        actor: "agent",
        verifierType: "agent",
      }),
    ).toThrow("actorId");
  });

  it("computes explainable confidence state from events", () => {
    const state = computeConfidenceState(
      [
        parseConfidenceEvent({
          id: "evt_000000000001",
          kind: "source_added",
          pageId: "page_conf00000000",
          timestamp: "2026-05-01T12:00:00.000Z",
          actor: "system",
          actorId: "akb-ingest",
          sourceId: "src_000000000001",
          sourceWeight: 1,
        }),
        parseConfidenceEvent({
          id: "evt_000000000002",
          kind: "verified",
          pageId: "page_conf00000000",
          timestamp: "2026-05-05T12:00:00.000Z",
          actor: "human",
          verifierType: "human",
          verifierId: "alvin",
        }),
        parseConfidenceEvent({
          id: "evt_000000000003",
          kind: "contradicted_by",
          pageId: "page_conf00000000",
          timestamp: "2026-05-10T12:00:00.000Z",
          actor: "agent",
          actorId: "akb-compile",
          bySourceId: "src_000000000002",
          severity: "minor",
        }),
      ],
      { now: new Date("2026-05-15T12:00:00.000Z"), pageType: "note" },
    );

    expect(state.pageId).toBe("page_conf00000000");
    expect(state.sourceCount).toBe(1);
    expect(state.contradictionCount).toBe(1);
    expect(state.lastVerifiedAt).toBe("2026-05-05T12:00:00.000Z");
    expect(state.score).toBeGreaterThan(0.7);
    expect(state.explanation.sourceStrength).toBeGreaterThan(0);
    expect(state.explanation.contradictionPenalty).toBe(0.1);
  });

  it("builds stable ledger paths for page paths", () => {
    expect(ledgerPathForPage(dir, "pages/gc.md", "page_conf00000000")).toBe(
      join(dir, "pages", ".page_conf00000000.ledger.jsonl"),
    );
  });

  it("rebuilds SQLite confidence projection tables from canonical events", () => {
    const event = parseConfidenceEvent({
      id: "evt_project00001",
      kind: "source_added",
      pageId: "page_project00001",
      timestamp: "2026-05-01T12:00:00.000Z",
      actor: "system",
      actorId: "akb-test",
      sourceId: "src_project00001",
      sourceWeight: 0.2,
    });
    const state = computeConfidenceState([event], {
      now: new Date("2026-05-15T12:00:00.000Z"),
    });
    const projection = new ConfidenceProjection({
      dbPath: join(dir, "index.db"),
    });

    try {
      const result = projection.rebuild([
        {
          pageId: event.pageId,
          events: [event],
          state,
        },
      ]);
      const states = projection.getStates([event.pageId]);
      const events = projection.getEvents(event.pageId);

      expect(result).toEqual({ pages: 1, events: 1 });
      expect(states.get(event.pageId)).toMatchObject({
        score: state.score,
        lastEventAt: event.timestamp,
      });
      expect(events).toEqual([event]);
    } finally {
      projection.close();
    }
  });
});
