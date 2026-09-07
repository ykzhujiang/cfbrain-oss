---
title: Hybrid search beats pure vector search
types: [concept]
confidence: high
raw_source: []
---

Pure vector search fails on exact identifiers — proper nouns, dates, error codes —
because embeddings blur precise tokens. Pure keyword search fails on paraphrase.
Reciprocal Rank Fusion over both retrievers reliably outperforms either alone.

This is why CFBrain runs tsvector and pgvector in parallel and fuses the ranked
lists rather than picking one strategy.

## Source
- [inferred: standard IR result, applied to this system's design] (confidence: medium)
