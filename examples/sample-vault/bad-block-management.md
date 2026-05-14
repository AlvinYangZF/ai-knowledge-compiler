---
id: page_badblock0000
title: Bad Block Management
tags: ["storage", "nand", "reliability"]
aliases: ["bad block table", "BBT"]
---
# Bad Block Management

The firmware keeps a bad block table for factory-marked and runtime-failed erase blocks.
Blocks with repeated program or erase failures are retired before they affect host data.

## Runtime Handling

When ECC margin drops below policy, the block is queued for data relocation.
This works with [[Garbage Collection Strategy]] because relocation already knows how to move valid pages.
