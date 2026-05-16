import type { PageId } from "@akb/core";

export interface Chunk {
  id: string;
  pageId: PageId;
  index: number;
  lineStart: number;
  lineEnd: number;
  text: string;
  tokenCount: number;
  origin: ChunkOrigin;
}

export type ChunkOrigin =
  | { kind: "verbatim" }
  | {
      kind: "derived";
      derivedFrom: DerivedFrom;
    };

export interface DerivedFrom {
  sourceUnitIds: string[];
  sourceChunkIds: string[];
  method: CompileMethod;
  compiledAt: string;
  patchId: string;
  promptHash: string;
  modelId: string;
}

export type CompileMethod =
  | "segment"
  | "extend"
  | "merge"
  | "contradict"
  | "supersede"
  | "summary";

export interface ChunkLineageRow {
  chunkId: string;
  sourceUnitId: string | null;
  sourceChunkId: string | null;
  method: CompileMethod;
  patchId: string;
  promptHash: string;
  modelId: string;
  compiledAt: string;
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
