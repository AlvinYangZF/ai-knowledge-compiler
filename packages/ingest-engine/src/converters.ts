import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type {
  CommandRunner,
  ConvertOptions,
  ConvertResult,
  ConvertedMarkdown,
  IngestSource,
} from "./types.js";

const defaultRunner: CommandRunner = {
  run(command, args) {
    try {
      const stdout = execFileSync(command, args, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return { ok: true, stdout };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `failed to run ${command}`;
      return { ok: false, error: message };
    }
  },
};

export async function convertIngestSource(
  source: IngestSource,
  options: ConvertOptions,
): Promise<ConvertResult> {
  const raw = readFileSync(source.absolutePath);
  const rawHash = rawSourceHash(raw);
  try {
    if (source.kind === "markdown") {
      return ok(convertMarkdown(source, raw, rawHash));
    }
    if (source.kind === "text") {
      return ok(convertText(source, raw, rawHash));
    }
    if (source.kind === "code") {
      return ok(convertCode(source, raw, rawHash));
    }
    return convertDocument(source, rawHash, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "conversion failed";
    return { ok: false, error: message, warnings: [] };
  }
}

export function rawSourceHash(raw: Buffer): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function convertMarkdown(
  source: IngestSource,
  raw: Buffer,
  rawHash: string,
): ConvertedMarkdown {
  const markdown = decodeUtf8(raw, source.relativePath);
  return {
    markdown,
    title: firstMarkdownTitle(markdown) ?? titleFromPath(source.relativePath),
    sourceType: "markdown",
    converter: { name: "markdown-pass-through", mode: "builtin" },
    warnings: [],
    metadata: {},
    rawHash,
  };
}

function convertText(
  source: IngestSource,
  raw: Buffer,
  rawHash: string,
): ConvertedMarkdown {
  const text = decodeUtf8(raw, source.relativePath).trimEnd();
  const title = titleFromPath(source.relativePath);
  return {
    markdown: `# ${title}\n\n${text}\n`,
    title,
    sourceType: source.extension === ".log" ? "text" : source.extension.slice(1),
    sourceSubtype: source.extension === ".log" ? "log" : undefined,
    converter: { name: "text-reader", mode: "builtin" },
    warnings: [],
    metadata: { line_count: countLines(text) },
    rawHash,
  };
}

function convertCode(
  source: IngestSource,
  raw: Buffer,
  rawHash: string,
): ConvertedMarkdown {
  const code = decodeUtf8(raw, source.relativePath).trimEnd();
  const language = codeLanguage(source.extension);
  const metadata = codeMetadata(code, source.extension);
  const title = source.relativePath;
  const lines = [
    `# ${title}`,
    "",
    "## Code Metadata",
    "",
    `- Language: ${language}`,
    `- Lines: ${countLines(code)}`,
  ];
  appendList(lines, "Includes", metadata.includes);
  appendList(lines, "Imports", metadata.imports);
  appendList(lines, "Functions", metadata.functions);
  lines.push("", "## Source", "", `${fenceFor(code)}${language}`, code, fenceFor(code), "");
  return {
    markdown: lines.join("\n"),
    title,
    sourceType: "code",
    sourceSubtype: language,
    converter: { name: "code-reader", mode: "builtin" },
    warnings: [],
    metadata: {
      code_language: language,
      line_count: countLines(code),
      includes: metadata.includes,
      imports: metadata.imports,
      functions: metadata.functions,
      export_count: metadata.exportCount,
    },
    rawHash,
  };
}

function convertDocument(
  source: IngestSource,
  rawHash: string,
  options: ConvertOptions,
): ConvertResult {
  if (options.mode === "builtin") {
    return {
      ok: false,
      error: `No converter available for ${source.extension} in builtin mode`,
      warnings: [],
    };
  }
  const runner = options.commandRunner ?? defaultRunner;
  const attempts = documentAttempts(source);
  const errors: string[] = [];
  for (const attempt of attempts) {
    const result = runner.run(attempt.command, attempt.args);
    if (result.ok && result.stdout && result.stdout.trim().length > 0) {
      const markdown = documentMarkdown(source, result.stdout);
      return ok({
        markdown,
        title: titleFromPath(source.relativePath),
        sourceType: sourceTypeForDocument(source.extension),
        sourceSubtype: sourceSubtypeForDocument(source.extension),
        converter: {
          name: attempt.command,
          mode: "external",
        },
        warnings: [],
        metadata: { original_extension: source.extension },
        rawHash,
      });
    }
    errors.push(`${attempt.command}: ${result.error ?? "empty output"}`);
  }
  return {
    ok: false,
    error: `No converter available for ${source.relativePath}. Tried ${attempts
      .map((attempt) => attempt.command)
      .join(", ")}. ${errors.join("; ")}`,
    warnings: [],
  };
}

function documentAttempts(source: IngestSource): Array<{
  command: string;
  args: string[];
}> {
  if (source.extension === ".pdf") {
    return [{ command: "pdftotext", args: ["-layout", source.absolutePath, "-"] }];
  }
  const attempts = [
    {
      command: "pandoc",
      args: [source.absolutePath, "-t", "gfm", "--wrap=none"],
    },
  ];
  if ([".doc", ".docx", ".html", ".htm", ".rtf", ".odt"].includes(source.extension)) {
    attempts.push({
      command: "textutil",
      args: ["-convert", "txt", "-stdout", source.absolutePath],
    });
  }
  return attempts;
}

function documentMarkdown(source: IngestSource, stdout: string): string {
  const title = titleFromPath(source.relativePath);
  const text = stdout.trimEnd();
  if (source.extension !== ".pdf") {
    return text.startsWith("# ") ? `${text}\n` : `# ${title}\n\n${text}\n`;
  }
  const pages = text.split("\f");
  const lines = [`# ${title}`, ""];
  pages.forEach((page, index) => {
    const pageText = page.trim();
    if (pageText.length === 0) {
      return;
    }
    lines.push(`<!-- page ${index + 1} -->`, "", pageText, "");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function ok(value: ConvertedMarkdown): ConvertResult {
  return { ok: true, value };
}

function decodeUtf8(raw: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error(`Unreadable UTF-8 source: ${path}`);
  }
}

function firstMarkdownTitle(markdown: string): string | undefined {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
    .find((title): title is string => Boolean(title));
}

function titleFromPath(path: string): string {
  const base = basename(path);
  const extension = extname(base);
  return extension ? base.slice(0, -extension.length) : base;
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

function codeLanguage(extension: string): string {
  const normalized = extension.toLowerCase();
  if ([".c", ".h"].includes(normalized)) {
    return "c";
  }
  if ([".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"].includes(normalized)) {
    return "cpp";
  }
  if ([".ts", ".mts", ".cts"].includes(normalized)) {
    return "ts";
  }
  if (normalized === ".tsx") {
    return "tsx";
  }
  if ([".js", ".mjs", ".cjs"].includes(normalized)) {
    return "js";
  }
  if (normalized === ".jsx") {
    return "jsx";
  }
  return normalized.replace(/^\./, "") || "text";
}

function codeMetadata(code: string, extension: string): {
  includes: string[];
  imports: string[];
  functions: string[];
  exportCount: number;
} {
  const language = codeLanguage(extension);
  if (language === "c" || language === "cpp") {
    return {
      includes: uniqueMatches(code, /^\s*#\s*include\s+[<"]([^>"]+)[>"]/gm),
      imports: [],
      functions: uniqueMatches(
        code,
        /^\s*(?:[A-Za-z_][\w\s:*&<>~]*\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/gm,
      ).filter((name) => !["if", "for", "while", "switch"].includes(name)),
      exportCount: 0,
    };
  }
  if (["js", "jsx", "ts", "tsx", "mts", "cts"].includes(language)) {
    return {
      includes: [],
      imports: extractJsImports(code),
      functions: [],
      exportCount: (code.match(/^\s*export\s+/gm) ?? []).length,
    };
  }
  return { includes: [], imports: [], functions: [], exportCount: 0 };
}

function uniqueMatches(code: string, pattern: RegExp): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const match of code.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

function extractJsImports(code: string): string[] {
  const specifiers: string[] = [];
  const seen = new Set<string>();
  const importPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of code.matchAll(importPattern)) {
    const value = match[1]?.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      specifiers.push(value);
    }
  }
  const requirePattern = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of code.matchAll(requirePattern)) {
    const value = match[1]?.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      specifiers.push(value);
    }
  }
  return specifiers;
}

function appendList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }
  lines.push(`- ${label}:`);
  for (const value of values) {
    lines.push(`  - ${value}`);
  }
}

function fenceFor(code: string): string {
  const longest = Math.max(
    3,
    ...[...code.matchAll(/`+/g)].map((match) => match[0].length + 1),
  );
  return "`".repeat(longest);
}

function sourceTypeForDocument(extension: string): string {
  if (extension === ".htm") {
    return "html";
  }
  return extension.replace(/^\./, "");
}

function sourceSubtypeForDocument(extension: string): string | undefined {
  return extension === ".pdf" ? undefined : sourceTypeForDocument(extension);
}
