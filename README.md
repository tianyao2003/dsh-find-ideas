# dsh-find-ideas

A DeepSeek Harness (DSH) plugin that answers one question: **has someone already built the thing you are about to build?**

The user describes a project idea in their own words. The plugin searches GitHub for repositories that resemble it, ranks the pool against the caller's own relevance judgements with a formula computed entirely in code, and then reads the actual source of the repositories the user picks — README, dependency manifest, directory tree and key files — so the comparison rests on code rather than on a one-line description. It registers exactly three tools (`scout_projects`, `rank_candidates`, `inspect_projects`) and declares zero runtime dependencies (`dependencies` is `{}` in `package.json`).

The plugin's distinguishing property is not retrieval quality but **honesty about what it measured**: every card separates code-computed numbers from caller-supplied text, unverified claims are labelled, long-tail loss is reported as two separate counts, "not measured" is never rendered as "measured zero", all third-party text is presented as untrusted data, and no failure path throws to the caller.

A **card** here means the rendered text a model actually reads. All three tools return one, but only `rank_candidates` produces the *ranked card* — the table that carries the `【代码计算区】` declaration below. When this README says "the card" without qualification, it means that one.

## The three tools

### `scout_projects` — step 1, gather a candidate pool

Registered at `src/index.ts:783` with `timeoutMs: 25000` (`src/index.ts:1215`). It turns the idea into a three-query GitHub search plan and returns raw, star-sorted candidates — deliberately **not** ranked by relevance.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `idea` | string | yes | The project the user wants to build, in their own words, any language. The tool translates a non-English idea itself (`src/index.ts:800-805`). |
| `limit` | integer | no | Maximum candidates. Default 20, clamped to `MAX_LIMIT` (`src/index.ts:954`). |
| `keywords` | string | no | Optional caller-supplied search terms. When present they **win** over the tool's own translation and are searched verbatim (`src/index.ts:814-823`). |

Returns `idea`, `cached`, `candidates[]` (`full_name`, `url`, `owner`, `name`, `description`, `stars`, `language`, `pushed_at`, `archived`, `topics`), `tail_included`, `low_star_in_pool`, `query_terms[]`, `probe_note`, and `degraded`.

Each candidate is rendered as one numbered entry line carrying its **last-updated timestamp**, its stars and its language, in that order, with the description and the url on their own indented lines below (`src/render.ts:382`). `pushed_at` is required on every candidate and the ranked table spends a whole column on it, so the flat list shows it too rather than making the reader call step 2 for the one fact.

Two behaviours are worth knowing before calling it:

- **A Chinese idea with no Latin term in `keywords` can be refused.** If the idea contains Han characters, no Latin letter is supplied, *and* the tool's own translation is unavailable, the call is refused with `degraded.reason === 'plan_failed'` before any search is sent (`src/index.ts:820-823`, `src/index.ts:1001-1007`). The check only ever proves "Latin terms were supplied", never "the translation was good".
- **A plan defect is a degradation, not a crash.** `buildQueries` used to throw on inputs it could not turn into a legal plan, and the exception escaped the tool entirely; it is now wrapped and returned as a `plan_failed` value (`src/index.ts:1019-1044`).

### `rank_candidates` — step 2, the only place a ranked card is produced

Registered at `src/index.ts:1219` with `timeoutMs: 5000` (`src/index.ts:1493`). It is deterministic: the caller supplies relevance judgements and nothing else, and all ordering is computed in code.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `idea` | string | yes | The same idea text passed to `scout_projects`. |
| `candidates` | array | yes | The whole pool, in the candidate shape above. It does **not** have to come from `scout_projects` — a pool the agent gathered itself with its own GitHub qualifiers is accepted (`src/index.ts:1254-1259`). |
| `scores` | array | yes | One `{ full_name, relevance, note? }` per candidate. `relevance` is an integer 0-10; 0 drops the candidate. Names not present in `candidates` are ignored (`src/index.ts:1280`). |
| `keywords` | string | no | Used only for the contradiction check, never in the formula (`src/index.ts:1306-1307`). |
| `pool_source` | string | no | `"scout_projects"` or `"agent"`. Purely descriptive — changes no number, gates no check — but it is printed on the card (`src/index.ts:1311-1314`). |
| `limit` | integer | no | Rows kept after ranking. Default 10, clamped to `MAX_LIMIT` (`src/index.ts:1437`). |

