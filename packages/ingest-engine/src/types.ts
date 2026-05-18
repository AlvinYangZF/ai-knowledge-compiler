export type IngestSourceKind = "markdown" | "document" | "text" | "code";

export type ConverterMode = "auto" | "builtin" | "external";

export interface IngestSource {
  absolutePath: string;
  relativePath: string;
  extension: string;
  kind: IngestSourceKind;
}

export interface DiscoverIngestOptions {
  recursive: boolean;
  includeHidden: boolean;
  includeDocuments: boolean;
  includeCode: boolean;
}

export interface DiscoverIngestResult {
  sources: IngestSource[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface ConvertedMarkdown {
  markdown: string;
  title?: string;
  sourceType: string;
  sourceSubtype?: string;
  converter: {
    name: string;
    version?: string;
    mode: "builtin" | "external";
  };
  warnings: string[];
  metadata: Record<string, string | number | boolean | string[]>;
  rawHash: string;
}

export type ConvertResult =
  | { ok: true; value: ConvertedMarkdown }
  | { ok: false; error: string; warnings: string[] };

export interface CommandRunResult {
  ok: boolean;
  stdout?: string;
  error?: string;
}

export interface CommandRunner {
  run(command: string, args: string[]): CommandRunResult;
}

export interface ConvertOptions {
  mode: ConverterMode;
  commandRunner?: CommandRunner;
}
