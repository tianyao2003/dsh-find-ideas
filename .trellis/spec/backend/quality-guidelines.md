# Quality Guidelines

> Code quality standards for this project.

---

## Overview

The quality bar in this repository is unusually explicit, because almost every rule was paid for with a measured field failure. Two rules dominate everything else:

1. **The card must not claim more than the code measured.** This is the project's central invariant and it is enforced across `src/types.ts`, `src/query.ts`, `src/render.ts` and the output schemas.
2. **A test that would still pass against the defect is not a regression test.** Anti-vacuity controls are mandatory; mutation testing is established practice.

There is no linter and no formatter config. `npm run check` is `typecheck && build` — `tsc` is the only automated gate on style, and it is a strict one.

---

## Forbidden Patterns

| Forbidden | Reason | Enforced by |
|-----------|--------|-------------|
| `console.log` / `process.stdout` / `process.stderr` anywhere in `src/` | There is no logging channel. Everything a reader needs must be rendered onto the card; a diagnostic that is not rendered does not exist for the caller. Verified: zero matches for `console\.|process\.stdout|process\.stderr` across all 11 `src/*.ts`. | **Review only — no test enforces this.** A grep for `console\.` / `process\.stdout` / `process\.stderr` across `test/*.mjs` returns no matches. The rule is upheld by the honesty tests indirectly: a value that never reaches the card fails the assertions that read it. |
| Reporting an unmeasured value as `0` | `0` is a measurement ("this term matched nothing on its own"); absence of a measurement is not zero. | `test/diagnostics-honesty.test.mjs`, `test/evidence-integrity.test.mjs` |
| Claiming rows are all high-star because a channel failed | A failed channel proves the lane did not run, not what the surviving lanes returned. | `test/plan-failure.test.mjs`, `test/diagnostics-honesty.test.mjs` |
| Re-parsing a failure message to recover a fact | Reword the message and the logic silently stops firing, with both halves still "working". The fact must travel as a field. | `test/plan-failure.test.mjs` |
| Text-grep assertions over `src/*.ts` as behavioural coverage | "Those assertions pass as long as the characters remain in the file — they keep passing when the behaviour they name is broken." | Convention, not a blanket ban — see below. `test/queries.test.mjs:1-16` records the replacement for the planner and the selector. |
| `node --test` / `npm run test:runner` | The runner spawns one child per file with piped stdio; in this project's sandbox that has been refused, producing **false negatives**. | `test/run-all.test.mjs` header; `test/skeleton.test.mjs` header states the rule in-source |
| Asserting on a value you must re-type whenever the guarded thing improves | "An assertion you must edit whenever the thing it guards improves is not a guard." | `test/stage2.test.mjs:82-83` |
| Letting a missing optional host service throw at module load | A plugin that throws on load takes the whole host down — a steep price for a missing optional token. Reach optional services with `ctx.get`, never by declaring them in `inject`. | `src/index.ts:153-160` |
| Reconstructing a GitHub URL from `full_name` | The owner path segment is case-sensitive; a lowercase rebuild 404s. | `src/types.ts:183-239` (`html_url`), `src/index.ts:1361-1363` |
| A second definition of one fact | "One fact with two definitions disagrees with itself eventually." | `src/select.ts:11-21` (`MANIFEST_RE`); `src/github.ts:70-79` (`countLowStar`) |
| Enums, parameter properties, namespaces | `erasableSyntaxOnly: true` — TypeScript syntax must be erasable. | `tsconfig.json:18` |
| Importing without the `.ts` extension | `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` are on; every intra-project import is written `from './types.ts'`. | `tsconfig.json:19-20`; `tsc` |
| A required field added to the cached shape without a `CACHE_VERSION` bump | A stale entry reads the new field back as `undefined`, and `undefined !== null` tests flip. | `src/cache.ts:23`, `:62-77` |
| Editing source text without running the integrity gate | A lossy encoding round-trip once rewrote the whole tree; the damage is silent (a vanished space or digit changes a measurement). | `test/source-integrity.test.mjs` |

