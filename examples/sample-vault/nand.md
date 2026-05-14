---
id: page_nand00000000
title: NAND Basics
tags: ["storage", "nand"]
aliases: ["flash media"]
---
# NAND Basics

NAND flash is programmed in pages and erased in blocks.
An overwrite requires writing a new physical page and invalidating the old location.

## Erase Blocks

Erase operations are slower and more damaging than page reads or page programs.
This asymmetry is why the FTL batches invalid pages for garbage collection.
