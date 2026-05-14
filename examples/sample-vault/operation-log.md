---
id: page_oplog0000000
title: Operation Log
tags: ["runtime", "observability"]
aliases: ["oplog"]
---
# Operation Log

The operation log records firmware decisions that are useful during incident review.
It is not the same as the metadata journal because it explains behavior instead of guaranteeing durability.

## Retrieval Use

Agent-facing runbooks can cite operation log summaries when explaining a recent storage incident.
The v0.0 search index treats these notes as normal markdown pages.
