export {
  type ChunkingOptions,
  chunkByHeaders,
  estimateTokens,
} from "./chunking.js";
export {
  assertSchemaCompatible,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from "./schema.js";
export {
  openIndex,
  SearchIndex,
  type SearchIndexOptions,
  type SearchOptions,
  type UpsertPageOptions,
} from "./search-index.js";
export type { Chunk, PageRow, RebuildResult, UpsertResult } from "./types.js";
