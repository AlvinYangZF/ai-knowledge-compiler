import { createHash, randomBytes } from "node:crypto";
import { basename, extname } from "node:path";
import type { Page, PageId } from "@akb/core";
import matter from "gray-matter";
import type { Root } from "mdast";
import { remark } from "remark";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  bodyStartLine: number;
  ast: Root;
}

export interface EnsureFrontmatterOptions {
  sourcePath?: string;
  tags?: string[];
  now?: Date;
}

export function parseMarkdown(content: string): ParsedMarkdown {
  const parsed = matter(content);
  return {
    frontmatter: parsed.data ?? {},
    body: parsed.content,
    bodyStartLine: getBodyStartLine(content),
    ast: remark().parse(parsed.content),
  };
}

export function generatePageId(): PageId {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(12);
  let suffix = "";
  for (const byte of bytes) {
    suffix += alphabet[byte % alphabet.length];
  }
  return `page_${suffix}` as PageId;
}

export function extractTitle(
  content: string,
  fallbackPath = "Untitled",
): string {
  const { body } = parseMarkdown(content);
  const heading = body
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
    .find((title): title is string => Boolean(title));
  if (heading) {
    return heading;
  }

  const base = basename(fallbackPath);
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return stem || "Untitled";
}

export function ensureFrontmatter(
  content: string,
  defaults: Partial<Page["frontmatter"]> = {},
  opts: EnsureFrontmatterOptions = {},
): string {
  const parsed = parseMarkdown(content);
  const now = opts.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const merged: Record<string, unknown> = {
    id: generatePageId(),
    title: extractTitle(content, opts.sourcePath),
    created_at: date,
    updated_at: date,
    imported_at: now.toISOString(),
    source_hash: sourceHash(content),
    ...defaults,
    ...parsed.frontmatter,
  };

  if (opts.sourcePath && merged.source_path === undefined) {
    merged.source_path = opts.sourcePath;
  }

  const tags = new Set<string>();
  for (const tag of toStringArray(defaults.tags)) {
    tags.add(tag);
  }
  for (const tag of toStringArray(parsed.frontmatter.tags)) {
    tags.add(tag);
  }
  for (const tag of opts.tags ?? []) {
    tags.add(tag);
  }
  if (tags.size > 0) {
    merged.tags = [...tags];
  }
  if (merged.aliases === undefined) {
    merged.aliases = [];
  }

  return `${matter.stringify(parsed.body, merged).trimEnd()}\n`;
}

export function sourceHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function getBodyStartLine(content: string): number {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return 1;
  }
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "---" || trimmed === "...") {
      return index + 2;
    }
  }
  return 1;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}
