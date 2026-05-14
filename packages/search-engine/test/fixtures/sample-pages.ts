import type { Page } from "@akb/core";

function page(id: string, path: string, title: string, tags: string[]): Page {
  return {
    id: id as never,
    path,
    title,
    frontmatter: {
      id: id as never,
      title,
      tags,
      aliases: [],
    },
  };
}

export const samplePages = {
  gc: {
    page: page(
      "page_gc1234567890",
      "pages/storage/gc.md",
      "Garbage Collection Strategy",
      ["storage", "gc"],
    ),
    body: [
      "# Garbage Collection Strategy",
      "",
      "The firmware uses greedy garbage collection when free block count drops.",
      "FIFO collection is kept as a fallback for cold data movement.",
      "",
      "## Trigger Policy",
      "",
      "GC is triggered when spare blocks fall under the watermark.",
    ].join("\n"),
  },
  ftl: {
    page: page("page_ftl123456789", "pages/storage/ftl.md", "FTL Internals", [
      "storage",
      "ftl",
    ]),
    body: [
      "# FTL Internals",
      "",
      "The flash translation layer maps logical pages to NAND locations.",
      "",
      "## Mapping Cache",
      "",
      "The mapping cache stores hot logical-to-physical entries.",
    ].join("\n"),
  },
};
