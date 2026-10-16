/**
 * Shared vocabulary for dsh-find-ideas.
 *
 * Every type here is lossless-JSON compatible: `output.schema` is enforced
 * against whatever `execute` returns, so nothing in these shapes may be a
 * class, `undefined`, `bigint`, `Map`, or a function.
 */

/** A GitHub repository candidate, normalized from the search API. */
export interface RepoCandidate {
  /** `owner/name`. */
  full_name: string
  /** HTML url. */
  url: string
  /** Owner login. */
  owner: string
  /** Repository name. */
  name: string
  /** Short description, or `''` when GitHub reports none. */
  description: string
  /** Star count. */
  stars: number
  /** Primary language, or `''` when undetected. */
  language: string
  /** Last push timestamp (ISO 8601), or `''` when absent. */
  pushed_at: string
  /** Whether GitHub archived the repository. */
  archived: boolean
  /** Topics declared by the repository. */
  topics: string[]
}

/** One LLM-inspected candidate, scored for relevance to the user's idea. */
export interface Inspection {
  /** `owner/name`. */
  full_name: string
  /** HTML url. */
  url: string
  /** Star count at inspection time. */
  stars: number
  /** Relevance to the user's idea, integer 0-10, judged by the agent. */
  relevance: number
  /** Derived borrow-worthiness rating, 1-5. Never LLM-authored directly. */
  stars_rating: number
  /** Technical-architecture summary. */
  arch_summary: string
  /** Concrete things worth borrowing for this idea. */
  borrow_points: string[]
  /** Agent's overall summary of the project. */
  summary: string
  /** Files actually read, for traceability. */
  files_read: string[]
  /** Whether inspection of this repo succeeded. */
  ok: boolean
  /** Failure reason when `ok` is false. */
  error?: string
}

/**
 * Degradation record. Present when a result is partial, so the card can explain
 * *why* it is partial rather than silently returning fewer rows.
 */
export interface Degraded {
  /** Stable machine-ish reason, e.g. `rate_limited`, `no_token`, `timeout`. */
  reason: string
  /** Human-readable detail shown at the bottom of the card. */
  detail: string
}

/** Result of the lexically-normalized cache key for an idea. */
export type CacheKey = string

/**
 * Derive the borrow-worthiness rating from relevance.
 *
 * Deliberately derived rather than LLM-authored: an independently generated
 * rating can contradict the same model's own relevance score, and there is no
 * way to adjudicate the disagreement.
 *
 * The bands are aligned to the relevance scale's own bands (10 = essentially the
 * same idea, 7-9 = same problem space, 4-6 = partial overlap, 3 = loosely
 * related). The previous mapping — `>=9→, >=7→, >=5→, >=3→, else 1` — was
 * off by one across the middle, which made the display contradict the score
 * printed beside it: relevance 4 and 5 both showed 2 stars, and 6 showed 3.
 * `MIN_RELEVANCE` is 3, so every surviving card row is relevance >= 3, and the
 * practical effect was that a row the ranking treated as clearly relevant could
 * render at two stars.
 *
 * Display only. This never enters `finalScore`, so no ordering changes.
 *
 * @param relevance - integer relevance, clamped to 0-10.
 * @returns star rating 1-5.
 */
export function ratingFromRelevance(relevance: number): number {
  if (relevance >= 10) return 5
  if (relevance >= 8) return 4
  if (relevance >= 6) return 3
  if (relevance >= 4) return 2
  return 1
}

/** Stars below this are treated as equal — the floor in `finalScore`. */
export const STAR_FLOOR = 10

/**
 * Final ranking score: `relevance × (1 + log10(max(stars, 10) + 1)) / 2`.
 *
 * Two things about this formula are load-bearing, and both were arrived at by
 * testing rather than by taste.
 *
 * **1. The log, not sqrt or linear.** A 200-star project that is genuinely
 * on-point (relevance 9) must outrank a 50k-star project that is only
 * tangentially related (relevance 4). `sqrt` and linear star terms both fail
 * that test (DESIGN.md §3.2.1-3.2.2): sqrt still gives 65x weight to the larger
 * repo, swamping the 2.25x relevance gap.
 *
 * **2. The star floor AND the halving.** Plain `log10(stars + 1)` scored exactly
 * 0 at 0 stars, so a perfectly on-point 0-star project sank below every noisy
 * high-star repo — and 0-3 stars is the *common* case for fresh projects (a live
 * scout run surfaced moonstone@0 and nexa-notes-v2@0, both topically exact). The
 * floor fixed the exact-zero case but not the underlying imbalance: with a bare
 * `log10(max(s,10)+1)`, weight runs 1.041 at 0 stars to 5.274 at 188k — a 5.06x
 * spread, meaning stars speak 5x louder than relevance, and 10 integer relevance
 * steps (r10 vs r3 = 3.3x) cannot overcome that. The measured consequence was
 * concrete: relevance 3 with 50k stars scored 14.10 against 10.41 for relevance
 * 10 with 0 stars, and a relevance-4 / 188k-star document converter scored 21.10
 * against the same 10.41.
 *
 * Dividing by 2 compresses the spread to 3.07x (1.021 at 0 stars, 3.137 at 188k)
 * while keeping star count meaningfully discriminating — a full "half-star tier"
 * of difference at the top end — and that is enough for relevance to win:
 * r10/0★ → 10.21 now beats r3/50k★ → 8.55. It also preserves the original
 * calibration unchanged in substance (r9/200★ still beats r4/50k★ 14.86 vs
 * 11.39), because both sit above the floor.
 *
 * Rejected: a double log (`log10(1 + log10(...))`, spread 2.57x) compresses so
 * hard that an r9/45k★ anchor (6.77) still crushed an r10/0★ exact match (3.10),
 * so it did not actually fix the ordering it was meant to fix. Rejected:
 * `log10(max(s,1000)+1)` (spread 1.76x) flattens star count out of the ranking
 * almost entirely, leaving the coarse first pass with nothing to do.
 *
 * @param relevance - integer relevance 0-10.
 * @param stars - star count.
 * @returns comparable score; higher is better.
 */
