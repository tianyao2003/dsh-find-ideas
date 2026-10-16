# Frontend Development Guidelines

> The presentation layer of this project — the Markdown card.

---

## Overview

**This project has no React, no browser code, no DOM and no build step for a UI.** `package.json` declares zero runtime dependencies, and nothing under `src/` imports a UI library. If you arrived here looking for component or state-management rules, most of the conventional answers are "not applicable" — and this layer says so explicitly rather than inventing content.

What *is* here is a presentation layer, and it is the part of the system the user actually experiences:

> `src/render.ts` (50692 bytes) turns computed values into the Markdown card that the calling model reads. **That card IS this project's user interface.** — `src/render.ts:1-14`

The card is the only thing a human ever sees. It is also the only output channel of any kind: there is no logger, no console output and no other surface (see `backend/logging-guidelines.md`).

---

## Pre-Development Checklist

Read these before changing anything a model will read. Every one of them is a rule this project has already broken once.

- [ ] **Decide what the sentence *claims*, not what it *says*.** A card line is read as a factual assertion about the search. 「未测」 asserts ignorance; 「0」 asserts a measurement. Rendering an unmeasured value as `0` is the single most common defect in this layer.
- [ ] **Do not let a renderer compute.** Renderers format values they are handed. If you find yourself calling `Math`, sorting, filtering or counting inside `src/render.ts`, the computation belongs in `src/types.ts` (`rankCandidates`) or `src/index.ts`, and the renderer should receive the result.
- [ ] **A new table cell must survive adversarial input.** `full_name`, `description`, `language` and `pushed_at` come from GitHub and are attacker-controlled. Any value entering a cell goes through `escapeCell` (`src/render.ts:97`) and, for the value side, `escapeUntrusted` (`src/render.ts:116`); a url only becomes a link if `allowlistedUrl` (`src/render.ts:182`) accepts it and `linkDestination` (`src/render.ts:208`) re-encodes it.
- [ ] **Never emit a bare url from untrusted input.** The reader is a model that follows links. `github.com.evil.example` passes a suffix test — the allowlist compares hosts exactly.
- [ ] **A bare-text line needs the escaper, not the encoder.** `linkDestination` (`src/render.ts:208`) protects a table cell by percent-encoding the characters that can end a destination — but it does **not** encode `[` or `]`, so it is the wrong tool for a line that is not a link at all. The flat candidate list prints its url as bare text and routes it through `escapeUntrusted` (`src/render.ts:387`). Measured: `https://github.com/o/r) [click](https://evil.example.com/x` passes the allowlist because the host really is `github.com`, and unescaped the `](` is read as a live link to a host the allowlist never approved. An allowlist answers *which host*, never *where the text ends*.
- [ ] **State the numbers, and state what they do not mean.** A low-star count on its own reads as "small projects were available"; it means nothing without the count that entered the final list. Report both or neither.
- [ ] **Spend from the render budget deliberately.** `test/render-budget.test.mjs` pins the pool under 15000 B, single lines under 1024 B and the ranked card under 4000 B. Measured headroom is still comfortable (pool 6128 B, longest line 249 B, ranked card 2839 B), but a per-row field is spent **per row**, not once: the flat list gained `pushed_at` and that one field cost 600 B across the 25-candidate pool (25 rows × 24 B, re-measured by deleting the field from the render rather than estimating it). A long description, or the next per-row field, is what closes the remaining gap.
- [ ] **Check the empty branch too.** The zero-candidate card is a separate code path (`src/render.ts:367-373`) and has silently lost honesty lines before. Any rule you add to the table branch must be checked against the empty branch as well.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | N/A — see `backend/directory-structure.md` |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | N/A — no components; nearest analogue is a renderer function |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | N/A — no hooks; reusable stateful behaviour is a plain exported module |
| [State Management](./state-management.md) | Local state, global state, server state | N/A — no client state; the only cross-call state is the cache |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Filled (owned by the Lead) |
| [Type Safety](./type-safety.md) | Type patterns, validation, the schema boundary | Filled |

Three of these files (`component-guidelines.md`, `hook-guidelines.md`, `state-management.md`) carry a short "not applicable" note plus a pointer to where the equivalent concern actually lives. That is deliberate: a spec full of invented component conventions would be actively misleading.

---

## The Presentation Layer

### Renderers are pure functions

| Renderer | Site | Produces |
|----------|------|----------|
| `renderCandidates` | `src/render.ts:349` | the step-1 candidate list |
| `renderRanked` | `src/render.ts:539` | the step-2 eight-column ranked table |
| `renderSkeleton` | `src/render.ts:812` | per-file signature evidence |
| `renderInspections` | `src/render.ts:953` | the step-3 inspection report |
| `explainEmpty` | `src/render.ts:326` | why a card has no rows |

They import types and two constants and nothing else — no I/O, no network, no clock. That is what makes them testable without a host, and it is why the module exists separately from the tool registration:

> "a renderer that can only be reached by calling a registered tool cannot be tested at all." — `src/render.ts:1-14`

### The order and the numbers come from the code

> "The one hard rule encoded here: whatever these functions emit, the ORDER and the NUMBERS come from `rankCandidates`, never from the model." — `src/render.ts:1-14`

