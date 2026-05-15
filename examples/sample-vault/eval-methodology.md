---
id: page_eval00000000
title: Retrieval Eval Methodology
tags: ["eval", "retrieval"]
aliases: ["golden set"]
---
# Retrieval Eval Methodology

The golden set contains queries with must-hit pages.
Every retrieval change should run eval so line citation and recall regressions are visible.

## Metrics

The v0.0 eval reports precision at five and ten, recall at five and ten, and must-hit pass rate.
Must-hit failures should fail CI because they mean a known answer is no longer retrievable.