export function finalScore(relevance: number, stars: number): number {
  return relevance * (1 + Math.log10(Math.max(STAR_FLOOR, Math.max(0, stars)) + 1)) / 2
}

/** One agent-supplied relevance judgement, as passed to `rank_candidates`. */
export interface RelevanceInput {
  /** `owner/name`, must match a candidate returned by `scout_projects`. */
  full_name: string
  /**
   * Optional free-text reason for this score (B4, user m00793).
   *
   * Purely explanatory: it is echoed in the suspicion note and never enters the
   * formula, the order, or the rating. Kept out of the card proper for the same
   * reason — a rationale rendered next to a computed score would read as though
   * the score were justified by it.
   */
  note?: string
  /**
   * Relevance to the idea, integer 0-10.
   *
   * `0` means "noise — exclude from the card" rather than "rank last", so the
   * agent has a way to discard keyword-bait repos (`Obsidian-Windows-Download`)
   * instead of letting them occupy the bottom of the card.
   */
  relevance: number
}

/** One ranked row, ready to render: candidate metadata joined with its score. */
export interface RankedCandidate {
  /** 1-based position after ranking. */
  rank: number
  /** `owner/name`. */
  full_name: string
  /** HTML url. */
  url: string
  /** Owner login. */
  owner: string
  /** Repository name. */
  name: string
  /** Short description, or `''`. */
  description: string
  /** Star count. */
  stars: number
  /** Primary language, or `''`. */
  language: string
  /** Last push timestamp (ISO 8601), or `''`. */
  pushed_at: string
  /** Whether GitHub archived the repository. */
  archived: boolean
  /** Topics declared by the repository. */
  topics: string[]
  /** Agent-judged relevance, integer 0-10. */
  relevance: number
  /** Rating derived from `relevance`; never agent-authored. */
  stars_rating: number
  /** `relevance × (1 + log10(max(stars, STAR_FLOOR) + 1)) / 2`; see {@link finalScore}. */
  score: number
  /**
   * The caller's own free-text reason for this score, if one was given (B4).
   *
   * Never computed, never part of the formula; the renderer puts it in a
   * separate labelled section so it cannot be mistaken for a tool output.
   */
  note?: string
  /**
   * GitHub's canonical HTML url for this repository (B10, user m00929).
   *
   * Carried on the RANKED row as well as the raw candidate, because the ranked
   * card is what a human reads and then clicks. Measured: `FuRongJun-1999/dsh-memory`
   * is reachable at that capitalization and 404s at the all-lowercase spelling,
   * and GitHub's owner path segment is case-sensitive even though login
   * uniqueness is not. Anything that makes the reader reassemble a URL from
   * `full_name` can therefore produce a 404 for a repository that exists, so the
   * fetched `html_url` — never a reconstruction — is what the card renders.
   */
  html_url: string
}

/**
 * One query term's solo match count (B6, user m00929).
 *
 * ## Why `total` is a number and not `number | null`
 *
 * The tool's output schema is what `execute` must return and what the host
 * validates against; in that schema a numeric field cannot be `null`. Encoding
 * "no measurement" as `null` therefore does not compile — and would not validate
 * at runtime either. `-1` is the sentinel instead, with
 * {@link TERM_TOTAL_UNKNOWN} naming it so the value is never a bare literal.
 *
 * The distinction the sentinel protects is real and is kept: a term that matched
 * NOTHING (`0`) constrains the query hard, while a term nobody measured (`-1`)
 * says nothing at all. Collapsing the two would report an unprobed term as a
 * term that matches no repository.
 */
export const TERM_TOTAL_UNKNOWN = -1

export interface TermReport {
  /** The term exactly as the plan sent it (quoted CJK runs keep their quotes). */
  term: string
  /** Solo `total_count`, or {@link TERM_TOTAL_UNKNOWN} when the probe returned none. */
  total: number
  /** `'carrying'` when this term adds little or no constraint to the query. */
  verdict: 'selective' | 'carrying'
}

/**
 * How the scores were distributed across the pool a card was built from (B3).
 *
 * Exists so a broad lead term shows up as a number instead of as a thin card
 * the reader has to interpret. `unanswered` counts candidates the caller never
 * scored — silence is not relevance, but it is also not noise, so it is reported
 * separately rather than folded into either.
 */