The score is

```
score = relevance × (1 + log10(max(stars, 10) + 1)) / 2
```

(`src/types.ts:146-148`), with the floor `STAR_FLOOR = 10` (`src/types.ts:103`) so that a plain `log10(stars + 1)` cannot pin an on-point zero-star project to the bottom. `stars_rating` is a display-only pure function of `relevance` (`src/types.ts:94-100`) and never enters the score.

Rows are excluded in two ways: `relevance === 0` becomes `dropped`, and `relevance < MIN_RELEVANCE` (3, `src/types.ts:310`) becomes `below_threshold`. Sorting is by score, then stars, then `full_name` (`src/types.ts:755-820`). Each row's link is the `url` GitHub returned, never a reconstructed one — the owner path segment is case-sensitive and a lower-cased URL 404s (`src/render.ts:640-649`).

### `inspect_projects` — read the source, not the description

Registered at `src/index.ts:1497` with `timeoutMs: INSPECT_TIMEOUT_MS` (`src/index.ts:1881`). It fetches the README, the dependency manifest, a directory-tree summary and up to `maxFiles` key files per repository, and scans the file-head excerpt for class, function, method, interface, type, struct, trait, impl and enum declarations.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `idea` | string | yes | The idea the user is building toward. |
| `repos` | array | yes | `"owner/repo"` strings. At most `MAX_INSPECT_REPOS` per call (`src/index.ts:1533-1539`). |
| `depth` | string | no | `shallow` (default, ≈6 requests per repo) or `deep` (≈10 requests per repo) (`src/index.ts:1541-1548`). |
| `files` | array | no | Explicit repo-relative paths to read instead of the automatic selection; one extra request per path per repo (`src/index.ts:1550-1556`). |

Without `files`, `src/select.ts` picks the files automatically — root README, a frontend entry point, a native/backend entry point, and a manifest or design document (`src/index.ts:1508-1511`).

The signature scanner is explicitly a **file-head local declaration scanner**, not an architecture extractor: it reads only the first `EXCERPT_WINDOW_CHARS` (1200) characters of a file (`src/skeleton.ts:39`), so class and function bodies normally fall outside the window. It never returns an empty array — `hits[0]` is always a file-level fact record built by `buildFact` with `name: ''` (`src/skeleton.ts:333`) and `startLine: 0` (`src/skeleton.ts:335`), pushed before any declaration is considered (`src/skeleton.ts:377-381`) — and it reports `supported` / `truncated` / `excerptChars` precisely so that a caller can tell "no declarations found in this window" from "this extension is not in the scanner's language coverage at all" (`src/skeleton.ts:9-24`, `src/skeleton.ts:369-376`).

## Installation

The package is loaded into a DSH profile as a bundle patch. `package.json` declares

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

and `cordis.patch.yml` inserts the plugin into the profile's layer stack:

```yaml
- insert:
    - id: find-ideas
      name: 'dsh-find-ideas'
```

A profile lists the package in its `dependencies` and in `dsh.profile.bundles`; DSH then applies the patch above when the profile loads. Because the patch is resolved through the package's own `exports` map (`"./cordis.patch.yml"` is an exported subpath), the file is reachable without depending on the installed directory layout.

### Peer dependencies

The plugin declares two peers and no dependencies:

- `@deepseek-ai/cordis` — `^4.0.1`
- `@deepseek-ai/dsh-tools` — `^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.2 || ^0.1.3-alpha.2 || ^0.1.5-alpha.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1 || ^0.2.0-rc.1`

