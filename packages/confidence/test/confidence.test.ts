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

  it("requires actorId for verification and contradiction events", () => {
    expect(() =>
      parseConfidenceEvent({
        id: "evt_000000000003",
        kind: "verified",
        pageId: "page_conf00000000",
        timestamp: "2026-05-15T12:00:00.000Z",
        actor: "human",
        verifierType: "human",
      }),
    ).toThrow("actorId");

    expect(() =>
      parseConfidenceEvent({
        id: "evt_000000000004",
        kind: "contradicted_by",
        pageId: "page_conf00000000",
        timestamp: "2026-05-15T12:00:00.000Z",
        actor: "system",
        bySourceId: "src_000000000001",
        severity: "major",
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
          actorId: "human:alvin@example.com",
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
    expect(state.score).toBeGreaterThan(0.6);
    expect(state.explanation.sourceStrength).toBeGreaterThan(0);
    expect(state.explanation.contradictionPenalty).toBe(0.1);
    expect(state.explanation.verificationBoost).toBe(0.05);
  });

  it("caps superseded page confidence at historical confidence", () => {
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
          timestamp: "2026-05-02T12:00:00.000Z",
          actor: "human",
          actorId: "human:local",
          verifierType: "human",
          verifierId: "human:local",
        }),
        parseConfidenceEvent({
          id: "evt_000000000003",
          kind: "superseded_by",
          pageId: "page_conf00000000",
          timestamp: "2026-05-03T12:00:00.000Z",
          actor: "human",
          actorId: "human:local",
          supersederPageId: "page_conf00000001",
        }),
      ],
      { now: new Date("2026-05-04T00:00:00.000Z") },
    );

    expect(state.supersededBy).toBe("page_conf00000001");
    expect(state.score).toBeLessThanOrEqual(0.3);
  });

  it("weights verification boost by actor identity", () => {
    const source = parseConfidenceEvent({
      id: "evt_verifywt0001",
      kind: "source_added",
      pageId: "page_verifywt0001",
      timestamp: "2026-05-01T12:00:00.000Z",
      actor: "system",
      actorId: "akb-ingest",
      sourceId: "src_verifywt0001",
      sourceWeight: 0.1,
    });
    const ciVerified = parseConfidenceEvent({
      id: "evt_verifywt0002",
      kind: "verified",
      pageId: "page_verifywt0001",
      timestamp: "2026-05-02T12:00:00.000Z",
      actor: "system",
      actorId: "ci:github-actions",
      verifierType: "agent",
      verifierId: "ci:github-actions",
    });
    const humanVerified = parseConfidenceEvent({
      id: "evt_verifywt0003",
      kind: "verified",
      pageId: "page_verifywt0001",
      timestamp: "2026-05-03T12:00:00.000Z",
      actor: "human",
      actorId: "human:alvin@example.com",
      verifierType: "human",
      verifierId: "alvin@example.com",
    });

    const ciState = computeConfidenceState([source, ciVerified], {
      now: new Date("2026-05-04T12:00:00.000Z"),
    });
    const humanState = computeConfidenceState([source, humanVerified], {
      now: new Date("2026-05-04T12:00:00.000Z"),
    });

    const combinedState = computeConfidenceState(
      [source, ciVerified, humanVerified],
      {
        now: new Date("2026-05-04T12:00:00.000Z"),
      },
    );
    const unpatternedHumanState = computeConfidenceState(
      [
        source,
        parseConfidenceEvent({
          id: "evt_verifywt0004",
          kind: "verified",
          pageId: "page_verifywt0001",
          timestamp: "2026-05-03T12:00:00.000Z",
          actor: "human",
          actorId: "alvin@example.com",
          verifierType: "human",
          verifierId: "alvin@example.com",
        }),
      ],
      {
        now: new Date("2026-05-04T12:00:00.000Z"),
      },
    );

    expect(ciState.explanation.verificationBoost).toBe(0.03);
    expect(humanState.explanation.verificationBoost).toBe(0.05);
    expect(combinedState.explanation.verificationBoost).toBe(0.08);
    expect(unpatternedHumanState.explanation.verificationBoost).toBe(0.01);
    expect(humanState.score).toBeGreaterThan(ciState.score);
  });

  it("applies short reset windows to repeated CI verification decay", () => {
    const source = parseConfidenceEvent({
      id: "evt_shortreset01",
      kind: "source_added",
      pageId: "page_shortreset01",
      timestamp: "2026-05-01T12:00:00.000Z",
      actor: "system",
      actorId: "akb-ingest",
      sourceId: "src_shortreset01",
      sourceWeight: 0.1,
    });
    const firstCi = parseConfidenceEvent({
      id: "evt_shortreset02",
      kind: "verified",
      pageId: "page_shortreset01",
      timestamp: "2026-05-02T12:00:00.000Z",
      actor: "system",
      actorId: "ci:github-actions",
      verifierType: "agent",
      verifierId: "ci:github-actions",
    });
    const repeatedCi = parseConfidenceEvent({
      id: "evt_shortreset03",
      kind: "verified",
      pageId: "page_shortreset01",
      timestamp: "2026-05-03T12:00:00.000Z",
      actor: "system",
      actorId: "ci:github-actions",
      verifierType: "agent",
      verifierId: "ci:github-actions",
    });

    const state = computeConfidenceState([source, firstCi, repeatedCi], {
      now: new Date("2026-06-01T12:00:00.000Z"),
    });
    const firstOnlyState = computeConfidenceState([source, firstCi], {
      now: new Date("2026-06-01T12:00:00.000Z"),
    });

    expect(state.lastVerifiedAt).toBe("2026-05-02T12:00:00.000Z");
    expect(state.lastEventAt).toBe("2026-05-03T12:00:00.000Z");
    expect(state.explanation.timeDecay).toBe(
      firstOnlyState.explanation.timeDecay,
    );
    expect(state.explanation.verificationBoost).toBe(0.06);
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
