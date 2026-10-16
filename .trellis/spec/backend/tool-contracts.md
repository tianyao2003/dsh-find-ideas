# Tool Contracts

> The parameter and output-schema contract of the three registered tools.

---

## Scope / Trigger

This is the plugin's **entire public API**. It is a contract document: change one of these keys, or one of these schema fields, and you have changed what every calling model can send and read.

Read this before:

- adding, renaming or removing a tool parameter;
- adding, renaming or removing an output-schema property;
- changing a `description` string on a parameter (several are asserted by tests);
- changing a tool's `timeoutMs`;
- changing what `render` receives or returns.

**Mandatory triggers** (from the Trellis spec rules): a changed command/API signature, a changed cross-layer request/response contract, or an infra integration. All three apply here — the tool schema *is* the cross-layer contract between the plugin and the host.

---

## Signatures

All three tools are registered inside `apply(ctx: Context): void` (`src/index.ts:781`) via `ctx.tools.register(defineTool({ ... }))`. **They are not module exports**, so a test reaches them only by calling `apply()` with a stub `ctx.tools.register` and capturing the definition objects.

| Tool | Registered | `parameters` | `output.schema` | `render` | `execute` | `timeoutMs` |
|------|-----------|--------------|-----------------|----------|-----------|-------------|
| `scout_projects` | `src/index.ts:782` | `:795-825` | `:827-929` | `:930-950` | `:952-1214` | `25000` `:1215` |
| `rank_candidates` | `src/index.ts:1218` | `:1244-1320` | `:1322-1418` | `:1419-1433` | `:1435-1492` | `5000` `:1493` |
| `inspect_projects` | `src/index.ts:1496` | `:1527-1564` | `:1566-1607` | `:1609-1614` | `:1616-1880` | `60000` `:1881` |

Registration order is call order: `scout_projects` (step 1) -> `rank_candidates` (step 2) -> `inspect_projects` (step 3, optional).

### Framework wiring: `def.output.render`, not `def.render`

The projection the model actually reads lives at **`def.output.render`**. There is no `def.render` — `test/declaration-honesty.test.mjs:20-21` states it directly: "`apply()` -> `rank_candidates.execute` -> `output.render`, and the projection lives at `def.output.render` — NOT at `def.render`, which does not exist."

`execute` returns the raw value; `output.render` is called with that value and returns the content blocks:

```ts
// src/index.ts:1419-1433 (shape)
render: (_args, value) => [{ type: 'text', text: renderRanked(value.idea, ...) }]
```

Tests use the shorthand `const renderOf = (def, value) => def.output.render({}, value)[0].text` (`test/diagnostics-honesty.test.mjs:108`, `test/evidence-chain.test.mjs:65`).

### Framework behaviour: property-level `required` is hoisted

A property-level `required: true` is **promoted by the framework into the schema's top-level `required` array**. It is not present on the property object at runtime.

```js
// test/diagnostics-honesty.test.mjs:348-352
// The framework hoists a property-level `required: true` into a top-level
// `required` array, so the flag is NOT on the property object at runtime.
// Checking `props.x.required` would fail against a schema that is in fact
// [correct].
const required = scout.output.schema.required ?? []
```

Consequence for tests and for reading this document: to check that a field is required, read the parent's `required` array — never `props.x.required`.

---

## Contracts

### `scout_projects` — GitHub prior-art search (step 1 of 2)

**Parameters** (`src/index.ts:795-825`)

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `idea` | string | **yes** (`:798`) | The project the user wants to build, in their own words. |
| `limit` | integer | no | Default 20, max `MAX_LIMIT` = 30 (`src/index.ts:168`). Clamped, not trusted. |
| `keywords` | string | no | Extra English search terms. Required in practice for a non-English idea. |

`keywords` is **enforced**: a call whose `idea` contains Han characters and whose `keywords` carries no Latin letter is refused with `plan_failed` before any search is sent (`src/index.ts:820-823`). The tool can check that Latin terms were supplied, never that they are a good translation.

