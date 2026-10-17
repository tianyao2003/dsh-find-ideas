# Backend Development Guidelines

> Conventions for this project's plugin code (`src/`).

---

## Overview

`dsh-find-ideas` is a DeepSeek Harness plugin: one Node ESM package (zero runtime dependencies, `"engines": { "node": ">=22" }`) that registers three LLM-facing tools — `scout_projects`, `rank_candidates`, `inspect_projects`. There is no HTTP server, no database, no web framework and no build step beyond `tsc`.

Everything the caller sees is the **Markdown card** produced by `src/render.ts`. That card is this project's API response, its log, and its UI at once. Two rules follow from that and dominate the rest of this directory:

- **Errors never reach the caller as exceptions.** They are converted into `Degraded { reason, detail }` (`src/types.ts:72`) or into `describe*` / `explain*` prose. See [Error Handling](./error-handling.md).
- **There is no logger.** Everything a reader needs is printed onto the card; a diagnostic that is not rendered does not exist. See [Logging Guidelines](./logging-guidelines.md).

The central quality invariant is that **the card must not claim more than the code measured** — an unmeasured term is not a zero, and a failed retrieval channel means coverage is unknown rather than "the rows are all high-star". See [Quality Guidelines](./quality-guidelines.md).

Start here, then read [Tool Contracts](./tool-contracts.md) before changing anything a caller can see.

---

## Pre-Development Checklist

Read these before writing backend code. Each one is a rule that has already been broken once in this project.

- [ ] **Read [Tool Contracts](./tool-contracts.md) before changing anything a caller can see.** A parameter key, an output-schema key or a rendered sentence is a published contract; the schema is the only thing standing between the model and the numbers.
- [ ] **Do not add a runtime dependency.** `package.json` `dependencies` is `{}` and stays `{}`. Everything is Node built-ins plus `tsc`. If a task seems to need a library, the answer is a bounded heuristic in `src/`, not a dependency.
- [ ] **Check whether the fact you are about to store is derivable.** A stored copy of a derivable fact goes stale; the project recomputes instead. `low_star_in_pool` is recomputed on both the cold and cached paths for exactly this reason, while `tail_included` cannot be derived from the rows and therefore *is* stored. Decide which kind yours is before adding a field.
- [ ] **Confirm the failure path returns a value.** Nothing in the pipeline may throw to the caller. A new failure becomes a `Degraded { reason, detail }` (`src/types.ts:72`) plus a `describe*` sentence on the card.
- [ ] **If you are adding a diagnostic string, write its test in the same change.** Every honesty claim on the card is pinned by a test that asserts the forbidden phrasing is *absent* (`test/diagnostics-honesty.test.mjs`, `test/evidence-chain.test.mjs`, `test/declaration-honesty.test.mjs`). A new sentence with no test is an unpinned claim.
- [ ] **Adding a parameter key is a breaking change.** `test/ranking.test.mjs:186` pins `rank_candidates`' parameter key set exactly; a new key fails that test, and that is the intended signal, not an obstacle to route around.
- [ ] **Before touching a constant, find out whether it is already defined elsewhere.** A value that must stay in step with another is defined once and referenced — see `INSPECT_TIMEOUT_MS` (`src/index.ts:211`) and `TIME_BUDGET_SHARE` (`src/index.ts:225`), where the registration refers to the identifier rather than repeating the literal.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization, the one-way import rule, naming | Filled |
| [Tool Contracts](./tool-contracts.md) | The three tools' parameter + output-schema contract, and the framework wiring rules | Filled |
| [Database Guidelines](./database-guidelines.md) | No database — the JSON disk cache in `src/cache.ts`: envelope, `CACHE_VERSION`, TTLs, the version-bump rule | Filled |
| [Error Handling](./error-handling.md) | The `Degraded` shape, the reason vocabulary, the `describe*` family, degrade-don't-throw | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Forbidden patterns, testing requirements, mutation testing, code review checklist | Filled |
| [Logging Guidelines](./logging-guidelines.md) | No logger — the card is the only output channel, and what must never be written | Filled |

