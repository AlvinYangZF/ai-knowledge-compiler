import { z } from "zod";

export type PageId = string & { readonly __brand: "PageId" };

export const PageIdSchema = z
  .string()
  .regex(/^page_[a-z0-9]{12}$/)
  .transform((value) => value as PageId);

export const PageFrontmatterSchema = z
  .object({
    id: PageIdSchema,
    title: z.string().min(1),
    type: z
      .enum([
        "note",
        "concept",
        "design",
        "decision",
        "architecture",
        "module",
        "runbook",
        "meeting",
        "api",
      ])
      .optional(),
    tags: z.array(z.string()).default([]),
    aliases: z.array(z.string()).default([]),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    imported_at: z.string().optional(),
    source_path: z.string().optional(),
    source_hash: z.string().optional(),
    source_type: z.string().min(1).optional(),
    source_subtype: z.string().min(1).optional(),
    source_url: z.string().optional(),
  })
  .passthrough();

export type PageFrontmatter = z.infer<typeof PageFrontmatterSchema>;

export const PageSchema = z.object({
  id: PageIdSchema,
  path: z.string().min(1),
  title: z.string().min(1),
  frontmatter: PageFrontmatterSchema,
});

export type Page = z.infer<typeof PageSchema>;

export interface Citation {
  line_start: number;
  line_end: number;
}

export interface SearchResult {
  page_id: PageId;
  path: string;
  title: string;
  score: number;
  snippet: string;
  citation: Citation;
}

const LlmProviderSchema = z.enum(["deepseek", "openai", "anthropic"]);

function llmDefaults(provider: z.infer<typeof LlmProviderSchema>): {
  base_url: string;
  model: string;
} {
  if (provider === "openai") {
    return {
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    };
  }
  if (provider === "anthropic") {
    return {
      base_url: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-20250514",
    };
  }
  return {
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  };
}

const LlmConfigSchema = z
  .object({
    provider: LlmProviderSchema.default("deepseek"),
    base_url: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
    api_key_env: z.string().min(1).optional(),
  })
  .transform((value) => {
    const defaults = llmDefaults(value.provider);
    return {
      ...value,
      base_url: value.base_url ?? defaults.base_url,
      model: value.model ?? defaults.model,
    };
  });

export const ConfigSchema = z.object({
  version: z.literal("0.0"),
  workspace: z.object({
    name: z.string().min(1),
    vault_dir: z.string().min(1),
  }),
  index: z.object({
    engine: z.literal("sqlite-fts5"),
    path: z.string().min(1),
  }),
  mcp: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
  }),
  sources: z
    .object({
      authority_domains: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  llm: LlmConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