---

## Required Patterns

### Anti-vacuity controls

Every regression group must fail if the machinery under it never ran. `test/evidence-integrity.test.mjs` states the rule: "Each group is the smallest input that separates the fixed behaviour from the old one, and each is written so that REMOVING the fix makes it fail... every group also carries an anti-vacuity control — a case that must FAIL if the machinery under it never ran (a 429 that was really served, a score gap that really fires, a cap that really binds)."

### Mutation testing

Established practice: copy `lib/` into a scratch directory, mutate the copy, and prove the new test actually fails against the mutation. Several test files ship with recorded mutation results. A test that has not been shown to fail is not yet a test.

### Rationale lives in the source

Every non-obvious constant, rule and extraction carries a doc comment naming the measured failure that produced it. This is not decoration — the headers are the project's institutional memory and the reason a later reader can tell a deliberate choice from an accident. Examples: `src/render.ts:30-46` (the 668,409-byte description incident behind `MAX_DESCRIPTION_CHARS`), `src/github.ts:52-59` (`TAIL_STAR_CEILING` names the four projects that were unreachable), `src/index.ts:225` (`TIME_BUDGET_SHARE` explains 0.75).

### Honesty invariants

| Invariant | Where |
|-----------|-------|
| An unmeasured term is `TERM_TOTAL_UNKNOWN` (`-1`), labelled unmeasured, distinct from a measured `0` | `src/types.ts:257`, `src/index.ts:136`, `:142-144` |
| Pool low-star count and kept low-star count are **two** numbers; their difference is the measurement | `src/github.ts:70-79`, `src/index.ts:871-883`, `:1415-1422` |
| A failed channel means coverage unknown, never "the rows are all high-star" | `src/query.ts:1251-1257` |
| `null` for an unreported pool population, never a defaulted `0` | `src/render.ts:357-364` |
| A cached fetch's failure is not reported as a current one | `src/query.ts:1387-1405` |
| A probe that did not run must say so, even on an empty card | `src/render.ts:367-373` |

### Types

`strict: true` and `noUncheckedIndexedAccess: true`. Indexed access is guarded everywhere; there are no non-null assertions on array access. `as` casts are confined to the boundaries where a schema-shaped value meets a typed one:

- `src/index.ts:1454`, `:1457`, `:1466-1468` — `args.candidates as RepoCandidate[]`, `args.scores as RelevanceInput[]`
- `src/index.ts:951`, `:1624` — the render-boundary coercions (`as TermReport[]`, `as Inspection[]`)
- `src/cache.ts:195`, `:199` — `hit.data as T`, `JSON.parse(...) as DiskEnvelope<T>`
- `src/credentials.ts:66` — `get.call(ctx, 'credentials') as CredentialService | undefined`
- `src/github.ts:437` — `item.owner as Record<string, unknown> | undefined`

There is no `any`, no `@ts-ignore`, no `@ts-expect-error` and no `as unknown as` anywhere in `src/`.

### Exports

Export only what another module or a test needs. Module-private by default — see `directory-structure.md` §"Private-by-default" for the `cache.ts` surface as the worked example.

---

## Testing Requirements

### Running tests

```bash
npx tsc -p tsconfig.json      # REQUIRED after any src/ edit
node test/ranking.test.mjs    # one file
npm test                      # the whole suite via test/run-all.test.mjs
```

**Never `node --test`, and never `npm run test:runner`.** Both are known to produce false negatives in this environment: the runner spawns one child per file with piped stdio, which the sandbox has refused. `test/run-all.test.mjs` spawns each file with `stdio: 'inherit'` and judges by exit code instead.

### Tests consume `lib/`, not `src/`

The universal loader is:

```js
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)
```

