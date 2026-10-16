/**
 * dsh-find-ideas — the plugin entry point.
 *
 * This file registers the three tools and nothing else. The logic they call
 * lives in focused modules:
 *
 *   - `query.ts`   — idea text -> GitHub search plan (pure)
 *   - `select.ts`  — repository tree -> the four files worth reading (pure)
 *   - `render.ts`  — computed values -> the text a model reads (pure)
 *   - `github.ts`  — the transport, plus pool selection and quoting
 *   - `cache.ts`   — memory + disk caching, with silent memory-only fallback
 *   - `types.ts`   — the ranking formula and the cache-key shape
 *
 * The split is not cosmetic. The three pure modules were once buried inside
 * this file, where no test could reach them: `buildQueries` and
 * `pickArchitectureFiles` went through three rewrites and three real defects
 * with zero coverage, because the only way to call them was to register the
 * plugin and invoke a tool. What a test needs is the function, so the functions
 * now stand alone.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { cacheGet, cacheGetWithMeta, cacheSet, SOURCE_TTL_MS } from './cache.ts'
import { GitHubSearchRateLimited, countLowStar, describeFailure, describeProbeOutcome, describeUnavailableProbeDiagnostic, getCoreQuota, getFileContent, getReadme, getTree, proxyHint, searchMerged, type AuthOptions } from './github.ts'
import { describeLexiconMiss, describePartialFailure, describePlanFailure, describeReplayedIncompleteness, describeReplayedThinness, explainThinResult, thinResultKind, tryPlanQueries, type QueryStep, type ThinKind } from './query.ts'
import { MANIFEST_RE, SELECTOR_VERSION, pickArchitectureFiles, treeEvidence } from './select.ts'
import { EXCERPT_WINDOW_CHARS, SCANNER_VERSION, scanSignatures } from './skeleton.ts'
import { termBudget, translateIdea, translationFailed, type TranslateDeps } from './translate.ts'
import { type Inspection, renderCandidates, renderInspections, renderRanked, renderSkeleton } from './render.ts'
import {
  type Degraded,
  type RankedCandidate,
  type RelevanceInput,
  type RepoCandidate,
  type TermReport,
  MIN_RELEVANCE,
  TERM_TOTAL_UNKNOWN,
  findDoubleSided,
  findNoteEchoes,
  findScoreGaps,
  rankCandidates,
  searchCacheKeyFor,
} from './types.ts'

export const name = 'dsh-find-ideas'
export const inject = ['tools']

/**
 * What GitHub's repository search actually matches (B1, user m00793).
 *
 * Measured, and previously only inferable: the search endpoint matches a
 * repository's NAME and DESCRIPTION. It does not index README bodies and it does
 * not index code. So a project whose README says "translates web pages" but
 * whose description omits the word is unreachable by any query, however good.
 *
 * The failure this prevents is a reasoning error, not a recall error: without
 * this sentence an agent reads an empty or noisy result set as "nothing like
 * this exists" and reports that to the user as a finding. Observed exactly that
 * (user m00781-m00793) — the browser-extension scouting round concluded that
 * immersive-translation projects "were not found", when the accurate statement
 * was that one query's surface never covered them.
 *
 * Kept as one constant and repeated verbatim in all three tool descriptions so
 * the boundary is stated wherever a result is read, and so a test can assert it
 * is present rather than trusting three hand-edited copies to stay in sync.
 */
export const RETRIEVAL_SURFACE =
  'RETRIEVAL SURFACE — GitHub repository search matches the repository NAME and DESCRIPTION only. ' +
  'It does NOT index README bodies, and it does NOT index file contents. A project that describes ' +
  'itself as this idea only inside its README or its code is unreachable by any query, however ' +
  'precise. An empty or noisy result set therefore means "this query reached nothing", never ' +
  '"nothing like this exists".'

/**
 * Report what each query term matched on its own (B6, user m00929).
 *
 * GitHub ANDs the terms of a multi-word query, so a term can contribute nothing
 * while the combined `total_count` still looks healthy — the observed
 * `browser extension web page translation translate` filled a page because
 * `browser extension` alone matches an enormous population. The card showed
 * four rows of results and no indication that the query was effectively one
 * term wide.
 *
 * A term is reported as `carrying` when it matched NOTHING alone (it can only be
 * subtracting from the combined result) or when its solo count is at least
 * {@link REDUNDANT_TERM_RATIO} of the largest solo count (it excludes almost
 * nothing, so it is decoration). Terms that were never probed are omitted
 * rather than reported as zero, because an absent measurement is not a
 * measurement of absence.
 *
 * @param queries - the plan that was searched.
 * @param termTotals - solo counts, keyed by term as it appears in the query.
 * @returns one entry per probed term, longest first.
 */
export interface QueryTermReport {
  /** The term exactly as the plan sent it (CJK runs keep their quotes). */
  term: string
  /** Solo `total_count`, or `null` when the probe did not return one. */
  total: number | null
  /** `'carrying'` when this term constrains the plan little or not at all. */
  verdict: 'selective' | 'carrying'
}

/**
 * A term whose solo count is at least this share of the widest solo count is
 * treated as carrying no constraint.
 *
 * 0.7, not 1.0: the terms of a well-formed query rarely match exactly identical
 * populations, and demanding equality would report every near-duplicate as
 * selective. At 0.7 the measured case is caught cleanly — `browser extension`'s
 * solo count dwarfed the others, and the combined page was full regardless.
 */
export const REDUNDANT_TERM_RATIO = 0.7

/**
 * Build the per-term report, marking the terms that carry no constraint.
 *
 * @param queries - the plan that was searched.
 * @param termTotals - solo counts keyed by term; a missing key means unprobed.
 * @returns a report entry per probed term, in plan order.
 */
export function termReport(
  queries: readonly QueryStep[],
  termTotals: ReadonlyMap<string, number>,
): TermReport[] {
  const seen = new Set<string>()
  const out: TermReport[] = []
  for (const step of queries) {
    for (const raw of step.query.split(/\s+/)) {
      const term = raw.trim()
      if (term.length === 0 || seen.has(term)) continue
      seen.add(term)
      // A term with no probe result carries TERM_TOTAL_UNKNOWN, never 0: an
      // absent measurement must not read as "this term matches no repository".
      out.push({ term, total: termTotals.get(term) ?? TERM_TOTAL_UNKNOWN, verdict: 'selective' })
    }
  }
  const known = out.map((entry) => entry.total).filter((n) => n !== TERM_TOTAL_UNKNOWN)
  const widest = known.length === 0 ? 0 : Math.max(...known)
  for (const entry of out) {
    // Zero alone means the term matched nothing on its own: inside an AND it can
    // only be subtracting, so it is never carrying the query. An unmeasured term
    // is left `selective` — the tool does not know, so it does not assert.
    if (entry.total === 0) entry.verdict = 'carrying'
    else if (entry.total !== TERM_TOTAL_UNKNOWN && widest > 0 && entry.total >= widest * REDUNDANT_TERM_RATIO) {
      entry.verdict = 'carrying'
    }
  }
  return out
}

/**
 * Credential reference resolved through the host's `credentials` service.
 *
 * This service is looked up with `ctx.get` rather than declared in `inject`,
 * because an absent service must degrade to anonymous access, not prevent the
 * plugin from loading. A plugin whose module throws on load takes the whole
 * host down with it, which is a steep price for a missing optional token.
 */
const GITHUB_TOKEN_REF = 'GITHUB_TOKEN'

/**
 * Hard ceiling on rows, for both tools. The limit is a parameter, but it is
 * clamped rather than trusted: an unbounded limit turns one call into an
 * unbounded response, and the caller has no way to know where the edge is.
 */
const MAX_LIMIT = 30

/** Cap on repositories per inspection call, for the same reason as MAX_LIMIT. */
const MAX_INSPECT_REPOS = 5

/**
 * Per-depth inspection budget.
 *
 * `requestsPerRepo` is the number the up-front quota arithmetic uses, so it must
 * stay honest: it is what the caller is told a read will cost.
 *
 * `msPerRepo` is the same kind of number for the other budget that matters --
 * wall-clock time. It is MEASURED, not guessed: timing every HTTP request of a
 * 3-repo cold read gave p50 405ms / p90 640ms / max 844ms per request, i.e.
 * ~3.96s per repo shallow and ~5.58s per repo deep. The constants round those
 * up, because understating the cost is what produces a call the host kills.
 */
const INSPECT_BUDGET = {
  shallow: { readmeChars: 4000, treeEntries: 20000, maxFiles: 4, requestsPerRepo: 6, msPerRepo: 4500 },
  deep: { readmeChars: 12000, treeEntries: 20000, maxFiles: 8, requestsPerRepo: 10, msPerRepo: 6500 },
}

type InspectDepth = keyof typeof INSPECT_BUDGET

/**
 * Wall-clock ceiling the host enforces on `inspect_projects`.
 *
 * A constant rather than a read of the registration, because the budget check
 * has to run BEFORE the work starts and the registration is built at the same
 * time as the check. The registration below refers to THIS identifier, so the
 * ceiling is stated once in the module and cannot drift from the budget math.
 *
 * That shared reference is the same repair `MANIFEST_RE` needed: the selector
 * and the manifest extractor each defined it separately, they drifted, and the
 * symptom was an empty excerpt rather than a failing test. A second literal
 * here would be that shape again, and a value this consequential (it decides
 * whether a call is refused or killed mid-way) should not have two homes.
 *
 * Exported so `test/queries.test.mjs` group S9 can assert the registered
 * `timeoutMs` IS this value and that the value is the 60000ms ceiling the host
 * actually enforces — a deliberate change to the ceiling has to update the test
 * that names it, instead of sliding through as a silent re-budget.
 */
export const INSPECT_TIMEOUT_MS = 60000

/**
 * How much of the ceiling a single call may claim.
 *
 * Not 100%: a call that plans to finish exactly at the limit has no room for the
 * one slow request that always happens. A refusal costs the caller a retry with
 * a smaller batch; an overrun costs them the whole call, including whatever the
 * host killed mid-way. The asymmetry is why this is not 1.
 *
 * Exported alongside {@link INSPECT_TIMEOUT_MS} so the test that pins the
 * ceiling can also pin the relationship between the two, rather than asserting
 * each number in isolation while the pair drifts.
 */
export const TIME_BUDGET_SHARE = 0.75