export interface NoiseReport {
  /** Candidates that received a score. */
  scored: number
  /** Scored relevance 0. */
  noise: number
  /** Scored above 0 but below {@link MIN_RELEVANCE}. */
  weak: number
  /** Rows that reached the card. */
  kept: number
  /** Pool rows that were never scored. */
  unanswered: number
  /** `noise / pool size`, 0 when the pool is empty. */
  noise_ratio: number
  /**
   * Low-star rows in the pool this card was built from (§7.6 / AC12).
   *
   * The two counts below are a matched pair and are only meaningful together.
   * `low_star_in_pool` is where small projects ARRIVE; `low_star_in_kept` is
   * where they SURVIVE. The scoring formula
   * `relevance × (1 + log10(max(stars, 10) + 1)) / 2` is unchanged by design
   * (the user's own ruling), and it systematically ranks a low-star row below an
   * equally relevant high-star one — so a small project can be present in the
   * pool, scored honestly, and still be absent from the card. That loss used to
   * be invisible: the card reported how many rows were kept, never which kind.
   *
   * A single number cannot express it. `kept` alone cannot distinguish "the
   * pool held no small projects" from "the pool held several and the formula
   * pushed all of them out", and those two need opposite responses from the
   * reader — the first is a retrieval fact, the second is a ranking fact. The
   * difference between these two counts IS the measurement §7.6 asks for.
   */
  low_star_in_pool: number
  /** Low-star rows that reached the card, counted after truncation. */
  low_star_in_kept: number
}

/**
 * Relevance at or below this is excluded from the card outright.
 *
 * The threshold exists because a broader query set introduces high-star noise.
 * Widening "markdown note bidirectional" to "markdown note" reached the field
 * anchors (logseq, AffiNE, memos) but also pulled in 188k-star document
 * converters and crawlers unrelated to a note-taking app. At relevance 3 those
 * noise rows scored 15.8 — above every relevant small project — so six of the
 * twelve card slots went to tools nobody asked about. A score of 1-2 means
 * "loosely related at best", which is not what a card titled "projects similar
 * to your idea" should spend space on.
 *
 * Kept as one exported constant so the boundary is inspectable and testable
 * rather than an inline `<= 2` buried in a comparison.
 */
export const MIN_RELEVANCE = 3

/**
 * Relevance at or below which a row is a *suspected* mis-score when its own
 * description shares a term with the query that produced it (B2, user m00793).
 *
 * This is the same floor as {@link MIN_RELEVANCE}, not a separate policy: the
 * band 1-2 is exactly "barely related", and the whole point of the check is that
 * a row landing there while carrying query terms in its description contradicts
 * its own score. Reusing the floor keeps one boundary to reason about.
 */
export const SUSPICION_RELEVANCE = MIN_RELEVANCE

/**
 * How much of a description may be echoed back in a suspicion note.
 *
 * A description can be 240 KB of keyword stuffing (see `MAX_DESCRIPTION_CHARS`),
 * and a note that quotes one in full recreates the exact truncation failure that
 * cap exists to prevent. The note only needs enough to be checkable by eye.
 */
export const SUSPICION_QUOTE_CHARS = 120

/** One scored row whose description contradicts the score it was given. */
export interface Suspicion {
  /** `owner/name`. */
  full_name: string
  /** The relevance the agent supplied. */
  relevance: number
  /** Query terms found in this candidate's own description, deduped. */
  matched: string[]
  /** A clipped excerpt of the description, for the reader to check by eye. */
  quote: string
  /**
   * Which rule fired. `term_gap` is B2's original one-directional check;
   * the other three are the C-series re-scoring checks (user m01331).
   *
   * A plain `string`, not a union: `rank_candidates`'s `output.schema` is used
   * by `defineTool` to infer the execute return type, and the schema language has
   * no unions — a union here makes the tool's return type unassignable. The four
   * values are still produced only by the functions below.
   */
  kind: string
  /**
   * The other row this suspicion is about, for the two pairwise rules.
   *
   * Empty string when the rule is about one row only. A sentinel rather than an
   * optional field, for the same schema-language reason as {@link kind}.
   */
  against: string
}

/**
 * Terms worth checking a description against.
 *
 * Latin runs of 4+ characters, lower-cased. The 4-character floor drops the
 * `and` / `the` / `for` noise that would otherwise match almost every English
 * description; short CJK runs are dropped entirely, because a Chinese term
 * almost never appears in a repo description that GitHub indexes.
 *
 * A term is only useful if the *same* term is absent from another candidate's
 * description — that is what separates "this row carries the query" from "every
 * row carries the query". That filtering happens in {@link findSuspicious},
 * which can see the whole pool.
 */
function queryTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const run of query.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    seen.add(run)
  }
  return [...seen]
}

/**
 * The single identity view every rank and every diagnostic shares.
 *
 * Two views used to exist side by side: `rankCandidates` walked the raw
 * `candidates` array, so the same repository passed twice under different
 * capitalisation produced TWO card rows, while `findScoreGaps` keyed by lowercase
 * `full_name` and saw one. The card and the diagnostic that exists to catch
 * contradictions were therefore comparing different pools, and the visible
 * symptom was the worst of the two: a duplicate row on the card.
 *
 * First occurrence wins, which is also the order `scout_projects` returned, so the
 * surviving row is the one the caller saw first. GitHub's owner path segment is
 * case-sensitive even though login uniqueness is not (see {@link RankedCandidate.html_url}),
 * so the surviving spelling is kept verbatim rather than normalised for display.
 *
 * @param candidates - the pool, possibly carrying the same repo more than once.
 * @returns one row per lowercase `full_name`, in first-occurrence order.
 */