The `dsh-tools` range names every shipped host line on purpose. node-semver only lets a prerelease satisfy a range that carries a prerelease on the same `major.minor.patch`, so a range pinned to one host line stops matching the next one. `npm run check:peers` (`scripts/check-peers.mjs`) resolves the `latest` and `next` lines of `@deepseek-ai/dsh` from the npm registry, reads the `@deepseek-ai/dsh-tools` version each line installs, and exits non-zero with `NOT COVERED` if the declared range rejects any of them (`scripts/check-peers.mjs:42-48`, `:91`, `:133-138`). If the registry is unreachable the check prints `skipped -- registry unavailable` and exits 0, because a network outage must not look like a bug in this package (`scripts/check-peers.mjs:96-102`).

## Building and testing

```sh
npm install
npm run typecheck     # tsc -p tsconfig.json --noEmit
npm run build         # tsc -p tsconfig.json  ->  lib/
npm test              # node test/run-all.test.mjs
npm run check         # typecheck + build
npm run check:peers   # resolve the current DSH host lines from the registry
```

**`npm run build` must run after every source edit, before `npm test`.** The tests import the compiled output, not the sources — each test file loads modules through `import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)`. `lib/` is gitignored and is regenerated by the build, so on a fresh clone there is nothing to test until `npm run build` has run. A green run against a stale `lib/` is the one failure mode that ordering prevents.

`npm test` is the supported entry point. `npm run test:runner` uses `node --test "test/**/*.test.mjs"`, which is the natural tool but spawns one child process per test file with piped stdio; in sandboxes that refuse piped child stdio this produces false negatives. `test/run-all.test.mjs` instead runs each file sequentially through `spawnSync` with `stdio: 'inherit'`, and reports a refused spawn as a failure rather than silently passing (`test/run-all.test.mjs:3-7`).

Requires Node ≥ 22 (`engines` in `package.json`).

## Budgets and limits

Every number below is a constant in the source, not an estimate.

| Constant | Value | Where |
|---|---|---|
| `MAX_LIMIT` | 30 (hard ceiling for `limit` on both search and ranking) | `src/index.ts:168` |
| `MAX_INSPECT_REPOS` | 5 repositories per `inspect_projects` call | `src/index.ts:171` |
| `INSPECT_TIMEOUT_MS` | 60000 ms (host kill point; nothing is returned when it fires) | `src/index.ts:211` |
| `TIME_BUDGET_SHARE` | 0.75, i.e. a 45000 ms read budget inside that ceiling | `src/index.ts:225`, `src/index.ts:1681` |
| `INSPECT_BUDGET.shallow` | `readmeChars` 4000, `treeEntries` 20000, `maxFiles` 4, `requestsPerRepo` 6, `msPerRepo` 4500 | `src/index.ts:186` |
| `INSPECT_BUDGET.deep` | `readmeChars` 12000, `treeEntries` 20000, `maxFiles` 8, `requestsPerRepo` 10, `msPerRepo` 6500 | `src/index.ts:187` |
| `scout_projects` default `limit` | 20 | `src/index.ts:954` |
| `rank_candidates` default `limit` | 10 | `src/index.ts:1437` |
| Tool timeouts | 25000 ms / 5000 ms / 60000 ms | `src/index.ts:1215`, `:1493`, `:1881` |
| `TAIL_STAR_CEILING` | 100 (a repository at or below this is "long tail") | `src/github.ts:60` |
| `TAIL_RESERVED_SLOTS` | 8 slots reserved so star-descending truncation cannot crowd the tail out | `src/github.ts:68` |
| `MAX_TERM_PROBES` | 3 solo per-term diagnostic probes | `src/github.ts:852` |
| `MAX_QUERIES` | 3 queries per search plan | `src/query.ts:146` |
| `MAX_QUERY_TERMS` | 6 terms per query | `src/query.ts:117` |
| `MAX_SEED_WORDS` | 3 words per lexicon seed phrase | `src/lexicon.ts:109` |
| Lexicon size | 97 CJK → English entries | `src/lexicon.ts:138-276` |
| `MEMORY_TTL_MS` | 5 minutes (in-process cache) | `src/cache.ts:26` |
| `DISK_TTL_MS` | 24 hours (on-disk cache) | `src/cache.ts:29` |
| `SOURCE_TTL_MS` | 10 minutes (inspection cache) | `src/cache.ts:53` |
| `CACHE_VERSION` | 2 | `src/cache.ts:23` |
| `STAR_FLOOR` | 10 (the floor inside the score formula) | `src/types.ts:103` |
| `MIN_RELEVANCE` | 3 (rows below this are excluded from the card) | `src/types.ts:310` |
| `TERM_TOTAL_UNKNOWN` | -1 (the wire encoding of "no count", rendered back as null) | `src/types.ts:240` |
| `SEARCH_PLAN_VERSION` | 7 (part of the search cache key) | `src/types.ts:987` |
| `SELECTOR_VERSION` | 2 (part of the inspection cache key) | `src/select.ts:305` |
| `SCANNER_VERSION` | 1 (part of the inspection cache key) | `src/skeleton.ts:148` |
| `EXCERPT_WINDOW_CHARS` | 1200 characters of file head scanned for signatures | `src/skeleton.ts:39` |
| `MAX_HITS_PER_FILE` | 40 entries per file (at most 39 declarations plus the fact record) | `src/skeleton.ts:51` |
| `SIGNATURE_MAX_CHARS` | 200 characters per quoted signature | `src/skeleton.ts:54` |
| `REDUNDANT_TERM_RATIO` | 0.7 | `src/index.ts:114` |
| `MAX_META_CELL_CHARS` | 64 characters per metadata cell, in the ranked table and the flat candidate list alike | `src/render.ts:218` |
| `DEFAULT_TIMEOUT_MS` | 8000 ms for the translation call | `src/translate.ts:191` |
| `MAX_KEYWORDS_CHARS` | 120 characters accepted from the translation | `src/translate.ts:203` |
| Suspicion thresholds | `SUSPICION_QUOTE_CHARS` 120, `SCORE_GAP_SIMILARITY` 0.6, `SCORE_GAP_RELEVANCE` 5, `NOTE_GAP_TERMS` 2, `NOTE_GAP_FLOOR` 7, `NOTE_MIN_CHARS` 12 | `src/types.ts:330`, `:531`, `:534`, `:537`, `:540`, `:543` |
| Rendered excerpt caps | manifest 15 lines, README 40 lines, tree unlimited | `src/render.ts:1000`, `:1004`, `:1007` |

