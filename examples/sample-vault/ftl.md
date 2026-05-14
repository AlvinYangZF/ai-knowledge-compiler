---
id: page_ftl000000000
title: FTL Internals
tags: ["storage", "ftl"]
aliases: ["flash translation layer"]
---
# FTL Internals

The flash translation layer maps logical pages to physical NAND locations.
It owns the mapping cache and coordinates garbage collection with write allocation.

## Mapping Cache

The mapping cache stores hot logical-to-physical entries in memory.
Cold mappings can be fetched from NAND metadata pages when cache pressure rises.
