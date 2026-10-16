/**
 * Query planning: turning a user's idea into GitHub search queries.
 *
 * Kept in its own module because it is the one part of the pipeline that is a
 * pure function of the user's words, and because its history is a warning: the
 * plan behind the long-tail fix went through three rewrites with no automated
 * coverage, because it was reachable only through a registered tool. Everything
 * here is exported and tested directly.
 */

import { englishSeeds } from './lexicon.ts'

/**
 * What the planner learned about the idea while building the plan.
 *
 * This exists because the planner already computes a fact it never told anyone:
 * which CJK terms its lexicon failed to recognise. `englishSeeds` has collected
 * that list since it was written and NOTHING ever read it — so a user whose idea
 * fell outside the vocabulary got a quietly worse search and no way to know.
 *
 * That silence has a measured cost. The lexicon is a hand-maintained Chinese ->
 * English table, and a term absent from it produces no English channel at all.
 * Chinese descriptions and English descriptions are near-disjoint populations —
 * logseq, siyuan and Trilium describe themselves in English — so an unrecognised
 * idea reaches only the smaller, worse-described half of GitHub, and the caller
 * is never told that the search they are reading was narrowed by a vocabulary
 * gap rather than by GitHub.
 *
 * The signal is reported and, when English keywords are available, switches the
 * bilingual plan to English-first. The planner never guesses a translation for
 * an unknown term. A lexical miss is only a fallback signal, not a semantic
 * coverage assessment.
 */
export interface PlanDiagnostics {
  /**
   * CJK terms from the idea that matched no lexicon entry at all.
   *
   * Empty for a Latin idea. An empty list only means each Chinese run matched
   * something; it does not prove that every concept in the sentence was covered.
   */
  readonly unknownTerms: readonly string[]

  /**
   * Whether the finished plan contains any channel made of Latin terms.
   *
   * ## Why this is computed from the plan and not from the idea
   *
   * The obvious test — "does the idea contain Han characters?" — is wrong, and
   * wrong in the direction that matters, because the lexicon CAN supply an
   * English channel for a Chinese idea. Measured with the shipped lexicon:
   *
   *   一个轻量级的看板工具        -> anchor `lightweight kanban`   (English channel)
   *   一个本地优先的待办事项管理工具 -> anchor `local-first todo`      (English channel)
   *   一个记账应用              -> anchor `personal finance`     (English channel)
   *   一个区块链浏览器，支持多链查询和交易追踪 -> three Chinese slots  (no English channel)
   *   一个智能家居控制面板，支持语音助手    -> three Chinese slots  (no English channel)
   *
   * The first three are fully covered by the table and reach the English
   * population; the last two are not covered and do not. A note asserting "only
   * Chinese queries were issued" would therefore be FALSE for the first three.
   *
   * This flag is what makes such a note honest: it is read off the queries that
   * will actually be sent.
   */
  readonly hasEnglishChannel: boolean
}

/**
 * Cap on terms in the precise query. Each term is another AND constraint, so
 * more terms means strictly fewer matches.
 *
 * ## Why 6, and why lowering it was measured and REJECTED
 *
 * The AND chain does collapse, and the collapse is brutal — measured live
 * (`scripts/probes/budget.mjs`, cumulative prefixes of each idea's own terms, one
 * `per_page=1` request per point, `sort=stars`):
 *
 *   rss-en        self-hosted 115,567 -> rss 1,003 -> reader 280 -> full-text 14 -> search 9 -> offline 0
 *   api-mock-en   api 6,511,614 -> mocking 15,838 -> server 3,003 -> http 277 -> integration 18 -> tests 16
 *   db-migrate-en sql 1,463,830 -> database 170,875 -> schema 8,259 -> migration 369 -> cli 52 -> versioned 3
 *   notes-en      local-first 87,262 -> markdown 3,377 -> note-taking 372 -> bidirectional 6 -> links 3
 *
 * That table looks like an argument for a smaller budget, and it is not one, for
 * two separate reasons.
 *
 * FIRST, the budget cannot recover rows, because a longer chain is a strict
 * SUBSET of a shorter one. `MAX_QUERY_TERMS` decides how many terms the PRECISE
 * query carries; the broad and tail channels below re-enter the same idea's
 * terms at lengths 2 and 3 regardless. So the plan already samples the chain at
 * several lengths, and cutting this constant to 3 would not widen slot 0 — it
 * would only make slot 0 identical to slot 2.
 *
 * SECOND, and this is the defect the probe actually found: the collapse is not
 * caused by the count 6, it is caused by ONE rare term landing in the chain, and
 * which term that is differs per idea. `5->6` costs 0.0% on `rss-en` (9 -> 0)
 * but 88.9% on `api-mock-en` (18 -> 16, nearly free) and 5.8% on
 * `db-migrate-en` (52 -> 3). No single count is principled, because the curve's
 * shape is set by vocabulary rarity, not by length.
 *
 * What the probe exposed is that slot 0 is the WORST place to spend this budget.
 * Measured `total_count` of slot 0 in the shipped (stage-1) plans:
 *
 *   rss-en 0      api-mock-en 16      db-migrate-en 3
 *
 * Slot 0 is the `sort=stars` channel whose documented job is to reach the field
 * anchors (logseq, siyuan, AFFiNE). A channel with 3 matches cannot contain an
 * anchor, so on these cases the anchor slot contributes essentially nothing and
 * the pool is carried by slots 1-2. The agent planner in `eval/agent-plan.mjs`
 * fixed this by reordering its channels — slot 0's `total_count` went 0 -> 279,
 * 16 -> 15,825, 3 -> 3,288 — which is evidence that the fix belongs in the PLAN
 * (which term set becomes which channel), not in this constant.
 *
 * `MAX_QUERY_TERMS` is therefore left at 6 and kept as a guard against a
 * pathological idea sentence, not as a recall control. The one measured shape
 * that consumes it is an 11-term English idea truncated to 6.
 */
export const MAX_QUERY_TERMS = 6

/**
 * The remedy offered to a token-less user, appended wherever the pipeline
 * blames the anonymous quota.
 *
 * It is a function rather than a constant because the guidance has to name the
 * thing the user can actually DO. "Configure GITHUB_TOKEN" is a fact about the
 * problem, not an instruction: it does not say where the setting lives, and
 * there is no settings field for it — the token is a credential, and per the
 * host's DESIGN the settings surface carries references, never secrets. The only
 * shared channel between the user and this plugin is the conversation, so the
 * actionable form of the sentence names that channel.
 *
 * @returns the remedy sentence, without a leading space.
 */
export function tokenRemedy(): string {
  return (
    '可以让我配置：直接说「配一下 GitHub token」并把 token 发给我，' +
    '我会写入本机凭据存储并当场验证额度。' +
    '代价是 token 会留在本次对话记录里；若不想这样，' +
    '也可以在启动 DSH 的环境里设置 GITHUB_TOKEN 环境变量（启动时生效，不进对话）。'
  )
}

/**
 * Cap on queries per search. GitHub's anonymous search quota is 10 requests per
 * minute for the whole egress IP, so the plan cannot grow freely.
 */
export const MAX_QUERIES = 3

/**
 * What a plan slot is FOR.
 *
 * The plan has three jobs and always has had: reach the field's biggest projects
 * (anchors), answer the idea as literally as possible (precise), and reach the
 * small projects star ordering can never show (tail). What it did NOT have was a
 * way to say which slot was doing which job — the roles were implicit in the
 * array POSITION, and the plan was assembled by concatenating two independently
 * built lists and slicing to three:
 *
 *   return [...englishChannels, ...queries].slice(0, MAX_QUERIES)
 *
 * Concatenate-then-slice cannot guarantee anything about which role survives. It
 * is pure array order: whichever list happens to be longer, or whichever slot
 * happens to be filled, decides. Measured on the frozen suite, every one of the
 * eight cases used all three slots (24/24) yet still lost a role:
 *
 *   notes-zh      anchors `local-first note-taking` + `note-taking bidirectional`,
 *                 then the precise query — the TAIL channel was sliced off.
 *   rss-en        slot 0 `self-hosted rss reader full-text search offline` is the
 *                 PRECISE query (`total_count` 0), so the anchor job was handed to
 *                 a channel with nothing in it. Same for db-migrate-en (total 3)
 *                 and api-mock-en (total 16).
 *
 * Naming the roles is what makes "all three jobs are covered" a checkable
 * property instead of an accident of array length.
 */
export type QueryRole =
  /** Biggest projects in the field; `sort=stars` over a wide, well-described phrase. */
  | 'anchor'
  /** The idea as literally as possible; longest term chain, `sort=stars` when wide. */
  | 'precise'
  /** Small projects star ordering cannot reach. See {@link TailReason}. */
  | 'tail'