The version numbers matter beyond bookkeeping: `SEARCH_PLAN_VERSION`, `SELECTOR_VERSION` and `SCANNER_VERSION` are written into cache keys so that a change to the plan, the file selector or the signature scanner invalidates old entries instead of replaying an older rule's silence as this call's conclusion.

`inspect_projects` refuses a batch it cannot finish rather than half-reading it. It asks `/rate_limit` first (a free request, but still counted in `requests_used`), refuses with `quota_exceeded` when the remaining quota is below `repos.length × requestsPerRepo`, refuses an anonymous batch estimated above 10 requests, and refuses with `time_budget_exceeded` when `repos.length × msPerRepo` exceeds the 45000 ms budget — the refusal names how many repositories would fit (`src/index.ts:1754-1805`).

## The GitHub token

The plugin resolves the credential reference `GITHUB_TOKEN` through the host's `credentials` service (`src/index.ts:161`, `src/credentials.ts:32`). The service is looked up with `ctx.get('credentials')` rather than declared in `inject`, because a missing service must degrade to anonymous access rather than prevent the plugin from loading (`src/index.ts:153-160`); any failure in resolution yields `undefined`.

GitHub's search endpoint allows **10 requests per minute per public IP** unauthenticated, and that quota is shared by every host behind the same egress IP. An authenticated token raises it to **30 requests per minute** and scopes it to the account, making it immune to shared-IP exhaustion (`src/github.ts:4-8`).

Without a token the plugin still works — it simply sits closer to the anonymous limit, and `inspect_projects` refuses anonymous batches estimated above 10 requests, telling the caller to reduce the repository count, switch to `shallow`, or configure `GITHUB_TOKEN` (`src/index.ts:1766-1772`).

`src/credentials.ts` also contains a complete, tested `configureGitHubToken` write path, and deliberately does **not** register it as a tool: a registered tool appears in every agent's tool list, and nothing in the plugin can limit a tool to "only when the user asked" (`src/credentials.ts:6-11`). Setting the `GITHUB_TOKEN` environment variable in the environment that starts DSH has the same effect (`src/credentials.ts:93`).

