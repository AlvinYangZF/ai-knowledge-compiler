---
id: page_checkpoint00
title: Checkpointing
tags: ["storage", "metadata"]
aliases: ["mapping checkpoint"]
---
# Checkpointing

Checkpointing writes compact mapping state so boot replay does not scan the entire metadata journal.
It is a latency optimization for recovery.

## Cadence

The cadence balances extra NAND writes against boot-time replay cost.
Large checkpoint intervals reduce write amplification but increase recovery work.