This is the project's central defence against a model narrating its own ranking. The tool descriptions enforce it from the other side: `rank_candidates`' description states "HARD LIMIT — you must NOT alter any key datum: the rank order, each row's relevance, stars_rating and …" (`src/index.ts:1235`), and the parameter key set is pinned by `test/ranking.test.mjs:177` so no `stars` or `stars_rating` parameter can ever be added for the model to set.

### Layout conventions

| Convention | Site | Reason |
|-----------|------|--------|
| `EMPTY_CELL = '—'` for an absent value | `src/render.ts:28` | an empty table cell reads as "nothing worth saying here", a different claim from "this value is missing" |
| `escapeCell` before any table cell | `src/render.ts:97` | a value containing `|` would otherwise break the table |
| `clipDescription` collapses whitespace, then truncates | `src/render.ts:58` | the format is line-oriented; whitespace is flattened first |
| `MAX_DESCRIPTION_CHARS = 200` | `src/render.ts:47` | see below |
| Eight-column ranked table | `src/render.ts:242-243` (header), `:284-295` (row builder) | rank, project, pushed, relevance/10, stars, score, language, description |

**The description cap is a measured fix, not a style choice.** `src/render.ts:30-46` records the incident: four keyword-stuffed descriptions of 241,979 / 143,365 / 143,333 / 139,284 characters took 668,409 of 674,064 bytes — 99.2% of one `scout_projects` result — while the other 21 candidates needed 5,655 bytes. The harness truncated the observation and the model silently lost 11 of 25 candidates, specifically the 324–2,600 star mid-tier ones, and the card filled with 1–22 star repos instead. "An honest description is 30-140 characters (`lissy93/dashy` is 136)." The cap is applied at render time rather than fetch time "so the stored candidate keeps its full value for scoring".

### Honesty rules that live in the renderer

The renderer is where a claim either becomes visible or is lost. Four rules are enforced here:

| Rule | Site |
|------|------|
| An empty card distinguishes a genuine miss, an exhausted quota and a network failure | `src/render.ts:315-346` |
| An unreported pool population is `null`, never a defaulted `0` | `src/render.ts:357-364` |
| A probe that did not run must say so, even on an empty card | `src/render.ts:367-373` |
| An unmeasured term is labelled unmeasured, distinct from a measured zero | `src/render.ts:480-484`, `src/index.ts:939-946` |

The first is worth quoting, because it is the reason the module has an `explain*` family at all: "A bare 'no results' was actively misleading: a genuine miss, an exhausted quota, and a network failure all rendered identically, so the calling agent had to guess at the cause (in practice it guessed 'rate limited' and gave up on the tool entirely)."

---

## How These Guidelines Are Written

These files document what the code **actually does**, with `path:line` citations. Where a conventional frontend topic has no counterpart in this project, the file says so in one line and points at the module where the equivalent concern lives — it does not invent content.

For the backend half of this plugin, see `backend/index.md`. Type patterns and the tool-schema boundary are in [Type Safety](./type-safety.md).

---

## Quality Check

Run this before declaring a presentation-layer change done. The commands are the same as the backend's; what differs is what you look for.

### Commands

```bash
npx tsc            # build to lib/ — REQUIRED before any test run
node test/render-table.test.mjs
node test/render-budget.test.mjs
node test/diagnostics-honesty.test.mjs
node test/declaration-honesty.test.mjs
node test/evidence-chain.test.mjs
node test/run-all.test.mjs
```

`test/` imports `lib/`, not `src/`: after editing a renderer, rebuild before testing or a correct change will look like a regression.

### Then verify, by claim

- [ ] **Render the card and read it as the model would.** Most defects in this layer are not type errors — they are sentences that assert more than was measured. Print the actual card for the changed path and read the prose.
- [ ] **Both branches were checked.** The table branch and the zero-candidate branch are separate paths; a rule added to one does not automatically hold in the other. There is precedent for an honesty line existing in only one of them.
- [ ] **Adversarial input was tried, not assumed.** Feed a `description` of 200 backticks, a `full_name` containing `]` and a `url` of `https://github.com/o/r) [click](https://evil.example.com/x`, then confirm the rendered card contains **no live forged fence and no link to a non-allowlisted host**. A green unit test has previously coexisted with both holes.
- [ ] **The budget was re-measured.** `node test/render-budget.test.mjs` must pass; if the change is near a limit, measure the actual number rather than trusting that it fits.
- [ ] **The honesty tests were re-run, not just the render tests.** `diagnostics-honesty`, `declaration-honesty` and `evidence-chain` assert that specific false phrasings are *absent*; a reworded sentence can satisfy a positive test while introducing a forbidden claim.
- [ ] **Every number on the card traces to a value the code computed.** No renderer invents a rating, reorders rows or fills a gap with a plausible default.
- [ ] **The empty card still says why it is empty.** A genuine miss, an exhausted quota and a network failure must remain distinguishable (`src/render.ts:315-346`).
- [ ] **Spec citations still resolve.** Adding or removing lines in `src/render.ts` moves every `path:line` citation in this directory. Update them, or confirm the cited symbol is still within the cited range.

---

**Language**: All documentation should be written in **English**.