/**
 * What a cached search stores.
 *
 * `tailIncluded` is stored rather than recomputed because it cannot be recovered
 * from the rows: an all-small pool has every row at or below the ceiling but only
 * `reserve` of them were admitted for that reason. Storing the count keeps the
 * cold path and the cached path reporting the same number for the same search.
 *
 * `incomplete` is stored for the same reason as `tailIncluded` and for a
 * different reason than the failure text: incompleteness is a property of the
 * rows, not of the moment they were fetched. See the field's own note.
 *
 * Everything here is a fact about the ROWS. Nothing here is wording, and nothing
 * here is a number that only existed during the fetch.
 */
interface CachedSearch {
  candidates: RepoCandidate[]
  tailIncluded: number
  /**
   * True when the fetch that filled this entry did NOT retrieve everything it
   * asked for — a query failed, or GitHub reported the quota nearly gone.
   *
   * This is stored, and the failure TEXT is not. The two are different kinds of
   * fact. "Two of three queries failed" is a statement about one fetch at one
   * moment; repeating it on a replay would claim queries failed when nothing was
   * attempted. But *incompleteness is a property of the rows themselves*: a
   * pool missing whatever the failed query would have found stays incomplete
   * however often it is replayed. Dropping the flag let a partial result come
   * back looking clean on the second call, which is the one thing the partial
   * note exists to prevent. So the flag is kept and the wording is regenerated.
   */
  incomplete: boolean
  /**
   * Why this entry's fetch came back short, or `null` when it did not.
   *
   * Stored as the KIND rather than as a boolean because the kind is not
   * re-derivable on a replay. The `narrow` test reads only the row count and the
   * requested limit, both of which survive in this record — but the `quota` test
   * reads `remaining`, which exists only in the fetch's response headers. With
   * `remaining === undefined` the rule would answer `narrow` for a fetch that was
   * actually quota-limited: a wrong diagnosis, and the exact class of silent
   * wrongness the `incomplete` note above was added to stop.
   *
   * The omission was measured, not theoretical. On the pure-Chinese idea
   * `一个给独立开发者用的客户反馈收集工具`, the first call reported
   * `thin_result` plus a `lexicon_miss` note, and the second call — served from
   * cache — reported `degraded: null` while returning the same 2 rows. The card
   * claimed a clean 2-candidate result on the retry.
   */
  thin: ThinKind | null
}

/**
 * What a cached inspection stores.
 *
 * This replaced a bare `Inspection[]`. The array alone could not answer the two
 * questions a replay has to answer honestly:
 *
 *   1. **Was this everything that was asked for?** A batch where two of three
 *      repositories failed still produced a non-empty array, and the replay
 *      returned it with `degraded: null` — a partial reading presented as a clean
 *      one. The failure list was discarded at `cacheSet` time, and `degraded` was
 *      re-derived from the rows afterwards, so only the COLD path ever knew.
 *   2. **Which repositories was it for?** The cache key sorts the repo list, so
 *      two callers naming the same repositories in a different order share one
 *      entry; without the requested list a replay hands back the first caller's
 *      order as if it were the second caller's answer.
 *
 * Per-file errors are NOT duplicated here: they live inside the `Inspection` rows
 * (`error`, `files_read`, and the unread-path list folded into `tree_summary`),
 * which are stored whole. Copying them would create a second definition of one
 * fact, which is how the cold and cached paths started disagreeing at all.
 *
 * `fetchedAt` is not duplicated either — the disk envelope already carries it and
 * `cacheGetWithMeta` hands it back. What this record adds is the part the
 * envelope cannot know: whether the fetch was COMPLETE.
 */
interface CachedInspection {
  /** The rows, in the order the fetch produced them. */
  inspections: Inspection[]
  /** Exactly the repositories the fetch was asked for, in the caller's order. */
  requestedRepos: string[]
  /** Repositories that were attempted and produced nothing usable. */
  failedRepos: string[]
  /**
   * True only when every requested repository was read successfully.
   *
   * Stored rather than re-derived because the rows cannot express it: a
   * repository that failed outright leaves no row, so "three rows for three
   * repositories" and "three rows for five repositories" look identical from the
   * array alone. That is the whole reason a replay used to come back clean.
   */
  complete: boolean
}

/**
 * Rebuild the degradation note for a cache HIT.
 *
 * A cache hit is not automatically a clean result. The entry records whether its
 * fetch got everything it asked for; when it did not, the replay has to say so —
 * otherwise re-running the same call turns a partial reading into an apparently
 * complete one, which is precisely the direction the caller cannot detect.
 *
 * The wording never replays the old failure text: "GitHub 返回 403" describes one
 * request at one moment, and printing it later asserts something no longer true.
 * What is replayed is the FACT about the rows, plus the age of the evidence,
 * because `SOURCE_TTL_MS` means a hit can be minutes old and the code it attests
 * to may already have changed.
 *
 * @param record - the stored inspection record.
 * @param absent - requested repositories that the entry has no row for.
 * @param ageMs - how long ago the entry was written.
 * @param fetchedAt - when the entry was written, for the reader to judge.
 * @returns a `partial` degradation, or `null` when the entry really was complete.
 */
function describeCachedInspection(
  record: CachedInspection,
  absent: string[],
  ageMs: number,
  fetchedAt: string,
): Degraded | null {
  const incomplete = !record.complete || absent.length > 0
  if (!incomplete) return null

  const parts: string[] = []
  if (record.failedRepos.length > 0) parts.push(`其中读取失败：${record.failedRepos.join(', ')}`)
  if (absent.length > 0) parts.push(`缓存中没有这些仓库的结果：${absent.join(', ')}`)
  if (parts.length === 0) parts.push('该次读取没有取全')

  const ageMinutes = Math.max(0, Math.round(ageMs / 60000))
  return {
    reason: 'partial',
    detail:
      `本次命中的是缓存（抓取于 ${fetchedAt}，约 ${ageMinutes} 分钟前），而那份证据本身就不完整：` +
      `${parts.join('；')}。` +
      '这些是缓存里的记录，不是本次重新读取的结果；重放不会让缓存变完整，' +
      '请重新调用并只传入需要重读的仓库。',
  }
}

/**
 * Resolve the token; a missing service or an unset credential yields undefined.
 *
 * @param ctx - plugin context.
 * @returns the token, or `undefined` when unconfigured.
 */