export function candidateIndex(candidates: RepoCandidate[]): Map<string, RepoCandidate> {
  const byName = new Map<string, RepoCandidate>()
  for (const candidate of candidates) {
    const key = candidate.full_name.toLowerCase()
    if (byName.has(key)) continue
    byName.set(key, candidate)
  }
  return byName
}

/** Clamp a caller-supplied relevance to the declared 0-10 integer domain. */
function clampRelevance(relevance: number): number {
  return Math.max(0, Math.min(10, Math.round(relevance)))
}

/**
 * The single effective-score view, shared by the rank and every diagnostic.
 *
 * `rankCandidates` resolved a repeated judgement last-wins while `findScoreGaps`
 * resolved it first-wins, so a caller that scored the same repository twice got a
 * card built on one number and a contradiction report built on the other. The
 * rule kept is last-wins: the caller's latest word is the deliberate one, and it
 * is the rule the rank already used.
 *
 * A name matching no candidate is REPORTED, never silently dropped — the caller
 * may have scored a row that fell out of the pool, and silence there would read
 * as "that score was fine".
 *
 * @param byName - the shared identity view from {@link candidateIndex}.
 * @param scores - agent-supplied judgements.
 * @returns relevance and note per lowercase `full_name`, plus unmatched names.
 */
export function judgementIndex(
  byName: Map<string, RepoCandidate>,
  scores: RelevanceInput[],
): { relevance: Map<string, number>; notes: Map<string, string | undefined>; unknown: string[] } {
  const relevance = new Map<string, number>()
  const notes = new Map<string, string | undefined>()
  const unknown: string[] = []
  for (const entry of scores) {
    const key = entry.full_name.toLowerCase()
    if (!byName.has(key)) {
      unknown.push(entry.full_name)
      continue
    }
    // Last judgement wins, so a repeat entry is idempotent rather than doubling up.
    relevance.set(key, clampRelevance(entry.relevance))
    notes.set(key, entry.note)
  }
  return { relevance, notes, unknown }
}

/**
 * Find scored rows whose own description contradicts the score given (B2).
 *
 * The failure this exists for, measured (user m00787-m00793): a broad query whose
 * lead term was `browser extension` returned 30 rows, of which 20 were noise.
 * Among them was `rerr-creator/open-translator`, whose description reads
 * "translates web pages using trusted AI models" — an exact hit on the idea —
 * yet it was scored 1 and dropped, because a glance at "1 star · archived" read
 * as noise. The pool percentage was reported afterwards; nothing checked the one
 * row where the score and the text disagreed.
 *
 * The check is deliberately one-directional: it flags LOW scores on rows that
 * CARRY query terms. It never argues a high score down, because "this repo does
 * not mention the idea but is still relevant" is a legitimate judgement, while
 * "this repo describes the idea and I called it noise" is a contradiction the
 * caller should have to look at once.
 *
 * @param candidates - the pool the scores were given against.
 * @param scores - agent-supplied judgements.
 * @param query - the idea and/or keywords that produced the pool.
 * @returns one entry per contradicted row, in pool order.
 */
export function findSuspicious(
  candidates: RepoCandidate[],
  scores: RelevanceInput[],
  query: string,
): Suspicion[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []

  // One identity view and one score view, shared with the rank (§2.6.2). Walking
  // the raw array here made this diagnostic see the pool twice over when a repo
  // arrived under two spellings, while the card saw it once.
  const byName = candidateIndex(candidates)
  const { relevance: relevanceByName } = judgementIndex(byName, scores)

  // A term that appears in most descriptions describes the population, not the
  // row, so it cannot support a suspicion. "extension" across 30 browser-extension
  // repos is the case this drops.
  const docFrequency = new Map<string, number>()
  for (const candidate of byName.values()) {
    const text = candidate.description.toLowerCase()
    for (const term of terms) {
      if (text.includes(term)) docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1)
    }
  }
  const discriminant = Math.max(2, Math.ceil(byName.size * 0.5))
  const discriminating = terms.filter((term) => (docFrequency.get(term) ?? 0) < discriminant)
  if (discriminating.length === 0) return []

  const out: Suspicion[] = []
  for (const candidate of byName.values()) {
    const relevance = relevanceByName.get(candidate.full_name.toLowerCase())
    if (relevance === undefined || relevance > SUSPICION_RELEVANCE) continue
    const text = candidate.description.toLowerCase()
    const matched = discriminating.filter((term) => text.includes(term))
    if (matched.length === 0) continue
    out.push({
      full_name: candidate.full_name,
      relevance,
      matched,
      quote: candidate.description.slice(0, SUSPICION_QUOTE_CHARS),
      kind: 'term_gap',
      against: '',
    })
  }
  return out
}

/**
 * How close two descriptions must be to count as "the same row" for the
 * score-gap rule.
 *
 * Measured motivation (user m01331): this session scored
 * `rerr-creator/open-translator` 1 and, in a separate round, scored near-identical
 * "translate web pages" rows 9 — the same text judged two ways. The floor is a
 * share of the shorter description, not an absolute character count, because
 * descriptions range from 12 characters to 240 KB.
 */
export const SCORE_GAP_SIMILARITY = 0.6

/** Relevance difference at or above which a similarity pair is flagged. */
export const SCORE_GAP_RELEVANCE = 5

/** How many matched terms make "the description names the idea" worth raising. */
export const NOTE_GAP_TERMS = 2