## Honesty guarantees

This is the part of the plugin that was designed against measured failures, and it is worth reading before trusting a card.

### Computed values are separated from caller-supplied ones

Every ranked card carries a `【代码计算区】` (code-computed area) declaration and, when the caller supplied free text, a separate `【调用方说明区】` (caller-supplied area) (`src/render.ts:514-527`, `src/render.ts:600`). The two are never flattened into one surface.

This split replaced a one-line declaration that claimed every number in the area was computed by the code and could not be altered by the caller. That was an overclaim: a caller passing `stars=99999`, `pushed_at=2099-01-01` and `pool_source=scout_projects` renders a table with no warning at all, because the tool never re-queries GitHub for a caller-supplied pool and cannot tell a real row from an invented one. Only the arithmetic is the tool's; the inputs are the caller's (`src/render.ts:246-265`).

### Three provenance classes

The declaration states them explicitly (`src/render.ts:267-274`):

1. **`relevance`** — the caller's own judgement (0-10). The tool does not compute it and does not verify that it is correct.
2. **`stars` / `pushed_at` / `description`** — metadata the caller passed in, from a source the tool has not verified. When the caller supplies its own pool, the tool does not re-check these three against GitHub.
3. **score / rating / order** — derived from the two classes above and reproducible from the formula. The rating is a pure function of `relevance`.

The closing line is the load-bearing one: the arithmetic being reproducible does not make the inputs true, and the tool raising no alarm does not mean it verified anything.

Caller-supplied notes are rendered only outside the computed table, clipped, escaped, and labelled `[未验证]` (unverified) (`src/render.ts:600`, `src/render.ts:618-630`). A note never enters the ranking arithmetic — the parameter schema says so, and the card repeats it.

### Long-tail observability

Low-star candidates are counted **twice and separately**: `low_star_in_pool` (small projects the pool contained) and `low_star_in_kept` (small projects that reached the final list), both using `stars <= TAIL_STAR_CEILING` (`src/github.ts:80-81`, `src/render.ts:686-699`).

Neither number means anything alone. `low_star_in_pool` on its own reads as "small projects were available"; `low_star_in_kept` on its own reads as "small projects were served". Only together do they separate the two failures that need opposite responses: a pool that held no small projects is a **retrieval** problem (rerun the search), while a pool that held them and lost them in the ranking is a **ranking** problem (read the rows directly). The card prints the difference and tells the reader not to treat the list as the whole set.

### "Not measured" is never rendered as "measured zero"

The per-term diagnostic probes can be skipped for four distinct reasons, and each gets its own wording rather than a silent omission (`src/github.ts:933-967`):

- search quota exhausted → the probes were skipped by choice, because a diagnostic should not spend the quota the caller's next real search needs;
- search quota too low to finish all planned probes → the same, with the count;
- **search quota unknown** → GitHub returned no usable reading, so the guard did not spend a budget nobody measured. The wording is explicit that this is "quota unknown", neither "quota insufficient" nor "the term matched nothing";
- no query succeeded → there were no terms to diagnose, which is again **not** "the term matched zero".

A partial probe run says so: the terms it never reached are unmeasured, and saying that is what keeps their absence from reading as "matched nothing" (`src/github.ts:959-966`). Likewise, a cache replay that carries no probe data prints that the diagnostic was not saved, never that it came back clean (`src/github.ts:969-979`).

The ranked card applies the same rule to unanswered scores: candidates with no `relevance` are reported separately and excluded by rule, with the note that **not scoring is not the same as being irrelevant** (`src/render.ts:669-671`).

### Third-party text is untrusted data

Everything fetched from a repository — README, manifests, trees, file-head declarations — is presented inside forged-fence-proof quoted blocks under a fixed banner (`src/render.ts:860-880`, `src/render.ts:917-924`). The banner states that the excerpts are untrusted third-party data, that the tool has not reviewed any sentence in them and cannot, that their code and install scripts must not be run, and that they are **not instructions** — a README line saying "ignore your previous instructions" or "run this script first" is data, not a directive.