async function resolveGitHubToken(ctx: Context): Promise<string | undefined> {
  try {
    const credentials = typeof ctx.get === 'function'
      ? (ctx.get('credentials') as { resolve?: (ref: string) => Promise<{ value?: string } | undefined> } | undefined)
      : undefined
    if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined
    const resolved = await credentials.resolve(GITHUB_TOKEN_REF)
    const value = resolved?.value
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Append the proxy sentence to a degradation message, with a leading separator.
 *
 * `proxyHint()` used to be attached inside `github.ts`'s transport-error path
 * only, so a proxy misconfiguration that surfaced as a 403 or as a shrunken
 * result set produced a "network failure" with no proxy clue at all. Attaching
 * it here — where every degradation message is assembled — means all three
 * paths (`rate_limited`, `search_failed`, `partial`) carry it.
 *
 * It stays a no-op in the common case: no proxy variables set, or the host
 * already opted in, yields an empty string and nothing is appended.
 *
 * @returns `"\\n  <hint>"`, or an empty string when there is nothing to say.
 */
function withProxyHint(): string {
  const hint = proxyHint()
  return hint === '' ? '' : `\n  ${hint}`
}

/**
 * A Chinese idea with no usable Latin term anywhere in `keywords` is REFUSED.
 *
 * ## Why this is a refusal and not a warning
 *
 * Step 1 (`chineseIdeaNote`) warns when the finished plan has no English channel,
 * which is honest but only as good as the agent's willingness to read the card and
 * retry. Measured: the failure it describes is not subtle — `本地优先的
 * Markdown 笔记应用，支持双向链接` returns `total_count: 0` while
 * `local-first markdown notes` returns 30 rows with `codexu/note-gen` on top, and
 * the projects worth comparing against (logseq, siyuan, Trilium) describe
 * themselves in English and are reached by no Chinese query at any precision.
 *
 * A call that provably cannot reach that population is worth one round trip, and
 * the schema is the only place the harness enforces anything: a description is
 * advice, a `required` entry is a contract. This is the second of the three steps
 * the user approved (m00439): step 1 warns, step 2 refuses the provably-hopeless
 * shape, step 3 would require `keywords` unconditionally (not done).
 *
 * ## What this does NOT enforce
 *
 * Only that SOME Latin term is present. The tool cannot judge whether the term is
 * a correct translation, and it does not try: `keywords: 'blockchain'` against a
 * Chinese idea passes. The claim is narrow on purpose — "the caller supplied
 * English search terms", never "the caller translated well".
 *
 * The check is also deliberately narrower than "the plan has no English channel":
 * a text that is NOT Chinese at all is never refused, even when `keywords` is
 * absent and the lexicon finds nothing, because an English idea is already a
 * usable English query and the remedy in the message would be nonsense.
 *
 * @param idea - the idea text as the caller wrote it.
 * @param keywords - the caller's `keywords` argument, or `undefined`.
 * @returns the refusal message, or `null` when the call may proceed.
 */
function refuseChineseIdeaWithoutKeywords(idea: string, keywords: string | undefined): string | null {
  // A NON-Chinese idea is out of scope. Note this is `has Han`, not
  // `is Han only`: `本地优先的 Markdown 笔记应用` contains Latin words and is
  // still a Chinese idea that needs translated terms, because the Latin words in
  // it (a product name) are not a substitute for the concept terms.
  if (!/\p{Script=Han}/u.test(idea)) return null
  // "Has a Latin letter" is the bar, matching `describeLexiconMiss`: a wholly
  // Chinese `keywords` value leaves the plan exactly as English-less as none.
  if (keywords !== undefined && /[A-Za-z]/.test(keywords)) return null
  const given = keywords === undefined ? '未提供' : `\`${keywords}\`（不含任何拉丁字母）`
  return (
    `拒绝执行：idea 含中文，但 keywords ${given}。\n` +
    `  \`${idea}\` 需要英文检索词才能触达值得对标的项目：GitHub 搜索对多词做 AND 匹配，` +
    '中文句子本身不是好查询，而 logseq、siyuan、Trilium 这类项目都用英文自我描述，' +
    '中文查询在任何精度下都够不到它们。\n' +
    '  实测：`本地优先的 Markdown 笔记应用，支持双向链接` 单独检索返回 total_count: 0，' +
    '而 `local-first markdown notes` 返回 30 条并命中 codexu/note-gen。\n' +
    '  请先把 idea 的核心概念翻成 3-6 个英文检索词，再带上 keywords 重新调用' +
    '（例如把「本地优先的笔记应用」写成 `local-first note-taking`）。\n' +
    '  注意：本工具只能检查是否提供了英文检索词，无法判断翻译质量。'
  )
}

/**
 * Combine the fetch-level degradation with the vocabulary-gap note.
 *
 * `lexicon_miss` is a note ABOUT THE PLAN, while `partial` / `thin_result` are
 * notes about WHAT CAME BACK. They are independent, so neither replaces the
 * other: the fetch note explains the shape of the result, the lexicon note
 * explains what to change before retrying — and the lexicon note is the one the
 * caller can act on, since supplying English `keywords` bypasses the lexicon
 * entirely.
 *
 * This is a function because BOTH the cold path and the replay path need it. The
 * cold path used to own the rule inline, and the replay path simply did not
 * implement it, so a replayed search lost the vocabulary note even though
 * `unknownTerms` is computed before the cache is ever consulted and the note is
 * therefore fully re-derivable. One definition, two callers.
 *
 * @param primary - the fetch-level degradation, or `null` when the fetch was clean.
 * @param lexiconMiss - the vocabulary note, or `null` when the lexicon covered the idea.
 * @returns the combined degradation, or `null` when there is nothing to report.
 */
function composeDegraded(
  primary: Degraded | null,
  lexiconMiss: string | null,
  planNote: string | null = null,
): Degraded | null {
  // Plan-stage notes come first: they describe what the QUERY was, and the fetch
  // notes below them only make sense once the reader knows that.
  const parts: string[] = []
  if (planNote !== null) parts.push(planNote)
  if (lexiconMiss !== null) parts.push(lexiconMiss)
  if (parts.length === 0) return primary
  const extra = parts.join('\n\n')
  // With a clean fetch the plan-stage note IS the finding and gets a reason of
  // its own; otherwise it is appended to whatever the fetch already reported.
  if (primary === null) {
    return { reason: lexiconMiss !== null ? 'lexicon_miss' : 'translation_degraded', detail: extra }
  }
  return { reason: primary.reason, detail: `${primary.detail}\n\n${extra}` }
}

/**
 * What the translation step contributed to the query, as a note for the card.
 *
 * Two different things are reported here, and they are deliberately one string
 * because both answer "what did the model's translation actually do":
 *
 *   1. **Why translation degraded**, when it did. The caller gets the reason
 *      (no LLM service, no model selected, timeout, invalid output, …) instead of
 *      the bare refusal the old guard produced — a refusal says "add keywords"
 *      without saying why the tool could not work them out itself.
 *   2. **Which terms reached a query and which were dropped.** The planner uses
 *      at most `BROAD_TERM_BUDGET` terms for the broad query and `TAIL_TERM_BUDGET`
 *      for the long tail. Measured: `blockchain explorer multi-chain transaction
 *      tracing` and `... social feed` produced IDENTICAL queries, so a constraint
 *      the caller cared about vanished with nothing in the output to say so.
 *      Reporting the dropped suffix is the only way that stays visible.
 *
 * @param outcome - the translation result.
 * @returns the note, or `null` when there is nothing worth saying.
 */
function describeTranslation(outcome: { keywords: string; source: string; degraded: Degraded | null }): string | null {
  const notes: string[] = []
  if (outcome.degraded !== null) notes.push(outcome.degraded.detail)

  if (outcome.source === 'llm' && outcome.keywords.length > 0) {
    const budget = termBudget(outcome.keywords)
    const head =
      `检索词由插件内的 LLM 译出（idea 未提供 keywords）：${budget.all.join(' / ')}。` +
      `进入宽查询的是前 ${budget.broad.length} 个（${budget.broad.join(' / ')}），` +
      `长尾另用前 ${budget.tail.length} 个。`
    notes.push(
      budget.dropped.length > 0
        ? `${head}⚠️ 被丢弃的后缀（未进入任何查询）：${budget.dropped.join(' / ')}。` +
          '这些限定词在本次检索里没有起作用，若它们重要，请自行提供 keywords 重试。'
        : `${head}没有词被丢弃。`,
    )
  }
  return notes.length > 0 ? notes.join('\n\n') : null
}

/**
 * Read one repository's README, tree and key files, within a request budget.
 *
 * @param fullName - `owner/repo`.
 * @param budget - depth-dependent limits.
 * @param options - token and cancellation.
 * @returns an inspection record; a per-repo failure is reported in `error`
 *   rather than thrown, so one bad repo cannot lose the whole batch.
 */
async function inspectOne(
  fullName: string,
  budget: typeof INSPECT_BUDGET[InspectDepth],
  options: AuthOptions,
  explicitFiles?: string[],
): Promise<Inspection> {
  const base: Inspection = {
    full_name: fullName,
    url: `https://github.com/${fullName}`,
    ok: false,
    files_read: [],
    readme_excerpt: '',
    manifest_excerpt: '',
    tree_summary: '',
    skeleton_summary: '',
    error: '',
  }

  // A rate limit is a batch-level condition, not a repo-level one: surface it so
  // the caller can report the real reason instead of five identical errors.
  const readme = await getReadme(fullName, budget.readmeChars, options)
  const tree = await getTree(fullName, budget.treeEntries, options)

  // Caller-supplied paths win over the heuristic. The heuristic ranks by how
  // informative a *path* looks, which is all it can do without reading anything;
  // a model that has already read the README knows what the project is made of.
  // Verified against the live repos, the heuristic's blind spot is real: it
  // picked `app/appx/AppxManifest.xml` (a Windows packaging manifest) and two
  // `.claude/skills/**/SKILL.md` files, because those paths carry no signal
  // either way. Explicit paths are honoured even when they look disqualified —
  // the caller may have read something the rules cannot see.
  const requested = (explicitFiles ?? []).filter(path => path.length > 0)
  const known = new Set(tree.entries.map(entry => entry.path))
  const missing: string[] = []
  let files: string[]
  if (requested.length > 0) {
    files = requested.slice(0, budget.maxFiles)
    for (const path of requested) {
      // Only warn about a path the tree proves absent; a truncated tree cannot
      // prove absence, so an unknown path is attempted rather than rejected.
      if (tree.entries.length > 0 && !tree.truncated && !known.has(path)) missing.push(path)
    }
  } else {
    // The README is fetched first in this function, and is still used for the
    // excerpts below, but the selector no longer takes it: that parameter was
    // never read, and a parameter nothing reads is a promise the code does not
    // keep.
    files = pickArchitectureFiles(tree.entries, budget.maxFiles)
  }

  const readFiles: string[] = []
  const excerpts: string[] = []
  const skeletons: string[] = []
  let manifest = ''
  for (const path of files) {
    // §2.6.4 — the README is already in hand. Slot 1 of the selector IS the root
    // README, so going through the contents endpoint for it spends one of the
    // six per-repo requests to re-fetch bytes this function fetched a moment
    // ago. Reused ONLY when the README fetch actually succeeded: a failed
    // `/readme` must still be attempted per path, otherwise a transient failure
    // would silently drop the file the selector ranked most important.
    const fromReadme = /^readme\.(md|markdown|rst|txt)$/i.test(path) && readme.text.length > 0
    const file: { text: string; truncated: boolean; error?: string } = fromReadme
      ? { text: readme.text, truncated: readme.truncated }
      : await getFileContent(fullName, path, budget.readmeChars, options)
    if (file.text.length === 0) {
      if (file.error !== undefined && file.error.length > 0) missing.push(`${path}（${file.error}）`)
      continue
    }
    readFiles.push(path)
    // One definition, shared with the selector. This used to be a second,
    // narrower list inline here, which drifted: the selector ranked `deps.edn`
    // as a manifest and promoted it into `files_read`, and this line — not
    // recognising it — then produced an empty `manifest_excerpt` for logseq.
    if (manifest.length === 0 && MANIFEST_RE.test(path)) {
      manifest = file.text.slice(0, 600)
    }
    // Two truncations happen to every excerpt and BOTH used to be silent, so a
    // 1200-character head of a 200KB file was indistinguishable from a whole
    // file. Level 3 is the read budget (`budget.readmeChars`), level 4 is the
    // window below; the header states whichever applies, in characters, so the
    // reader can tell how much of the file is actually in front of them.
    const windowed = file.text.length > EXCERPT_WINDOW_CHARS
    const coverage: string[] = []
    if (file.truncated) coverage.push(`文件长于 ${budget.readmeChars} 字符的读取预算，已截断`)
    if (windowed) coverage.push(`本摘录只含开头 ${EXCERPT_WINDOW_CHARS} 字符，其后内容未展示`)
    const excerpt = file.text.slice(0, EXCERPT_WINDOW_CHARS)
    excerpts.push(`--- ${path} ---${coverage.length > 0 ? `（${coverage.join('；')}）` : ''}\n${excerpt}`)
    // The scanner reads the SAME window the excerpt shows. Scanning more than is
    // displayed would let the card cite a declaration the reader cannot see, and
    // scanning less would leave a line number pointing at nothing.
    skeletons.push(renderSkeleton(path, scanSignatures(path, excerpt)))
  }

  // Counted from the same entries the fetch already paid for. This replaces a
  // `[...dirs].slice(0, 20)` that was truncated with no marker — logseq's list
  // stopped alphabetically at `ios` and looked complete, so the agent could not
  // tell a full listing from a partial one.
  const evidence = treeEvidence(tree.entries, tree.truncated)

  const errors = [readme.error, tree.error].filter((item): item is string => typeof item === 'string' && item.length > 0)
  const ok = readme.text.length > 0 || tree.entries.length > 0

  return {
    ...base,
    ok,
    files_read: readFiles,
    readme_excerpt: readme.text,
    manifest_excerpt: manifest,
    skeleton_summary: skeletons.length > 0 ? skeletons.join('\n\n') : '',
    tree_summary:
      `顶层目录（${evidence.topDirs.length}）：${evidence.topDirs.length > 0 ? evidence.topDirs.join(', ') : '（无）'}\n` +
      `文件总数：${evidence.entries}${evidence.truncated ? '（GitHub 截断了列表——下面的计数是下界，缺失不等于不存在）' : ''}\n` +
      `其中源文件：${evidence.sourceFiles}　测试文件：${evidence.testFiles}\n` +
      // The root manifest is what the project is built with; nested manifests
      // are workspace members, and listing all of them said nothing (logseq
      // produced 29 paths, 11% of the payload). Count them, name the root ones.
      `依赖清单：共 ${evidence.manifests.length} 个${evidence.rootManifests.length > 0 ? `，根目录：${evidence.rootManifests.join(', ')}` : '（无根目录清单）'}\n` +
      `读取的文件：${readFiles.length > 0 ? readFiles.join(', ') : '（无）'}\n` +
      `文件摘录：\n${excerpts.length > 0 ? excerpts.join('\n\n') : '（无）'}` +
      // A requested path that could not be read is reported, never silently
      // dropped: otherwise "I asked for these 3 files" and "I got these 3 files"
      // look identical when one of them never arrived.
      (missing.length > 0 ? `\n未能读取的指定文件：${[...new Set(missing)].join('；')}` : ''),
    error: ok ? '' : errors.join('；'),
  }
}

/**
 * GitHub's own name character set, one path segment of `owner/name` (AC10).
 *
 * Deliberately a whitelist rather than a blacklist: the point of the check is
 * that the value is a repository identifier and nothing else, and every
 * dangerous shape (`..`, a control character, a newline, a shell metacharacter,
 * a percent-encoded traversal) is excluded by not being in the set. A dot is
 * allowed because real names contain one; a name that is ONLY dots is rejected
 * below, which is the case that matters.
 */
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

/**
 * Validate one `owner/name` entry and name the reason when it is not one.
 *
 * This refuses rather than drops. A silently dropped entry is the worse
 * failure of the two: the caller asked for three repositories, the card shows
 * two, and nothing says which one vanished or why — so the agent describes an
 * architecture it never read. The refusal is per-entry and actionable, because
 * "invalid input" without the offending value and the rule it broke leaves the
 * caller guessing at a fix.
 *
 * @param value - the raw entry, before trimming.
 * @returns the trimmed `owner/name`, or the reason it is not one.
 */
function validateRepo(value: string): { ok: true; value: string } | { ok: false; reason: string } {
  const repo = typeof value === 'string' ? value.trim() : ''
  if (repo.length === 0) return { ok: false, reason: '空字符串' }
  // Checked before the character whitelist so the message names the real
  // problem: a newline is also a non-matching character, but "contains a
  // control character" is the sentence the caller can act on.
  const control = repo.match(/[\u0000-\u001F\u007F]/)
  if (control !== null) return { ok: false, reason: `含控制字符（U+${control[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}）` }
  if (/\s/.test(repo)) return { ok: false, reason: '含空白字符' }
  const segments = repo.split('/')
  if (segments.length !== 2) {
    return {
      ok: false,
      reason: segments.length < 2 ? '不是 "owner/name" 两段形式（缺少 /）' : `不是 "owner/name" 两段形式（有 ${segments.length - 1} 个 /）`,
    }
  }
  const [owner, name] = segments as [string, string]
  if (owner.length === 0 || name.length === 0) return { ok: false, reason: '"owner/name" 两段都不能为空' }
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    return { ok: false, reason: '含 "." 或 ".." 路径段' }
  }
  if (!REPO_SEGMENT_RE.test(owner)) return { ok: false, reason: `owner 段含非法字符：${JSON.stringify(owner)}` }
  if (!REPO_SEGMENT_RE.test(name)) return { ok: false, reason: `name 段含非法字符：${JSON.stringify(name)}` }
  return { ok: true, value: `${owner}/${name}` }
}

/**
 * Validate one repository-relative file path (AC10).
 *
 * Only `..` segments and control characters are refused, and NOT the wider
 * character set `validateRepo` applies: file names legitimately contain spaces,
 * `+`, `@`, CJK and parentheses, and a whitelist here would reject real paths
 * (`docs/设计 说明.md`, `src/a+b.ts`) that `getFileContent` percent-encodes
 * correctly. The two shapes that actually escape the repository are refused.
 *
 * @param value - the raw path, before trimming.
 * @returns the trimmed path, or the reason it is not one.
 */
function validateFilePath(value: string): { ok: true; value: string } | { ok: false; reason: string } {
  const path = typeof value === 'string' ? value.trim() : ''
  if (path.length === 0) return { ok: false, reason: '空字符串' }
  const control = path.match(/[\u0000-\u001F\u007F]/)
  if (control !== null) return { ok: false, reason: `含控制字符（U+${control[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}）` }
  if (path.startsWith('/')) return { ok: false, reason: '不是仓库内相对路径（以 / 开头）' }
  if (path.split('/').some(segment => segment === '..')) return { ok: false, reason: '含 ".." 路径段' }
  return { ok: true, value: path }
}

/**
 * Turn a list of raw entries into validated values, or the refusals that stop
 * the call.
 *
 * Duplicates are collapsed only AFTER validation, and only exact duplicates:
 * the same repository named twice is one read, which is what the caller meant,
 * while two entries that differ only by case are two different names on GitHub
 * and are both kept.
 */
function collectValidated<T extends string>(
  raw: readonly string[] | undefined,
  validate: (value: string) => { ok: true; value: T } | { ok: false; reason: string },
  what: string,
): { values: T[]; refusals: string[] } {
  const values: T[] = []
  const refusals: string[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    const result = validate(entry)
    if (result.ok) values.push(result.value)
    // The offending value is quoted rather than interpolated raw, because an
    // entry carrying a newline would otherwise forge extra lines in the error
    // the caller reads — the same class of injection this change is about.
    else refusals.push(`${what} ${JSON.stringify(typeof entry === 'string' ? entry : String(entry))}：${result.reason}`)
  }
  return { values: [...new Set(values)], refusals }
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'scout_projects',
    description:
      'STEP 1 of 2. Search GitHub for open-source projects similar to a project the user wants to build. ' +
      'Returns raw candidates (name, owner, description, stars, language, url) sorted by star count — NOT ' +
      'ranked by relevance. Call this first when the user describes an app, tool, or library they intend to ' +
      'build and wants to know what already exists. ' +
      'IMPORTANT: this tool does NOT rank. After it returns, you MUST call rank_candidates (step 2) with a ' +
      'relevance score for every candidate you consider on-topic; the ranking order and the star ratings are ' +
      'computed by code there and cannot be set from prose. Do not present your own ordering of these raw ' +
      'results to the user. Results are cached for 24h per normalized idea + keywords + limit, so identical ' +
      'calls are cheap. ' +
      RETRIEVAL_SURFACE,
    parameters: {
      idea: {
        type: 'string',
        required: true,
        description:
          'The project the user wants to build, in their own words. Free text, any language — ' +
          'pass the idea exactly as the user wrote it. A non-English idea can only reach a ' +
          'same-language repo population disjoint from most well-described projects, so this ' +
          'tool translates the idea into English search terms itself (using the session model) ' +
          'and searches with them. You do NOT need to translate anything, and you should not ' +
          'pre-translate the idea: the tool sees the original text plus its own translation.',
      },
      limit: {
        type: 'integer',
        description: `Maximum candidates to return (default 20, max ${MAX_LIMIT}).`,
      },
      keywords: {
        type: 'string',
        description:
          'OPTIONAL extra GitHub search terms (e.g. "markdown editor local-first") to sharpen recall. ' +
          'Supply these only when the user themself named the terms to search for — the tool already ' +
          'translates a non-English idea on its own, so you do not need to translate anything here. ' +
          'When you do supply them they WIN over the tool\'s own translation: the terms you pass are ' +
          'the ones searched, verbatim. Measured — a Chinese-only idea with no keywords at all used to ' +
          'return ZERO candidates, which is why the tool now translates rather than asking you to. ' +
          'The one remaining refusal: when the idea contains Han characters, no Latin letter is ' +
          'supplied here, AND the tool\'s own translation is unavailable, the call is REFUSED with a ' +
          '`plan_failed` degradation before any search is sent. The tool can only check that Latin ' +
          'terms were supplied, never that they are a good translation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          idea: { type: 'string', required: true },
          cached: { type: 'boolean', required: true },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                full_name: { type: 'string', required: true },
                url: { type: 'string', required: true },
                owner: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                stars: { type: 'number', required: true },
                language: { type: 'string', required: true },
                pushed_at: { type: 'string', required: true },
                archived: { type: 'boolean', required: true },
                topics: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          // How many low-star rows survived the reserved-slot rule. Reported as
          // a number rather than a boolean because "8 small repos are in here"
          // is actionable during scoring, while "true" is not.
          //
          // One definition, both paths: this is the count of rows admitted
          // *because of a reserved slot* (`selectPool` in github.ts), not every
          // row at or below the star ceiling. The cached path used to recompute
          // it as `candidates.filter(c => c.stars <= TAIL_STAR_CEILING).length`,
          // which answers a different question — in an all-small pool that is
          // every row, not the reserved ones — so the same search reported one
          // number on a cold run and another on a replayed one. The count is now
          // stored alongside the rows.
          tail_included: { type: 'integer', required: true },
          // §7.6 / AC12: how many of the RETURNED rows are at or below the tail
          // ceiling. The long-tail population, counted while the pool still
          // exists as a pool.
          //
          // Deliberately a second number rather than a replacement for
          // `tail_included`, which counts the seats the reservation rule PAID
          // for. They diverge in the case that matters: an all-small pool has
          // every row below the ceiling and almost no reserved ones, so one
          // number would report the population as absent exactly where it is
          // largest. See `lowStarInPool` in github.ts.
          //
          // The final-list counterpart is `low_star_in_kept`, reported by
          // `rank_candidates` — the difference between the two is the loss.
          low_star_in_pool: { type: 'integer', required: true },
          // B6: what each query term matched ON ITS OWN. A term that matches
          // almost as much alone as the widest term constrains nothing, which is
          // the fact a full-looking card cannot show.
          query_terms: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                term: { type: 'string', required: true },
                total: {
                  type: 'number',
                  required: true,
                  description: `Solo match count for this term alone, or ${TERM_TOTAL_UNKNOWN} when the probe returned no count.`,
                },
                verdict: { type: 'string', required: true },
              },
            },
          },
          // §7.2: why the per-term diagnostic above is missing or partial, when
          // it is. A plain string rather than a structured object because the
          // renderer prints it verbatim and nothing branches on it — the branch
          // already happened in `describeProbeOutcome`, which saw the report.
          //
          // Empty means "the probes ran and their counts are in `query_terms`".
          // Every other case carries a sentence, because printing nothing reads
          // as "the terms were checked and are fine" — a claim about GitHub that
          // the code is not entitled to make when the truth is a budget fact.
          probe_note: { type: 'string', required: true },
          // The schema language has no `null`, so a probed-but-unmeasured term
          // travels as -1 and the render boundary converts it back. This is the
          // ONE place that encoding is spelled out; the renderer itself only ever
          // sees a `TermReport`, where `total` is `number | null`.
          degraded: {
            required: true,
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  reason: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                },
              },
              { type: 'null' },
            ],
          },
        },
      },
      render: (_args, value) =>
        [{
          type: 'text',
          text: renderCandidates(
            value.idea,
            value.candidates,
            value.degraded,
            value.cached,
            value.tail_included,
            // The schema encodes "no count" as -1, because the tool's schema
            // language has no null in this position. Converted back to null here
            // so the renderer keeps one meaning for unknown: absent, not zero.
            value.query_terms.map((entry) => ({
              term: entry.term,
              total: entry.total < 0 ? null : entry.total,
              verdict: entry.verdict === 'carrying' ? ('carrying' as const) : ('selective' as const),
            })) as TermReport[],
            value.probe_note,
            value.low_star_in_pool,
          ),
        }],
    },
    execute: async (args, exec) => {
      const idea = args.idea.trim()
      const limit = Math.max(1, Math.min(args.limit ?? 20, MAX_LIMIT))

      // Step 2 (user m00439): a Chinese idea with no Latin term anywhere in
      // `keywords` cannot reach the English population the idea is worth
      // comparing against, so the call is refused BEFORE any plan is built or any
      // request is sent. Refusing early is the point — a warning the agent does
      // not act on costs the same round trip as a refusal, but returns a card
      // that looks like an answer. See `refuseChineseIdeaWithoutKeywords`.
      //
      // This runs before the cache, so a refusal never writes a cache entry and
      // never replays one: the same `idea` WITH keywords is a different request,
      // and the same `idea` with no keywords is not a search at all.
      // ---- Translation, then the plan (R2 / AC9) ---------------------------
      //
      // The old flow refused a Han idea with no Latin `keywords` BEFORE planning.
      // That refusal was wrong in two directions at once:
      //
      //   - It made the tool useless for the input it was written for. A Chinese
      //     idea is exactly the case where the plugin can help, and the old path
      //     answered it with an instruction to go and translate by hand.
      //   - It refused input that did NOT need refusing. The guard's predicate is
      //     "has Han AND keywords lack Latin", so a MIXED idea such as
      //     `本地优先的 Markdown 笔记应用，支持双向链接` was refused even though it
      //     already carries usable Latin terms. Measured with the probe in
      //     `.scratch/probe-mixed-plan.mjs`: that input plans cleanly into three
      //     queries with no keywords at all. It was being refused for a defect it
      //     did not have.
      //
      // So translation runs first and the guard is demoted to a FALLBACK: it is
      // reached only when translation was attempted and failed, i.e. when the idea
      // really is Han-only AND there is no way to derive Latin terms.
      //
      // The branch condition is `translationFailed`, NOT `source === 'none'`. A
      // SKIP (English idea, or a mixed idea that already has Latin) is a success
      // with `degraded: null`; testing `source` instead would send the mixed case
      // straight back into the guard and reintroduce the exact bug above. See the
      // decision table in `src/translate.ts`.
      const translation = await translateIdea(
        {
          llm: typeof ctx.get === 'function' ? (ctx.get('llm') as TranslateDeps['llm']) : undefined,
          defaultModel:
            typeof ctx.get === 'function'
              ? (ctx.get('agentDefaultModel') as TranslateDeps['defaultModel'])
              : undefined,
        },
        idea,
        args.keywords,
        exec?.signal,
      )
      const translationNote = describeTranslation(translation)

      if (translationFailed(translation)) {
        const refusal = refuseChineseIdeaWithoutKeywords(idea, args.keywords)
        if (refusal !== null) {
          const degraded: Degraded = { reason: 'plan_failed', detail: refusal }
          return { idea, candidates: [], degraded, cached: false, tail_included: 0, low_star_in_pool: 0, query_terms: [], probe_note: '' }
        }
      }

      // The terms that actually go into the plan. Translation only fills a gap:
      // caller-supplied `keywords` already won inside `translateIdea`, so this
      // never overrides them.
      const effectiveKeywords =
        args.keywords !== undefined && args.keywords.trim().length > 0
          ? args.keywords
          : translation.keywords.length > 0
            ? translation.keywords
            : undefined

      // The plan is built inside a guard, because building it can fail and a
      // failure here used to escape the whole tool.
      //
      // `buildQueries` throws on inputs it cannot turn into a legal plan, and
      // that call used to sit OUTSIDE this try. Measured: 5 of 12 natural Chinese
      // ideas threw before any request was made — `一个区块链浏览器，支持多链查询和交易追踪`
      // and four others — including when English `keywords` were supplied. The
      // exception went straight through `execute`, so the contract every other
      // path in this function honours ("a failed search still returns a
      // well-formed value with a degraded note") was broken at step one, and the
      // caller got a raw error instead of a card that explains itself.
      //
      // A plan defect is a degradation now, not a crash. T2 removes the known
      // cause; this guard is what keeps the NEXT unknown cause from reaching the
      // user as a stack trace.
      let queries: QueryStep[] = []
      let unknownTerms: readonly string[] = []
      const planned = tryPlanQueries(idea, effectiveKeywords)
      if (!planned.ok) {
        const degraded: Degraded = {
          reason: 'plan_failed',
          detail: describePlanFailure(planned.error, effectiveKeywords),
        }
        degraded.detail = `${degraded.detail}${withProxyHint()}`
        return { idea, candidates: [], degraded, cached: false, tail_included: 0, low_star_in_pool: 0, query_terms: [], probe_note: '' }
      }
      queries = planned.planned.queries
      unknownTerms = planned.planned.diagnostics.unknownTerms
      const hasEnglishChannel = planned.planned.diagnostics.hasEnglishChannel

      // Resolve the token BEFORE touching the cache: whether a token is available
      // changes what GitHub returns, so it is part of the identity of this search.
      // Reading the cache first would let a thin anonymous result be replayed to a
      // caller that now has a token (see `searchCacheKeyFor`).
      const token = await resolveGitHubToken(ctx)
      // The key uses the EFFECTIVE keywords, not the raw argument: a translated
      // query and a caller-supplied one produce the same plan only by accident,
      // and two different ideas can translate to the same terms. Keying on what
      // was actually searched is what keeps a hit an answer to this question.
      const key = searchCacheKeyFor(idea, effectiveKeywords, limit, token !== undefined)
      const hit = await cacheGet<CachedSearch>(key)
      if (hit !== undefined) {
        // `tail_included` is stored, not recomputed. Recomputing it from the
        // rows answered a different question than the cold path did (see the
        // note on the output schema), so a replayed search reported a different
        // number than the run that filled the cache.
        //
        // `degraded` is rebuilt rather than replayed — but rebuilt from the facts
        // about the ROWS that were stored alongside them, never from the wording.
        // A message like "剩余配额只剩 1 次" describes one fetch at one moment;
        // printing it 20 hours later would assert a reading that no longer exists.
        // See `describeReplayedIncompleteness` and `describeReplayedThinness`.
        //
        // `lexicon_miss` needs no stored field at all: it is a pure function of
        // `unknownTerms` — computed above, BEFORE this lookup — and `args.keywords`,
        // so the replay re-derives an identical note. It used to be dropped here,
        // which meant the one actionable note in the card vanished on the retry.
        //
        // `hit.thin` is `ThinKind | null` and not `undefined` because
        // `CACHE_VERSION` was bumped when the field was added: entries written
        // before it are rejected by the version check in `cacheGet`, so a shape
        // that lacks the field cannot reach this line.
        const primary: Degraded | null = hit.incomplete
          ? { reason: 'partial', detail: describeReplayedIncompleteness() }
          : hit.thin !== null
            ? { reason: 'thin_result', detail: describeReplayedThinness(hit.thin) }
            : null
        const degraded = composeDegraded(
          primary,
          describeLexiconMiss(idea, effectiveKeywords, unknownTerms, hasEnglishChannel),
          translationNote,
        )
        // §7.6 / AC12: the pool-side low-star count is RECOMPUTED here rather
        // than stored, and that is not a contradiction of the paragraph above —
        // it is the distinction that paragraph draws. `tailIncluded` cannot be
        // recovered from the rows (an all-small pool has every row under the
        // ceiling but only `reserve` of them were seated for that reason), so it
        // must be stored. `low_star_in_pool` is a pure function of the rows, so
        // storing it would be a second copy of a derivable fact — exactly the
        // kind of duplicate that goes stale. Same helper as the cold path, so
        // the two cannot answer with different thresholds.
        return {
          idea,
          candidates: hit.candidates,
          degraded,
          cached: true,
          tail_included: hit.tailIncluded,
          low_star_in_pool: countLowStar(hit.candidates),
          query_terms: [],
          probe_note: describeUnavailableProbeDiagnostic(),
        }
      }

      try {
        const { candidates, failures, failureDetails, remaining, tailIncluded, lowStarInPool, termTotals, probe } = await searchMerged(queries, limit, {
          token,
          signal: exec?.signal,
        })
        // Classify the shortfall BEFORE caching, so the KIND travels with the
        // rows. This is the one degradation fact that cannot be re-derived on a
        // replay: the `quota` test reads `remaining`, which exists only in this
        // response's headers. Storing it is what keeps a replayed 2-row result
        // from being presented as a clean one.
        //
        // Both calls below read the SAME rule (`thinResultKind`); one yields the
        // kind to store, the other the wording to show. The rule having one
        // definition is the property that matters — the defect was the cold and
        // cached paths implementing the rule separately, not the extra call.
        const thinKind = thinResultKind(candidates.length, limit, remaining, token !== undefined)
        const thin = explainThinResult(candidates.length, limit, remaining, token !== undefined)

        // B6: report what each query term matched ON ITS OWN, so a term that
        // constrains nothing becomes visible while the card is still being read.
        // Measured case: `browser extension web page translation translate`
        // returned a full page because `browser extension` alone matches a huge
        // population, and the card showed 30 rows with no sign that two of the
        // four terms were pulling no weight.
        const queryTerms = termReport(queries, termTotals)

        // Only non-empty results are cached. A zero-row response almost always
        // reflects a weak query rather than a fact about GitHub, and caching it
        // would replay that bad outcome for a full day even after the caller
        // retries with better keywords.
        if (candidates.length > 0) {
          // `incomplete` records whether this fetch got everything it asked for,
          // so a replay can say "these rows are missing something" without
          // claiming any query failed just now. `thin` records which shortfall
          // this was, for the same reason.
          await cacheSet<CachedSearch>(key, {
            candidates,
            tailIncluded,
            incomplete: failures.length > 0,
            thin: thinKind,
          })
        }

        // Three separate things can make a card thin, and they are not the same
        // problem: some queries failed, the quota is nearly gone, or the queries
        // were simply too narrow. Report whichever actually applies.
        //
        // `lexicon_miss` is a FOURTH thing and is reported ALONGSIDE whichever of
        // the three applies, not instead of it — see `composeDegraded`, which the
        // replay path calls too so the two cannot disagree.
        let primary: Degraded | null = null
        if (failures.length > 0) {
          primary = {
            reason: 'partial',
            // The roles of the failed slots travel as data. They used to be
            // recovered by looking for the string `sort=updated` inside the
            // failure text, which (a) broke whenever the wording changed and
            // (b) could not see a `narrow` tail at all, since that tail is
            // deliberately `sort=stars`.
            detail: describePartialFailure(
              queries,
              failures,
              token !== undefined,
              failureDetails.map((failure) => failure.role),
            ),
          }
        } else if (thin !== null) {
          primary = { reason: 'thin_result', detail: thin }
        }
        const degraded = composeDegraded(
          primary,
          describeLexiconMiss(idea, effectiveKeywords, unknownTerms, hasEnglishChannel),
          translationNote,
        )
        // Every failure path gets the proxy sentence, not just the one where the
        // transport layer happened to throw. A misconfigured proxy shows up as a
        // 403 or as a smaller result set just as easily as it does as a
        // `fetch failed`, and those paths never reached `proxyHint()` before.
        if (degraded !== null) degraded.detail = `${degraded.detail}${withProxyHint()}`
        return { idea, candidates, degraded, cached: false, tail_included: tailIncluded, low_star_in_pool: lowStarInPool, query_terms: queryTerms, probe_note: describeProbeOutcome(probe) }
      } catch (error) {
        // Partial-result rule: a failed search still returns a well-formed
        // value with a degraded note, so the card can explain itself rather
        // than the call failing outright.
        const degraded: Degraded = error instanceof GitHubSearchRateLimited
          ? {
              reason: 'rate_limited',
              detail: token === undefined
                ? `${error.message} 未配置 GITHUB_TOKEN，建议配置后重试。`
                : error.message,
            }
          : {
              reason: 'search_failed',
              detail: describeFailure(error),
            }
        degraded.detail = `${degraded.detail}${withProxyHint()}`
        return { idea, candidates: [], degraded, cached: false, tail_included: 0, low_star_in_pool: 0, query_terms: [], probe_note: '' }
      }
    },
    timeoutMs: 25000,
  }))

  ctx.tools.register(defineTool({
    name: 'rank_candidates',
    description:
      'STEP 2 of 2, and the ONLY place a card is produced. Turn raw candidates from scout_projects into a ' +
      'ranked card. Supply a relevance score (integer 0-10) for EVERY candidate: 10 = almost exactly the same ' +
      'idea, 7-9 = same problem space with a different angle, 4-6 = partial overlap or a useful dependency, ' +
      '3 = loosely related but worth a mention. ' +
      'Scores below 3 are excluded by code and never appear in the card — use 1-2 for "barely related" (for ' +
      'example a general Markdown converter or web scraper that only shares the word "markdown"), and 0 for ' +
      'noise such as keyword-bait repos. Do not inflate a weak match just to fill the card; a short honest ' +
      'card is the intended outcome. ' +
      'You provide ONLY full_name and relevance. The order, the borrow-worthiness star rating, and the score ' +
      'are all computed in code by relevance × (1 + log10(max(stars, 10) + 1)) / 2; do not attempt to order ' +
      'the list yourself, do not invent a star rating, and do not present your own ranking to the user. ' +
      'Pass every candidate you scored in one call — candidates you omit are excluded. ' +
      'The rendered card is material for you to work with, not a finished message: you are free to re-present ' +
      'it in your own format, grouping or wording, and to add your own commentary. ' +
      'HARD LIMIT — you must NOT alter any key datum: the rank order, each row\'s relevance, stars_rating and ' +
      'score, and each repository\'s stars, owner, name and url must be reproduced exactly as the card gives ' +
      'them. Changing a number, reordering rows, dropping a row or a column, or inventing a rating is not. ' +
      'A description may be paraphrased, but its column must appear for every row, and every number you show ' +
      'must stay traceable to the card: a restatement without 简介 has lost a column, not shortened a table. ' +
      'The card separates CODE-COMPUTED rows (order, stars_rating, score, all derived from your relevance) ' +
      'from CALLER NOTES (any free text you supply): a judgement in prose never enters the formula, so put ' +
      'your reasoning in `scores[].note` rather than beside a number. ' +
      RETRIEVAL_SURFACE,
    parameters: {
      idea: {
        type: 'string',
        required: true,
        description: 'The same idea text passed to scout_projects.',
      },
      candidates: {
        type: 'array',
        required: true,
        description:
          'The pool to rank. Pass the whole array through so the card can render name, owner, description, ' +
          'stars, language and url. These do NOT have to come from scout_projects: if you searched GitHub ' +
          'yourself (for example with the qualifiers `topic:`, `in:readme`, `stars:>` or `pushed:`), pass your ' +
          'own results here in this exact shape. The ranking arithmetic, the card, and the consistency checks ' +
          'below all work on any pool — they never re-query GitHub. `topics` may be an empty array. If you ' +
          'supply your own, the card reports where the pool came from so the distinction is not lost.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            full_name: { type: 'string', required: true },
            url: { type: 'string', required: true },
            owner: { type: 'string', required: true },
            name: { type: 'string', required: true },
            description: { type: 'string', required: true },
            stars: { type: 'number', required: true },
            language: { type: 'string', required: true },
            pushed_at: { type: 'string', required: true },
            archived: { type: 'boolean', required: true },
            topics: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
      },
      scores: {
        type: 'array',
        required: true,
        description: 'Your relevance judgement for each candidate. Names not present in `candidates` are ignored.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            full_name: { type: 'string', required: true },
            relevance: { type: 'integer', required: true, description: 'Integer 0-10. 0 drops the candidate.' },
            note: {
              type: 'string',
              description:
                'A one-line reason for this score, at least a short clause. This is NOT optional in practice: ' +
                'the note is how you tell the tool "this score is deliberate", and how you tell the user why. ' +
                'Two consistency checks read it — a high score (7+) with no note counts as an unexplained ' +
                'judgement, and two rows with near-identical descriptions and a 5+ point gap are reported as ' +
                'self-contradictory UNLESS both carry a note (two projects can share a description and still ' +
                'deserve different scores; the note is what records that distinction). Kept OUT of the computed ' +
                'card and the formula — it never enters the ranking arithmetic, and is echoed under a label that ' +
                'says it is unverified. Use it instead of writing a rationale beside a number in your reply, ' +
                'where it would read as if the code had produced it.',
            },
          },
        },
      },
      keywords: {
        type: 'string',
        description:
          'The same keywords passed to scout_projects, if any. Used only to check whether a low-scored ' +
          'candidate\'s own description contradicts its score — it never enters the ranking formula.',
      },
      pool_source: {
        type: 'string',
        description:
          'Where this pool came from: "scout_projects" or "agent" (your own GitHub search). Purely ' +
          'descriptive — it changes no number and gates no check — but it is printed on the card, so a ' +
          'reader can tell a tool-gathered pool from a self-gathered one.',
      },
      limit: {
        type: 'integer',
        description: `Maximum rows to keep after ranking (default 10, max ${MAX_LIMIT}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          idea: { type: 'string', required: true },
          total: { type: 'number', required: true },
          ranked: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rank: { type: 'number', required: true },
                full_name: { type: 'string', required: true },
                url: { type: 'string', required: true },
                owner: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                stars: { type: 'number', required: true },
                language: { type: 'string', required: true },
                pushed_at: { type: 'string', required: true },
                archived: { type: 'boolean', required: true },
                topics: { type: 'array', required: true, items: { type: 'string' } },
                relevance: { type: 'number', required: true },
                stars_rating: { type: 'number', required: true },
                score: { type: 'number', required: true },
                // B10: the fetched canonical url, not a reconstruction from
                // full_name — the owner path segment is case-sensitive.
                html_url: { type: 'string', required: true },
                // §6.4c: the caller's own reason for the score, carried through
                // to the card. It was already accepted as INPUT (see the
                // `scores` parameter) and already read by the renderer, but it
                // was never declared HERE — so it was dropped between the two
                // and the 【调用方说明区】 block could never be non-empty. It is
                // deliberately optional: a score without a stated reason is a
                // real case (the consistency rules report it as `noteGap`), not
                // a malformed row.
                note: { type: 'string' },
              },
            },
          },
          unknown: { type: 'array', required: true, items: { type: 'string' } },
          dropped: { type: 'array', required: true, items: { type: 'string' } },
          below_threshold: { type: 'array', required: true, items: { type: 'string' } },
          // B2: rows whose OWN description carries a query term yet which were
          // scored at or below the floor. Reported as objects, not names,
          // because the reader has to see the matched term and the quote to
          // judge whether the score or the text is wrong.
          suspicious: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                full_name: { type: 'string', required: true },
                relevance: { type: 'number', required: true },
                matched: { type: 'array', required: true, items: { type: 'string' } },
                quote: { type: 'string', required: true },
                // C1-C4: which consistency rule fired, so the reader can tell a
                // one-directional mis-score from a duplicated note.
                kind: { type: 'string', required: true },
                against: { type: 'string', required: true },
              },
            },
          },
          // B3: how the scores were distributed across the pool, so a query
          // whose lead term is too broad is visible as a number rather than as a
          // feeling about the card.
          noise: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              scored: { type: 'number', required: true },
              noise: { type: 'number', required: true },
              weak: { type: 'number', required: true },
              kept: { type: 'number', required: true },
              unanswered: { type: 'number', required: true },
              noise_ratio: { type: 'number', required: true },
              // §7.6 / AC12: the long-tail loss, as two numbers that are only
              // meaningful together. `low_star_in_pool` counts the caller's pool,
              // `low_star_in_kept` counts what survived into the card. Reporting
              // one of them would be worse than reporting neither: a bare
              // "3 small projects kept" reads as "the long tail was served",
              // when the pool may have held 20 and the formula pushed 17 out.
              low_star_in_pool: { type: 'integer', required: true },
              low_star_in_kept: { type: 'integer', required: true },
            },
          },
          // Step 1 (user m01331): the pool no longer has to come from
          // scout_projects, so the card records which it was. Empty string means
          // the caller did not say.
          pool_source: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: renderRanked(
            value.idea,
            value.ranked,
            value.unknown,
            value.dropped,
            value.below_threshold,
            value.suspicious,
            value.noise,
            value.pool_source,
          ),
        },
      ],
    },
    execute: async (args) => {
      const idea = args.idea.trim()
      const limit = Math.max(1, Math.min(args.limit ?? 10, MAX_LIMIT))

      // Ranking is pure and local: no network, no cache, no token. The agent's
      // only degree of freedom is the relevance integer, and everything visible
      // in the card (order, star rating, score) is derived from it here.
      const candidates = args.candidates as RepoCandidate[]
      const { ranked, unknown, dropped, belowThreshold } = rankCandidates(
        candidates,
        args.scores as RelevanceInput[],
      )
      const kept = ranked.slice(0, limit)

      // B2 + C1-C4 (user m01331): was this scoring round internally consistent?
      // The query is idea + keywords, matching what produced the pool, because a
      // term only counts as evidence if that is what the search ran on.
      const queryText = `${idea} ${args.keywords ?? ''}`
      const suspicious = [
        ...findDoubleSided(candidates, args.scores as RelevanceInput[], queryText),
        ...findScoreGaps(candidates, args.scores as RelevanceInput[]),
        ...findNoteEchoes(args.scores as RelevanceInput[]),
      ]

      // B3: the distribution behind the card. `unanswered` is counted against
      // the pool the agent was given, so a partial scoring round (25 of 30 rows
      // scored) is visible instead of silently shrinking the pool.
      const scored = dropped.length + belowThreshold.length + ranked.length
      const noise = {
        scored,
        noise: dropped.length,
        weak: belowThreshold.length,
        kept: kept.length,
        unanswered: Math.max(0, candidates.length - scored),
        noise_ratio: candidates.length === 0 ? 0 : dropped.length / candidates.length,
        // §7.6 / AC12. Both counts use the SAME helper as the search side, so a
        // future change to what "low star" means cannot move one end of the
        // measurement without the other. The pool here is the caller's list —
        // the thing this tool was actually handed — and the final list is
        // `kept`, the rows the card shows, AFTER the limit truncation. Counting
        // against `ranked` instead would measure a list nobody ever sees and
        // would hide exactly the truncation loss the field exists to expose.
        low_star_in_pool: countLowStar(candidates),
        low_star_in_kept: countLowStar(kept),
      }

      return {
        idea,
        total: kept.length,
        ranked: kept,
        unknown,
        dropped,
        below_threshold: belowThreshold,
        suspicious,
        noise,
        pool_source: args.pool_source?.trim() ?? '',
      }
    },
    timeoutMs: 5000,
  }))

  ctx.tools.register(defineTool({
    name: 'inspect_projects',
    description:
      'STEP 2 of the scouting flow. Read the actual source of the repositories the user selected — README, ' +
      'dependency manifest, directory tree and key files — so you can judge architecture and borrow-worthiness ' +
      'from evidence instead of a one-line description. Call this after the user picks repositories from the ' +
      'card, and before writing any implementation plan. ' +
      'WHY THIS RATHER THAN READING FILES YOURSELF: this returns every file in one call, and `files_read` ' +
      'records exactly what was fetched, so the plan you write can state its evidence. Reading individual files ' +
      'by hand costs the same API requests, loses that record, and skips the selection step below. ' +
      'Low-star repos surfaced by the tail search often have an empty description, so this is the ONLY way to ' +
      'know what they actually are. ' +
      'FILE SELECTION IS AUTOMATIC AND ALREADY DONE: without `files`, this picks up to 4 files per repository ' +
      'from the full directory tree — the root README, a frontend entry point, a native/backend entry point, ' +
      'and a manifest or design document — so a Tauri-style project shows both its frontend and its Rust side. ' +
      'On live repositories this selection has been right on every one tried. Pass `files` only to override ' +
      'it, e.g. to re-read a specific path the user asked about. ' +
      'BUDGET: reading costs GitHub API requests and anonymous access allows 10 requests/minute per public IP, ' +
      'shared with every other process. shallow costs about 6 requests per repo, deep about 10. There is also a ' +
      'wall-clock budget: the host terminates this call at 60 seconds and returns NOTHING when it does, not even ' +
      'the repos already read, so a batch that cannot finish in time is refused up front instead. If the request ' +
      'does not fit in the remaining quota or time budget the call is refused outright with the reason — you must ' +
      'then reduce the number of repos, use shallow, or ask the user to configure GITHUB_TOKEN. Retrying the same ' +
      'batch unchanged will fail the same way. A refusal is a normal, ' +
      'expected outcome; it is reported to the user, not hidden. Never present an inspection you did not ' +
      'receive. ' +
      'REPORTING RULE: `files_read` is the exact list of files that were fetched. Judge only from the excerpts ' +
      'returned, and if you did not read code, say so plainly rather than describing an architecture you ' +
      'inferred from the name. ' +
      RETRIEVAL_SURFACE + ' Reading files HERE is what closes that gap — a description that omits the idea ' +
      'does not mean the code does, which is why an empty description is a reason to inspect, not to dismiss.',
    parameters: {
      idea: {
        type: 'string',
        required: true,
        description: 'The same idea text the user is building toward.',
      },
      repos: {
        type: 'array',
        required: true,
        description:
          `Repositories to inspect, as "owner/repo" strings. At most ${MAX_INSPECT_REPOS} per call; if you need ` +
          'more, make several calls and spread them over time to respect the per-minute quota.',
        items: { type: 'string' },
      },
      depth: {
        type: 'string',
        enum: ['shallow', 'deep'],
        description:
          'shallow (default) reads the README plus up to 4 key files and costs about 6 requests per repo — ' +
          'enough to judge architecture and borrow-worthiness, and the right choice for a first pass over ' +
          'several repositories. deep reads far more of the README and up to 8 files, costing about 10 ' +
          'requests per repo — use it for the one or two projects the user is most likely to borrow from.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional explicit file paths to read, e.g. ["src/main.ts","deps.edn"]. Omit it for a first pass: the ' +
          'automatic selection picks the four most CENTRAL faces of this repo (root README, a frontend entry ' +
          'point, a native/backend entry point, and a manifest or design document from the full directory ' +
          'tree). Central is not always the same as most useful FOR THIS IDEA — when step 1\'s file tree or ' +
          'the conversation has already told you which paths matter, pass them here. Explicit paths override ' +
          'the selector including for paths it would reject, because the caller may have read something no ' +
          'rule can see. Paths are relative to the repository root and apply to every repository in `repos`; ' +
          'a path that cannot be read is reported, never silently skipped. Costs one extra request per path ' +
          'per repository.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          idea: { type: 'string', required: true },
          cached: { type: 'boolean', required: true },
          depth: { type: 'string', required: true },
          requests_used: { type: 'number', required: true },
          inspections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                full_name: { type: 'string', required: true },
                url: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                files_read: { type: 'array', required: true, items: { type: 'string' } },
                readme_excerpt: { type: 'string', required: true },
                manifest_excerpt: { type: 'string', required: true },
                tree_summary: { type: 'string', required: true },
                skeleton_summary: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
          degraded: {
            required: true,
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  reason: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                },
              },
              { type: 'null' },
            ],
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: renderInspections(value.idea, value.inspections as Inspection[], value.degraded, value.cached),
        },
      ],
    },
    execute: async (args, exec) => {
      const idea = args.idea.trim()
      const depth: InspectDepth = args.depth === 'deep' ? 'deep' : 'shallow'
      const budget = INSPECT_BUDGET[depth]

      // AC10: validate before anything is fetched, and REFUSE rather than drop.
      // A dropped entry is the worse failure: the caller asked for three
      // repositories, the card shows two, and nothing says which one vanished —
      // so the agent describes architecture it never read. The refusal names
      // every offending entry and the rule it broke, so the fix is a rewrite of
      // the argument rather than a guess.
      const repoCheck = collectValidated(args.repos, validateRepo, '仓库名')
      const fileCheck = collectValidated(args.files, validateFilePath, '文件路径')
      if (repoCheck.refusals.length > 0) {
        const detail =
          `以下 repos 不是合法的 "owner/name"：${repoCheck.refusals.join('；')}。` +
          `要求：恰好两段、非空、只含 GitHub 允许的字符（字母、数字、. _ -），不含 ".."、空白或控制字符。` +
          `这些条目已拒绝，本轮没有读取任何仓库——请修正后重新调用。`
        return { idea, cached: false, depth, requests_used: 0, inspections: [], degraded: { reason: 'invalid_repos', detail } }
      }
      if (fileCheck.refusals.length > 0) {
        const detail =
          `以下 files 不是合法的仓库内相对路径：${fileCheck.refusals.join('；')}。` +
          `要求：不含 ".." 路径段、不含控制字符、不是绝对路径。` +
          `这些条目已拒绝，本轮没有读取任何仓库——请修正后重新调用。`
        return { idea, cached: false, depth, requests_used: 0, inspections: [], degraded: { reason: 'invalid_files', detail } }
      }

      const requested = repoCheck.values
      const repos = requested.slice(0, MAX_INSPECT_REPOS)

      // Refuse up front rather than half-reading: a partial inspection that looks
      // complete is worse than a clear refusal, because the agent would then
      // describe architecture it never actually saw.
      if (requested.length > MAX_INSPECT_REPOS) {
        const detail =
          `一次最多读取 ${MAX_INSPECT_REPOS} 个仓库，收到 ${requested.length} 个。` +
          `建议分批调用：先读最可能借鉴的 ${MAX_INSPECT_REPOS} 个，与用户确认后再读下一批。`
        return { idea, cached: false, depth, requests_used: 0, inspections: [], degraded: { reason: 'too_many_repos', detail } }
      }

      if (repos.length === 0) {
        const detail = '没有提供任何仓库名。请传入形如 "owner/repo" 的字符串数组。'
        return { idea, cached: false, depth, requests_used: 0, inspections: [], degraded: { reason: 'no_repos', detail } }
      }

      const estimated = repos.length * budget.requestsPerRepo
      const token = await resolveGitHubToken(ctx)

      // Real request count, not a budget estimate. The counter is incremented by
      // `requestJson` at the moment an HTTP attempt goes on the wire, so it
      // includes retries and excludes repositories served from cache -- the two
      // cases the old `+= budget.requestsPerRepo` got exactly backwards.
      //
      // Declared HERE, above the quota probe, because that probe is itself a
      // request and is wired to this counter. Declaring it next to the read loop
      // below would leave the probe referencing a `const` in its temporal dead
      // zone: legal to type-check, and a `ReferenceError` at runtime.
      let requestsUsed = 0
      const countRequest = (): void => { requestsUsed += 1 }

      // When this call must be finished, and the slice of that which the reads
      // may claim. Everything below threads `deadline` into the HTTP layer, so
      // the per-attempt timeout shrinks as the budget is spent instead of a
      // single request being allowed to burn 19000ms of a 60000ms ceiling.
      const budgetMs = Math.floor(INSPECT_TIMEOUT_MS * TIME_BUDGET_SHARE)
      const deadline = Date.now() + budgetMs

      // ---- Cache first, refusals second ------------------------------------
      //
      // This lookup USED to sit after the quota probe and after the anonymous
      // refusal, so a caller whose cache already held the answer was told
      // "配额不足" and sent away without it. The order was backwards: a hit costs
      // no request and no wall-clock, so neither refusal applies to it. Those
      // checks exist to protect NETWORK work, and a hit is not network work.
      //
      // The key carries three things the old one did not:
      //   - `auth`, because whether a token is present changes what GitHub
      //     returns (private repos, a higher quota), so the two are different
      //     questions and must not share one entry;
      //   - the SELECTOR version, because the stored rows record WHICH PATHS were
      //     picked — a cached pick from an older selector answers a question the
      //     current code no longer asks;
      //   - the SCANNER version, for the same reason about the signature evidence
      //     derived from those file heads.
      // Without the two versions, a rules change would keep serving the old
      // rules' output with nothing in the result to tell the caller.
      //
      // The explicit file list is part of the identity of the result too: serving
      // a cached heuristic pick to a caller who asked for three specific files
      // would silently answer a different question.
      // The validated list, not `args.files`: the key must identify what will
      // actually be read, so a rejected or duplicated entry cannot make two
      // different reads share one cache slot.
      const filesKey = fileCheck.values.slice().sort().join('|')
      const cacheKey =
        `inspect:${depth}:${repos.slice().sort().join(',')}:${filesKey}` +
        `:auth:${token !== undefined ? 1 : 0}:sel:${SELECTOR_VERSION}:scan:${SCANNER_VERSION}`
      // Source reads expire in minutes, not a day: what this caches is file
      // CONTENTS, and a stale copy would make `files_read` attest to code that no
      // longer exists. See `SOURCE_TTL_MS`.
      //
      // `cacheGetWithMeta` rather than `cacheGet` because the replay must report
      // the AGE of the evidence: "this is what the file said eight minutes ago" is
      // a different claim from "this is what the file says", and only the caller
      // can judge whether that is good enough.
      const cached = await cacheGetWithMeta<CachedInspection>(cacheKey, SOURCE_TTL_MS)
      if (cached !== undefined && cached.data.inspections.length > 0) {
        const record = cached.data
        // Serve the rows in the order THIS caller asked for them. The key sorts
        // the repo list, so a hit can come from a call that named the same
        // repositories in a different order; returning the earlier caller's order
        // would answer a question this caller did not ask. The stored
        // `requestedRepos` is what makes the reorder possible at all.
        const byName = new Map(record.inspections.map(row => [row.full_name.toLowerCase(), row]))
        const ordered = repos
          .map(repo => byName.get(repo.toLowerCase()))
          .filter((row): row is Inspection => row !== undefined)
        const present = new Set(ordered.map(row => row.full_name.toLowerCase()))
        const absent = repos.filter(repo => !present.has(repo.toLowerCase()))
        return {
          idea,
          cached: true,
          depth,
          requests_used: 0,
          inspections: ordered,
          // NOT `null`. A hit is only clean when the fetch that filled it was
          // complete; otherwise the replay rebuilds the shortfall from the stored
          // facts. See `describeCachedInspection`.
          degraded: describeCachedInspection(record, absent, cached.ageMs, cached.fetchedAt),
        }
      }

      // The caller's own arithmetic can say the batch fits while the shared
      // egress IP has already spent the quota. `/rate_limit` is free, so ask it
      // before any read: an up-front refusal with the real wait time beats a
      // mid-batch 403 that leaves a partial reading looking complete.
      //
      // This probe is free of *quota* but it is not free of requests: it is a
      // real HTTP call, and the counter that feeds `requests_used` counts what
      // went on the wire. Wired here too, so the field means "requests this call
      // actually sent" rather than "requests this call sent after the probe".
      const quota = await getCoreQuota({ token, signal: exec?.signal, onRequest: countRequest })
      if (quota !== undefined && quota.remaining < estimated) {
        const wait = quota.resetInSeconds > 0 ? `约 ${Math.ceil(quota.resetInSeconds / 60)} 分钟后` : '稍后'
        const detail =
          `当前 GitHub 配额剩余 ${quota.remaining}/${quota.limit} 次，而本次需要约 ${estimated} 次` +
          `（${repos.length} 个仓库 × ${budget.requestsPerRepo} 次/${depth}），不足以完成读取。` +
          `配额${wait}重置。请减少仓库数量、改用 shallow、分批调用，或配置 GITHUB_TOKEN` +
          '（认证后为每账号 5000 次/小时，不受此限制）。' +
          '本次未发起任何读取请求。'
        return { idea, cached: false, depth, requests_used: 0, inspections: [], degraded: { reason: 'quota_exceeded', detail } }
      }

      if (token === undefined && estimated > 10) {
        const detail =
          `本次需要约 ${estimated} 次 API 请求（${repos.length} 个仓库 × ${budget.requestsPerRepo} 次/${depth}），` +
          '而匿名访问的配额是每出口 IP 每分钟 10 次、且与其他进程共享，会中途被限流并留下不完整的读取结果。' +
          `请减少仓库数量（一步到位约 2 个 shallow 或 1 个 deep）、改用 shallow、分批调用，` +
          '或配置 GITHUB_TOKEN（认证后为每账号 30 次/分钟）。'
        return { idea, cached: false, depth, requests_used: 0, inspections: [], degraded: { reason: 'quota_exceeded', detail } }
      }

      // The other budget: wall-clock time. A real session died here -- a deep
      // 2-repo read hit the host's 60000ms ceiling and came back as a bare
      // `ToolTimeoutError` with no partial payload, so the caller learned
      // nothing about which repositories had been read or how much quota the
      // call had spent. The tool cannot catch that kill: the host terminates the
      // call, so no `catch` here ever runs. Two things are fixable, and both are
      // fixed above rather than predicted here:
      //
      //   1. `requestJson` now caps every attempt's timeout by the time left
      //      before `deadline`, so one sick request cannot cost 19000ms. The
      //      budget is a bound the code enforces, not a guess about the network.
      //   2. This check refuses a batch that cannot fit even at the MEASURED
      //      per-repo cost, which is the only refusal that is certain to be
      //      right. It deliberately does not assume any requests will fail:
      //      measured latency says deep 2 repos costs 11.9s, and refusing that
      //      call -- which an earlier version of this check did -- would reject
      //      work that succeeds. Sickness is handled by the cap, not by
      //      pretending to forecast it.
      const estimatedMs = repos.length * budget.msPerRepo
      if (estimatedMs > budgetMs) {
        const fitsShallow = Math.floor(budgetMs / INSPECT_BUDGET.shallow.msPerRepo)
        const detail =
          `按实测速度，本次读取约需 ${(estimatedMs / 1000).toFixed(1)} 秒` +
          `（${repos.length} 个仓库 × 约 ${(budget.msPerRepo / 1000).toFixed(1)} 秒/${depth}），` +
          `超过了本工具 ${(budgetMs / 1000).toFixed(0)} 秒的时间预算` +
          `（宿主在 ${(INSPECT_TIMEOUT_MS / 1000).toFixed(0)} 秒处强制终止，且被终止时不会返回任何已读到的内容）` +
          `——那样你会拿不到任何结果，也不知道哪些仓库已经读过。` +
          `请一次最多读 ${fitsShallow} 个仓库，或改用 shallow，或分批调用。` +
          '本次未发起任何读取请求。'
        return { idea, cached: false, depth, requests_used: 0, inspections: [], degraded: { reason: 'time_budget_exceeded', detail } }
      }

      const inspections: Inspection[] = []
      const failures: string[] = []

      for (const repo of repos) {
        try {
          if (exec?.signal?.aborted === true) {
            failures.push(`${repo}: 已取消`)
            break
          }
          inspections.push(await inspectOne(
            repo,
            budget,
            { token, signal: exec?.signal, deadline, onRequest: countRequest },
            fileCheck.values.length > 0 ? fileCheck.values : undefined,
          ))
        } catch (error) {
          // Rate limiting aborts the whole batch: continuing would just burn
          // more of a quota that is already exhausted.
          if (error instanceof GitHubSearchRateLimited) {
            const detail = `${error.message}${withProxyHint()}`
            if (inspections.length === 0) {
              return { idea, cached: false, depth, requests_used: requestsUsed, inspections: [], degraded: { reason: 'rate_limited', detail } }
            }
            failures.push(`${repo}: ${error.message}`)
            break
          }
          failures.push(`${repo}: ${describeFailure(error)}`)
        }
      }

      if (inspections.length === 0) {
        const detail = failures.length > 0 ? failures.join('；') : '没有读取到任何仓库。'
        return { idea, cached: false, depth, requests_used: requestsUsed, inspections: [], degraded: { reason: 'inspect_failed', detail: detail + withProxyHint() } }
      }

      // Store the batch record, not a bare array. `requestedRepos` is kept so a
      // replay can serve the rows in the calling order and can notice a
      // repository the entry has no answer for at all; `complete` is the flag
      // that stops a partial fetch from coming back clean. Both are facts about
      // the rows, so both survive the replay unchanged — unlike the failure text,
      // which is regenerated. See `describeCachedInspection`.
      //
      // Only non-empty results are cached, for the same reason the search cache
      // skips them: a zero-row response reflects a weak request far more often
      // than a fact about GitHub, and replaying it for ten minutes would hide a
      // retry that would have worked.
      const failedRepos = inspections.filter(item => !item.ok).map(item => item.full_name)
      await cacheSet<CachedInspection>(
        cacheKey,
        {
          inspections,
          requestedRepos: repos,
          failedRepos,
          complete: failures.length === 0 && failedRepos.length === 0 && inspections.length === repos.length,
        },
        `sel:${SELECTOR_VERSION}:scan:${SCANNER_VERSION}`,
      )

      const degraded: Degraded | null = failures.length > 0 || failedRepos.length > 0
        ? {
            reason: 'partial',
            detail: [
              failures.length > 0 ? `未能读取：${failures.join('；')}` : '',
              failedRepos.length > 0 ? `读取失败：${failedRepos.join(', ')}` : '',
            ].filter(part => part.length > 0).join(' '),
          }
        : null

      return { idea, cached: false, depth, requests_used: requestsUsed, inspections, degraded }
    },
    timeoutMs: INSPECT_TIMEOUT_MS,
  }))
}
