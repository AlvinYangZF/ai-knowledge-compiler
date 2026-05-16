import type { PageId, SearchResult } from "@akb/core";
import { describe, expect, it } from "vitest";
import { rankSearchResults } from "../src/index.js";

function result(
  pageId: string,
  score: number,
  updatedAt = "2026-05-01",
): SearchResult {
  return {
    page_id: pageId as PageId,
    path: `pages/${pageId}.md`,
    title: pageId,
    score,
    snippet: `${pageId} snippet`,
    citation: { line_start: 1, line_end: 2 },
    frontmatter: { updated_at: updatedAt },
  };
}

describe("rankSearchResults", () => {
  it("reranks relevant pages using confidence without hiding low-confidence results", () => {
    const ranked = rankSearchResults({
      rawResults: [
        result("page_low0000000", 0.8),
        result("page_high000000", 0.7),
      ],
      confidenceState: new Map([
        [
          "page_low0000000" as PageId,
          {
            score: 0.2,
            supersededBy: undefined,
            lastVerifiedAt: "2026-04-01T00:00:00.000Z",
            lastEventAt: "2026-04-01T00:00:00.000Z",
          },
        ],
        [
          "page_high000000" as PageId,
          {
            score: 0.95,
            supersededBy: undefined,
            lastVerifiedAt: "2026-04-01T00:00:00.000Z",
            lastEventAt: "2026-04-01T00:00:00.000Z",
          },
        ],
      ]),
      now: new Date("2026-05-15T00:00:00.000Z"),
    });

    expect(ranked.map((item) => item.page_id)).toEqual([
      "page_high000000",
      "page_low0000000",
    ]);
    expect(ranked[1].flags).toContain("NEEDS_REVIEW");
  });

  it("filters superseded pages by default and returns them when requested", () => {
    const rawResults = [
      result("page_old0000000", 0.95),
      result("page_new0000000", 0.75),
    ];
    const confidenceState = new Map([
      [
        "page_old0000000" as PageId,
        {
          score: 0.8,
          supersededBy: "page_new0000000" as PageId,
          lastEventAt: "2026-05-01T00:00:00.000Z",
        },
      ],
      [
        "page_new0000000" as PageId,
        {
          score: 0.8,
          supersededBy: undefined,
          lastEventAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    ]);

    expect(
      rankSearchResults({ rawResults, confidenceState }).map(
        (item) => item.page_id,
      ),
    ).toEqual(["page_new0000000"]);

    const withHistory = rankSearchResults({
      rawResults,
      confidenceState,
      options: { includeSuperseded: true },
    });

    expect(withHistory.map((item) => item.page_id)).toContain(
      "page_old0000000",
    );
    expect(
      withHistory.find((item) => item.page_id === "page_old0000000")?.flags,
    ).toContain("SUPERSEDED");
  });

  it("uses neutral confidence defaults for pages without ledger state", () => {
    const ranked = rankSearchResults({
      rawResults: [result("page_plain00000", 0.5)],
      confidenceState: new Map(),
    });

    expect(ranked[0].component_scores.confidence).toBe(0.7);
    expect(ranked[0].flags).toEqual([]);
  });
});