**A red test may mean a stale build, not a broken change.** Run `tsc` first. This indirection has already hidden a real defect: during the encoding incident the suite reported 10/10 while the source no longer compiled, because every test imported the previously built `lib/`.

### Assertion harness

A local `check(name, condition, detail)` helper per file — **not** `node:test` and not `node:assert`. It prints `PASS` / `FAIL` and tracks counts; each file ends with a summary line and exits non-zero on any failure. Two shapes exist: `function check(label, cond, detail = '')` (most files) and `function check(label, actual, ...expected)` (`test/bilingual-routing.test.mjs:23`).

### Suite mechanics

`test/run-all.test.mjs` auto-discovers `test/*.test.mjs`, excludes itself, sorts, and spawns each file. A file counts as **skipped** (not failed) when it exits 0 **and** left a marker file at `$DSH_SKIP_MARKER`. Skipped files are printed as `skipped (fixture absent, NOT verified)` — "SKIPPED IS NOT PASSED". `test/baseline.test.mjs` and `test/stage2.test.mjs` skip when the `eval/runs/**` fixtures are absent.

### Scratch `DSH_HOME`

Any test touching the cache must set a scratch `DSH_HOME` **before importing the module under test** (`test/cache.test.mjs:27`: "a scratch directory first — this must happen BEFORE the module is imported"), and clean it up with `rmSync(scratch, { recursive: true, force: true })`. Two roots are used: `mkdtempSync(join(tmpdir(), 'dsh-<name>-'))` and an in-package `.scratch/` root.

### No network, no real model

`test/probe-guard.test.mjs`: "Every case stubs `globalThis.fetch`, so this file never touches the network." `test/translate.test.mjs`: "Every test here uses a STUB. No test in this file calls a real model, and none should ever be changed to."

### The source-integrity gate

`test/source-integrity.test.mjs` is a text gate over `src/*.ts` and must be run after editing source text. It rejects:

| Group | Rule |
|-------|------|
| T1 | any U+FFFD anywhere in the package |
| T2 | loss of the 19 CJK lexicon keys or the 5 ecosystem keys |
| T3 | a CJK character immediately followed by a Latin character (count must be exactly 0 in all six scanned modules) |
| T4 | an em-dash, star or arrow immediately followed by Latin/digit without a space (`≤` deliberately excluded) |
| T5 | loss of the measured numbers `2,528–73,328`, `0–566`, `≤100` |

The header records the 2026-10-12 incident that produced it: a lossy encoding round-trip rewrote the tree, damaging one 3-byte character plus the following byte. The loud failure was `Unterminated string literal` (28 of them); the **silent** failure was a vanished space or digit — `2,528–73,328` became `2,528—3,328` and `≤100` became `≤00`, changing a measurement with no test failing.

---

## Code Review Checklist

- [ ] Does the change touch `src/`? Then `npx tsc -p tsconfig.json` was run before testing.
- [ ] Did source **text** change? Then `node test/source-integrity.test.mjs` was run.
- [ ] Does any new number, count or claim on the card assert more than the code measured? (Unmeasured vs zero; channel failure vs row population.)
- [ ] Is any fact defined twice? (A constant needing a value from a higher layer belongs where that value lives — `TAIL_STAR_CEILING` in `github.ts`, not `types.ts`.)
- [ ] Does a new output-schema field also appear in the `render` projection? (The `note` defect.)
- [ ] Is the new test proven to fail against the defect (mutate `lib/` in a scratch copy)?
- [ ] Does the new test group carry an anti-vacuity control?
- [ ] Is a new tool parameter added? Then `test/ranking.test.mjs:177`'s pinned key set was updated deliberately, not reflexively.
- [ ] Is a new required field added to the cached shape? Then `CACHE_VERSION` was bumped.
- [ ] Does any new error path throw instead of degrading?
- [ ] Did anything start logging to the console? It must not.
- [ ] Are the rationale comments present for any non-obvious constant or rule?