/**
 * WHY a slot is a tail: the two ways a channel reaches the small-project end.
 *
 * The role used to be defined as "always `sort=updated`", and a test asserted that
 * literally. The assertion was wrong in the same way the old `plan is unchanged`
 * assertions were: it pinned a MECHANISM and called it the purpose. Reaching the
 * long tail is the purpose; `sort=updated` is one of two ways to get there.
 *
 *  - `updated`  — re-issue a query in the other ordering. The result set for the
 *    same query text is disjoint between orderings, so this reaches rows the
 *    `sort=stars` form cannot see at all.
 *  - `narrow`   — the query is `core AND rare` by construction, so its whole
 *    result set is already small. If that set is smaller than one page, BOTH
 *    orderings return the entire set, only permuted: the ordering then has no
 *    behavioural consequence and `stars` is as good as `updated`.
 *
 * Measured for the `narrow` case (`scripts/probes/narrow-sort.mjs`, 2026-10-12), query
 * `note-taking bidirectional` on idea `本地优先的笔记应用，支持双向链接`:
 *
 *   sort=stars    total=26  rows=26  <=100 stars 23 (88.5%)  max=918
 *   sort=updated  total=26  rows=26  <=100 stars 23 (88.5%)  max=918
 *   top-5 overlap between the two orderings: 2/5
 *
 * Same 26 rows, 88.5% of them in the tail band, and the same maximum — the
 * ordering only permuted the set. The sample is ONE channel (only `notes-zh`
 * produces a `narrow` channel at all on the frozen suite), so this is not claimed
 * as a general law: it is why the plan records which reason applies instead of
 * forcing every tail through `sort=updated`. A `narrow` channel whose set later
 * proves larger than a page would be visible here as a `narrow`-reasoned slot that
 * needs re-measuring, rather than as a silently-wrong `stars` on a tail.
 */
export type TailReason =
  /** The other ordering over the same query text; disjoint rows. */
  | 'updated'
  /** Narrow by construction, so the ordering cannot change the member set. */
  | 'narrow'

/**
 * One step of the plan: what to ask, which ordering to use, and why it is there.
 *
 * The ordering is not cosmetic. `sort=stars` and `sort=updated` over the *same*
 * result set return disjoint populations — see `buildQueries` for the numbers.
 */
export interface QueryStep {
  query: string
  sort: 'stars' | 'updated'
  /** Which of the plan's three jobs this slot does; see {@link QueryRole}. */
  role: QueryRole
  /**
   * Present only on `tail` slots: which mechanism makes this slot reach the long
   * tail. See {@link TailReason}. A tail without a stated reason is a bug — it is
   * the slot whose absence is invisible in the output.
   */
  tailReason?: TailReason
}

/**
 * Words too generic to narrow a repository search.
 *
 * GitHub's repository search AND-matches across name, description and topics,
 * so every extra word strictly shrinks the result set. These words appear in
 * almost every project description and therefore cost recall while adding
 * almost no discrimination.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'without', 'to', 'of', 'in', 'on', 'at',
  'by', 'from', 'as', 'is', 'are', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'my', 'me', 'we', 'our', 'you', 'your', 'they', 'them', 'their', 'he', 'she',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'do', 'does', 'did',
  'app', 'application', 'tool', 'project', 'program', 'software', 'system', 'platform',
  'build', 'create', 'make', 'want', 'need', 'like', 'similar', 'simple', 'new', 'using', 'use',
  'based', 'support', 'supports', 'supporting', 'able', 'help', 'helps', 'allow', 'allows',
])

/**
 * How many Han characters a CJK run may have before it stops being a searchable
 * term and starts being an unsearchable clause.
 *
 * CJK has no whitespace, so a run is whatever sits between punctuation. That
 * makes run length carry the role that word count carries in Latin text, and
 * GitHub has no notion of "these characters are a word" to fall back on — it
 * matches the run as one token either way.
 *
 * Measured (`scripts/probes/a2.mjs`, 2026-10-10):
 *   本地优先的          (5 chars) -> total_count 3,808, top 30 all on-topic
 *   本地优先的 笔记应用  (5 + 4)  -> 12
 *   一个本地优先的笔记应用 (11)     -> 15 on its own, 0 when ANDed with anything
 *
 * The boundary is drawn at 8: comfortably above the 4-5-character phrases that
 * are the useful unit of Chinese technical vocabulary (`笔记应用`, `本地优先的`,
 * `双向链接`), and below the 11-character clause that cannot be ANDed at all.
 */
const MAX_CJK_RUN_CHARS = 8

/**
 * Whether a query contains a long CJK run (longer than
 * {@link MAX_CJK_RUN_CHARS}) that may need a standalone fallback channel.
 *
 * Deliberately does NOT require a second term. The previous version demanded
 * `query.split(' ').length > 1`, which silently excluded the worst case of all:
 * a plan whose ONLY query is a single quoted long CJK run. Measured live on the
 * idea `一个本地优先的待办事项管理工具` (`scripts/probes/determinism.mjs`, 20 runs, 1
 * distinct plan):
 *
 *   plan = [`"一个本地优先的待办事项管理工具"`]        -> 1 query, quoted, total_count 0
 *   the same string unquoted                          -> total_count 13
 *
 * Both facts are the SAME run; only the quoting differs, and GitHub treats a
 * quoted phrase as an exact substring that no 15-character Chinese clause
 * satisfies. The pure-CJK idea therefore produced an empty pool under every
 * merge strategy, because there was nothing to merge.
 *
 * Requiring a second term was the wrong guard: it was derived from the shape
 * where a long run is ANDed with a Latin term, but the failure mode does not
 * depend on the AND at all.
 *
 * @param query - a built query string.
 * @returns true when the query has a quoted CJK run longer than
 *   {@link MAX_CJK_RUN_CHARS}.
 */
function hasLongCjkRun(query: string): boolean {
  return longestCjkRun(query) !== undefined
}

/**
 * The longest quoted Han run in a query, unquoted, when it exceeds the length
 * limit; `undefined` otherwise.
 *
 * @param query - a built query string.
 * @returns the run text without its quotes, or `undefined`.
 */
function longestCjkRun(query: string): string | undefined {
  const runs = query.match(/"[^"]*"/g) ?? []
  let best: string | undefined
  for (const run of runs) {
    const inner = run.slice(1, -1)
    const han = (inner.match(/\p{Script=Han}/gu) ?? []).length
    if (han <= MAX_CJK_RUN_CHARS) continue
    // Compare on Han count, not raw length, so punctuation cannot make a short
    // run look long.
    if (best === undefined || inner.length > best.length) best = inner
  }
  return best
}

/**
 * Reduce one text fragment to its significant search terms.
 *
 * Latin text is split on whitespace after punctuation is stripped. CJK text has
 * no whitespace, so it needs the opposite treatment: a run of Han characters is
 * kept as ONE quoted phrase rather than split.
 *
 * Splitting CJK into character bigrams was measured and rejected. On the idea
 * "本地优先的 Markdown 笔记应用，支持双向链接" the bigrams were
 * 本地 / 地优 / 优先 / 先的 / 笔记 / 记应 / 应用 / 支持 / 持双 / 双向 / 向链 / 链接
 * — of which 地优, 先的, 记应, 持双 and 向链 are crossing pairs, not words. Each
 * bigram alone has a misleadingly large total (本地: 60,063 repos), but that is
 * because a two-character fragment matches loosely. ANDing three of them drops to
 * 3,376, which is WORSE than the single unsplit token 本地优先的 (3,571). Bigrams
 * buy noise, not recall.
 *
 * @param text - raw fragment.
 * @returns ordered significant terms, deduplicated. CJK phrases are quoted.
 */
export function significantTerms(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, ' ').split(/\s+/)) {
    if (raw.length === 0) continue

    // A whitespace-delimited token that is mostly Han is a whole CJK run (the
    // separators between runs become spaces above). Quote it so GitHub matches
    // the phrase instead of requiring the characters to co-occur anywhere.
    const han = raw.match(/\p{Script=Han}/gu)?.length ?? 0
    if (han > 0 && han >= raw.length / 2) {
      if (raw.length < 2) continue
      if (seen.has(raw)) continue
      seen.add(raw)
      out.push(`"${raw}"`)
      continue
    }

    const term = raw.replace(/^-+|-+$/g, '')
    if (term.length < 2) continue
    if (STOPWORDS.has(term)) continue
    if (seen.has(term)) continue
    seen.add(term)
    out.push(term)
  }
  return out
}