### Layer map

| Concern | Module |
|---------|--------|
| Plugin entry, tool registration, budget checks | `src/index.ts` |
| HTTP, retry, rate limiting, pool selection | `src/github.ts` |
| Search planning and planning-degrade prose | `src/query.ts` |
| Shared types, scoring maths, ranking, consistency detectors | `src/types.ts` |
| Architecture-file selector (pure) | `src/select.ts` |
| Signature scanning over file excerpts (pure) | `src/skeleton.ts` |
| CJK-to-English seed table (pure data) | `src/lexicon.ts` |
| Idea-to-English-keywords translation | `src/translate.ts` |
| Card renderers (pure string builders) | `src/render.ts` |
| Memory + JSON disk cache | `src/cache.ts` |
| `GITHUB_TOKEN` write path — deliberately not registered | `src/credentials.ts` |

---

## How These Guidelines Are Written

These files document what the code **actually does**, with `path:line` citations, because the alternative — an aspirational spec — is worse than no spec. Each non-obvious rule carries the measured failure that produced it, and where a rule is enforced by a test, the test file is named.

Three conventions worth knowing before you read on:

1. **A rule with no enforcing test says so.** Do not assume coverage that has not been verified.
2. **Sections that do not apply say so in one line** rather than being filled with generic advice. This project has no ORM, no log levels, no HTTP error codes and no frontend framework, and pretending otherwise would make the spec unusable.
3. **Rationale comments in `src/` are part of the spec.** Where this directory cites one, read it in the source; the headers are the project's institutional memory.

---

## Quality Check

Run this before declaring backend work done. It is the concrete form of the checklist in `.agents/skills/trellis-check/SKILL.md`, narrowed to what actually breaks in this project.

### Commands

```bash
npx tsc --noEmit              # type-check only
npx tsc                       # build to lib/ — REQUIRED before any test run
node test/run-all.test.mjs    # the suite (21/23 files pass, 2 skip on a missing fixture)
```

Two traps worth stating because both have already produced a false result here:

1. **`test/` imports `lib/`, not `src/`.** After editing any file under `src/`, run `npx tsc` before `node test/...`. A stale `lib/` makes a correct change look like a regression.
2. **Never run `node --test` directly.** The `test:runner` script in `package.json` produces false negatives; always invoke a single file (`node test/<file>.test.mjs`) or `test/run-all.test.mjs`. The runner counts a file as skipped only when it exits 0 *and* left its marker file.

### Then verify, by claim

- [ ] **Every new assertion has been seen to fail.** A test that passes on the first run has not been shown to test anything. Break the code deliberately, watch the test go red, restore it.
- [ ] **No honesty rule regressed.** `diagnostics-honesty`, `evidence-chain` and `declaration-honesty` assert that specific *false* phrasings do **not** appear. If you changed a card sentence, re-run all three.
- [ ] **Unknown is still unknown.** An unmeasured value is `未测` / `null` / `TERM_TOTAL_UNKNOWN` (`src/types.ts:257`), never a defaulted `0`. A measured zero is reported as `0（solo 无命中）`, which is a different claim.
- [ ] **No absolute claim about coverage.** A failed retrieval channel means coverage is unknown — never that the results "only contain high-star projects".
- [ ] **The card's numbers come from the code.** No renderer reorders rows or invents a rating; the order and the numbers come from `rankCandidates`.
- [ ] **Nothing throws to the caller.** Grep the new path for `throw`; the only acceptable one is a pure guard wrapped by a `try`/`catch` that converts it (see `src/query.ts:1019`).
- [ ] **Budget still holds.** `test/render-budget.test.mjs` pins the pool under 15000 B, a raw/rendered ratio above 40x, lines under 1024 B and the ranked card under 4000 B. A new field on the card spends from that budget.
- [ ] **Spec citations still resolve.** If you added or removed lines in `src/`, the `path:line` citations in this directory have moved. Either update them or confirm the cited symbol is still inside the cited range — a stale citation is a false statement in the spec.

---

**Language**: All documentation should be written in **English**.
