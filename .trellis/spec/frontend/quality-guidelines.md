# Quality Guidelines

> Code quality standards for the presentation layer.

---

## Overview

This project has no browser frontend. The presentation layer is the **Markdown card**
that `src/render.ts` produces, and its consumer is the calling model, not a human at a
screen. Every rule below follows from one difference between those two readers: a human
who is unsure asks a follow-up question, while a model reading a card treats what it sees
as the whole truth and acts on it.

So the governing rule of this layer is **the card must not claim more than the code
measured**. The rest of this file is that rule made concrete.

Three card families are rendered, all in `src/render.ts`:

| Renderer | Card | Tool |
|---|---|---|
| `renderCandidates` (`src/render.ts:355`) | Candidate pool | `scout_projects` |
| `renderRanked` (`src/render.ts:545`) | Ranked table | `rank_candidates` |
| `renderInspections` (`src/render.ts:959`) | Source excerpts | `inspect_projects` |

---

## Forbidden Patterns

### 1. Flattening the two regions

`【代码计算区】` (code-computed) and `【调用方说明区】` (caller-supplied, unverified) must stay
distinguishable. Do not merge them, do not move the declaration below the table, do not
drop it from a branch.

**Why:** a flat surface makes "this row belongs to the noise group" and "the code computed
`1/10` for this row" look identical. This is not hypothetical — it happened in the
browser-extension round (m00781–m00793) and is the reason the two-region split exists.

Enforced by `test/render-table.test.mjs` and `test/declaration-honesty.test.mjs`.

### 2. The overclaim sentence

Never print anything of the form 「均由代码算出、不可指定」 — the exact banned sentence, the
weaker 「均由代码算出」, and the 「不可指定」/「不能指定或改动」 family are all forbidden as
claims about *the inputs*.

**Why:** only the arithmetic is code-derived. `stars`, `pushed_at` and `description` are
caller-supplied metadata that the tool never re-checks against GitHub, and `relevance` is
the caller's own judgement. The safe sentence is the one that is actually true —
「排序与星级均由代码按公式计算，不可由模型指定。」 — and it must survive verbatim.

**Trap:** the safe sentence contains 「不可由模型指定」, so a naive substring search for the
forbidden family matches the safe sentence. `test/declaration-honesty.test.mjs` strips the
safe sentence before searching, *and* asserts the safe sentence is still present, so the
tolerance cannot silently become a hole.

### 2b. A restated card keeps every row AND every column

`renderRanked` prints a second line directly under the safe sentence:

> 复述本卡时，每一行与每一列都必须保留（共八列，含「简介」列）：删掉一行或一列是丢失信息，不是缩短表格。

**Why:** `rank_candidates`' description already forbade dropping a column (commit `e34ce4a`),
and the column still disappeared in the one observed trial session. The card was correct —
eight columns including 简介 — and the agent re-presented it with 简介 deleted and `relevance`
translated to 「相关性」. Two things made that possible. A tool description is read once, at
planning time, while the card is read again on every call, so a rule that lives only in the
description competes with the table it describes and loses. Worse, the description rule was
unreachable for a whole day: the host process predated `e34ce4a`, and a plugin's `defineTool`
payload is built at load time, so every model call still carried the old text even though the
disk copy was correct the whole time. The card cannot assume the description arrived.

**Trap:** this sentence is a RULE, not a measurement — it claims nothing about what the code
computed, which is what keeps it compatible with the honesty rules above. It must also stay on
its **own line**: `test/declaration-honesty.test.mjs` removes the safe sentence by exact match
before scanning for the banned family, so folding the two into one line would leave a fragment
behind and turn that tolerance into a hole.

Pinned by `test/render-table.test.mjs` (T7b): the rule is present, names the column count and
简介, names both losses (a row AND a column), follows the table, occupies its own line, and is
absent from the empty branch — which has no table to protect.

### 3. Claiming absence from a failed measurement

A channel that failed proves nothing about the rows that did come back. The forbidden
shape is 「只包含高 star 项目」 (the returned rows are all high-star); the honest shape is
「长尾通道覆盖未知」 (tail-channel coverage is unknown).

**Why:** the surviving channels sort by `stars` or `updated`, which only reaches the head
of their own result set, and the anchor-only plan has been measured returning 5★ repos.
The honest claim is about the **channel**, never about the rows.

Enforced by `test/queries.test.mjs`, `test/diagnostics-honesty.test.mjs`.

### 4. A bare `0` for an unmeasured count

Three distinct states must render differently and never collapse:

| State | Render |
|---|---|
| Measured, matched nothing | `0（solo 无命中）` |
| Never probed | `未知（未测得）` |
| Measured | `12.3k` (via `formatCount`, `src/render.ts:507`) |

A bare `0` reads as "this term is useless", which is a claim the probe did not make; `未测`
claims an ignorance the probe does not have when it did run and got zero. See
`termCoverage` (`src/render.ts:471`), which returns `[]` entirely when *nothing* was
measured — an absent block and a clean block look the same otherwise.

### 5. Reporting one long-tail number instead of two

`low_star_in_pool` and `low_star_in_kept` are reported as separate counts. Never report
only the second.