/**
 * Turn an idea (and optional hint terms) into a GitHub search query.
 *
 * The idea is *reduced*, not passed through. Sending the raw sentence returns
 * almost nothing because every word must match: the live case
 * "a local-first Markdown note-taking app with bidirectional links" yielded
 * `total_count: 1`. Dropping stopwords and capping the term count turns the
 * same idea into a query that returns a full candidate set.
 *
 * Caller-supplied `keywords` lead the query, since they are the caller's own
 * judgement about what matters; idea terms follow as a fallback and are capped
 * so a long idea cannot drown out the hint.
 *
 * @param idea - raw user idea.
 * @param keywords - optional extra search terms from the caller.
 * @returns a query string, or the trimmed idea when reduction leaves nothing.
 */
export function buildQuery(idea: string, keywords?: string): string {
  const hint = keywords === undefined ? [] : significantTerms(keywords)
  const fromIdea = significantTerms(idea)
  // Dedup across BOTH sources before applying any budget. Slicing the idea
  // first let a term already present in the hint (e.g. "markdown") consume an
  // idea slot, starving later idea terms like "note-taking" and "links".
  const seen = new Set(hint)
  const extra = fromIdea.filter((term) => !seen.has(term))
  // Keep the query short: each additional term is another AND constraint.
  // A caller-supplied hint is trusted, so the idea only tops it up.
  const ideaBudget = hint.length > 0 ? 3 : MAX_QUERY_TERMS
  const terms = [...hint, ...extra.slice(0, ideaBudget)]
  if (terms.length === 0) {
    // Reduction left nothing. Sending the raw idea is the better fallback for a
    // real sentence whose every word is a stopword — but only when there IS a
    // sentence. A blank idea must return a blank query.
    //
    // Returning `idea` untrimmed was a measured defect (found by the property
    // test in `test/planner-properties.test.mjs`): a whitespace-only idea planned
    // the slots `anchor:" "` and `tail:" "`. Those are not queries — GitHub
    // receives whitespace and answers with something, and the card presents it as
    // the result of a real search. An empty query is honest about having nothing
    // to ask; a whitespace one is not.
    const raw = idea.trim()
    return raw.length > 0 ? raw : ''
  }

  // Keep at most ONE quoted CJK phrase. GitHub treats a quoted phrase as an
  // exact substring match, and the AND of two or more exact Chinese phrases is
  // a query almost no repository can satisfy — measured live:
  //   "本地优先的" markdown "笔记应用" "支持双向链接"   -> 0 candidates
  //   "本地优先的" markdown                             -> 30 candidates
  //   "一个本地的待办事项管理工具" "支持标签和筛选"        -> 0 candidates
  // The first phrase is kept because term order follows the caller's emphasis.
  // Extra phrases are dropped rather than unquoted: an unquoted CJK run is
  // still an AND constraint, and relaxing it is what the broad query is for.
  let phraseKept = false
  const capped = terms.filter((term) => {
    if (!term.startsWith('"')) return true
    if (phraseKept) return false
    phraseKept = true
    return true
  })
  return capped.join(' ')
}

/**
 * The plan together with what building it revealed about the idea.
 *
 * Separate from {@link buildQueries} because the two have different audiences.
 * Most callers (tests, regression scripts) want the plan and would be noise if
 * they had to destructure a diagnostics object they never read. The registered
 * tool is the opposite: it has to know whether the lexicon understood the idea,
 * because that fact changes what it should tell the user.
 */
export interface PlannedQueries {
  /** The queries to run, in order. At most {@link MAX_QUERIES} slots. */
  readonly queries: QueryStep[]
  /** What the planner noticed while building `queries`. */
  readonly diagnostics: PlanDiagnostics
}

/**
 * Build the query plan and report what the build revealed.
 *
 * Use this instead of {@link buildQueries} when the caller can act on the
 * diagnostics. `buildQueries` remains the plan-only entry point.
 *
 * @param idea - the user's idea, in their own words.
 * @param keywords - optional narrowing hint; also the source of broad terms.
 * @returns the plan plus diagnostics about the idea's coverage by the lexicon.
 */
export function planQueries(idea: string, keywords?: string): PlannedQueries {
  const ideaTerms = significantTerms(idea)
  // Only Chinese terms can be "unknown": `englishSeeds` passes Latin terms
  // through untouched and never records them, so a Latin idea always reports an
  // empty list and no caller sees a spurious warning.
  const seeds = englishSeeds(ideaTerms)
  const queries = buildPlan(idea, keywords)
  return {
    queries,
    diagnostics: {
      unknownTerms: seeds.unknown,
      // A channel counts as English when it carries a Latin letter. A MIXED query
      // (`"本地优先的" markdown`) counts: it reaches the English population too,
      // which is the fact this flag is asked about. Measured — the mixed plan for
      // `本地优先的 Markdown 笔记应用，支持双向链接` reaches codexu/note-gen.
      hasEnglishChannel: queries.some((step) => /[A-Za-z]/.test(step.query)),
    },
  }
}

/**
 * Build the query plan: which searches to run, and in what order.
 *
 * The plan mixes two ORDERINGS, and that is the whole point. Queries 0-1 ask for
 * the most-starred matches, which is how the field anchors (logseq, AFFiNE,
 * memos) get into the pool — they describe themselves differently from the idea
 * and would otherwise never surface. Query 2 asks the *same kind of question*
 * against the opposite end of the result set: `sort=updated` on a narrow query.
 *
 * Measured on the query `markdown notes`, both drawn from the same population of
 * 14,388 matches:
 *   sort=stars   -> 30 repos spanning 2,528–73,328 stars, **0** under 100
 *   sort=updated -> 30 repos spanning 0–566 stars,        **28** under 100
 * Only the ordering differed; the population was identical. Star ordering can
 * never reach the tail, and no amount of weight tuning in the ranking layer
 * changes that — the tail has to be fetched.
 *
 * @param idea - the user's idea, in their own words.
 * @param keywords - optional narrowing hint; also the source of broad terms.
 * @returns queries to run in order, paired with the ordering each should use.
 *
 * Exported for tests. The three-query plan is the mechanism behind the whole
 * long-tail fix, and the previous round of tests only asserted that the string
 * `latinSeed` appears in this file — which stays true even if the seed logic
 * inverts. What matters is the plan this actually returns.
 */
export function buildQueries(idea: string, keywords?: string): QueryStep[] {
  return buildPlan(idea, keywords)
}

/**
 * The plan itself. Private so that the two public entry points cannot drift:
 * `planQueries` needs the plan *and* the seeds, `buildQueries` needs only the
 * plan, and both must agree on the plan they describe.
 */
