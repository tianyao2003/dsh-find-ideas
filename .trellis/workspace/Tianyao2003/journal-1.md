# Journal - Tianyao2003 (Part 1)

> AI development session journal
> Started: 2026-10-15

---



## Session 1: dsh-find-ideas v0.1: prior-art plugin shipped, then a last-updated column added to the flat list
<!-- trellis-session: v=2 fp=ed209f95e400a5f6 -->

**Date**: 2026-10-16
**Task**: dsh-find-ideas v0.1: prior-art plugin shipped, then a last-updated column added to the flat list
**Branch**: `master`

### Summary

Built and shipped the dsh-find-ideas DSH plugin (three tools: scout_projects, rank_candidates, inspect_projects) end to end: trellis spec layers, 23 test files, README, live profile install and restart verification. Then, on request, added the last-updated timestamp to the flat candidate list (src/render.ts:382) via the shared formatMetaCell, synced README and spec headroom numbers, and pushed both commits to GitHub.

### Git Commits

| Hash | Message |
|------|---------|
| `0bd14d0` | chore: keep trial-run reports out of the repository |
| `e57593a` | feat: show the last-updated timestamp in the flat candidate list |

### Status

[OK] **Completed**


## Session 2: dsh-find-ideas: surface the retrieval signals the pipeline already computes
<!-- trellis-session: v=2 fp=ee89ab995f0fc57d -->

**Date**: 2026-10-17
**Task**: dsh-find-ideas: surface the retrieval signals the pipeline already computes
**Branch**: `master`

### Summary

Built the find-ideas-signals task end to end after analysing a comparable project: PRD first, then three increments. R1 states the real GitHub retrieval surface (repository name and description only, never README bodies or file contents) in all five places that claim it. R2 states the archived share of a pool as a count, not only per-row markers. R3 surfaces the per-row query-channel count that selectPool already computed but discarded, as an optional field that never enters the score. All 15 acceptance criteria were verified and annotated with their evidence, and 174 spec citations were renumbered in the same commit as the line shifts that moved them. Also added a GitHub Actions workflow running npm run check and the test suite on Node 22 and 24.

### Main Changes

- R1: state the retrieval surface in all five places that claim it, and pin it with a test
- R2: report the archived share of a pool as a count, keeping the table at eight columns
- R3: carry the channel-hit count from selectPool to the card as an optional field, with no change to the score or the schema order
- Sync the four tool-contracts spec claims with the new optional field, and renumber 174 citations across 11 spec files in the same commit as the shifts
- Create the find-ideas-signals task with a 15-criterion PRD, then archive it once every criterion carried its evidence
- Add .github/workflows/ci.yml running npm run check and the test suite on Node 22 and 24

### Git Commits

| Hash | Message |
|------|---------|
| `96dbc8d` | Fix spelling of 'Licence' to 'License' |
| `7d5495c` | docs: add the architecture diagram to the README |
| `1d406ed` | docs(spec): correct the stale facts in the directory-structure spec |
| `ba72aff` | docs: rewrite the README for a shorter, structured read |
| `85bdc88` | Update README.zh.md |
| `608a77e` | Update README.md |
| `1474128` | docs: rewrite the README around what a reader needs to do |
| `2704b14` | chore: generate the README samples from the shipped code |
| `943559a` | fix: compare README samples independently of line endings |
| `831f4a1` | Update README.zh.md |
| `d5448ff` | Update README.zh.md |
| `6e3ab68` | Update README.zh.md |
| `0a834a6` | Update README.zh.md |
| `e34ce4a` | fix: stop a restated card from losing the description column |
| `5bacd81` | fix: keep the traceability guarantee alongside the column rule |
| `749f23e` | docs: sync the READMEs with the maintainer's Chinese edit |
| `5c99277` | docs: add static badges to the READMEs |
| `92a7967` | ci: run the check and the test suite on Node 22 and 24 |
| `5979928` | chore(task): archive 00-bootstrap-guidelines |
| `5977799` | chore(task): add the find-ideas-signals task and its PRD |
| `3ab9e95` | docs(task): correct the PRD's R1 after the surface measurement refuted half of it |
| `4485cb6` | fix(surface): state GitHub's real retrieval surface in all five places |
| `d8f3ca8` | feat(render): state the archived share of a pool, not just which rows are archived |
| `5dcf23a` | feat(card): show how many query channels found each row |
| `db333ea` | docs(task): mark the PRD's acceptance criteria with their verified evidence |

