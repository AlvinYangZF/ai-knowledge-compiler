---
id: page_metadata0000
title: Metadata Journal
tags: ["storage", "metadata"]
aliases: ["journal", "metadata log"]
---
# Metadata Journal

The metadata journal records mapping changes before they are considered durable.
It protects the [[FTL Internals]] mapping table from power loss.

## Replay

On boot, replay walks committed journal records and restores the latest logical-to-physical mappings.
Checkpoint pages bound replay time.