function buildPlan(idea: string, keywords?: string): QueryStep[] {
  const hint = keywords === undefined ? [] : significantTerms(keywords)
  const ideaTerms = significantTerms(idea)

  // Prefer Latin terms as the seed for broad queries.
  //
  // Measured: Chinese idea tokens reach a repo population DISJOINT from the
  // field anchors. For the idea "本地优先的 Markdown 笔记应用，支持双向链接",
  // the query 本地优先的 returned 30 repos headed by
  // Dujltqzv/Some-Many-Books, cirosantilli/x86-bare-metal-examples and a
  // political document repo — zero note-taking projects — because those
  // characters merely co-occur in Chinese-language repos. logseq, siyuan and
  // Trilium describe themselves in English, so a CJK query cannot reach them at
  // any precision. English terms are therefore the better broad seed whenever
  // they exist, and CJK terms are a last resort.
  const isLatin = (term: string): boolean => !/\p{Script=Han}/u.test(term)
  const latinSeed = (hint.length > 0 ? hint : ideaTerms).filter(isLatin)
  const cjkSeed = (hint.length > 0 ? hint : ideaTerms).filter((t) => !isLatin(t))
  // Broad and tail queries are the recall-relaxing instruments, so a CJK seed
  // reaching them must lose its quotes: an exact-phrase AND is the precise
  // query's job. Measured: two quoted phrases ANDed -> 0 candidates; the same
  // runs unquoted ANDed with a Latin term -> 30.
  const unquote = (term: string): string => (term.startsWith('"') ? term.slice(1, -1) : term)

  // Bilingual input gets separate Chinese and English channels. Mixing English
  // keywords with a quoted Chinese phrase measured ONE candidate in the notes
  // probe; two unquoted Chinese runs alone measured 12 on-topic candidates.
  // Keep that original Chinese-first layout when no total lexicon miss is found.
  //
  // With an unrecognised run AND usable English keywords, let the English broad
  // query lead instead. This is a deterministic fallback signal, NOT a semantic
  // coverage test or proof that the Chinese query returns nothing. Keep the
  // Chinese channel as precise, and retain the English updated tail.
  //
  // Chinese runs come from the IDEA, not the English hint's empty `cjkSeed`.
  const ideaCjk = ideaTerms.filter((t) => !isLatin(t))
  if (hint.length > 0 && latinSeed.length > 0 && ideaCjk.length > 0) {
    const runs = ideaCjk.map(unquote)
    const chineseQuery = runs.slice(0, 2).join(' ')
    const broad = latinSeed.slice(0, 2).join(' ')
    const tailTerms = latinSeed.slice(0, 3)
    const englishFirst = englishSeeds(ideaTerms).unknown.length > 0
    const queries: QueryStep[] = englishFirst
      ? [
          { query: broad, sort: 'stars', role: 'anchor' },
          { query: chineseQuery, sort: 'stars', role: 'precise' },
        ]
      : [{ query: chineseQuery, sort: 'stars', role: 'anchor' }]

    if (!englishFirst && latinSeed.length >= 2 && broad !== chineseQuery) {
      queries.push({ query: broad, sort: 'stars', role: 'precise' })
    }

    if (tailTerms.length >= 2) {
      const tailQuery = tailTerms.join(' ')
      if (!queries.some((entry) => entry.query === tailQuery)) {
        queries.push({ query: tailQuery, sort: 'updated', role: 'tail', tailReason: 'updated' })
      }
    }

    return ensureRoles(queries)
  }

  // English seed channels for a Chinese idea — the fix for the language-domain
  // mismatch, and the one change that reaches the field anchors at all.
  //
  // The Chinese plan below cannot: measured live, its queries returned
  // `total_count` 0 in four of five configurations, and where they did return
  // rows the heads were a book list, three political-document mirrors and an
  // anime repo. `本地优先的` matches Chinese-language repositories that happen to
  // contain those characters; logseq, siyuan and Trilium describe themselves in
  // English, so no CJK query reaches them at ANY precision.
  //
  // The seed comes from the IDEA's terms, never from `hint` or `latinSeed`. A
  // hint is already Latin by construction (the bilingual branch above handles
  // it), so a hint-derived seed would be empty exactly when it is needed.
  //
  // Measured (`scripts/probes/slots.mjs`), idea 本地优先的笔记应用，支持双向链接:
  //
  //   local-first note-taking   sort=stars    total 758   siyuan 46,705 / logseq 45,193 / Trilium 38,265
  //   note-taking bidirectional sort=stars    total 26    23 of 26 under 100 stars
  //   本地优先的笔记应用         sort=stars    total 15    head: a book list, no note app
  //
  // Two channels, not three: the anchor channel and the tail channel. The second
  // slot has three candidate fillers, chosen offline in this order:
  //
  //  1. `narrow` — the core ANDed with the constraint, when it fits. Measured:
  //     `note-taking bidirectional` = 26 rows, 23 of them under 100 stars, so it
  //     is simultaneously the constraint channel and the tail.
  //  2. `core` — the bare core, when it differs from the seed. A modifier costs
  //     recall, and this is the widest gap measured: the reference implementation
  //     of `一个本地优先的待办事项管理工具` is `go-vikunja/vikunja`, which is ABSENT
  //     from the seed's 449 rows (`local-first todo`) but sits at position 10 of
  //     the 1,782,914-row `todo`. A project can be local-first without saying so.
  //     This also supplies the tail, since the restrictive seed measured 23/30
  //     rows under 100 stars while the bare core measured 0/30.
  //  3. the seed again under `sort=updated` — the only remaining option when the
  //     core IS the seed (an idea with no modifier), where a second identical
  //     `sort=stars` channel would be pure duplication. Measured 30/30 rows under
  //     100 stars for `personal knowledge management`.
  const seeds = englishSeeds(ideaTerms)
  const englishChannels: QueryStep[] = []
  if (seeds.seed !== '') {
    englishChannels.push({ query: seeds.seed, sort: 'stars', role: 'anchor' })
    if (seeds.narrow !== '') {
      // `narrow` is the core ANDed with the idea's rare constraint. It is NOT an
      // anchor, and labelling it as one was a measured bug: both English channels
      // carried role 'anchor', `ensureRoles` picks exactly one per role, and the
      // SECOND anchor was silently dropped — which for this idea is the channel
      // that carries `bidirectional`.
      //
      // Traced (`scripts/probes/narrow-drop.mjs`, idea `本地优先的笔记应用，支持双向链接`):
      //
      //   candidates: [anchor local-first note-taking] [anchor note-taking bidirectional] [precise 本地优先的笔记应用]
      //   pick('anchor') -> local-first note-taking
      //   DROPPED: note-taking bidirectional        <- never reached the plan
      //   filler loop: budget already full (anchor + precise + synthesized tail)
      //
      // and the synthesized tail was `local-first note-taking` again, i.e. the plan
      // spent two slots on one query while the constraint channel sat unused. The
      // symptom had been misread as "the idea's vocabulary is too small for three
      // distinct channels" — it was this mislabel.
      //
      // Why `tail` and not `anchor`: the channel is narrow by construction (core
      // AND a rare term) and it is exactly where the small projects are. Measured
      // `note-taking bidirectional` = 26 rows, 23 of them under 100 stars.
      //
      // `sort=stars` with `tailReason: 'narrow'`, not `sort=updated`: measured on
      // that same query, both orderings return the identical 26 rows (88.5% under
      // 100 stars, max 918) and differ only in permutation, because the set is
      // smaller than one page. See {@link TailReason}.
      englishChannels.push({ query: seeds.narrow, sort: 'stars', role: 'tail', tailReason: 'narrow' })
    } else if (seeds.core !== '' && seeds.core !== seeds.seed) {
      // The bare core is genuinely an anchor: dropping the modifier widens the
      // population (`local-first todo` 449 rows -> `todo` 1,782,914), which is
      // what reaches projects that describe themselves differently.
      englishChannels.push({ query: seeds.core, sort: 'stars', role: 'anchor' })
    } else {
      englishChannels.push({ query: seeds.seed, sort: 'updated', role: 'tail', tailReason: 'updated' })
    }
  }

  const precise = buildQuery(idea, keywords)
  const queries: QueryStep[] = [{ query: precise, sort: 'stars', role: 'precise' }]

  // A long CJK run in slot 0 can empty the whole pool, and nothing downstream can
  // repair that: `searchMerged` de-duplicates and reorders what the queries
  // returned, so a plan whose only query matched nothing yields an empty pool
  // under every merge strategy there is.
  //
  // Measured live (`scripts/probes/a2.mjs`, 2026-10-10), idea
  // 一个本地优先的笔记应用，支持 markdown 和双向链接:
  //
  //   "一个本地优先的笔记应用" markdown   -> total_count 0
  //   一个本地优先的笔记应用 markdown     -> total_count 0   <- unquoting does NOT help
  //   一个本地优先的笔记应用              -> total_count 15
  //   一个本地优先的 笔记应用             -> total_count 0
  //   本地优先的 笔记应用                 -> total_count 12
  //
  // Two separate lessons, and the second one cost a wasted fix:
  //
  //  1. ANDing ANY Latin term with that CJK run kills the query, quoted or not.
  //     So the remedy is not to relax the quoting — it is to issue the CJK run
  //     ALONE, as its own channel. This is the same finding that made the
  //     bilingual branch above put an unquoted Chinese query in slot 0.
  //  2. The reason the run is unusable is its LENGTH, not its quoting. A CJK run
  //     here is not a word — `一个本地优先的笔记应用` is a whole clause, and GitHub
  //     matches it as one token. Short runs behave completely differently:
  //     `本地优先的` alone measured 3,808 matches, all on-topic.
  //
  // Both facts point the same way, so the fix is the same for either: when the
  // precise query is a single long CJK run ANDed with something else, add the run
  // as a standalone query. `MAX_CJK_RUN_CHARS` is what separates the two length
  // regimes; it is a measured boundary, not a tuned parameter.
  //
  // The guard also covers the PURER failure, where there is no AND to blame:
  // idea `一个本地优先的待办事项管理工具` produced the single query
  // `"一个本地优先的待办事项管理工具"` (quoted, 15 Han chars) at total_count 0, while
  // the same string unquoted returned 13. That plan had exactly one query, so the
  // pool was empty before the merge layer ever ran — no fusion, quota or ranking
  // change can reach it. The old guard required a second term and so never fired
  // on this shape; see {@link hasLongCjkRun}.
  //
  // The precise query is REPLACED here, not supplemented. Keeping it alongside the
  // bare run cost a whole query slot to re-learn a measured fact: a long quoted CJK
  // run is a single GitHub token that matches nothing. Measured total_count for
  // `"一个本地优先的待办事项管理工具"` was 0 in every run, while the same string
  // unquoted returned 13 — and `MAX_QUERIES` is 3, so that dead slot was a third of
  // the entire request budget. `scripts/probes/a2-pool.mjs` confirmed the cost was real: the
  // pool came back as exactly the bare run's 13 rows with `tailIncluded: 4`, i.e.
  // the quoted channel contributed zero rows and the RRF fuse had only one
  // non-empty channel to work with — which also disabled `CHANNEL_QUOTA`, leaving
  // the tail guard as the only thing that admitted the two on-topic 0-2 star rows.
  //
  // Ordering still matters and is NOT cosmetic. A plan is consumed in order by
  // `searchMerged`, and the bilingual branch above already puts its Chinese
  // channel in slot 0 for the same reason: a Chinese query reaches a repo
  // population the Latin queries cannot see at all, so it belongs in front.
  if (queries.length === 1 && hasLongCjkRun(precise)) {
    const run = longestCjkRun(precise)
    if (run !== undefined) {
      const solo = run.replace(/"/g, '')
      if (solo !== precise) queries[0] = { query: solo, sort: 'stars', role: 'precise' }
    }
  }

  const seed = latinSeed.length > 0 ? latinSeed : cjkSeed.map(unquote)

  // Broader query: the two most distinctive terms only, which loosens the AND
  // chain enough to reach well-described but differently-worded projects.
  if (seed.length >= 2) {
    const broad = seed.slice(0, 2).join(' ')
    if (broad !== precise) queries.push({ query: broad, sort: 'stars', role: 'anchor' })
  }

  // Long tail: a narrow query the tail can actually win.
  //
  // A one-word query is the wrong instrument here — it matches a huge, mostly
  // unrelated population, and the newest slice of that population is noise. A
  // 3-term AND chain shrinks the population to something small enough that the
  // newest members are plausibly on-topic: `markdown notes bidirectional`
  // returned 29 matches, 25 of them under 100 stars, headed by note and sync
  // projects. Prefer 3 Latin terms and fall back to 2.
  //
  // The chain must be built from LATIN terms only, and that is a measured
  // constraint rather than a preference. A CJK run cannot be a tail term at all:
  // `significantTerms` keeps a Han run as ONE quoted token, and ANDing those
  // tokens reproduces the idea sentence. Measured on the plan-6 snapshot
  // (`scripts/probes/tail-bug.mjs`) for the idea
  // 一个个人记账应用，支持多币种和预算管理，数据保存在本地:
  //
  //   personal finance                                          total 63,156   0/30 under 100 stars
  //   "一个个人记账应用"                                          total      1   1/1  under 100 stars
  //   一个个人记账应用 支持多币种和预算管理 数据保存在本地            total      0   0    rows  <- tail
  //
  // The tail returned nothing at all, so the case had NO long-tail channel; its
  // pool came back with 1 row under 100 stars against 8 before. Three CJK runs
  // ANDed cannot match: they are three separate exact substrings of one sentence,
  // and no repository description carries the sentence as written. Journaling the
  // defect is not enough — it silently removes the only role whose absence the
  // card cannot recover from, so {@link assertTailIsReachable} below rejects the
  // shape outright instead of issuing it and hoping.
  const tailTerms = (latinSeed.length > 0 ? latinSeed : seed)
    .filter((term) => !/\p{Script=Han}/u.test(term))
    .slice(0, 3)
  if (tailTerms.length >= 2) {
    const tailQuery = tailTerms.join(' ')
    if (!queries.some((entry) => entry.query === tailQuery)) {
      queries.push({ query: tailQuery, sort: 'updated', role: 'tail', tailReason: 'updated' })
    }
  }

  // The English channels go FIRST, and the Chinese channels fill what is left.
  //
  // Order is not cosmetic here even though RRF itself is order-independent: the
  // quota stage walks `channels` in plan order and puts each channel's head at
  // the front of `ordered`, which is then sliced to the pool size. So the first
  // channel's head is the pool's head. The English anchor channel is the right
  // claimant — its head is siyuan at 46,705 stars, which is a real answer to the
  // idea, whereas the Chinese channel's head is a book list.
  //
  // The Chinese channel still gets a slot rather than being deleted: its rows are
  // a genuinely DISJOINT population (repositories whose description carries no
  // English at all), and RRF is documented as the mechanism that admits them.
  // What it does not get is the tail slot, which the seed's own `sort=updated`
  // form fills better.
  return ensureRoles([...englishChannels, ...queries])
}

/**
 * Assemble the final plan so that all three roles are covered, in role order.
 *
 * Replaces `[...englishChannels, ...queries].slice(0, MAX_QUERIES)`. That line was
 * the defect this function exists to remove: it chose the surviving slots by
 * ARRAY POSITION, so a role could be lost without anyone noticing. Two measured
 * consequences on the frozen suite:
 *
 *  - `notes-zh` built four candidate slots (seed, narrow, precise, tail) and the
 *    tail was sliced off — the plan could not reach small projects at all.
 *  - `rss-en` / `db-migrate-en` / `api-mock-en` gave the anchor role to the
 *    PRECISE query, whose `total_count` measured 0 / 3 / 16. A channel with three
 *    matches cannot contain a field anchor (logseq, siyuan, AFFiNE), so the anchor
 *    job was silently unstaffed while its slot sat occupied.
 *
 * Both are the same bug: the plan did not know which slot was for what. With the
 * roles named, "all three jobs are covered" becomes a property that can be
 * asserted rather than an accident of array length.
 *
 * Order is still load-bearing for the pool, not cosmetic: `selectPool`'s quota
 * stage walks channels in plan order and puts each channel's head at the front of
 * `ordered`, which is then sliced to the pool size — so the first channel's head
 * is the pool's head. Role order (anchor, precise, tail) therefore puts the
 * widest, best-described channel in front, which is where an anchor belongs.
 *
 * @param candidates - every slot the two builders produced, in build order.
 * @returns at most {@link MAX_QUERIES} slots, one per role where a candidate exists.
 */
function ensureRoles(candidates: readonly QueryStep[]): QueryStep[] {
  // Dedup by query text first: a query that appears twice cannot serve two roles,
  // and the old `slice` could keep both copies (e.g. a seed equal to the precise
  // query) while dropping a genuinely different one.
  const byQuery = new Map<string, QueryStep>()
  for (const step of candidates) {
    if (step.query.length === 0) continue
    if (!byQuery.has(step.query)) byQuery.set(step.query, step)
  }
  const unique = [...byQuery.values()]

  const pick = (role: QueryRole): QueryStep | undefined => unique.find((step) => step.role === role)

  const chosen: QueryStep[] = []

  // The anchor is the channel that must exist: it is the one whose failure mode
  // (a slot occupied by a 3-match query) is invisible in the output. Prefer the
  // built anchor; fall back to the widest remaining query, which is what a broad
  // `sort=stars` channel is for.
  const anchor = pick('anchor') ?? unique.find((step) => step.sort === 'stars')
  if (anchor !== undefined) chosen.push({ ...anchor, role: 'anchor' })

  const precise = unique.find((step) => step.role === 'precise' && step.query !== anchor?.query)
  if (precise !== undefined) chosen.push({ ...precise, role: 'precise' })

  // The tail is the other role that cannot be recreated downstream: the card's
  // `finalScore` weighs stars, so a plan without a tail can never surface a 31-star
  // answer no matter how relevant it is. Two mechanisms reach that end — see
  // {@link TailReason} — and the slot records which one it used.
  const tail =
    unique.find((step) => step.role === 'tail' && step.query !== anchor?.query && step.query !== precise?.query) ??
    // No explicit tail candidate: re-issue the anchor in the other ordering. This is
    // the same instrument the builder already uses when a seed has no second form,
    // and it costs no extra request budget.
    (anchor === undefined
      ? undefined
      : { query: anchor.query, sort: 'updated' as const, role: 'tail' as const, tailReason: 'updated' as const })
  if (tail !== undefined) chosen.push({ ...tail, role: 'tail' })

  // Every tail must state WHY it reaches the long tail. A synthesized one does
  // (above); a candidate that arrived without a reason does not, and guessing
  // `updated` for it would be exactly the mechanism-pinning this field exists to
  // stop. Fail loudly instead: a tail whose reason is unknown is the one slot whose
  // absence is invisible in the output, so it must not be silently tolerated.
  for (const step of chosen) {
    if (step.role === 'tail' && step.tailReason === undefined) {
      throw new Error(
        `query plan: tail slot ${JSON.stringify(step.query)} has no tailReason; ` +
          `every tail must state whether it reaches the long tail by re-ordering ('updated') ` +
          `or by being narrow by construction ('narrow')`,
      )
    }
  }

  // Fill any remaining budget with the leftover candidates, in build order, so a
  // plan that has fewer than three distinct roles still uses its slots.
  //
  // Dedup here is on the `${sort}|${query}` PAIR, not on the query text. The same
  // text under both orderings is two disjoint result sets over one population —
  // the mechanism the whole plan rests on — so a query that already appears under
  // a DIFFERENT ordering is a legitimate extra channel, not a duplicate. Keying on
  // text alone silently dropped the English seed's constraint channel whenever a
  // `sort=updated` re-issue of that same seed had been chosen as the tail:
  // `本地优先的笔记应用，支持双向链接` lost `note-taking bidirectional`, the one
  // channel that carries the idea's rare constraint.
  const usedPairs = new Set(chosen.map((entry) => `${entry.sort}|${entry.query}`))
  for (const step of unique) {
    if (chosen.length >= MAX_QUERIES) break
    const pair = `${step.sort}|${step.query}`
    if (usedPairs.has(pair)) continue
    usedPairs.add(pair)
    chosen.push(step)
  }

  // Repair, do not reject. See {@link repairTail}.
  const repaired = chosen.slice(0, MAX_QUERIES).map((step) => repairTail(step, unique))

  return repaired
}

/**
 * Make a tail slot reachable, instead of refusing to serve the request.
 *
 * WHY THIS REPLACED A THROW
 * -------------------------
 * This check used to throw, and the throw reached the user: 5 of 12 natural
 * Chinese ideas failed outright, before any request was made.
 *
 *  一个区块链浏览器，支持多链查询和交易追踪
 *  一个自托管的照片管理应用，支持人脸识别
 *  一个本地的视频剪辑工具，支持字幕和转场
 *  一个智能家居控制面板，支持语音助手
 *  一个开源的邮件客户端，支持多账户和加密
 *
 * All five share one shape. Their terms are absent from {@link LEXICON}, so
 * `englishSeeds` yields nothing, so no English channel exists; the plan's only
 * material is the Chinese precise query; and `ensureRoles` synthesizes the tail
 * by re-ordering the anchor — which is that Chinese query, carrying two or more
 * CJK runs. Two ANDed CJK runs are exact substrings of one sentence and match
 * the empty set, so the slot was genuinely dead, and the guard was right about
 * the diagnosis. What it got wrong was the response: refusing the whole search
 * denies the user the OTHER channels for no reason. A dead tail is a degraded
 * plan, not an illegal one.
 *
 * The invariant still exists — it is asserted in the test suite, where a plan
 * defect belongs. What changed is that the runtime REPAIRS the slot first.
 *
 * HOW IT REPAIRS
 * --------------
 * Keep the longest single CJK run, unquoted. That is the one form measured to
 * return rows where the full sentence returns nothing:
 *
 *   "一个本地优先的待办事项管理工具"          (quoted, 15 chars) -> total_count 0
 *   一个本地优先的待办事项管理工具            (unquoted, same)  -> total_count 13
 *
 * Unquoting matters because a quoted phrase is an exact-substring match, and
 * dropping to one run matters because every additional run is another AND. The
 * repaired slot stays a `tail` with reason `updated`: it is still the
 * re-ordering instrument, aimed at the sub-population the anchor can reach, and
 * the honest reason is the mechanism actually in use rather than the one that
 * would have been preferred.
 *
 * If a Latin sibling exists in the plan — a `precise` channel built from
 * `keywords` — its terms make a strictly better tail: Latin terms are the only
 * route to the projects that describe themselves in English, and the whole
 * reason this idea had no seed is that its Chinese terms do not reach them. So
 * the repair prefers Latin terms when the plan has any, and falls back to the
 * longest CJK run when it does not.
 *
 * @param step - one assembled slot.
 * @param plan - every candidate the builders produced, for Latin fallback terms.
 * @returns the slot, repaired if it was an unreachable tail.
 */
function repairTail(step: QueryStep, plan: readonly QueryStep[]): QueryStep {
  if (step.role !== 'tail') return step
  const runs = step.query.match(/\p{Script=Han}+/gu) ?? []
  if (runs.length <= 1) return step

  // Prefer Latin terms from anywhere in the plan: a plan can carry them on a
  // `precise` channel even when `englishSeeds` found no seed.
  const latin = plan
    .flatMap((entry) => significantTerms(entry.query))
    .filter((term) => !term.startsWith('"') && !/\p{Script=Han}/u.test(term))
  const seen = new Set<string>()
  const latinTerms: string[] = []
  for (const term of latin) {
    if (seen.has(term)) continue
    seen.add(term)
    latinTerms.push(term)
  }
  if (latinTerms.length >= 2) {
    return { query: latinTerms.slice(0, 3).join(' '), sort: step.sort, role: 'tail', tailReason: step.tailReason }
  }

  const first = runs[0] ?? ''
  const longest = runs.reduce((best, run) => (run.length > best.length ? run : best), first)
  return { query: longest, sort: step.sort, role: 'tail', tailReason: step.tailReason }
}

/**
 * The plan invariant, asserted by tests rather than enforced at runtime.
 *
 * It used to be `assertTailIsReachable`, called on every plan and throwing when
 * it failed — which made a plan DEFECT into a user-visible outage (5 of 12
 * natural Chinese ideas). The runtime now repairs the slot instead
 * ({@link repairTail}); this predicate is what proves the repair worked, and it
 * belongs in the suite where a plan invariant can fail a build without failing a
 * user's request.
 *
 * A tail must not AND two or more CJK runs. A CJK run is an exact substring of
 * one sentence, so ANDing them can only match a repository that reproduces that
 * sentence verbatim — the empty set in practice. Measured twice on the plan-6
 * snapshot (`scripts/probes/tail-bug.mjs`): `expense-zh` issued three CJK runs as its
 * tail and returned 0 rows, dropping the case to a single row under 100 stars
 * from 8.
 *
 * @param step - one assembled slot.
 * @returns true when the slot is a reachable tail (or not a tail at all).
 */
export function isTailReachable(step: QueryStep): boolean {
  if (step.role !== 'tail') return true
  const runs = step.query.match(/\p{Script=Han}+/gu) ?? []
  return runs.length <= 1
}

/**
 * Run the planner, turning a plan defect into a reportable failure.
 *
 * This exists so the guard that protects `scout_projects` is TESTABLE. After T2
 * removed the reachable causes, no realistic input makes the planner throw any
 * more — which is the desired state, and also the state in which the guard would
 * silently rot: a test that needs a throwing input has nothing left to throw, and
 * the next cause to appear would be the first one ever exercised.
 *
 * Keeping the decision in a pure function means the guard is driven by a
 * synthetic error instead of by hoping a natural one still exists. The contract
 * it encodes is the one the whole plugin rests on: a failure anywhere in the
 * pipeline returns a well-formed value, never a stack trace.
 *
 * @param idea - the idea to plan for.
 * @param keywords - the caller's optional hint.
 * @returns either the plan and its diagnostics, or the error that stopped it.
 */
export function tryPlanQueries(
  idea: string,
  keywords?: string,
): { ok: true; planned: PlannedQueries } | { ok: false; error: unknown } {
  try {
    return { ok: true, planned: planQueries(idea, keywords) }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Explain why the query planner could not build a plan.
 *
 * The planner is not supposed to fail — T2 removed the one cause that reached
 * users — but "not supposed to" is not a guarantee, and the failure mode when it
 * does happen is the worst one available: no card, no rows, no explanation.
 * Measured before the guard existed: a Chinese idea whose terms were absent from
 * LEXICON produced a raw throw out of `scout_projects`, 5 of 12 natural ideas.
 *
 * The remedy offered is the one that was measured to work. A Chinese idea always
 * reaches a different repository population than the English one — logseq,
 * siyuan and Trilium describe themselves in English — so `keywords` is not a
 * nicety here, it is the only route to those projects.
 *
 * @param error - whatever the planner threw.
 * @param keywords - the caller's hint, if any; changes the remedy offered.
 * @returns the `degraded.detail` text.
 */
export function describePlanFailure(error: unknown, keywords: string | undefined): string {
  const reason = error instanceof Error ? error.message : String(error)
  const hasHint = keywords !== undefined && keywords.trim().length > 0
  return (
    '检索计划构建失败，因此没有发起任何检索。\n' +
    `  原因：${reason}\n` +
    '  这不代表没有相关项目。GitHub 仓库搜索只覆盖仓库的名称、描述与 topics，不覆盖 README 正文；' +
    '只在 README 里自我描述的项目可用 in:readme 扩大覆盖（但不保证穷尽）。中文描述的项目与英文描述的项目是两个几乎不相交的总体。\n' +
    (hasHint
      ? '  你已提供 keywords，但计划仍未能构建——这是一个需要修复的缺陷，请把上面的原因一并反馈。'
      : '  请通过 keywords 参数补充 3-6 个英文检索词重试（例如把「一个本地优先的笔记应用」' +
        '写为 local-first note-taking）。英文词是触达 logseq / siyuan 这类用英文自我描述的项目' +
        '的唯一途径')
  )
}

/**
 * Explain that a Chinese idea was planned with no English channel at all.
 *
 * ## Why this note exists
 *
 * GitHub's repository search matches a query's words with AND. A Chinese
 * sentence is therefore a poor query, and the population it reaches is nearly
 * disjoint from the one worth comparing against, because the projects worth
 * comparing against describe themselves in English. Two measured cases:
 *
 *   - `本地优先的 Markdown 笔记应用，支持双向链接` (no keywords) returns
 *     `total_count: 0`, while `local-first markdown notes` returns 30 and puts
 *     `codexu/note-gen` on top.
 *   - `本地优先的` alone returns 30 rows headed by an x86 example set and an
 *     unrelated document collection — zero field anchors — while logseq, siyuan
 *     and Trilium all describe themselves in English and are reached by no
 *     Chinese query at any precision.
 *
 * ## Why the trigger is the PLAN, not the idea's language
 *
 * "The idea is Chinese" is the obvious trigger and it is WRONG in both
 * directions. Measured against the shipped lexicon:
 *
 *   一个轻量级的看板工具            -> `lightweight kanban`   HAS English channel
 *   一个本地优先的待办事项管理工具      -> `local-first todo`     HAS English channel
 *   一个记账应用                  -> `personal finance`     HAS English channel
 *   一个区块链浏览器，支持多链查询和交易追踪 -> 3 Chinese slots      NO English channel
 *   一个智能家居控制面板，支持语音助手     -> 3 Chinese slots      NO English channel
 *
 * So a note keyed on the idea's language claims "only Chinese queries were
 * issued" about a plan whose slot 0 IS an English query — a false statement in a
 * user-facing message. (`plan-failure.test.mjs` caught exactly this: it asserts
 * that a lexicon-covered idea is not warned about, and the covered idea above has
 * an English anchor.)
 *
 * Conversely, `unknownTerms` alone is also the wrong trigger: `一个本地优先的
 * 待办事项管理工具` reports NO unknown terms yet — before the conditional routing
 * in `buildPlan` — fell through to a Chinese-only plan.
 *
 * What both cases have in common is the fact the caller can act on and cannot see
 * for themselves: THE FINISHED PLAN HAS NO ENGLISH CHANNEL. That is read off the
 * queries about to be sent, so the note cannot contradict them.
 *
 * @param idea - the idea text exactly as the caller wrote it.
 * @returns the `degraded.detail` text.
 */
function chineseIdeaNote(idea: string): string {
  return (
    `本次计划没有任何英文检索通道：\`${idea}\` 没有可用的英文检索词。\n` +
    '  GitHub 的仓库搜索对多个词做 AND 匹配，中文句子本身不是好查询；更重要的是，' +
    '值得对标的项目大多用英文自我描述，中文查询在任何精度下都触达不到它们。\n' +
    '  实测：`本地优先的 Markdown 笔记应用，支持双向链接` 单独检索返回 total_count: 0，' +
    '而 `local-first markdown notes` 返回 30 条并命中 codexu/note-gen；logseq、siyuan、' +
    'Trilium 都用英文描述自己，中文查询一条都够不到。\n' +
    '  修法：把核心概念翻成 3-6 个英文检索词，通过 keywords 参数传入（例如把' +
    '「本地优先的笔记应用」写成 local-first note-taking）。提供英文 keywords 后，' +
    '本次检索会同时保留中文通道与英文通道，两路结果合并进同一个候选池再统一打分。'
  )
}

/**
 * Explain that the idea's own words were not understood by the lexicon.
 *
 * This reports a narrowing the caller cannot otherwise see. The lexicon is a
 * hand-maintained Chinese -> English table; a term missing from it yields no
 * English channel, and a Chinese-only plan reaches a repository population that
 * is nearly disjoint from the English one (measured: `本地优先的` returns 30 rows
 * headed by a book list and an x86 documentation mirror, zero note-taking
 * projects, while logseq / siyuan / Trilium describe themselves in English).
 *
 * The search still runs and still returns rows — this is the difference between
 * `lexicon_miss` and `plan_failed`. What changes is that the caller learns the
 * result was shaped by a vocabulary gap rather than by GitHub, which is the only
 * form of this fact they can act on: supplying English `keywords` bypasses the
 * lexicon entirely.
 *
 * ## Two findings, two conditions
 *
 * `unknownTerms` and `hasEnglishChannel` are independent facts about the same
 * plan, and this function checks them in order of how much they matter,
 * returning at most one note:
 *
 *   1. A plan with NO English channel cannot reach the English population at all,
 *      which is a strictly larger problem than an unnamed term in a plan that
 *      still has one. See {@link chineseIdeaNote}.
 *   2. Otherwise, terms the lexicon did not recognise at all are named.
 *
 * The keyword remedy is only offered when the caller did not already supply
 * keywords, because "add English words" is not advice to someone who did.
 *
 * @param idea - the idea text exactly as the caller wrote it.
 * @param keywords - the caller's `keywords` argument, or `undefined` when absent.
 * @param unknownTerms - the Chinese terms the lexicon did not recognise at all.
 * @param hasEnglishChannel - whether the finished plan has any Latin query.
 * @returns the `degraded.detail` text, or `null` when there is nothing to report.
 */
export function describeLexiconMiss(
  idea: string,
  keywords: string | undefined,
  unknownTerms: readonly string[],
  hasEnglishChannel: boolean,
): string | null {
  // A hint counts only when it carries a LATIN letter: `keywords: '笔记'` is a
  // Chinese hint that leaves the plan exactly as English-less as no hint at all,
  // so treating "some string was passed" as "the caller translated" would retire
  // the remedy text in the one case it is still needed.
  const hinted = keywords !== undefined && /[A-Za-z]/.test(keywords)
  if (!hasEnglishChannel) return chineseIdeaNote(idea)
  if (unknownTerms.length === 0) return null
  // Cap the list: a caller pasting a paragraph would otherwise get the paragraph
  // back. The count still reports the true total.
  const shown = unknownTerms.slice(0, 8)
  const more = unknownTerms.length - shown.length
  const list = `${shown.join('、')}${more > 0 ? ` 等 ${unknownTerms.length} 个` : ''}`
  return (
    `词表未覆盖：${list}\n` +
    '  这些中文词没有对应的英文检索词，因此本次检索缺少由它们驱动的英文通道。' +
    '结果可能偏向中文描述的项目。\n' +
    (hinted
      ? '  你已提供 keywords，本次检索已使用它们；若结果仍不理想，可再补充更贴近领域的英文词。'
      : '  通过 keywords 参数补充 3-6 个英文检索词即可绕开词表（例如把「一个本地优先的笔记应用」' +
        '写为 local-first note-taking）。英文词是触达 logseq / siyuan 这类用英文自我描述的项目' +
        '的唯一途径')
  )
}

/**
 * Describe a partial failure, naming any capability the failure destroyed.
 *
 * "2/3 queries failed" is true and useless when one of the failures was the tail
 * query: the card still looks complete, but the long tail is now unreachable,
 * and nothing in the old message said so. Measured: 30 candidates returned with
 * `partial` reported and ZERO rows at or below 100 stars, because the only query
 * that can reach that end of the result set was one of the two that failed.
 *
 * ## Why the tail test no longer reads the message
 *
 * This used to decide "was the tail lost?" with
 * `plan.some(step => step.sort === 'updated')` plus
 * `failures.some(f => f.includes('sort=updated'))`. Both halves were wrong in a
 * way no test could see:
 *
 *  - `sort === 'updated'` is a PROXY for the tail, and the plan has a tail that
 *    does not use it. A `narrow` tail carries `sort=stars` by design (the
 *    ordering cannot change the member set of a result set smaller than a page),
 *    so losing THAT tail produced no warning at all — the exact silent failure
 *    this note exists to prevent.
 *  - `includes('sort=updated')` coupled this module to the wording of a string
 *    built in `github.ts`. Reword that message and the warning stops firing,
 *    with both modules still "working".
 *
 * The role now travels as data (`QueryFailure.role`), so the check asks the
 * question directly: did a slot whose ROLE is `tail` fail?
 *
 * @param plan - the queries that were run, in order.
 * @param failures - the per-query failure strings, as `searchMerged` produced them.
 * @param hasToken - whether a GITHUB_TOKEN was used; changes the remedy offered.
 * @param failedRoles - optional roles of the failed slots, index-aligned with the
 *   failures `searchMerged` recorded. Omitted by callers that only have the
 *   strings, in which case the tail test falls back to the plan's own roles: a
 *   plan that contained a tail is treated as having lost it, which errs toward
 *   telling the user rather than toward silence.
 * @returns the `degraded.detail` text.
 *
 * Exported for tests. The branch was inline inside `execute()` and therefore
 * unreachable from any test — the same structural problem that let the query
 * builder go uncovered for three rewrites.
 */
export function describePartialFailure(
  plan: QueryStep[],
  failures: string[],
  hasToken: boolean,
  failedRoles?: readonly (QueryRole | undefined)[],
): string {
  // Ask about the ROLE, never about the ordering: a narrow tail uses
  // `sort=stars` and is still the only channel that reaches small projects.
  const tailPlanned = plan.some((step) => step.role === 'tail')
  // With roles supplied, a failing tail is a precise fact. Without them, assume
  // the planned tail was among the failures — the alternative is silently
  // omitting a warning, which is the failure mode this whole note fixes.
  const tailFailed = tailPlanned && (failedRoles === undefined
    ? true
    : failedRoles.some((role) => role === 'tail'))
  return (
    `${failures.length}/${plan.length} 个查询失败，以下是已成功部分的合并结果。\n` +
    failures.map((f) => `  · ${f}`).join('\n') +
    (tailFailed
      // §7.5 / design.md §2.7: this used to read 「因此本次结果**只包含高 star
      // 项目**，star ≤ 100 的小项目无法进入候选池」 — an absolute claim about the
      // rows that DID come back. A failed tail channel proves nothing about them:
      // the surviving channels are ordered by `sort=stars` (which reaches only the
      // head of its own result set) or by `sort=updated`, and an anchor-only plan
      // was measured returning three 5★ repositories. The honest claim is the one
      // about the channel, not about the rows: the low-star lane did not run, so
      // its coverage is unknown. Keep the tail's ceiling named — the reader needs
      // to know WHICH population went uncovered — but do not convert "uncovered"
      // into "absent from the results you are holding".
      ? '\n  ⚠️ 失败的是长尾查询，因此**长尾通道覆盖未知**：' +
        'star ≤ 100 的小项目这一轮没有被检索，' +
        '所以本次结果里有没有小项目、有多少，无从判断。' +
        '这不代表不存在相关的小项目。' +
        (hasToken ? '' : ' ' + tokenRemedy())
      : '')
  )
}

/**
 * Why a candidate set came back short.
 *
 * Split out from {@link explainThinResult} because the two callers need
 * different halves of the same rule. The cold path needs the wording; the replay
 * path needs to know WHICH short result it is looking at, so it can regenerate
 * the wording without re-deriving the fact (and without the quota reading, which
 * only exists at fetch time).
 *
 * One definition, two readers. Deriving the kind twice is how the cold and
 * cached paths drifted apart before.
 */
export type ThinKind = 'quota' | 'narrow'

/**
 * Classify a suspiciously small candidate set.
 *
 * Not every short card is a fact about GitHub. Anonymous search allows 10
 * requests/minute for the whole egress IP, and when that budget is spent the
 * API can answer with a much smaller page rather than an error — a live run got
 * 2 candidates for a query GitHub itself reported as `total_count: 30`. Without
 * this note the card looks identical whether the query truly has 2 matches or
 * the quota was silently exhausted.
 *
 * The two kinds are ordered, not alternatives: a quota-limited fetch is reported
 * as `quota` even when its row count would also look narrow, because the quota is
 * the fact the caller can act on (wait, or configure a token). Recomputing this
 * on a replay with `remaining === undefined` would silently relabel every
 * quota-short result as `narrow` — a wrong diagnosis, which is why the kind is
 * what gets cached.
 *
 * @param count - candidates actually returned.
 * @param limit - candidates requested.
 * @param remaining - quota left per GitHub's header, when reported.
 * @param hasToken - whether a GITHUB_TOKEN was used.
 * @returns the kind of shortfall, or `null` when nothing looks wrong.
 */
export function thinResultKind(
  count: number,
  limit: number,
  remaining: number | undefined,
  hasToken: boolean,
): ThinKind | null {
  if (count >= limit) return null
  if (remaining !== undefined && remaining <= 1 && !hasToken) return 'quota'
  if (count === 0) return null
  if (count < 500 && count <= Math.max(2, Math.floor(limit / 4))) return 'narrow'
  return null
}

/**
 * Explain a suspiciously small candidate set, for the fetch that produced it.
 *
 * @param count - candidates actually returned.
 * @param limit - candidates requested.
 * @param remaining - quota left per GitHub's header, when reported.
 * @param hasToken - whether a GITHUB_TOKEN was used.
 * @returns a warning line, or `null` when nothing looks wrong.
 */
export function explainThinResult(
  count: number,
  limit: number,
  remaining: number | undefined,
  hasToken: boolean,
): string | null {
  const kind = thinResultKind(count, limit, remaining, hasToken)
  if (kind === 'quota') {
    return (
      `本次仅返回 ${count} 个（请求 ${limit} 个），且 GitHub 报告剩余配额只剩 ${remaining} 次。\n` +
      '  匿名检索每分钟只有 10 次且同一出口 IP 共享；配额耗尽时 GitHub 可能不报错，而是返回一个更小的结果集。\n' +
      '  这不代表 GitHub 只有这么多匹配项目。建议稍后重试。' + tokenRemedy()
    )
  }
  if (kind === 'narrow') {
    return (
      `本次仅返回 ${count} 个（请求 ${limit} 个）。这通常是查询词过窄，而非 GitHub 缺少相关项目：\n` +
      '  GitHub 仓库搜索对名称、描述、topics 做多词 AND 匹配，词越多命中越少。\n' +
      '  可以换几个更宽泛的关键词（如去掉一个限定词）重试。'
    )
  }
  return null
}

/**
 * The replay-path half of {@link explainThinResult}.
 *
 * A cached candidate list stores which kind of shortfall its fetch had, but not
 * the numbers behind it. That split is deliberate, and it is the same one
 * {@link describeReplayedIncompleteness} makes: "本次仅返回 2 个（请求 20 个），
 * 剩余配额只剩 1 次" is a claim about one fetch at one moment, and printing it
 * 20 hours later would assert a quota reading that no longer exists. What
 * survives caching is the weaker, still-true fact — **this list is short, and
 * here is why it was short** — and that is what this function says.
 *
 * Dropping this note entirely was a real defect: the second call for the same
 * idea returned `degraded: null`, so a 2-row pool was presented as a clean
 * result. The second call is exactly when the caller is retrying, which is when
 * the note matters most.
 *
 * @param kind - the shortfall kind recorded when the entry was written.
 * @returns the note to attach to a replayed short result.
 */
export function describeReplayedThinness(kind: ThinKind): string {
  if (kind === 'quota') {
    return (
      '这条候选列表来自缓存，且当初抓取时 GitHub 配额已接近耗尽。\n' +
      '  **当前结果可能偏少**：匿名检索每分钟只有 10 次且同一出口 IP 共享，配额耗尽时 GitHub 可能不报错，而是返回一个更小的结果集。\n' +
      '  这不代表 GitHub 只有这么多匹配项目。可清空缓存或稍后重新检索。' + tokenRemedy()
    )
  }
  return (
    '这条候选列表来自缓存，且当初只返回了少量结果。这通常是查询词过窄，而非 GitHub 缺少相关项目：\n' +
    '  GitHub 仓库搜索对名称、描述、topics 做多词 AND 匹配，词越多命中越少。\n' +
    '  可以换几个更宽泛的关键词（如去掉一个限定词）重新检索。'
  )
}

/**
 * The replay-path half of {@link describePartialFailure}.
 *
 * A cached candidate list stores whether its fetch was incomplete, but not which
 * query failed. That split is deliberate: "2/3 个查询失败" is a claim about a
 * fetch at one moment, and printing it 20 hours later would assert that queries
 * failed when nothing was attempted this call. What survives caching is the
 * weaker, still-true fact — **these rows are a subset of what was asked for** —
 * and that is what this function says.
 *
 * @returns the note to attach to a replayed incomplete result.
 */
export function describeReplayedIncompleteness(): string {
  return (
    '这条候选列表来自缓存，且当初的抓取并未取全（部分查询失败）。\n' +
    '  **当前结果是不完整**：缺少的是当初失败的那部分查询本会返回的项目，其中可能包含低 star 的同类项目。\n' +
    '  这不代表不存在相关项目。可清空缓存或换关键词重新检索以获得完整结果。'
  )
}
