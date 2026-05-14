import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { Page, PageId, SearchResult } from "@akb/core";
import Database from "better-sqlite3";
import { chunkByHeaders } from "./chunking.js";
import { assertSchemaCompatible, SCHEMA_SQL } from "./schema.js";
import type { PageRow, RebuildResult, UpsertResult } from "./types.js";

export interface SearchIndexOptions {
  dbPath: string;
  readonly?: boolean;
  maxChunkTokens?: number;
}

export interface SearchOptions {
  topK?: number;
  tags?: string[];
  snippetChars?: number;
}

export interface UpsertPageOptions {
  bodyStartLine?: number;
}

export class SearchIndex {
  private readonly db: Database.Database;
  private readonly maxChunkTokens: number;
  private readonly dbPath: string;

  constructor(opts: SearchIndexOptions) {
    this.dbPath = opts.dbPath;
    this.db = new Database(opts.dbPath, { readonly: opts.readonly ?? false });
    if (!opts.readonly) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
    }
    this.db.pragma("foreign_keys = ON");
    this.maxChunkTokens = opts.maxChunkTokens ?? 800;
    const currentVersion = this.db.pragma("user_version", {
      simple: true,
    }) as number;
    assertSchemaCompatible(currentVersion);
    if (!opts.readonly && currentVersion === 0) {
      this.db.exec(SCHEMA_SQL);
    }
  }

  upsertPage(
    page: Page,
    body: string,
    opts: UpsertPageOptions = {},
  ): UpsertResult {
    const startMs = performance.now();
    const bodyStartLine = opts.bodyStartLine ?? 1;
    const contentHash = pageContentHash(page, body, bodyStartLine);
    const existing = this.db
      .prepare("SELECT content_hash FROM pages WHERE id = ?")
      .get(page.id) as { content_hash: string } | undefined;

    if (existing?.content_hash === contentHash) {
      const count = this.db
        .prepare("SELECT COUNT(*) AS count FROM chunks WHERE page_id = ?")
        .get(page.id) as {
        count: number;
      };
      return {
        pageId: page.id,
        action: "unchanged",
        chunkCount: count.count,
        elapsedMs: elapsed(startMs),
      };
    }

    const chunks = chunkByHeaders(page.id, body, {
      maxTokens: this.maxChunkTokens,
      bodyStartLine,
    });
    const action: UpsertResult["action"] = existing ? "updated" : "inserted";
    const write = this.db.transaction(() => {
      this.writePage(page, body, bodyStartLine, contentHash, chunks);
    });
    write();
    return {
      pageId: page.id,
      action,
      chunkCount: chunks.length,
      elapsedMs: elapsed(startMs),
    };
  }

  deletePage(pageId: PageId): void {
    const remove = this.db.transaction(() => {
      this.db.prepare("DELETE FROM pages_fts WHERE id = ?").run(pageId);
      this.db.prepare("DELETE FROM chunks_fts WHERE page_id = ?").run(pageId);
      this.db.prepare("DELETE FROM chunks WHERE page_id = ?").run(pageId);
      this.db.prepare("DELETE FROM pages WHERE id = ?").run(pageId);
    });
    remove();
  }

  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    const topK = opts.topK ?? 10;
    const snippetChars = opts.snippetChars ?? 200;
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
        SELECT
          p.id, p.path, p.title, p.frontmatter,
          c.line_start, c.line_end, c.text,
          bm25(chunks_fts) AS rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.id
        JOIN pages p ON p.id = c.page_id
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(ftsQuery, Math.max(topK * 20, 50)) as SearchRow[];

    const results: SearchResult[] = [];
    const seenPages = new Set<string>();
    for (const row of rows) {
      if (seenPages.has(row.id)) {
        continue;
      }
      const frontmatter = JSON.parse(row.frontmatter) as { tags?: unknown };
      if (
        opts.tags?.length &&
        !intersects(
          opts.tags,
          Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
        )
      ) {
        continue;
      }
      results.push({
        page_id: row.id as PageId,
        path: row.path,
        title: row.title,
        score: row.rank < 0 ? -row.rank : 1 / (1 + row.rank),
        snippet: makeSnippet(row.text, query, snippetChars),
        citation: {
          line_start: row.line_start,
          line_end: row.line_end,
        },
      });
      seenPages.add(row.id);
      if (results.length >= topK) {
        break;
      }
    }
    return results;
  }

  rebuild(
    pages: Iterable<{ page: Page; body: string; bodyStartLine?: number }>,
  ): RebuildResult {
    const startMs = performance.now();
    const items = [...pages];
    const rebuild = this.db.transaction(() => {
      this.db.prepare("DELETE FROM chunks_fts").run();
      this.db.prepare("DELETE FROM pages_fts").run();
      this.db.prepare("DELETE FROM chunks").run();
      this.db.prepare("DELETE FROM pages").run();
      for (const item of items) {
        const bodyStartLine = item.bodyStartLine ?? 1;
        this.writePage(
          item.page,
          item.body,
          bodyStartLine,
          pageContentHash(item.page, item.body, bodyStartLine),
          chunkByHeaders(item.page.id, item.body, {
            maxTokens: this.maxChunkTokens,
            bodyStartLine,
          }),
        );
      }
    });
    rebuild();
    return {
      totalPages: items.length,
      inserted: items.length,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      elapsedMs: elapsed(startMs),
    };
  }

  listIndexedPageIds(): PageId[] {
    return (
      this.db.prepare("SELECT id FROM pages ORDER BY id").all() as Array<{
        id: string;
      }>
    ).map((row) => row.id as PageId);
  }

  getStats(): { pages: number; chunks: number; dbSizeBytes: number } {
    const pages = this.db
      .prepare("SELECT COUNT(*) AS count FROM pages")
      .get() as { count: number };
    const chunks = this.db
      .prepare("SELECT COUNT(*) AS count FROM chunks")
      .get() as { count: number };
    return {
      pages: pages.count,
      chunks: chunks.count,
      dbSizeBytes: statSync(this.dbPath).size,
    };
  }

  getPageByIdOrPath(
    pageIdOrPath: string,
  ): { page: Page; body: string; bodyStartLine: number } | undefined {
    const row = this.db
      .prepare(
        `
        SELECT p.*, f.body
        FROM pages p
        LEFT JOIN pages_fts f ON f.id = p.id
        WHERE p.id = ? OR p.path = ?
        LIMIT 1
      `,
      )
      .get(pageIdOrPath, pageIdOrPath) as
      | (PageRow & { body: string | null })
      | undefined;
    if (!row) {
      return undefined;
    }
    const frontmatter = JSON.parse(row.frontmatter) as Page["frontmatter"];
    return {
      page: {
        id: row.id as PageId,
        path: row.path,
        title: row.title,
        frontmatter,
      },
      body: row.body ?? "",
      bodyStartLine: row.body_start_line,
    };
  }

  close(): void {
    this.db.close();
  }

  private writePage(
    page: Page,
    body: string,
    bodyStartLine: number,
    contentHash: string,
    chunks: ReturnType<typeof chunkByHeaders>,
  ): void {
    this.db.prepare("DELETE FROM pages_fts WHERE id = ?").run(page.id);
    this.db.prepare("DELETE FROM chunks_fts WHERE page_id = ?").run(page.id);
    this.db.prepare("DELETE FROM chunks WHERE page_id = ?").run(page.id);
    this.db
      .prepare(
        `
        INSERT INTO pages (id, path, title, frontmatter, content_hash, body_start_line, indexed_at)
        VALUES (@id, @path, @title, @frontmatter, @content_hash, @body_start_line, @indexed_at)
        ON CONFLICT(id) DO UPDATE SET
          path = excluded.path,
          title = excluded.title,
          frontmatter = excluded.frontmatter,
          content_hash = excluded.content_hash,
          body_start_line = excluded.body_start_line,
          indexed_at = excluded.indexed_at
      `,
      )
      .run({
        id: page.id,
        path: page.path,
        title: page.title,
        frontmatter: JSON.stringify(page.frontmatter),
        content_hash: contentHash,
        body_start_line: bodyStartLine,
        indexed_at: new Date().toISOString(),
      });
    this.db
      .prepare(
        "INSERT INTO pages_fts (id, title, body, tags) VALUES (?, ?, ?, ?)",
      )
      .run(page.id, page.title, body, toTagsText(page.frontmatter.tags));

    const insertChunk = this.db.prepare(
      `
      INSERT INTO chunks (id, page_id, idx, line_start, line_end, text, token_count)
      VALUES (@id, @page_id, @idx, @line_start, @line_end, @text, @token_count)
    `,
    );
    const insertChunkFts = this.db.prepare(
      "INSERT INTO chunks_fts (id, page_id, text) VALUES (?, ?, ?)",
    );
    for (const chunk of chunks) {
      insertChunk.run({
        id: chunk.id,
        page_id: chunk.pageId,
        idx: chunk.index,
        line_start: chunk.lineStart,
        line_end: chunk.lineEnd,
        text: chunk.text,
        token_count: chunk.tokenCount,
      });
      insertChunkFts.run(chunk.id, chunk.pageId, chunk.text);
    }
  }
}