**Output schema** (`src/index.ts:827-929`)

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `idea` | string | yes | Echo of the input. |
| `cached` | boolean | yes | Served from the 24h disk cache. |
| `candidates` | array of object | yes | `full_name`, `url`, `owner`, `name`, `description`, `stars` (number), `language`, `pushed_at`, `archived` (boolean), `topics` (string[]) — all required, `additionalProperties: false` (`:838`). |
| `tail_included` | integer | yes | Rows admitted **because of a reserved slot** (`selectPool`), not every row at or below the ceiling. |
| `low_star_in_pool` | integer | yes | Rows at or below `TAIL_STAR_CEILING` in the returned pool. Deliberately a second number (§7.6/AC12). |
| `query_terms` | array of object | yes | `term` (string), `total` (number), `verdict` (string) — all required. |
| `probe_note` | string | yes | Why the per-term diagnostic is missing or partial. **Empty means the probes ran.** |
| `degraded` | object \| null | yes | `oneOf: [{ reason, detail }, { type: 'null' }]` (`:914-927`). |

`tail_included` and `low_star_in_pool` are two different measurements and both are required (`test/diagnostics-honesty.test.mjs:354-358` asserts both are present and in the top-level `required` array). They diverge in the case that matters: an all-small pool has every row below the ceiling and almost no reserved ones, so one number would report the population as absent exactly where it is largest (`src/index.ts:866-879`).

**The `-1` encoding.** The schema language has no `null` in a number position, so an unmeasured term total travels as `TERM_TOTAL_UNKNOWN = -1` (`src/types.ts:240`) and is converted back at the render boundary:

```ts
// src/index.ts:939-946
value.query_terms.map((entry) => ({
  term: entry.term,
  total: entry.total < 0 ? null : entry.total,
  verdict: entry.verdict === 'carrying' ? ('carrying' as const) : ('selective' as const),
})) as TermReport[],
```

This is the **one** place the encoding is spelled out; the renderer only ever sees a `TermReport` whose `total` is `number | null`.

### `rank_candidates` — deterministic scoring + card (step 2 of 2)

**Parameters** (`src/index.ts:1244-1320`)

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `idea` | string | **yes** (`:1247`) | The same idea text passed to `scout_projects`. |
| `candidates` | array of object | **yes** (`:1252`) | The pool to rank — same 10 fields as `scout_projects`' candidate items, all required, `additionalProperties: false` (`:1262`). |
| `scores` | array of object | **yes** (`:1279`) | `full_name` (string, required), `relevance` (integer, required, 0-10, `0` drops), `note` (string, **optional**). |
| `keywords` | string | no | Used only to check a low-scored candidate's description; never enters the formula. |
| `pool_source` | string | no | `"scout_projects"` or `"agent"`. Purely descriptive. |
| `limit` | integer | no | Default 10, max `MAX_LIMIT` = 30. |

**The parameter key set is pinned by a test.** `test/ranking.test.mjs:177`:

```js
JSON.stringify(Object.keys(rank.parameters.properties ?? {}).sort()) ===
  JSON.stringify(['candidates', 'idea', 'keywords', 'limit', 'pool_source', 'scores'])
```

Adding, renaming or removing any parameter fails the suite until that literal is updated deliberately. Adjacent assertions in the same file:

| Assertion | Site | Pins |
|-----------|------|------|
| `pool_source` description matches `/changes no number|descriptive/i` | `:182` | the field stays descriptive-only |
| `keywords` description matches `/never enters the ranking formula/i` | `:183` | the field never becomes a ranking input |
| `!('stars' in props) && !('stars_rating' in props)` | `:184` | **the agent cannot pass stars or a rating to the ranker** |
| `'note' in scores.items.properties && !('note' in parameters.properties)` | `:188-190` | `note` belongs to a score row, not to the call |