**Why:** "3 small projects kept" reads as "the long tail was served" when the pool may have
held 20 and the formula pushed 17 out. The **difference between the two counts is the
measurement** — a bare number destroys exactly the information the field exists to carry.
Both are computed by the single shared `countLowStar` (`src/github.ts:80`); a second
threshold definition would let the difference drift while still producing two plausible
numbers.

### 6. Rendering `undefined`, or a URL that is not the canonical one

`pushed_at` absent renders `—` (`EMPTY_CELL`, `src/render.ts:28`), never `undefined` — in the
ranked table and in the flat candidate list alike (`src/render.ts:388`), which is why both go
through the one `formatMetaCell` rather than each spelling its own placeholder.
`canonicalUrl` (`src/render.ts:651`) must not lowercase `full_name`: GitHub paths are
case-sensitive, and a lowercased `FuRongJun-1999/dsh-memory` returns 404.

### 7. Letting card text build structure

`escapeCell` (`src/render.ts:103`) flattens all whitespace and escapes `|`. Do not add
escaping of `[`/`]` to the 项目 column — `rankedRow` (`src/render.ts:290`) uses that column
to construct the Markdown link, so escaping brackets there breaks every link. This
constraint is documented at the function and must not be "fixed".

Note the deliberate asymmetry: `escapeCell` does **not** handle backticks or forged fences.
Instruction-isolation escaping is a separate concern; do not assume it is done because this
one is.

---

## Required Patterns

### Declarations belong to every branch, not just the happy one

`CODE_AREA_DECLARATION` (`src/render.ts:273`) is pushed in the **empty-result branch** as
well as the table branch. A card that shows no candidates is exactly when the reader most
needs to know what would have been computed and by whom.

### Every state that was measured differently is labelled differently

When adding a status, ask: *is the silence I am about to print the same silence as the
other silences?* If not, it needs its own wording. The cache replay is the worked example:
a replayed search has no per-term diagnostics, so it says 「诊断未保存」 and adds 「这不代表检索词
都有效」 — because an empty coverage block is otherwise indistinguishable from "measured,
all clean".

### `note` renders outside the computed table

A caller-supplied note goes to `【调用方说明区】` (`callerNotes`, `src/render.ts:624`), below
the table, labelled `[未验证]`, with whitespace flattened. It must never appear inside a
table row, where it would read as a computed field.

### Truncation is always annotated

`clipDescription` (`src/render.ts:64`, `MAX_DESCRIPTION_CHARS = 200`) marks that it clipped.
`renderSkeleton` and its `SKELETON_DISCLAIMER` (`src/render.ts:797`) are already careful —
do not weaken them.

---

## Testing Requirements

- **Tests consume `lib/`, not `src/`.** Run `npx tsc -p tsconfig.json` after any source edit
  and before any test. A red renderer test often means a stale build, not a bug.
- **Never `node --test`.** Run `node test/<file>.mjs`. The `test:runner` npm script produces
  false negatives.
- **Exercise the real path.** Call `def.output.render({}, value)` after
  `def.execute(args, {})`. `render` lives at `def.output.render`, **not** `def.render`.
  Hand-constructing a row and calling the renderer directly skips the layer where a
  declaration can vanish — which is precisely how the missing `note` wiring survived
  unnoticed until `test/declaration-honesty.test.mjs` became the first test in the repo to
  call `.output.render(...)`.
- **Assertions about absence must tolerate negation.** Any check of the form "the card does
  not contain X" must account for the card containing X inside a sentence that *denies* X.
  `test/diagnostics-honesty.test.mjs` hit this for real: the cache note says
  「下面没有「查询词覆盖」区块」, so a substring assertion on 「查询词覆盖」 fails on the very
  sentence that admits the block is missing. Assert on the block's full header instead.
- **`suspicious` mixes kinds.** `findNoteEchoes` emits `note_echo`/`note_gap` alongside
  `score_gap`. Filter by `entry.kind`; never assert `suspicious.length === 0`.
- **Mutation-test a new honesty assertion.** Copy `lib/` to a scratch directory, mutate the
  copy, and prove the test fails. An assertion that cannot fail is not a check. Recorded
  mutation results exist for several files in `test/`.
- **`test/source-integrity.test.mjs` is a text gate over `src/*.ts`** and rejects U+FFFD,
  CJK-immediately-followed-by-Latin, and em-dash/star/arrow-immediately-followed-by-Latin.
  Any source edit can trip it.

---

## Code Review Checklist

- [ ] Does the card claim anything the code did not measure? Look for quantifiers
      ("all", "every", 「都」) and for absolute verbs applied to populations.
- [ ] Are the two regions still separate, and is the declaration present in **every**
      branch this change touches?
- [ ] Is a new count/state labelled distinctly from the other states it could be confused
      with — including the state "we did not measure"?
- [ ] If two numbers are now reported where one was, is their **difference** still
      meaningful, and does the wording make it so?
- [ ] Is the banned-claim family absent, and is the safe sentence still present verbatim?
- [ ] If the card tells the model how to restate it, does that sentence claim nothing about the
      data, and does it sit on its own line rather than being folded into the safe sentence?
- [ ] Does any new test assert absence in a way a negation in the output could satisfy?
- [ ] Was `npx tsc -p tsconfig.json` run, and was `test/source-integrity.test.mjs` run
      after the text edit?
