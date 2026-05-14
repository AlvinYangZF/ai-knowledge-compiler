---
id: page_ecc000000000
title: ECC Pipeline
tags: ["storage", "reliability"]
aliases: ["error correction"]
---
# ECC Pipeline

The ECC pipeline detects and corrects bit errors from NAND reads.
Correction counts are also a health signal for refresh and bad block retirement.

## Telemetry

The firmware records correction strength, retry count, and final read status.
Those values help explain why [[Read Retry]] was needed.
