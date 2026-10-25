# PRD: Incremental relevance, architecture inspection, and lightweight prior history

## Problem

The plugin currently exposes a single agent-authored relevance integer, a point-read tool that returns selected file windows, and short-lived request caches. Users can see a score but cannot tell which kind of similarity produced it; they can read files but still have to infer architecture manually; and repeated searches do not retain a bounded local record of projects already seen or inspected.

## Goals

1. Derive a deterministic relevance score from explicit dimensions while preserving the existing ranking formula and legacy callers.
2. Add an architecture view to read_repo_files that returns evidence-backed entry points, direct dependencies, routes or command registrations, data model declarations, conservative observed call chains, external boundaries, and observed test behaviors.
3. Add a bounded local prior history that stores repository metadata only, never raw source or raw idea text, and never changes ranking automatically.
4. Preserve the lightweight runtime profile: zero runtime dependencies, bounded requests, bounded output, existing default tool behavior, existing cache safety, and graceful degradation.

## Non-goals

- Embedding or vector search.
- A full cross-language AST or complete call graph.
- A new database or background service.
- Automatic ranking boosts from historical observations.
- Storing README/source bodies in the prior history.
- Replacing the existing files view of read_repo_files.

## Acceptance criteria

### P0 baseline

- Existing check/build/test commands pass before feature work.
- Existing read_repo_files files mode, rank_candidates legacy relevance input, inspect card cap, cache TTLs, and cache version remain unchanged.

### P1 relevance

- Dimensions: problem_fit, workflow_fit, technical_fit, optional borrowability; known values are integer 0..5 and unknown values are null.
- Derived relevance is deterministic, uses explicit weights, renormalizes known dimensions, and does not treat unknown as zero.
- Legacy single relevance input remains accepted during migration and is visibly marked as legacy.
- The existing finalScore stars formula remains unchanged.
- New output remains within the existing card/payload budget envelope.
- Tests cover boundary values, unknown handling, determinism, schema and rendering compatibility.

### P2 architecture view

- view=files remains behaviorally compatible.
- view=architecture can auto-select files from the repository tree or accept explicit paths.
- Shallow/deep budgets remain bounded at approximately 6/10 requests per repository.
- Every reported fact includes path, line information, evidence level/confidence, or an explicit unknown.
- Call-chain output is limited to conservative observed/heuristic two-hop relationships.
- Architecture output is bounded, cached by commit and format version, and degraded without throwing.

### P3 prior history

- History is bounded to 256 records or 64 KB.
- Records contain repository identity, timestamps, counters, commit/path metadata, and hashed idea identifiers only.
- No raw source, README, or raw idea text is persisted.
- Reads/writes do not issue network requests.
- Corrupt, missing, oversized, or deleted history degrades to an empty history.
- History is surfaced as context only and never changes ranking in this release.

### P4 release

- Typecheck, build, full test suite, and relevant eval gates pass.
- README and README.zh document the new modes, evidence limits, cache/history privacy, and migration behavior.
- Output/cache format versions are bumped where required.