**Output schema** (`src/index.ts:1322-1418`)

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `idea` | string | yes | Echo. |
| `total` | number | yes | Rows kept. |
| `ranked` | array of object | yes | 16 fields, `additionalProperties: false` (`:1333`). |
| `unknown` | string[] | yes | Scored names that matched no candidate. Reported, never dropped silently. |
| `dropped` | string[] | yes | Scored `relevance: 0`. |
| `below_threshold` | string[] | yes | Scored below `MIN_RELEVANCE = 3` (`src/types.ts:310`). |
| `suspicious` | array of object | yes | `full_name`, `relevance`, `matched` (string[]), `quote`, `kind`, `against` — all required (`src/index.ts:1371-1388`). |
| `noise` | object | yes | `scored`, `noise`, `weak`, `kept`, `unanswered`, `noise_ratio` (numbers), `low_star_in_pool`, `low_star_in_kept` (integers) — all required (`src/index.ts:1392-1412`). |
| `pool_source` | string | yes | Empty string means the caller did not say. |

`ranked` items, in schema order: `rank`, `full_name`, `url`, `owner`, `name`, `description`, `stars`, `language`, `pushed_at`, `archived`, `topics`, `relevance`, `stars_rating`, `score`, `html_url`, `note`.

Two of these carry a rule:

- **`html_url` is the fetched canonical url, never a reconstruction from `full_name`** (`src/index.ts:1349-1351`) — GitHub's owner path segment is case-sensitive, so a lowercase rebuild 404s for repos like `FuRongJun-1999/dsh-memory`.
- **`note` is deliberately optional** (`src/index.ts:1360`, no `required: true`). A score without a stated reason is a real case the consistency rules report as `noteGap`, not a malformed row. It was once accepted as input and read by the renderer but never declared here, so it was dropped between the two and the caller-note block could never be non-empty (`src/index.ts:1352-1359`).

`low_star_in_pool` / `low_star_in_kept` are asserted to be required integers on the `noise` object by `test/diagnostics-honesty.test.mjs:364-371`. They are only meaningful together: a bare "3 small projects kept" reads as "the long tail was served" when the pool may have held 20 and the formula pushed 17 out (`src/index.ts:1403-1410`).

**`rank_candidates` has no degraded path.** It is pure and local — no network, no cache, no token — so `execute` (`:1435`) always produces a card. There is no `degraded` field in its output schema.

### `inspect_projects` — source reading (step 3)

**Parameters** (`src/index.ts:1527-1564`)

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `idea` | string | **yes** (`:1530`) | The idea the user is building toward. |
| `repos` | string[] | **yes** (`:1535`) | `"owner/repo"` strings. At most `MAX_INSPECT_REPOS` = 5 per call (`src/index.ts:171`). |
| `depth` | string, `enum: ['shallow','deep']` | no | `shallow` default, ~6 requests/repo; `deep` ~10. Budgets at `src/index.ts:185-188`. |
| `files` | string[] | no | Explicit paths, relative to the repo root. **Override the selector, including for paths it would reject** (`src/index.ts:1558-1560`). Cost: one extra request per path per repo. |

`files` is the only parameter in the whole plugin whose description is asserted by a test (`test/ranking.test.mjs:199` reads `inspect.parameters.properties?.files?.description`).

**Output schema** (`src/index.ts:1566-1607`)

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `idea` | string | yes | Echo. |
| `cached` | boolean | yes | Served from cache. |
| `depth` | string | yes | The depth actually used. |
| `requests_used` | number | yes | Requests spent, counted from before the quota probe. |
| `inspections` | array of object | yes | `full_name`, `url`, `ok` (boolean), `files_read` (string[]), `readme_excerpt`, `manifest_excerpt`, `tree_summary`, `skeleton_summary`, `error` — all required strings/arrays (`:1577-1590`). |
| `degraded` | object \| null | yes | Same `oneOf` shape as `scout_projects`. |

