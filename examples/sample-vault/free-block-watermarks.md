---
id: page_watermark000
title: Free Block Watermarks
tags: ["storage", "gc", "policy"]
aliases: ["free block pool"]
---
# Free Block Watermarks

Free block watermarks decide when background garbage collection should start.
The low watermark protects foreground writes from waiting on block reclamation.

## Watermark Levels

The high watermark stops background reclaim.
The low watermark starts reclaim, and the critical watermark can throttle host writes.
