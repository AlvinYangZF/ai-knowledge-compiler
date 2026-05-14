---
id: page_readretry000
title: Read Retry
tags: ["storage", "nand", "reliability"]
aliases: ["read threshold retry"]
---
# Read Retry

Read retry adjusts NAND read thresholds after an initial read fails correction.
It is slower than a normal read but can recover data with shifted threshold distributions.

## Interaction With ECC

The ECC engine reports correction margin.
Low margin can trigger refresh or relocation through [[Bad Block Management]].
