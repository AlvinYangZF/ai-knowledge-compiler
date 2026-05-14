---
id: page_writeamp0000
title: Write Amplification
tags: ["storage", "performance"]
aliases: ["WA"]
---
# Write Amplification

Write amplification compares NAND writes against host writes.
Garbage collection and wear leveling both add internal writes, so the firmware tracks them separately.

## Measurement

The metric is most useful when reported with workload shape and free block pressure.
Short bursts can look efficient even when long steady-state behavior is poor.
