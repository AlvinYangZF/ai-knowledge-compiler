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
    type: z.enum(["note", "concept", "design"]).optional(),
    tags: z.array(z.string()).default([]),
    aliases: z.array(z.string()).default([]),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    imported_at: z.string().optional(),
    source_path: z.string().optional(),
    source_hash: z.string().optional(),
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
});

export type Config = z.infer<typeof ConfigSchema>;