An inspection with `ok: false` still carries `full_name`, `url` and a populated `error` — a failed read is a reported row, never a silently skipped one.

**Refusals happen before any work.** `execute` (`:1616`) refuses `repos.length > MAX_INSPECT_REPOS` with `too_many_repos` (`:1654`) and an empty array with `no_repos` (`:1659`), both with Chinese prose naming the batch size to use instead. The request counter is declared *above* the quota probe so a refusal is still counted.

**The 60-second ceiling is a contract, not a tuning value.** The host terminates the call at 60s and returns **nothing** when it does — not even repositories already read. `src/index.ts:211` therefore duplicates the timeout as `INSPECT_TIMEOUT_MS = 60000` so the budget check (`:1681`, `:1682`) can run before the work starts.

> **The pair is now pinned by the suite.** `src/index.ts:206-209` states why the ceiling is exported: so S9 can assert the registered `timeoutMs` IS this constant and that the constant is the 60000ms the host enforces. S9 does both — `test/queries.test.mjs:782-784` asserts `inspect.timeoutMs === index.INSPECT_TIMEOUT_MS`, and `:785-787` asserts `index.INSPECT_TIMEOUT_MS === 60000`. A drift between the registration (`:1881`) and the constant (`:211`) therefore fails the suite rather than silently re-budgeting. (This note previously said the opposite — that the comment claimed a guard which did not exist. That was true when it was written: S9 then asserted only `typeof inspect.timeoutMs === 'number'`, and no test named `INSPECT_TIMEOUT_MS`. The assertion has since been added, so the warning is obsolete, not the comment.)

---

## Validation & Error Matrix

| Condition | Tool | `degraded.reason` | Site |
|-----------|------|-------------------|------|
| Han idea, no Latin keywords | `scout_projects` | `plan_failed` | `src/index.ts:1008` |
| Planner threw / could not build | `scout_projects` | `plan_failed` | `src/index.ts:1043` |
| Some channels failed | `scout_projects` | `partial` | `src/index.ts:1169` |
| Result set smaller than GitHub implied | `scout_projects` | `thin_result` | `src/index.ts:1183` |
| GitHub refused (403/429) | `scout_projects` | `rate_limited` | `src/index.ts:1202` |
| Search request failed | `scout_projects` | `search_failed` | `src/index.ts:1208` |
| Cached row was thin / incomplete | `scout_projects` | `thin_result` / `partial` | `src/index.ts:1086`, `:1088` |
| More than 5 repos | `inspect_projects` | `too_many_repos` | `src/index.ts:1654` |
| Empty `repos` | `inspect_projects` | `no_repos` | `src/index.ts:1659` |
| Per-call request budget would be breached | `inspect_projects` | `quota_exceeded` | `src/index.ts:1767`, `:1776` |
| Wall-clock share would be breached | `inspect_projects` | `time_budget_exceeded` | `src/index.ts:1808` |
| GitHub refused | `inspect_projects` | `rate_limited` | `src/index.ts:1832` |
| Reading a repo failed | `inspect_projects` | `inspect_failed` | `src/index.ts:1843` |
| Some repos read, some not | `inspect_projects` | `partial` | `src/index.ts:1871` |
| Any | `rank_candidates` | — | no degraded path exists |

`Degraded.reason` is a plain `string`, not a union: `output.schema` is what `defineTool` uses to infer the `execute` return type, and the schema language has no unions. The same constraint forces `Suspicion.kind: string` and the empty-string sentinel on `Suspicion.against`.

---

## Good / Base / Bad Cases

**Good — a full three-step call.** `scout_projects` returns 25 candidates with `low_star_in_pool: 9` and `probe_note: ''`; the model scores all 25; `rank_candidates` returns a card whose `noise` block reports `low_star_in_pool: 25, low_star_in_kept: 3`, making the long-tail loss visible as a number.

