# Implementation plan

## P0 baseline

- [x] Run npm run check and npm test from the project root.
- [x] Record current schema keys, card budget, cache behavior, and test output.
- [x] Confirm no existing dirty implementation files are overwritten.

## P1 relevance dimensions

- [x] Add shared dimension types and pure derivation helpers.
- [x] Extend rank_candidates input parsing with dimension and legacy paths.
- [x] Preserve finalScore, rating, noise and suspicion behavior.
- [x] Add compact breakdown fields to ranked output/rendering.
- [x] Add pure, schema, render, diagnostics, and regression tests.
- [x] Run targeted ranking/render tests, then full check/test.
- [x] Run offline ranking comparison before proceeding.

## P2 architecture view

- [x] Add pure architecture types and extractors in src/architecture.ts.
- [x] Reuse treeEvidence and pickArchitectureFiles; avoid duplicate manifest/source rules.
- [x] Add view/depth routing in read_repo_files.
- [x] Add bounded architecture output and renderer with evidence/unknown handling.
- [x] Add commit/format-aware cache keys.
- [x] Add fixtures for JS/TS, Python, Go/Rust, Tauri/monorepo, unsupported or truncated trees.
- [x] Run architecture unit/integration tests and full check/test.

## P3 lightweight prior history

- [x] Add bounded prior module and format version.
- [x] Record metadata after successful search/inspect/read.
- [x] Surface exact hashed history hints without ranking changes.
- [x] Add corruption, cap, delete, privacy and no-network tests.
- [x] Run full cache/replay/disk-gc and full test suite.

## P4 release gate

- [x] Update README.md and README.zh.md.
- [x] Update format/version documentation.
- [x] Run npm run check, npm test, and relevant eval gates.
- [x] Review types -> tool schema -> execute -> cache -> render -> tests as one contract.
- [x] Run the independent acceptance checklist and fix all findings.

## Completion notes

- P0 through P4 implementation, tests, and acceptance review completed in the working tree.
- npm run check, npm test, and npm run eval:golden passed; the full suite reports 36/38 test files passed and 2 fixture-dependent skips.
- The directory contains an incomplete .git metadata directory without a usable Git repository configuration, so no commit was created.

