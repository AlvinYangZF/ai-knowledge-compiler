---
id: page_allocator000
title: Write Allocator
tags: ["storage", "allocator"]
aliases: ["write pointer"]
---
# Write Allocator

The write allocator chooses the next open block for host and internal writes.
It considers free block watermarks, wear leveling pressure, and open block limits.

## Allocation Inputs

The allocator receives signals from [[Wear Leveling]], [[Garbage Collection Strategy]], and host queue depth.
It must avoid using blocks that are reserved for emergency garbage collection.