/** Relevance at or above which a note-free row is worth raising. */
export const NOTE_GAP_FLOOR = 7

/** The longest a note may be and still count as empty of content. */
export const NOTE_MIN_CHARS = 12

/**
 * Character-pair similarity, used only to find pairs of rows that are
 * *plausibly the same candidate*.
 *
 * Deliberately a character bigram, not a word or embedding comparison: it must
 * be cheap, deterministic, and explainable to the caller in one sentence. It is
 * a *trigger*, never a verdict — the card shows the score difference and lets
 * the reader decide.
 */
function bigrams(text: string): Set<string> {
  const out = new Set<string>()
  const clean = text.toLowerCase().replace(/\s+/g, ' ').trim()
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

/** Sørensen-Dice overlap of two strings' character bigrams, in [0, 1]. */
export function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return (2 * shared) / (left.size + right.size)
}

/**
 * Rule 1: two rows whose descriptions are so close that the same candidate was
 * judged twice, with a wide relevance gap.
 *
 * Unlike the other checks this needs no query and no idea — it compares the
 * caller's scores against each other, which is exactly the class of error a
 * single-row check cannot see.
 *
 * @param candidates - the pool the scores were given against.
 * @param scores - agent-supplied judgements.
 */
export function findScoreGaps(
  candidates: RepoCandidate[],
  scores: RelevanceInput[],
): Suspicion[] {
  // §2.6.2: the shared identity and score views, so a repeated judgement cannot
  // produce a card built on the last word and a gap report built on the first.
  // Iterating the candidate view (not the score list) also makes the pair order
  // independent of the order the caller happened to list its scores in.
  const byName = candidateIndex(candidates)
  const { relevance: relevanceByName, notes } = judgementIndex(byName, scores)
  const scored: Array<{ candidate: RepoCandidate; relevance: number; reasoned: boolean }> = []
  for (const [key, candidate] of byName) {
    const relevance = relevanceByName.get(key)
    if (relevance === undefined) continue
    scored.push({
      candidate,
      relevance,
      // A stated reason is the caller declaring "this score is deliberate".
      // See the doc comment above for why that decides whether a wide gap on
      // similar descriptions is a contradiction or a judgement.
      reasoned: (notes.get(key) ?? '').trim().length >= NOTE_MIN_CHARS,
    })
  }

  const out: Suspicion[] = []
  for (let i = 0; i < scored.length; i += 1) {
    for (let j = i + 1; j < scored.length; j += 1) {
      const left = scored[i]!
      const right = scored[j]!
      if (Math.abs(left.relevance - right.relevance) < SCORE_GAP_RELEVANCE) continue
      if (similarity(left.candidate.description, right.candidate.description) < SCORE_GAP_SIMILARITY) continue
      // Both rows carry a reason: the caller has already distinguished them on
      // the record, which is exactly what this rule exists to force. Reporting
      // here is the false positive measured on WeChatMsg(8) / WechatExporter(3)
      // — two legitimately different projects that genuinely share a
      // description, both explicitly justified.
      if (left.reasoned && right.reasoned) continue
      const lower = left.relevance <= right.relevance ? left : right
      const higher = lower === left ? right : left
      out.push({
        full_name: lower.candidate.full_name,
        relevance: lower.relevance,
        matched: [],
        quote: lower.candidate.description.slice(0, SUSPICION_QUOTE_CHARS),
        kind: 'score_gap',
        against: higher.candidate.full_name,
      })
    }
  }
  return out
}

/**
 * Rule 2, widened (user m01331): a row whose description states the idea AND
 * carries query terms, but which was scored on either side of the floor.
 *
 * B2 only looked one way — low score, carrying terms. This adds the mirror:
 * a *high* score on a row whose description does NOT carry the discriminating
 * terms is worth one look too, because "I like this repo" and "this repo is
 * what the query asked for" are different claims and only the first is a score.
 *
 * Both directions stay *suspicions*, never corrections: nothing here changes a
 * score or the order the formula produced.
 */
export function findDoubleSided(
  candidates: RepoCandidate[],
  scores: RelevanceInput[],
  query: string,
): Suspicion[] {
  const terms = queryTerms(query)
  // §2.6.2: shared views. This rule reads both a score and a note, so it is the
  // one most exposed to a caller that scored the same repo twice — it used to
  // take the last relevance and the last note independently, which could pair a
  // score from one entry with a note from another.
  const byName = candidateIndex(candidates)
  const { relevance: relevanceByName, notes: noteByName } = judgementIndex(byName, scores)

  const docFrequency = new Map<string, number>()
  for (const candidate of byName.values()) {
    const text = candidate.description.toLowerCase()
    for (const term of terms) {
      if (text.includes(term)) docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1)
    }
  }
  const discriminant = Math.max(2, Math.ceil(byName.size * 0.5))
  const discriminating = terms.filter((term) => (docFrequency.get(term) ?? 0) < discriminant)

  const out: Suspicion[] = []
  for (const candidate of byName.values()) {
    const key = candidate.full_name.toLowerCase()
    const relevance = relevanceByName.get(key)
    if (relevance === undefined) continue
    const text = candidate.description.toLowerCase()
    const matched = discriminating.filter((term) => text.includes(term))
    const quote = candidate.description.slice(0, SUSPICION_QUOTE_CHARS)

    // Direction A (B2, unchanged): low score, but the row carries the query.
    if (relevance <= SUSPICION_RELEVANCE && matched.length > 0) {
      out.push({ full_name: candidate.full_name, relevance, matched, quote, kind: 'term_gap', against: '' })
      continue
    }

    // Rule 3 (user m01331): a confident score with no stated reason.
    //
    // This rule deliberately does NOT reuse B2's `discriminating` filter. That
    // filter answers "does the query term mark this row out from its pool?",
    // which is the right question for direction A but the wrong one here: rule 3
    // asks whether a *confident* score carries a reason, and that has nothing to
    // do with which terms are distinctive. Gating it on `matched` was measured
    // to make the rule fire almost never — on the two-row pool from the WeChat
    // screenshot run, `matched` was 1 and 0 against a `NOTE_GAP_TERMS` floor of
    // 2, so a score of 9 with no note at all was reported as nothing.
    //
    // The term match is still computed, because it makes the report more useful
    // when it happens (`a confident score, and its description does carry
    // "wechat"`), but it is evidence attached to the finding, never its trigger.
    const note = noteByName.get(key)
    if (relevance >= NOTE_GAP_FLOOR && (note === undefined || note.trim().length < NOTE_MIN_CHARS)) {
      out.push({
        full_name: candidate.full_name,
        relevance,
        matched,
        quote,
        kind: 'note_gap',
        against: '',
      })
    }
  }
  return out
}