export function openIndex(dbPath: string): SearchIndex {
  return new SearchIndex({ dbPath });
}

interface SearchRow {
  id: string;
  path: string;
  title: string;
  frontmatter: string;
  line_start: number;
  line_end: number;
  text: string;
  rank: number;
}

function pageContentHash(
  page: Page,
  body: string,
  bodyStartLine: number,
): string {
  return createHash("sha256")
    .update(
      `${JSON.stringify(page.frontmatter)}\n${bodyStartLine}\n${body}`,
      "utf8",
    )
    .digest("hex");
}

function elapsed(startMs: number): number {
  return Math.max(0, Math.round((performance.now() - startMs) * 100) / 100);
}

function toFtsQuery(query: string): string {
  return [...query.matchAll(/[\p{L}\p{N}_]+/gu)]
    .map((match) => `"${match[0].replaceAll('"', '""')}"`)
    .join(" ");
}

function intersects(needles: string[], values: unknown[]): boolean {
  const set = new Set(
    values.filter((value): value is string => typeof value === "string"),
  );
  return needles.some((needle) => set.has(needle));
}

function makeSnippet(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const firstTerm = query.match(/[\p{L}\p{N}_]+/u)?.[0]?.toLowerCase();
  const index = firstTerm ? text.toLowerCase().indexOf(firstTerm) : -1;
  const start = Math.max(
    0,
    index === -1 ? 0 : index - Math.floor(maxChars / 3),
  );
  return text.slice(start, start + maxChars).trim();
}

function toTagsText(tags: unknown): string {
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === "string").join(" ")
    : "";
}