### Testing

- [OK] npx tsc -p tsconfig.json --noEmit exits 0, and npm run check is green
- [OK] node test/run-all.test.mjs: 24 of 26 test files passed, 2 skipped (frozen eval fixtures absent, unrelated to this work)
- [OK] node test/channel-visibility.test.mjs 48 PASS / 0 FAIL, and node test/source-integrity.test.mjs 27 PASS / 0 FAIL
- [OK] cite-guard: 539 of 539 cited text unchanged, 0 moved, 0 retargeted, 0 newly past EOF
- [OK] verify-tree: 513 citations checked, 0 past EOF, 0 nonexistent files, 0 needing adjudication

### Status

[OK] **Completed**

### Next Steps

- Push the local commits once the user approves; nothing has been pushed since 92a7967


## Session 3: dsh-find-ideas 0.2.0: scrub the history, sync the READMEs, repoint every recorded SHA
<!-- trellis-session: v=2 fp=b1f2dd202e321bff -->

**Date**: 2026-10-17
**Task**: dsh-find-ideas 0.2.0: scrub the history, sync the READMEs, repoint every recorded SHA
**Branch**: `master`

### Summary

Prepared the repository for its first public push. Rewrote all 40 commits with git filter-repo so every author email is longtianyao2003@126.com (the 29 commits that carried a phone-number address are gone) and the 14 local absolute paths in five archived task files are neutralised; a 1.2 MB bundle plus the backup/pre-rewrite branch keep the old history recoverable locally. Because the rewrite changed every SHA, all 88 SHAs recorded in tracked files were repointed 1:1 (40/40 matched by author date, commit date and subject). Bumped the version to 0.2.0 and synced both READMEs with the shipped code: the install snippet no longer calls the repository private, the test counts now say 27/26/24, and two new sections document the version line and how to contribute.

### Main Changes

- Rewrite all 40 commits with git filter-repo: one author email everywhere, 14 local absolute paths in the archived v0.1 task files replaced
- Repoint 88 recorded commit SHAs across 7 files through the old-to-new map, with a residue post-condition
- Bump the version to 0.2.0 and record the 0.2.0 and 0.1.0 lines in both READMEs
- Add a contributing section and drop the private-repository wording from both READMEs
- Correct the test counts in both READMEs from 24/23/21 to 27/26/24

### Git Commits

| Hash | Message |
|------|---------|
| `421bb55` | fix(render): state the restatement rule on the card, not only in the tool description |
| `da5874b` | chore(history): repoint every recorded commit SHA after the identity rewrite |
| `bb24684` | chore(release): bump the version to 0.2.0 |
| `009767c` | docs(readme): document the 0.2.0 version line and how to contribute |

### Testing

- [OK] [OK] npx tsc -p tsconfig.json --noEmit exits 0, and npm run check is green
- [OK] [OK] node test/run-all.test.mjs: 24 of 26 test files passed, 2 skipped (frozen eval fixtures absent, unrelated to this work)
- [OK] [OK] cite-guard: 539 of 539 cited text unchanged, 0 moved, 0 retargeted; verify-tree: 513 citations, 0 past EOF, 0 needing adjudication
- [OK] [OK] post-rewrite scan of the rewritten history: 0 occurrences of the old phone number, 0 of the old working-directory path, and the only remaining user-home hits are the <user> placeholders

### Status

[OK] **Completed**

### Next Steps

- Force-push master, then flip the repository to public once the user confirms