/**
 * Rule 4 (user m01331): the same note pasted onto more than one row.
 *
 * A shared note cannot be a per-row reason. Unlike a short note, this is not
 * "thin" but *duplicated*, which is a different claim and gets its own kind so
 * the card can say which one happened.
 */
export function findNoteEchoes(scores: RelevanceInput[]): Suspicion[] {
  const byNote = new Map<string, string[]>()
  for (const entry of scores) {
    const note = (entry.note ?? '').trim().toLowerCase()
    if (note.length < NOTE_MIN_CHARS) continue
    const list = byNote.get(note) ?? []
    list.push(entry.full_name)
    byNote.set(note, list)
  }

  const out: Suspicion[] = []
  for (const [, names] of byNote) {
    if (names.length < 2) continue
    for (const name of names) {
      out.push({ full_name: name, relevance: -1, matched: [], quote: '', kind: 'note_echo', against: '' })
    }
  }
  return out
}

/**
 * Rank candidates by the formula, dropping noise and unknown names.
 *
 * This is the whole point of `rank_candidates`: the agent supplies relevance
 * judgements and nothing else, so the resulting order is produced by code and
 * cannot be reshuffled by prose. Ties break on star count, then on `full_name`,
 * so the order is total and deterministic.
 *
 * @param candidates - candidates previously returned by `scout_projects`.
 * @param scores - agent-supplied `{full_name, relevance}` judgements.
 * @returns ranked rows (relevance below {@link MIN_RELEVANCE} and unrecognized
 *   names removed), plus the names that did not match any candidate and those
 *   excluded for falling below the relevance floor.
 */
export function rankCandidates(
  candidates: RepoCandidate[],
  scores: RelevanceInput[],
): { ranked: RankedCandidate[]; unknown: string[]; dropped: string[]; belowThreshold: string[] } {
  // §2.6.2: the shared views. Walking the raw array was what let the same
  // repository produce two card rows when it arrived under two spellings, while
  // every diagnostic — keyed by lowercase `full_name` — saw only one.
  const byName = candidateIndex(candidates)
  const { relevance: relevanceByName, notes, unknown } = judgementIndex(byName, scores)

  const dropped: string[] = []
  const belowThreshold: string[] = []
  const ranked: RankedCandidate[] = []

  // Candidates the agent never scored are excluded: silence must not be promoted
  // into the card, or 45 scored-in-name-only rows reappear.
  for (const [key, candidate] of byName) {
    const relevance = relevanceByName.get(key)
    if (relevance === undefined) continue
    if (relevance === 0) {
      dropped.push(candidate.full_name)
      continue
    }
    // Relevance 1-2 is "barely related", the band that broad-query noise lands
    // in. Dropping it here (not merely ranking it low) is what stops a 188k-star
    // converter from occupying a card slot.
    if (relevance < MIN_RELEVANCE) {
      belowThreshold.push(candidate.full_name)
      continue
    }
    // §6.4c: the caller's own words travel with the row. They used to stop at the
    // rank, so the card could not show a reason the caller had actually given.
    const note = notes.get(key)
    ranked.push({
      rank: 0,
      full_name: candidate.full_name,
      url: candidate.url,
      owner: candidate.owner,
      name: candidate.name,
      description: candidate.description,
      stars: candidate.stars,
      language: candidate.language,
      pushed_at: candidate.pushed_at,
      archived: candidate.archived,
      topics: candidate.topics,
      relevance,
      stars_rating: ratingFromRelevance(relevance),
      score: finalScore(relevance, candidate.stars),
      ...(note !== undefined && note.trim().length > 0 ? { note } : {}),
      // B10: carried through unchanged from the fetch. A reconstruction from
      // `full_name` would reintroduce the 404 this field exists to prevent.
      html_url: candidate.url,
    })
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.stars !== a.stars) return b.stars - a.stars
    return a.full_name.localeCompare(b.full_name)
  })
  ranked.forEach((row, i) => {
    row.rank = i + 1
  })

  return { ranked, unknown, dropped, belowThreshold }
}

