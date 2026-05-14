---
id: page_wear00000000
title: Wear Leveling
tags: ["storage", "endurance"]
aliases: ["endurance balancing"]
---
# Wear Leveling

Wear leveling spreads erase cycles across blocks so no small set of blocks fails early.
Static wear leveling occasionally moves cold data away from blocks with low erase counts.

## Interaction With GC

Garbage collection optimizes free space, while wear leveling optimizes lifetime.
The allocator needs both signals before selecting the next write block.
