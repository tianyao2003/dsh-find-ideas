# Logging Guidelines

> How logging is done in this project.

---

## Overview

**There is no logger.** No logging library, no log levels, no `console.log`, no `process.stdout`, no `process.stderr`, no log file, no structured-event sink. Verified: a grep for `console\.|process\.stdout|process\.stderr` across all 11 files in `src/` returns zero matches.

The output channel of this plugin is exactly one thing: **the Markdown card that `render*` functions produce and the model reads.** That card is the UI and the log.

The governing consequence, stated as a rule:

> **A diagnostic that is not rendered does not exist.**

If the code learned something a reader needs — a quota was spent, a channel failed, a term was never measured, a probe was skipped — it must reach the card, as prose or as a number. Writing it to a console stream instead is not a lighter-weight option; it is a way for the information to be lost, because nothing in the host reads this plugin's stdout.

---

## Log Levels

Not applicable. There is no logging framework and therefore no level vocabulary.

The functional equivalents, and where each one lives:

| Conventional level | This project's equivalent | Where |
|-------------------|---------------------------|-------|
| `debug` | the rationale comments in the source | every module header |
| `info` | the card body — counts, rows, table, header line | `src/render.ts:349`, `:539`, `:953` |
| `warn` | a `degraded` note on the card | `src/query.ts:1232`, `src/github.ts:933` |
| `error` | `Degraded { reason, detail }` in the output | `src/types.ts:63`, 10 reasons in `src/index.ts` |

The `describe*` / `explain*` helper families are the message constructors: `describe*` names a cause, `explain*` writes what the reader should do about it. See `error-handling.md` for the full table.

---

## Structured Logging

Not applicable in the conventional sense — but the card *is* structured, and the structure is contract-bearing.

The machine-readable half of every diagnostic travels in the tool's output schema, not in prose:

```ts
// src/types.ts:63-68
export interface Degraded {
  reason: string   // a controlled vocabulary — see error-handling.md
  detail: string   // the human-readable sentence
}
```

`reason` is the field a caller can branch on; `detail` is what a reader sees. Keeping them separate is what allows `explainEmpty` (`src/render.ts:326`) to distinguish a genuine miss from an exhausted quota from a network failure — three cases that previously "rendered identically, so the calling agent had to guess at the cause (in practice it guessed 'rate limited' and gave up on the tool entirely)" (`src/render.ts:315-325`).

Structured counts are carried the same way, as required schema fields rather than as sentences: `tail_included`, `low_star_in_pool`, `low_star_in_kept`, `requests_used`, `noise.scored` / `noise` / `weak` / `kept` / `unanswered` / `noise_ratio`. A number the reader may need to act on belongs in the schema, where it is typed and asserted, not in a sentence.

---

## What to Log

Everything a reader needs, onto the card. The events this project considers reportable:

| Event | Rendered as | Site |
|-------|------------|------|
| A search returned nothing | `explainEmpty` — which of the three causes | `src/render.ts:326` |
| A retrieval channel failed | `describePartialFailure` — which channel, and what that does and does not prove | `src/query.ts:1232` |
| The result set is thin | `explainThinResult` / `describeReplayedThinness` | `src/query.ts:1329`, `:1372` |
| The term probe was skipped or partial | `probe_note` on the card | `src/github.ts:933`, `:977` |
| The idea's terms were not in the lexicon | `describeLexiconMiss` | `src/query.ts:1160` |
| The plan could not be built | `describePlanFailure` | `src/query.ts:1048` |
| Quota is exhausted or near | `rate_limited` / `quota_exceeded` plus `tokenRemedy()` | `src/index.ts:1202`, `:1767`, `src/query.ts:133` |
| A proxy is configured but invisible to Node's fetch | `proxyHint` | `src/github.ts:195` |
| A transport failure | `describeFailure` — the full `cause` chain | `src/github.ts:174` |
| A cached row came from a thin or incomplete fetch | `describeReplayedThinness` / `describeReplayedIncompleteness` | `src/query.ts:1372`, `:1399` |
| A repository could not be read | a row with `ok: false` and a populated `error` | `src/index.ts:1843` |

Two rules govern *how* these are written:

1. **Empty must be distinguishable from unchecked.** `probe_note: ''` means the probes ran and their counts are in `query_terms`; every other case carries a sentence, "because printing nothing reads as 'the terms were checked and are fine' — a claim about GitHub that the code is not entitled to make when the truth is a budget fact" (`src/index.ts:900-908`).
2. **Report the fact, not the inference.** A failed channel is reported as a channel that did not run, never as a claim about the rows that came back (`src/query.ts:1251-1257`).

---

## What NOT to Log

| Never | Why |
|-------|-----|
| The GitHub token, in any form, at any length | It is a credential. `TokenSetupResult.message` is documented "Never contains the token" (`src/credentials.ts:49-55`), and `state` carries only `configured` / `source` / `writable` from `describe()` — never the value. |
| Anything to `console.log` / `process.stdout` / `process.stderr` | There is no logging channel; output written there is lost. |
| A credential's value, even on a successful write | The host's own `describe(ref)` never returns the value and `set` refuses an empty one; this plugin mirrors that. |
| A raw API response body | No response body is ever read into a message. The `detail` on an HTTP failure is built from rate-limit **headers** by `describe()` (`src/github.ts:232`, called at `:421`): `limit=` / `remaining=` / `resetAt=` / `token=set\|none`. A body that is not JSON contributes only `describeFailure(error)` (`src/github.ts:402`), which walks the `Error` cause chain — never the payload. |
| A cached fetch's transient failure, replayed as current | "2/3 个查询失败" is a claim about one moment; printing it 20 hours later would assert queries failed when nothing was attempted. Only the weaker, still-true fact survives caching: these rows are a subset of what was asked for (`src/query.ts:1387-1405`). |
| Anything that reads as a stronger claim than the code measured | See `quality-guidelines.md` §"Honesty invariants". |

**On secrets specifically:** the token has to reach `configureGitHubToken` through the conversation, so it lands in the local session transcript. That cost is deliberate and disclosed — `tokenRemedy()` names it "in the same breath as the offer" (`src/credentials.ts:1-29`). What must never happen is the token additionally reaching a log stream, a card, or a `detail` string.