/** Render a star count compactly: 12493 -> `12.5k`. */
export function formatStars(stars: number): string {
  if (stars < 1000) return String(stars)
  const k = stars / 1000
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`
}

/** Render a 1-5 rating as filled/empty stars. */
export function formatRating(rating: number): string {
  const clamped = Math.max(1, Math.min(5, Math.round(rating)))
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped)
}

/**
 * Normalize one text fragment for use inside a cache key.
 *
 * Lowercases, strips punctuation to spaces, and collapses whitespace so that
 * "Build a  Markdown note-taking app!" and "build a markdown note taking app"
 * normalize identically.
 *
 * @param text - raw fragment.
 * @returns normalized fragment.
 */
function normalizeFragment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Normalize the idea string into a stable cache key.
 *
 * @param idea - raw user idea text.
 * @returns normalized key.
 */
export function cacheKeyFor(idea: string): CacheKey {
  return normalizeFragment(idea)
}

/**
 * Version of the SEARCH STRATEGY, not of the on-disk envelope.
 *
 * `cache.ts` has its own `CACHE_VERSION` guarding the storage FORMAT; bumping
 * that discards every entry when the JSON shape changes. This constant guards
 * something different and more subtle: the QUERY PLAN. `scout_projects` does not
 * send the user's text to GitHub — it derives a plan (narrow exact query, a
 * medium query, and a `sort=updated` long-tail query; see `buildQueries`). A
 * cached row set is only a valid answer to the plan that produced it.
 *
 * The defect this prevents: change how queries are built — add a fourth query,
 * drop the long-tail pass, alter stopword handling — and every previously cached
 * entry stays valid as far as the storage layer is concerned, because the key
 * still describes the same (idea, keywords, limit, auth) and the envelope still
 * parses. Callers would then be served results from the OLD plan for up to 24h
 * while the code claims to be running the new one. Nothing in the output would
 * reveal it: the card looks exactly like a correct answer from the new plan.
 *
 * This is the same failure family as the missing `auth` dimension (B1) and the
 * too-long source TTL (B3): the cache is not wrong about what it stored, it is
 * answering a slightly different question than the caller asked. Rows are
 * plausible, marked `cached: true`, and describe a search the current code would
 * no longer perform.
 *
 * Bump this whenever the derived plan changes in a way that alters which
 * repositories a search can return — adding/removing a query, changing a query's
 * `sort`, or changing term extraction. It is part of the key, so a bump orphans
 * old entries rather than mis-serving them.
 *
 * Current value corresponds to the role-labelled plan plus conditional bilingual
 * routing: with a total lexicon miss and a usable Latin hint, the English broad
 * query leads; otherwise the original Chinese-first bilingual layout is kept.
 * Max 3 queries; the Chinese channel and the English updated tail are retained.
 *
 * Bumped 1 -> 2 when that bilingual branch landed. It changes slot 0's query,
 * the number of queries actually issued, and which of them carries
 * `sort=updated` — all three of the conditions this constant exists for. Without
 * the bump, a caller repeating the same idea+keywords+limit+auth for 24h was
 * served rows fetched under the pre-bilingual plan, so the new plan could not
 * run at all and the fix looked like it did nothing.
 *
 * Bumped 2 -> 3 when the long-CJK-run fallback and the channel-fused pool landed.
 * Both change WHICH repositories come back for a given idea:
 *
 *  - `buildQueries` may now emit an extra query when the precise query ANDs a
 *    LONG CJK run with a further term. Measured (`scripts/probes/a2.mjs`): the 11-character
 *    run 一个本地优先的笔记应用 returns 15 matches alone but 0 in any conjunction,
 *    quoted or unquoted, and as the plan's only query it made the pool empty no
 *    matter how rows were merged. So the run is issued on its own, first.
 *  - `selectPool` merges per-query channels by reciprocal-rank fusion with a
 *    per-channel quota instead of star-descending truncation. Measured on a
 *    blind-judged A/B: on-topic rate 43%/47%/47% -> 70%/60%/63%, pure noise
 *    11/6/10 rows -> 5/2/3, while a 37,411-star anchor that plain fusion had
 *    dropped is retained by the quota.
 *
 * The second change is the reason the bump is not optional: for an unchanged
 * idea+keywords+limit+auth, the new code returns a materially different set of
 * repositories than the old code did, and the cache cannot tell the two apart on
 * its own.
 *
 * Bumped 3 -> 4 when the long-CJK-run fallback began REPLACING the precise query
 * instead of being prepended to it. This lowers the query count for exactly the
 * plans that were already the weakest ones:
 *
 *  - for idea `一个本地优先的待办事项管理工具` the plan went from 2 queries to 1. The
 *    dropped query was the quoted long run, measured at total_count 0 in every
 *    run, while the surviving bare run returned 13 rows. The channel was therefore
 *    empty, and `scripts/probes/a2-pool.mjs` showed the consequence: with only one
 *    non-empty channel, RRF had nothing to fuse and `CHANNEL_QUOTA` could not
 *    promote anything, so the two on-topic rows (2 and 0 stars) entered the pool
 *    solely through the <=100-star tail guard, at positions 12 and 13 of 13.
 *
 * Fewer queries is not automatically a worse plan for the cache's purposes — it is
 * simply a different one, and the number of queries issued is one of the three
 * conditions this constant exists to track. The 15-and-30-request budgets are the
 * same either way; what changed is which rows come back for an unchanged idea.
 *
 * Bumped 4 -> 5 when the CJK->English seed channels landed (`lexicon.ts`). This is
 * the largest change of the five: for a Chinese idea the plan's first two slots are
 * now English queries that did not exist before, and slot 0 is no longer a Chinese
 * query at all.
 *
 *  - Measured end to end (`scripts/probes/e2e-fix.mjs`, pool size 20, four Chinese ideas):
 *    named field projects in the pool went 0/15, 0/20, 0/18, 0/13 -> 7/20, 7/20,
 *    8/20, 7/20, and the junk cluster (book lists, political-document mirrors) fell
 *    from 8-9 rows per pool to 2. The anchors reached are siyuan (46,705 stars),
 *    logseq (45,193), Trilium (38,265), foam (17,441), dendron (7,468),
 *    super-productivity (22,694).
 *  - So for the SAME idea+keywords+limit+auth, versions 4 and 5 disagree on almost
 *    every row. A cache written under 4 and replayed under 5 would not merely be
 *    stale, it would look like the fix had done nothing — the exact failure mode
 *    that made the 1 -> 2 bump mandatory.
 *
 * Bumped 5 -> 6 when plan slots gained ROLES and were assembled by role instead of
 * by array position. The old assembly was
 * `[...englishChannels, ...queries].slice(0, MAX_QUERIES)`, which chose the
 * surviving slots by array index; it is now `ensureRoles(...)`, which guarantees one
 * slot per role (anchor, precise, tail). Every one of the eight frozen cases changed
 * its plan, and most changed which queries are issued at all:
 *
 *  - `notes-zh` previously spent two slots on `local-first note-taking` (once each
 *    way, `stars` and `updated`) and dropped `note-taking bidirectional` entirely.
 *    It now issues that constraint channel. Different queries, not a reordering.
 *  - `expense-zh` previously issued `personal finance` twice with no `sort=updated`
 *    channel at all, i.e. no way to reach a small project. It now has a real tail.
 *  - `rss-en` / `db-migrate-en` / `api-mock-en` moved their anchor to slot 0. Their
 *    old slot 0 was the precise query, measured at `total_count` 0 / 3 / 16 — a
 *    channel too narrow to contain an anchor (logseq, siyuan, AFFiNE).
 *
 * A plan's SHAPE is one of the three conditions this constant tracks (which queries
 * are issued, how many, and in which order), and that shape changed for 8/8 cases.
 * Without this bump, `.probe-*` and `eval/` runs made under role-labelled assembly
 * would be served rows gathered under positional assembly for the whole 24h TTL — * the same silent-wrong-answer failure the 1 -> 2 bump existed to stop.
 *
 * Bumped 6 -> 7 for conditional bilingual routing. With a total lexicon miss and
 * English keywords, the English broad query is now the anchor and the Chinese
 * query is precise. The queries often stay the same, but their order changes
 * pool selection, so results gathered under plan 6 must not satisfy plan 7.
 * The cache envelope and source-inspection keys do not change.
 *
 * Note that a bump is never the risky direction. Invalidating cache costs one
 * re-fetch per distinct idea; failing to invalidate serves wrong rows as if they
 * were right, and does so silently for the full 24h TTL.
 */
export const SEARCH_PLAN_VERSION = 7

/**
 * Cache key for one concrete search.
 *
 * The key MUST cover every input that changes what gets fetched. Keying on the
 * idea alone was a real defect: `keywords` altered the GitHub query but not the
 * slot, so a later call with better keywords replayed the earlier stale result
 * and reported `cached: true`. `limit` is included because a 20-row fetch and a
 * 5-row fetch are genuinely different result sets.
 *
 * `authenticated` is the third such input, and the least visible one. GitHub
 * throttles anonymous callers by silently returning a SMALLER result set — not
 * by failing. Measured: the same query returned 30 rows (`total_count: 30`) on
 * one run and `HTTP 403 rate limit exceeded` on another, and a third run
 * returned a plausible-looking 2 rows. Without this dimension, an anonymous
 * thin result written to cache is then replayed to an authenticated caller for
 * the full 24h TTL, with no `degraded` marker to reveal it — the user simply
 * concludes the field is emptier than it is. That lands hardest on first-time
 * users, who have no token yet.
 *
 * A boolean is enough: the failure being prevented is "thin anonymous result
 * replayed as complete". Rotating between two tokens is not a correctness
 * problem, so the key deliberately does not identify WHICH token.
 *
 * `plan` is the fourth: the derived query plan, versioned by
 * {@link SEARCH_PLAN_VERSION}, so a code change to how queries are built cannot
 * serve rows gathered under the old plan.
 *
 * @param idea - raw user idea text.
 * @param keywords - optional extra search terms.
 * @param limit - requested candidate count.
 * @param authenticated - whether a GitHub token was available for this call.
 * @param plan - version of the query plan that will run; defaults to the current one.
 * @returns normalized composite key.
 */
export function searchCacheKeyFor(
  idea: string,
  keywords: string | undefined,
  limit: number,
  authenticated = false,
  plan: number = SEARCH_PLAN_VERSION,
): CacheKey {
  const kw = keywords === undefined ? '' : normalizeFragment(keywords)
  return `${cacheKeyFor(idea)}|kw:${kw}|n:${limit}|auth:${authenticated ? 1 : 0}|p:${plan}`
}