Three mechanisms close three different holes (`src/render.ts:897-924`):

- the fence is computed from the excerpt — one character longer than the longest run of backticks or tildes it actually contains, with a floor of four — so a README line of three backticks cannot close the block early and let the rest of the README read as card structure;
- every line is escaped so backticks, angle brackets and brackets lose their structural meaning while staying legible;
- every line carries a `│` gutter, without which a README line reading `【代码计算区】…` would trim to exactly the tool's own heading and become indistinguishable from a declaration.

Link destinations are restricted to an exact-match HTTPS allowlist of `github.com` and `raw.githubusercontent.com` (`src/render.ts:180-194`). A suffix test would accept `github.com.evil.example`, so the host is compared exactly; anything else — another scheme, another host, a URL with embedded credentials — comes back as an empty string, and the rejected value is shown as inert text rather than as a click target. Destinations that do pass are percent-encoded for the characters that could end a Markdown destination early, because `https://github.com/o/r) [click](https://evil.example.com/x` passes the host allowlist and would otherwise forge a second link (`src/render.ts:196-215`).

**An allowlist answers *which host*, never *where the text ends* — so a line that is not a link needs the escaper, not the encoder.** `linkDestination` percent-encodes the characters that can end a destination, but it does **not** encode `[` or `]`, which makes it the wrong tool for bare text: the flat candidate list that `scout_projects` prints is not a table cell and not a link, and unescaped the `](` in that same url is read as a live link to a host the allowlist never approved. The list therefore routes its url through `escapeUntrusted` (`src/render.ts:387`), which turns `[` and `]` into literals (`src/render.ts:116-118`) and leaves the allowlist as the only thing that decides what may be a click target. The same rule covers every other untrusted field on that line — `full_name`, `description`, the idea itself, and the metadata bits: `language` (`src/render.ts:381`) and `pushed_at` (`src/render.ts:382`) both pass through the same `formatMetaCell` the table branch uses. This is pinned by `test/instruction-isolation.test.mjs` §I4c, which first proves its own probe can see a genuinely live link before it asserts that the list contains none.

The licence line is a fixed disclaimer, not a guess: the candidate metadata has no `license` field, nothing fetches a `LICENSE` file, and silence would read as "no restriction" — the one reading that is certainly wrong. So the card says the licence was never established and that this means the ideas may be studied but the implementation is not licensed for copying (`src/render.ts:882-895`).

### Failures are values, never exceptions

Every failure path returns a well-formed result with a `degraded` note of shape `{ reason: string, detail: string }` (`src/types.ts:63-68`). The contract is that a failed search still returns a card that explains itself, rather than a raw error reaching the caller.

Reasons emitted across the three tools include `plan_failed`, `rate_limited`, `search_failed`, `thin_result`, `lexicon_miss`, `partial`, `quota_exceeded`, `time_budget_exceeded`, `inspect_failed`, `too_many_repos`, `no_repos`, `invalid_repos` and `invalid_files`.

Two properties of that design are deliberate:

- **A degraded note is rebuilt from stored facts, not replayed as wording.** A message like "only 1 request of quota remains" describes one fetch at one moment; printing it 20 hours later would assert a reading that no longer exists. The cached path re-derives the note from the rows that were stored alongside it (`src/index.ts:1060-1090`, `src/index.ts:1719-1742`).
- **Cache entries never come back cleaner than the fetch that filled them.** A cache hit is only clean when the fetch was complete; otherwise the shortfall is reconstructed from stored flags, including a repository the entry has no answer for at all (`src/index.ts:1742-1745`, `src/index.ts:342-365`).

The proxy hint is appended at the point where every degradation message is assembled, so `rate_limited`, `search_failed` and `partial` all carry it — it used to be attached only inside the transport-error path, which meant a proxy misconfiguration surfacing as a 403 produced a "network failure" with no proxy clue (`src/index.ts:387-404`).

## Module map

