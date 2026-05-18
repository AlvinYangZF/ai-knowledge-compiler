import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type {
  DiscoverIngestOptions,
  DiscoverIngestResult,
  IngestSource,
  IngestSourceKind,
} from "./types.js";

const markdownExtensions = new Set([".md", ".markdown"]);
const textExtensions = new Set([".txt", ".text", ".log"]);
const documentExtensions = new Set([
  ".pdf",
  ".docx",
  ".doc",
  ".html",
  ".htm",
  ".rtf",
  ".odt",
]);
const codeExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const ignoredDirectories = new Set([
  ".akb",
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

export function discoverIngestSources(
  inputPath: string,
  options: DiscoverIngestOptions,
): DiscoverIngestResult {
  if (!existsSync(inputPath)) {
    throw new Error(`Path does not exist: ${inputPath}`);
  }
  const stat = statSync(inputPath);
  const root = stat.isDirectory() ? inputPath : inputPath;
  const skipped: Array<{ path: string; reason: string }> = [];
  const sources = stat.isDirectory()
    ? discoverDirectory(inputPath, inputPath, options, skipped)
    : sourceForFile(inputPath, basename(inputPath), options, skipped);

  return {
    sources: sources.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    skipped: skipped.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function targetMarkdownPath(source: Pick<IngestSource, "relativePath" | "kind" | "extension">): string {
  const relativePath = toPosix(source.relativePath);
  if (source.kind === "markdown") {
    return source.extension === ".markdown"
      ? `${relativePath.slice(0, -".markdown".length)}.md`
      : relativePath;
  }
  return `${relativePath}.md`;
}

export function classifyIngestExtension(
  extension: string,
): IngestSourceKind | undefined {
  const normalized = extension.toLowerCase();
  if (markdownExtensions.has(normalized)) {
    return "markdown";
  }
  if (textExtensions.has(normalized)) {
    return "text";
  }
  if (documentExtensions.has(normalized)) {
    return "document";
  }
  if (codeExtensions.has(normalized)) {
    return "code";
  }
  return undefined;
}

export function isSupportedCodeExtension(extension: string): boolean {
  return codeExtensions.has(extension.toLowerCase());
}

function discoverDirectory(
  root: string,
  directory: string,
  options: DiscoverIngestOptions,
  skipped: Array<{ path: string; reason: string }>,
): IngestSource[] {
  const sources: IngestSource[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!options.includeHidden && isHiddenName(entry.name)) {
      continue;
    }
    const next = join(directory, entry.name);
    const relativePath = toPosix(relative(root, next));
    if (entry.isDirectory()) {
      if (
        options.recursive &&
        !ignoredDirectories.has(entry.name) &&
        (options.includeHidden || !isHiddenName(entry.name))
      ) {
        sources.push(...discoverDirectory(root, next, options, skipped));
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    sources.push(...sourceForFile(next, relativePath, options, skipped));
  }
  return sources;
}

function sourceForFile(
  absolutePath: string,
  relativePath: string,
  options: DiscoverIngestOptions,
  skipped: Array<{ path: string; reason: string }>,
): IngestSource[] {
  if (!options.includeHidden && isHiddenName(basename(absolutePath))) {
    return [];
  }
  const extension = extname(absolutePath).toLowerCase();
  const kind = classifyIngestExtension(extension);
  if (!kind) {
    skipped.push({ path: toPosix(relativePath), reason: "unsupported extension" });
    return [];
  }
  if (kind === "code" && !options.includeCode) {
    return [];
  }
  if ((kind === "document" || kind === "text") && !options.includeDocuments) {
    return [];
  }
  return [
    {
      absolutePath,
      relativePath: toPosix(relativePath),
      extension,
      kind,
    },
  ];
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}
