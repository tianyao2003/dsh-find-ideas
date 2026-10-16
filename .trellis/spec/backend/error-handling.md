# Error Handling

> How errors are handled in this project.

---

## Overview

The governing rule: **an error never reaches the caller as an exception.** It is converted, at the tool boundary, into either a `Degraded` value or a sentence of prose on the card.

There is no HTTP API, so there is no status-code surface. The error surface is:

1. `Degraded { reason, detail }` (`src/types.ts:63-68`) in the tool's output, and
2. the `describe*` / `explain*` prose helpers that write the human-readable half.

The reason for this shape is recorded in `src/github.ts:1-17`: a rate limit carries `limit` / `remaining` / `resetAt` "so the caller can degrade instead of failing". A tool call that throws is a tool call that produced nothing; a tool call that degrades still tells the model what happened and what to do next.

---

## Error Types

### The one custom error class

```ts
// src/github.ts:146-154
export class GitHubSearchRateLimited extends Error {
  readonly info: GitHubRateLimitInfo
  constructor(message: string, info: GitHubRateLimitInfo) {
    super(message)
    this.name = 'GitHubSearchRateLimited'
    this.info = info
  }
}
```

Thrown only at `src/github.ts:423`, after a 403/429 has already been retried once honouring `retry-after`. It exists so the caller can distinguish "GitHub refused" from "the network failed" without parsing a message.

### Plain `Error`

Everything else uses a plain `Error`. There are exactly **five** `throw new` sites in `src/`:

| Site | What it reports |
|------|-----------------|
| `src/github.ts:389` | transport failure after the one retry, as `GitHub request failed: <cause chain>` |
| `src/github.ts:402` | GitHub returned a body that is not JSON |
| `src/github.ts:423` | `GitHubSearchRateLimited` |
| `src/github.ts:431` | generic `GitHub HTTP <status> for <path> (<detail>)`, where `detail` is built from rate-limit **headers** by `describe()` (`src/github.ts:232`, called at `:421`) — never from the response body |
| `src/query.ts:862` | the planner refusing to build a query plan |

Only one of the five is a subclass (`GitHubSearchRateLimited`, `:423`, described above); the other four are plain `Error`. That is intentional: the *reason vocabulary* lives in `Degraded.reason`, not in the class hierarchy, because the reason has to survive JSON serialisation onto the card.

### `Degraded`

```ts
// src/types.ts:63-68
export interface Degraded {
  reason: string
  detail: string
}
```

`reason` is a `string`, **not** a union. The constraint is mechanical: `rank_candidates`'s `output.schema` is what `defineTool` uses to infer the `execute` return type, and the schema language has no unions. The same constraint produces `Suspicion.kind: string` (`src/types.ts:333-359`) and the empty-string sentinel on `Suspicion.against` instead of an optional field.

**Complete `reason` vocabulary in use** (grep `reason:` in `src/index.ts`):

| `reason` | Emitted at | Meaning |
|----------|-----------|---------|
| `plan_failed` | `src/index.ts:1008`, `:1043` | no query was sent; includes the Han-without-Latin refusal |
| `partial` | `src/index.ts:358`, `:1086`, `:1169`, `:1871` | some queries/repos succeeded, some did not |
| `thin_result` | `src/index.ts:1088`, `:1183` | the result set is smaller than GitHub implied |
| `rate_limited` | `src/index.ts:1202`, `:1832` | GitHub refused; quota or IP-level limit |
| `search_failed` | `src/index.ts:1208` | the search request itself failed |
| `too_many_repos` | `src/index.ts:1654` | more than `MAX_INSPECT_REPOS` (5) requested |
| `no_repos` | `src/index.ts:1659` | empty `repos` array |
| `quota_exceeded` | `src/index.ts:1767`, `:1776` | the per-call request budget would be breached |
| `time_budget_exceeded` | `src/index.ts:1808` | the wall-clock share of the host timeout would be breached |
| `inspect_failed` | `src/index.ts:1843` | reading a repository failed |

`rank_candidates` has **no** `Degraded` path at all — it is pure and local, so it can always produce a card.

### The `describe*` family

| Helper | Site | Produces |
|--------|------|----------|
| `describeFailure` | `src/github.ts:174` | the full `cause` chain, joined with `->`, for a transport failure |
| `proxyHint` | `src/github.ts:195` | the `NODE_USE_ENV_PROXY` sentence, or `''` |
| `describe` (private) | `src/github.ts:232` | `limit=... remaining=... resetAt=... token=set|none` |
| `describeProbeOutcome` | `src/github.ts:933` | why the term probe was skipped or partial |
| `describeUnavailableProbeDiagnostic` | `src/github.ts:977` | why no probe ran at all |
| `describePlanFailure` | `src/query.ts:1048` | no query was sent, and what to do about it |
| `describeLexiconMiss` | `src/query.ts:1160` | the idea's terms were not in the CJK lexicon |
| `describePartialFailure` | `src/query.ts:1232` | which channels failed, and what that does and does not prove |
| `explainThinResult` | `src/query.ts:1329` | a live thin result |
| `describeReplayedThinness` | `src/query.ts:1372` | a cached thin result |
| `describeReplayedIncompleteness` | `src/query.ts:1399` | a cached incomplete result |
| `explainEmpty` | `src/render.ts:326` | why a card has no rows |

