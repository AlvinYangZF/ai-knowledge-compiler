export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA user_version = ${SCHEMA_VERSION};

CREATE TABLE IF NOT EXISTS pages (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    frontmatter     TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    body_start_line INTEGER NOT NULL,
    indexed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    id UNINDEXED,
    title,
    body,
    tags,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS chunks (
    id              TEXT PRIMARY KEY,
    page_id         TEXT NOT NULL,
    idx             INTEGER NOT NULL,
    line_start      INTEGER NOT NULL,
    line_end        INTEGER NOT NULL,
    text            TEXT NOT NULL,
    token_count     INTEGER NOT NULL,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    id UNINDEXED,
    page_id UNINDEXED,
    text,
    tokenize='unicode61 remove_diacritics 2'
);
`;

export function assertSchemaCompatible(actual: number): void {
  if (actual === 0) {
    return;
  }
  if (actual !== SCHEMA_VERSION) {
    throw new Error(
      `Schema version mismatch: db is v${actual}, code expects v${SCHEMA_VERSION}. ` +
        "Run 'akb index --rebuild' to recreate the index.",
    );
  }
}
