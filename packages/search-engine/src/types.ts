import type { PageId } from "@akb/core";

export interface Chunk {
  id: string;
  pageId: PageId;
  index: number;
  lineStart: number;
  lineEnd: number;
  text: string;
  tokenCount: number;
}

export interface PageRow {
  id: string;
  path: string;
  title: string;
  frontmatter: string;
  content_hash: string;
  body_start_line: number;
  indexed_at: string;
}

export interface UpsertResult {
  pageId: PageId;
  action: "inserted" | "updated" | "unchanged";
  chunkCount: number;
  elapsedMs: number;
}

export interface RebuildResult {
  totalPages: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  elapsedMs: number;
}