---

## Error Handling Patterns

### Catch at the tool boundary, degrade, keep going

The network tools wrap each stage and substitute a degraded value rather than aborting the call. `scout_projects` (`src/index.ts:782`) still returns `idea`, `cached`, `candidates`, `query_terms` and `probe_note` when search fails; only `degraded` changes.

### Check the budget *before* the work, not after

`src/index.ts:1808` refuses with `time_budget_exceeded` when the planned work would exceed `TIME_BUDGET_SHARE = 0.75` (`src/index.ts:225`) of the host timeout. The rationale is at `src/index.ts:213-224`: a call planning to finish exactly at the limit has no room for the one slow request that always happens, and "a refusal costs the caller a retry with a smaller batch; an overrun costs them the whole call". This is why `INSPECT_TIMEOUT_MS = 60000` (`src/index.ts:211`) is duplicated as a constant instead of read from the registration — the budget check (`:1681`, `:1682`) runs before the registration is reachable.

> **This pair is pinned, not review-enforced.** `src/index.ts:206-209` states why the ceiling is exported: so S9 can assert the registered `timeoutMs` IS this constant and that the constant is the 60000ms the host enforces. S9 does both — `test/queries.test.mjs:782-784` asserts `inspect.timeoutMs === index.INSPECT_TIMEOUT_MS`, `:785-787` asserts `index.INSPECT_TIMEOUT_MS === 60000`, and `:791-792` asserts `TIME_BUDGET_SHARE` lies strictly inside `(0, 1)`. A drift between `:211` and `:1881` therefore fails the suite. (An earlier revision of this note said the opposite — that the comment claimed a guard which did not exist. That was accurate at the time: S9 then asserted only `typeof inspect.timeoutMs === 'number'`, and no test named `INSPECT_TIMEOUT_MS`. The assertion has since been added.)

### Never re-parse a message to recover a fact

`src/github.ts:21-33` records the defect this rule comes from: `describePartialFailure` used to decide whether the long tail was lost by testing `failure.includes('sort=updated')`. Reword the message and the warning silently stops firing, with both halves still "working". The role now travels as a field on `QueryFailure`. **If a caller needs a fact, pass the fact; do not encode it in prose and decode it downstream.**

### Distinguish "measured zero" from "not measured"

`TERM_TOTAL_UNKNOWN = -1` (`src/types.ts:240`) exists because `null` is not available in that schema position, and `0` already means something else ("the term matched nothing on its own"). `termReport` (`src/index.ts:123`) leaves an unmeasured term `selective` rather than asserting anything about it — "the tool does not know, so it does not assert" (`src/index.ts:142-144`).

### A failed channel is a statement about the channel, never about the rows

The canonical case is `src/query.ts:1251-1257`. The old text claimed 「因此本次结果**只包含高 star 项目**」 — an absolute claim about the rows that *did* come back. A failed tail channel proves nothing about them: the surviving channels are ordered by `sort=stars` (which reaches only the head of its own result set) or by `sort=updated`, and an anchor-only plan was measured returning three 5-star repositories. The honest claim is about the lane that did not run, so coverage is unknown.

---

## API Error Responses

Not applicable — this plugin exposes no HTTP API. The equivalent surface is the card, and its shape is specified in `.trellis/spec/backend/tool-contracts.md`.

Two rules govern that surface:

1. **Every degraded state must render.** A diagnostic that is not printed onto the card does not exist for the caller. `explainEmpty` (`src/render.ts:326`) exists because "a genuine miss, an exhausted quota, and a network failure all rendered identically, so the calling agent had to guess at the cause (in practice it guessed 'rate limited' and gave up on the tool entirely)" (`src/render.ts:315-325`).
2. **A refusal is never dressed up as a result.** The `inspect_projects` description states that the host terminates the call at 60 seconds and returns *nothing* when it does — not even repositories already read — and that a refusal must never be presented as a received inspection.

---

## Common Mistakes

| Mistake | Why it is wrong | Where it was fixed |
|---------|----------------|-------------------|
| Parsing a failure message to recover a fact | Rewording the message silently disables the logic; no test can catch it because both halves still "work" | `src/github.ts:21-33` |
| Claiming rows are all high-star because a channel failed | A failed channel proves the lane did not run, not what the surviving lanes returned | `src/query.ts:1251-1257` |
| Rendering a bare "no results" | A genuine miss, an exhausted quota and a network failure become indistinguishable; the model guesses "rate limited" and abandons the tool | `src/render.ts:315-325` |
| Treating an absent measurement as `0` | `0` is a measurement ("matched nothing"); absence is not | `src/types.ts:240`, `src/render.ts:357-364` |
| Letting a missing optional host service throw at module load | "A plugin whose module throws on load takes the whole host down with it, which is a steep price for a missing optional token" | `src/index.ts:153-160` |
| Reporting a cached fetch's failure as a current one | `describeReplayedIncompleteness` (`src/query.ts:1387-1405`) prints only the weaker, still-true fact: these rows are a subset of what was asked for | `src/query.ts:1387-1405` |
| Retrying a caller-cancelled request | The retry budget is one per call and shared with the rate-limit path; an aborted request is never retried | `src/github.ts:1-17` |
