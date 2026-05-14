---
id: page_kvcache00000
title: KV Cache
tags: ["runtime", "cache"]
aliases: ["key value cache"]
---
# KV Cache

The key value cache keeps recently retrieved knowledge snippets in memory for repeated agent queries.
It is separate from the SQLite FTS index, which remains the persistent projection.

## Eviction

The v0.0 implementation does not include a cache eviction policy.
Runtime caching is a later optimization once retrieval quality is stable.
