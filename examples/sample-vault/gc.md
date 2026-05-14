---
id: page_gc0000000000
title: Garbage Collection Strategy
tags: ["storage", "gc"]
aliases: ["GC", "block reclamation"]
---
# Garbage Collection Strategy

The firmware uses greedy garbage collection when free block count drops below the low watermark.
Victim blocks are ranked by valid page count so the controller moves the least live data first.

## Trigger Policy

Garbage collection starts before the free block pool is empty.
The trigger is intentionally conservative because foreground writes must not wait on long reclaim work.

## Related Pages

See [[FTL Internals]] and [[Wear Leveling]] for the mapping and endurance trade-offs.