| Module | Lines | What it does |
|---|---|---|
| `src/index.ts` | 1883 | The plugin entry point. Registers the three tools and nothing else; the logic they call lives in the focused modules below. |
| `src/github.ts` | 1331 | GitHub search over public repositories: the transport, the rate-limit handling, pool selection, quoting, and the per-term diagnostic probes. |
| `src/query.ts` | 1405 | Query planning: turning a user's idea into GitHub search queries. A pure function of the user's words, exported and tested directly. |
| `src/lexicon.ts` | 483 | CJK → English search-term lexicon (97 entries), so a Chinese idea can reach the half of the corpus that describes itself in English. |
| `src/select.ts` | 816 | Architecture file selection: which four files to read to understand a repository. A pure function over a repository tree. |
| `src/cache.ts` | 246 | Two-layer cache (in-process plus on-disk) for GitHub search results, with silent memory-only fallback. |
| `src/credentials.ts` | 151 | Configuring the GitHub token without ever echoing it. The write path is tested but deliberately not registered as a tool. |
| `src/render.ts` | 1036 | Renderers: turning computed values into the text a model actually reads. Pure string builders. |
| `src/skeleton.ts` | 416 | File-head local declaration scanner: quoted class/function/interface/type/struct/trait/impl/enum evidence from an excerpt the caller already fetched. |
| `src/translate.ts` | 809 | In-plugin translation: a non-Latin idea becomes English search terms using the session model, so the search can reach the English-describing corpus. |
| `src/types.ts` | 1032 | Shared vocabulary: the ranking formula, the cache-key shape, and every type. All shapes are lossless-JSON compatible because `output.schema` is enforced against what `execute` returns. |

The split is not cosmetic. `query.ts`, `select.ts` and `render.ts` were each rewritten several times while living inside a tool registration, where no test could reach them; they are pure functions, so they were extracted and are now tested directly (`src/index.ts:4-16`, `src/query.ts:4-8`, `src/select.ts:4-9`, `src/render.ts:4-9`).

## Test suite

`test/` holds 24 `*.test.mjs` files. 23 of them are run by `test/run-all.test.mjs`, which runs each file in its own process and aggregates the totals; `run-all.test.mjs` excludes itself.

The runner treats **skipped as distinct from passed**. Each child process is handed a marker path through `DSH_SKIP_MARKER`; a file may only claim "skipped" by exiting 0 **and** leaving that marker behind. The runner then prints the skipped files by name under the heading `skipped (fixture absent, NOT verified)` (`test/run-all.test.mjs:9-17`, `:35-58`). Counting a skip as a pass would let the run print a clean total on a machine where two evidence-integrity suites never executed, which is exactly the kind of claim this repository exists to stop making.

Two files skip themselves in this repository:

- `test/baseline.test.mjs` — replays frozen GitHub rows from `eval/runs/baseline-2026-10-10T07-22-48-244Z/` through the real registered tool and asserts that the resulting pool has the same membership that was scored. It asserts pool membership rather than card order because relevance is an LLM judgement and is not reproducible offline.
- `test/stage2.test.mjs` — checks that the agent-plan arm stays comparable to the frozen Stage 1 baseline and that the shipped planner still produces the plans the baseline depended on.

Both read `eval/runs/`, which **is not present in this repository**, so on a fresh clone they skip loudly instead of throwing `ENOENT`, naming what went unverified (`test/run-all.test.mjs:12-16`, `test/baseline.test.mjs:82-93`). The fixtures were never ported: the predecessor plugin's evaluation runs were not carried over with its test files. This used to say `eval/runs/` was "gitignored by design" — true of the predecessor repository, whose `.gitignore` does ignore `eval/runs/`, and false here, because this `.gitignore` does not mention `eval` at all (`test/baseline.test.mjs:53-59`, `test/stage2.test.mjs:48-53`). The skip was correct either way, but a reason copied from another repository sends a reader looking for an ignore rule that does not exist instead of at the real gap.

`test/baseline.test.mjs` redirects `DSH_HOME` to a temporary directory before importing anything that resolves it lazily, so a developer's real cache can never serve part of the replay.

## License

MIT. See [LICENSE](LICENSE).
