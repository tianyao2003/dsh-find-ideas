# Design: Incremental relevance, architecture inspection, and lightweight prior history

## Principles

The product task is to decide whether an existing repository is worth borrowing from, and to support that decision with evidence. Similarity, usefulness, and evidence quality are separate facts.

## Data flow

Search candidates -> agent supplies relevance dimensions -> deterministic rank derivation -> compact ranked card.

Architecture view -> commit lookup + tree lookup -> deterministic file selection -> bounded file reads -> pure architecture extractors -> evidence-first architecture card.

Search/inspect/read success -> bounded prior metadata write -> exact hashed idea/repository lookup -> context hint only.

## Relevance contract

RelevanceDimensions:
- problem_fit: number | null
- workflow_fit: number | null
- technical_fit: number | null
- borrowability?: number | null

evidence_level: metadata | readme | source.

relevance remains a derived integer 0..10. Initial weights are problem 0.45, workflow 0.30, technical 0.25. Unknown dimensions are omitted and the remaining weights are renormalized. borrowability is displayed separately and does not affect finalScore in this release. A legacy {full_name, relevance, note} score is accepted and marked with a legacy source.

## Architecture contract

read_repo_files gains view (files|architecture) and depth (shallow|deep). Existing files mode remains the default.

Architecture mode reuses getHeadCommit, getTree, pickArchitectureFiles, treeEvidence, getFileContent, and existing source caches. It does not add a GitHub endpoint.

Architecture sections:
- entry_points
- dependencies
- routes_commands
- data_models
- call_chain
- external_boundaries
- test_behaviors
- unknowns

Each evidence item carries repository-relative path, line or line range when available, evidence text or a short excerpt, and confidence (observed, heuristic, unknown). The extractor never reports a negative fact from an unread or truncated file.

The first implementation uses bounded regex and manifest parsing over already-read text. It does not claim a complete call graph. Unsupported languages and insufficient evidence are explicit unknowns.

## Prior history contract

A separate bounded JSON file under the existing cache directory stores only repository metadata. It is not part of the request cache envelope and has its own version and cap. The record uses a SHA-256 digest of normalized idea text; raw idea text and source text are never stored. History is written after successful search/inspect/read operations and surfaced as non-ranking context.

## Compatibility and rollout

- P0 freeze current outputs.
- P1 adds dimension input with legacy fallback.
- P2 adds architecture view while preserving files mode.
- P3 is additive and has no ranking effect.
- P4 updates documentation and format versions.

## Failure behavior

All new failures return existing Degraded records or explicit unknown fields. No new path throws to callers. Cache/history failures are memory-only or empty-history degradations.