**Base — a degraded first step.** `scout_projects` returns `degraded: { reason: 'rate_limited', detail: ... }` with zero candidates. The model reads `explainEmpty` on the card, which says this is a quota problem and not an absence of matching projects, and reports that to the user instead of concluding nothing exists.

**Bad — a pool the model gathered itself, unlabelled.** The model runs its own GitHub search, passes the results to `rank_candidates`, and omits `pool_source`. The card reports an empty `pool_source`, which means "the caller did not say" — a reader cannot tell a tool-gathered pool from a self-gathered one. Pass `"agent"`.

**Bad — reconstructing a url from `full_name`.** The model emits a lowercase URL for a repo whose owner has capitals. The card's `html_url` is correct; the model's is a 404. The card's value is authoritative.

---

## Tests Required

Assertion points that must survive any change to this contract:

| Test | Group | Asserts |
|------|-------|---------|
| `test/ranking.test.mjs` | `:177` | the exact `rank_candidates` parameter key set |
| `test/ranking.test.mjs` | `:182-190` | `pool_source` descriptive, `keywords` non-formulaic, no `stars`/`stars_rating` parameter, `note` on the score row only |
| `test/ranking.test.mjs` | `:199` | the `files` parameter description |
| `test/declaration-honesty.test.mjs` | S1 | `typeof def.output.render === 'function'`, and `execute` + `output.render` complete without throwing |
| `test/diagnostics-honesty.test.mjs` | D-groups | `low_star_in_pool` and `tail_included` are required integers; `noise.low_star_in_pool`/`low_star_in_kept` likewise — read from the **top-level `required` array** |
| `test/evidence-chain.test.mjs` | `:119` | the `ranked` item property set |
| `test/queries.test.mjs` | S9 | `inspect.timeoutMs` is a positive number (it does **not** assert equality with `INSPECT_TIMEOUT_MS` — see the warning above) |
| `test/translate.test.mjs` | `:164` | `TranslateOutcome`'s key set is exactly `["degraded","keywords","source"]` |

Every output-schema root and every nested object carries `additionalProperties: false` (`src/index.ts:829`, `:838`, `:888`, `:919`, `:1262`, `:1283`, `:1324`, `:1333`, `:1376`, `:1395`, `:1568`, `:1579`, `:1598`). A new field must be declared in **both** the schema and the `render` projection — declaring it in one place only is exactly the `note` defect (`src/index.ts:1352-1359`).

---

## Wrong vs Correct

**1. Checking a property-level `required` flag**

```js
// WRONG — the framework hoists it; this is always undefined
check('required', props.low_star_in_pool.required === true)

// CORRECT — read the parent's required array
const required = scout.output.schema.required ?? []
check('required', required.includes('low_star_in_pool'))
```

**2. Reaching for the projection**

```js
// WRONG — def.render does not exist
const text = rankTool.render(args, value)[0].text

// CORRECT
const text = rankTool.output.render(args, value)[0].text
```

**3. Declaring a field in the schema but not in the projection**

```ts
// WRONG — accepted as input, read by the renderer, dropped in between
//   (this is the real `note` defect, src/index.ts:1352-1359)
// CORRECT — declare it in the output schema AND pass it through `render`
note: { type: 'string' },   // src/index.ts:1360
```

**4. Encoding "unmeasured" as `0`**

```ts
// WRONG — 0 already means "the term matched nothing on its own"
total: termTotals.get(term) ?? 0

// CORRECT — sentinel travels as -1, converted to null at the render boundary
total: termTotals.get(term) ?? TERM_TOTAL_UNKNOWN   // src/index.ts:136
```

**5. Letting the agent supply a number the code computes**

```js
// WRONG — a `stars` or `stars_rating` parameter would let prose set a score
// CORRECT — the key set is pinned; the agent supplies only `relevance`
//   test/ranking.test.mjs:184
```
