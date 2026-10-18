/**
 * GitHub search over public repositories.
 *
 * GitHub's **search** endpoint allows only 10 requests/minute per public IP when
 * unauthenticated, and that quota is shared by every host behind the same egress
 * IP (carrier CGNAT in practice), so this call fails intermittently with a bare
 * `HTTP 403` for reasons the user cannot control. This module therefore:
 *
 *  1. sends an optional bearer token — authenticated search allows 30 req/min
 *     and is account-scoped, so it is immune to shared-IP exhaustion;
 *  2. treats 403/429 as rate limiting: retries once (honouring `retry-after`),
 *     then throws {@link GitHubSearchRateLimited} carrying `limit` /
 *     `remaining` / `resetAt` so the caller can degrade instead of failing;
 *  3. retries once on network errors too (one retry budget per call, shared
 *     with the rate-limit path; a caller-cancelled request is never retried);
 *  4. caches failures for a minute so a retry loop cannot keep burning quota.
 */

import type { RepoCandidate } from './types.ts'

/**
 * One query's outcome, kept together with the query that produced it.
 *
 * The failure message used to be a bare string built here and re-parsed by the
 * caller: `describePartialFailure` decided whether the LONG TAIL was lost by
 * testing `failure.includes('sort=updated')`. That coupled a message's wording
 * to logic in another module — reword the message and the warning silently stops
 * firing, with no test able to catch it because both halves "work".
 *
 * The role is the fact the caller actually needs, so it travels as a field.
 * `role` is absent for callers that build channels by hand (the eval harness, the
 * probes), and absent means "unknown", never "no tail".
 */
export interface QueryFailure {
  /** The query text that failed, as issued. */
  query: string
  /** The ordering that was asked for. */
  sort: 'stars' | 'updated'
  /** The plan role of the slot that failed, when the plan said. */
  role?: QueryRole
  /** The transport error message. */
  message: string
}

/**
 * The role a plan slot plays. Declared here rather than imported from `query.ts`
 * so that `github.ts` does not depend on the planner: the fetch layer only needs
 * the NAME, and a structural copy keeps the two modules independently testable.
 */
export type QueryRole = 'anchor' | 'precise' | 'tail'

/**
 * Star ceiling that defines the "long tail".
 *
 * 100 is deliberately generous rather than a quality judgement: the projects the
 * user wanted to see in the original run were `moonstone` (0), `nexa-notes-v2`
 * (0), `deckle` (1) and `driftpad` (0), so anything at or below this is exactly
 * the population that was structurally unreachable before.
 */
export const TAIL_STAR_CEILING = 100

/**
 * How many of the returned slots the long tail may occupy.
 *
 * Fixed at 8 per the user's decision (m00999): enough that a small on-point
 * project reliably reaches the card, small enough that 22 anchor slots survive.
 */
export const TAIL_RESERVED_SLOTS = 8

/**
 * How many of these rows sit at or below {@link TAIL_STAR_CEILING} (§7.6/AC12).
 *
 * One definition, two call sites that must not drift: the POOL side
 * (`selectPool` in this module, where the pool still exists as a pool) and the
 * FINAL-LIST side (`rank_candidates` in `index.ts`, after the card's own
 * truncation). The measurement §7.6 asks for is the DIFFERENCE between the two
 * counts, so a second, subtly different threshold rule would silently change
 * the answer while still producing two plausible numbers.
 */
export const countLowStar = (rows: RepoCandidate[]): number =>
  rows.filter((row) => row.stars <= TAIL_STAR_CEILING).length

/** Rate-limit details lifted off a failed response, for degradation messages. */
export interface GitHubRateLimitInfo {
  status: number
  limit?: number
  remaining?: number
  resetAt?: string
  retryAfter?: number
}

export interface AuthOptions {
  /** GitHub PAT. Without it the anonymous 10 req/min/IP quota applies. */
  token?: string
  /** Caller cancellation, merged with the per-attempt timeout. */
  signal?: AbortSignal
  /**
   * Absolute wall-clock instant by which every request must be finished.
   *
   * A caller that has a hard ceiling above it (the host kills `inspect_projects`
   * at 60000ms and returns no partial payload) passes one so that no single
   * request can eat the whole budget. Without it, one request that times out and
   * retries costs 8000 + 3000 + 8000 = 19000ms -- about 45x a healthy one -- and
   * only three such requests out of fifty are enough to breach a 60s ceiling.
   * With it, the per-attempt timeout is capped by the time actually left, so the
   * batch fails loudly and early instead of being killed silently and late.
   */
  deadline?: number
  /**
   * Called once per HTTP attempt that is actually sent, including retries.
   *
   * Exists so a caller can report how many requests it really spent instead of
   * how many it hoped to spend. `inspect_projects` used to derive its
   * `requests_used` field from the per-repo budget constant, which answers a
   * different question: it counts what the batch was *allowed* to send, so a
   * repository served entirely from a cache still "cost" 6, and the two retry
   * paths cost 0. Counting here instead makes the number the caller reports and
   * the number GitHub sees the same number.
   */
  onRequest?: () => void
}

/** Options accepted by the raw request helper (auth only). */
export type RequestOptions = AuthOptions

export interface SearchOptions extends AuthOptions {
  /**
   * Which dimension GitHub should order by.
   *
   * `stars` (the default) surfaces the established projects — the field anchors
   * an idea should be compared against. `updated` surfaces the opposite end of
   * the same result set: on the query `markdown notes`, `sort=stars` returned
   * 30 repos spanning 2,528–73,328 stars with **zero** under 100, while
   * `sort=updated` on the identical query returned 30 repos spanning 0–566
   * stars with **28** under 100. Both were drawn from the same population
   * (`total_count: 14388`); only the ordering differed.
   *
   * The long tail is not noise. A one-person project with 2 stars is often
   * closer to a specific idea than a 70k-star general-purpose suite, and it is
   * far cheaper to read — which is exactly what "borrow-worthiness" means.
   */
  sort?: 'stars' | 'updated'
}

/** Thrown when GitHub reports rate limiting, so callers can degrade. */
export class GitHubSearchRateLimited extends Error {
  readonly info: GitHubRateLimitInfo

  constructor(message: string, info: GitHubRateLimitInfo) {
    super(message)
    this.name = 'GitHubSearchRateLimited'
    this.info = info
  }
}

/** Proxy variables Node's fetch reads only when the host process opted in. */
const PROXY_ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const

/** Truthy spelling of `NODE_USE_ENV_PROXY`; anything else (including `0`) is off. */
function envProxyOptedIn(): boolean {
  const raw = (process.env.NODE_USE_ENV_PROXY ?? '').trim().toLowerCase()
  return raw !== '' && raw !== '0' && raw !== 'false'
}

/**
 * Name the real reason a request failed. Node reports every transport failure
 * as the same `fetch failed` and hides the actionable part — DNS, refused
 * connection, certificate, TLS — one level down in `cause`, so the chain is
 * what a reader (and a bug report) actually needs.
 *
 * @param error - the thrown value.
 * @returns `message (code) → cause` as far as the chain goes, never empty.
 */
export function describeFailure(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code
    const label = typeof code === 'string' && code.length > 0 && !current.message.includes(code)
      ? `${current.message} (${code})`
      : current.message
    if (label.length > 0 && !parts.includes(label)) parts.push(label)
    current = (current as { cause?: unknown }).cause
  }
  return parts.length === 0 ? String(error) : parts.join(' → ')
}

/**
 * One sentence for the trap behind most "fetch failed" reports: a system proxy
 * (VPN accelerators, corporate MITM) is invisible to Node's fetch unless the
 * host process was started with `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` — * a browser has no such rule, which is why GitHub opens fine and this fails.
 *
 * @returns the sentence, or an empty string when no proxy is configured.
 */
export function proxyHint(): string {
  if (envProxyOptedIn()) return ''
  const configured = PROXY_ENV_VARS.filter(name => (process.env[name] ?? '').trim().length > 0)
  if (configured.length === 0) return ''
  return `${configured.join('/')} is set, but Node's fetch ignores proxy environment variables unless DSH itself ` +
    'was started with NODE_USE_ENV_PROXY=1 (or --use-env-proxy); without that, requests from DSH bypass the proxy.'
}

const TIMEOUT_MS = 8000
const RETRY_DELAY_MS = 1500
const MAX_RETRY_DELAY_MS = 3000
/**
 * Smallest slice of the deadline worth starting an attempt with.
 *
 * A retry is only started when at least `RETRY_DELAY_MS + RETRY_FLOOR_MS`
 * remains, so an attempt never begins with a timeout so short that it is
 * guaranteed to fail and produce a misleading error.
 */
const RETRY_FLOOR_MS = 1000

function rateLimitInfo(res: Response): GitHubRateLimitInfo {
  const num = (key: string): number | undefined => {
    const raw = res.headers.get(key)
    if (raw === null) return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }
  const reset = num('x-ratelimit-reset')
  return {
    status: res.status,
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    resetAt: reset === undefined ? undefined : new Date(reset * 1000).toISOString(),
    retryAfter: num('retry-after'),
  }
}

function describe(info: GitHubRateLimitInfo, authenticated: boolean): string {
  return [
    `limit=${info.limit ?? '?'}`,
    `remaining=${info.remaining ?? '?'}`,
    info.resetAt === undefined ? undefined : `resetAt=${info.resetAt}`,
    authenticated ? 'token=set' : 'token=none',
  ].filter((part): part is string => part !== undefined).join(' ')
}

/**
 * Result of one search call, including the quota state GitHub reported.
 *
 * The quota observation is not decoration. A live run returned 2 candidates for
 * a query GitHub itself reported as `total_count: 30`, and the card could not
 * tell that apart from "this query genuinely has 2 matches" — the anonymous
 * 10 req/min budget had simply been spent by another process on the same egress
 * IP. Exposing `remaining` is what makes that case reportable instead of silent.
 */
export interface SearchOutcome {
  /** Normalized candidates, at most `limit`. */
  candidates: RepoCandidate[]
  /** `x-ratelimit-remaining` from the final response, when GitHub sent it. */
  remaining?: number
  /** `x-ratelimit-limit` from the final response, when GitHub sent it. */
  limit?: number
  /**
   * `x-ratelimit-reset` from the final response as an ISO timestamp, when GitHub
   * sent it.
   *
   * Carried alongside `remaining` because the two buckets behind these headers
   * refill on different clocks: the search bucket resets every minute, the core
   * bucket hourly. A reader given only `remaining: 0` cannot tell a 40-second
   * wait from a 40-minute one, and a message that assumed the hourly window
   * would overstate the search wait by roughly 60x.
   */
  resetAt?: string
  /** What GitHub reported as `total_count` — the true match count, not the page size. */
  totalCount?: number
}

/** Live quota state for one resource, as `/rate_limit` reports it. */
export interface QuotaState {
  /** Requests still allowed in this window. */
  remaining: number
  /** Window size. */
  limit: number
  /** ISO timestamp when the window resets. */
  resetAt: string
  /** Seconds until reset. */
  resetInSeconds: number
}

/**
 * Read the live core quota before committing to a batch of reads.
 *
 * The static 10 req/min assumption in `INSPECT_BUDGET` is a floor, not the
 * truth: the same egress IP is shared with every other process, so core quota
 * can already be at 0 while the caller's own arithmetic says the batch fits.
 * Checking first turns a mid-batch 403 — which yields a *partial* reading that
 * looks complete — into an up-front refusal with the real wait time.
 *
 * `/rate_limit` itself does not consume quota, so this probe is free.
 *
 * @param options - token and cancellation.
 * @returns live core quota, or `undefined` when it could not be determined.
 */
export async function getCoreQuota(options: RequestOptions = {}): Promise<QuotaState | undefined> {
  try {
    const { body } = await requestJson('/rate_limit', options)
    const payload = body as { resources?: { core?: { remaining?: unknown; limit?: unknown; reset?: unknown } } }
    const core = payload.resources?.core
    if (core === undefined) return undefined
    const remaining = Number(core.remaining)
    const limit = Number(core.limit)
    const reset = Number(core.reset)
    if (!Number.isFinite(remaining) || !Number.isFinite(limit) || !Number.isFinite(reset)) return undefined
    const resetInSeconds = Math.max(0, reset - Math.floor(Date.now() / 1000))
    return {
      remaining,
      limit,
      resetAt: new Date(reset * 1000).toISOString(),
      resetInSeconds,
    }
  } catch {
    // A failed probe must never block the call: fall back to the static budget.
    return undefined
  }
}

/**
 * One authenticated GET against the GitHub API, with the retry and quota rules
 * applied uniformly.
 *
 * Every endpoint P2 needs — `readme`, `git/trees`, `contents` — must obey the
 * same rules as `search/repositories`: 8s timeout, one retry after a transient
 * transport failure, one retry after a 403/429 that honours `retry-after`, and a
 * `GitHubSearchRateLimited` error the caller can degrade on. Inlining that four
 * times would mean four places to fix when one rule changes, so it lives here
 * and the four callers share it.
 *
 * The `path` is interpolated into the URL by the caller; callers are responsible
 * for encoding owner/repo segments (see {@link repoPath}).
 *
 * @param path - API path beginning with `/`, e.g. `/repos/o/r/readme`.
 * @param options - token and cancellation.
 * @returns the parsed JSON body plus the quota counters GitHub reported.
 * @throws {GitHubSearchRateLimited} when GitHub reports rate limiting.
 */
async function requestJson(
  path: string,
  options: RequestOptions = {},
): Promise<{ body: unknown; remaining?: number; limit?: number; resetAt?: string }> {
  const token = typeof options.token === 'string' && options.token.length > 0 ? options.token : undefined
  const callerSignal = options.signal
  const url = `https://api.github.com${path}`
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-find-ideas',
  }
  if (token !== undefined) headers.authorization = `Bearer ${token}`

  // The per-attempt timeout is capped by the time left before the caller's
  // deadline. `remainingMs()` returns undefined when there is no deadline, which
  // keeps the old behaviour for every caller that does not set one.
  const remainingMs = (): number | undefined =>
    options.deadline === undefined ? undefined : options.deadline - Date.now()
  const signalFor = (): AbortSignal => {
    const left = remainingMs()
    // Floor at 1ms: AbortSignal.timeout(0) and negative values throw a
    // RangeError, and "no time left" must mean "fail fast", not "throw here".
    const budget = left === undefined ? TIMEOUT_MS : Math.max(1, Math.min(TIMEOUT_MS, left))
    const timeout = AbortSignal.timeout(budget)
    return callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout])
  }

  let attempt = 0
  for (;;) {
    let res: Response
    try {
      // Counted here rather than at the call sites: this is the one place a
      // request is actually put on the wire, so a retry and an initial attempt
      // are counted alike, and a path that is never reached is counted never.
      options.onRequest?.()
      res = await fetch(url, { headers, signal: signalFor() })
    } catch (error) {
      // A retry is only worth starting when the deadline leaves room for another
      // attempt plus the delay before it. Retrying with no time left just burns
      // the budget and then reports the same failure.
      const left = remainingMs()
      const canRetry = left === undefined || left > RETRY_DELAY_MS + RETRY_FLOOR_MS
      if (attempt === 0 && callerSignal?.aborted !== true && canRetry) {
        attempt += 1
        await new Promise(resolvePromise => setTimeout(resolvePromise, RETRY_DELAY_MS))
        continue
      }
      const hint = proxyHint()
      const expired = left !== undefined && left <= 0
      throw new Error(
        `GitHub request failed: ${describeFailure(error)}` +
        (expired ? ' (deadline for this call has passed)' : '') +
        (hint === '' ? '' : `. ${hint}`),
      )
    }

    if (res.ok) {
      const quota = rateLimitInfo(res)
      let body: unknown
      try {
        body = await res.json()
      } catch (error) {
        throw new Error(`GitHub returned a non-JSON body for ${path}: ${describeFailure(error)}`)
      }
      return { body, remaining: quota.remaining, limit: quota.limit, resetAt: quota.resetAt }
    }

    const info = rateLimitInfo(res)
    const limited = res.status === 403 || res.status === 429
    // Same rule for the rate-limit retry: it must fit in what is left.
    const left = remainingMs()
    const canRetry = left === undefined || left > RETRY_DELAY_MS + RETRY_FLOOR_MS
    if (limited && attempt === 0 && canRetry) {
      attempt += 1
      const delay = info.retryAfter === undefined
        ? RETRY_DELAY_MS
        : Math.min(info.retryAfter * 1000, MAX_RETRY_DELAY_MS)
      await new Promise(resolvePromise => setTimeout(resolvePromise, delay))
      continue
    }

    const detail = describe(info, token !== undefined)
    if (limited) {
      throw new GitHubSearchRateLimited(
        `GitHub rate limited (HTTP ${res.status}; ${detail}). ` +
          'Anonymous access allows 10 req/min per public IP and that quota is shared by every host ' +
          'behind the same egress IP; an authenticated GITHUB_TOKEN raises it to 30 req/min and is ' +
          'account-scoped.',
        info,
      )
    }
    throw new Error(`GitHub HTTP ${res.status} for ${path}${detail === '' ? '' : ` (${detail})`}`)
  }
}

/**
 * Maximum characters of a description kept in the cache.
 *
 * GitHub does not bound `description`, and repositories abuse it: the worst one
 * seen in the field is 241,896 characters. Only 74 of 817 candidates (9%)
 * exceeded this cap, yet those 74 accounted for 97% of the cache's 10.9 MB —
 * so this is a free cap on real input, exactly like the render budget.
 *
 * 512 is chosen over the render budget (200) deliberately. The two are separate
 * knobs: 200 decides what the model sees, 512 decides what is stored and what
 * `similarity()` and `SUSPICION_QUOTE_CHARS` score against. Capping storage at
 * the display budget would silently shorten the evidence chain and shift the
 * bigram similarity of mid-length descriptions. 512 sits at the point where the
 * long tail is gone but scoring input is untouched.
 */
const MAX_STORED_DESCRIPTION_CHARS = 512

/**
 * Cap a description for STORAGE.
 *
 * Truncation only — whitespace is never folded here. `clipDescription` folds at
 * render time, and folding earlier would change the input to `similarity()`,
 * breaking the guarantee that candidates under the cap score exactly as before.
 * No ellipsis or length marker is appended either: the stored value is data,
 * not display copy, and a marker would both eat the budget and get re-marked by
 * the render layer.
 *
 * @param raw - description as returned by GitHub, possibly adversarial.
 * @returns the description, at most `MAX_STORED_DESCRIPTION_CHARS` characters.
 */
function storedDescription(raw: string): string {
  return raw.length > MAX_STORED_DESCRIPTION_CHARS ? raw.slice(0, MAX_STORED_DESCRIPTION_CHARS) : raw
}

/** Map one raw search-API item into the normalized candidate shape. */
function toCandidate(item: Record<string, unknown>): RepoCandidate {
  const owner = item.owner as Record<string, unknown> | undefined
  const topics = Array.isArray(item.topics) ? item.topics.map(String) : []
  return {
    full_name: String(item.full_name ?? ''),
    url: String(item.html_url ?? ''),
    owner: String(owner?.login ?? ''),
    name: String(item.name ?? ''),
    description: storedDescription(String(item.description ?? '')),
    stars: Number(item.stargazers_count ?? 0),
    language: String(item.language ?? ''),
    pushed_at: String(item.pushed_at ?? ''),
    archived: item.archived === true,
    topics,
  }
}

/**
 * Search public repositories.
 *
 * `sort=stars` is requested deliberately: star count is the coarse first pass,
 * and pulling the most-starred matches gives the LLM a candidate set worth
 * scoring. The fine ranking happens in `rank_candidates`
 * (`relevance × (1 + log10(max(stars, 10) + 1)) / 2`), so this endpoint's ordering is not
 * the final ordering.
 *
 * @param query - free-text query, already phrased for GitHub.
 * @param limit - maximum candidates to return.
 * @param options - token and cancellation.
 * @returns candidates plus the quota counters GitHub reported.
 * @throws {GitHubSearchRateLimited} when GitHub reports rate limiting.
 */
export async function searchRepositories(
  query: string,
  limit: number,
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const q = encodeURIComponent(query)
  const perPage = Math.max(1, Math.min(limit, 100))
  const sort = options.sort === 'updated' ? 'updated' : 'stars'
  const { body, remaining, limit: quotaLimit, resetAt } = await requestJson(
    `/search/repositories?q=${q}&sort=${sort}&order=desc&per_page=${perPage}`,
    options,
  )
  const payload = body as { items?: Array<Record<string, unknown>>; total_count?: unknown }
  const total = Number(payload.total_count)
  return {
    candidates: (payload.items ?? []).map(toCandidate).slice(0, limit),
    remaining,
    limit: quotaLimit,
    resetAt,
    totalCount: Number.isFinite(total) ? total : undefined,
  }
}

/** Encode a `owner/repo` pair for use in an API path. */
export function repoPath(fullName: string): string {
  const [owner, name] = fullName.split('/')
  return `${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`
}

/** What the README endpoint gave back, or a reason it did not. */
export interface ReadmeResult {
  /** Decoded README text, truncated to `maxChars`. Empty when unavailable. */
  text: string
  /** True when the README was cut short by `maxChars`. */
  truncated: boolean
  /** Why the README is missing, when `text` is empty. */
  error?: string
}

/**
 * Fetch a repository's README as text.
 *
 * This is the single highest-value read for judging borrow-worthiness: a
 * repository description is at most a sentence, while the README states what the
 * project does, what stack it uses and how it is structured. P2 exists mainly
 * because low-star repos — the ones P3 now surfaces — often have an empty or
 * one-line description, leaving the README as the only available evidence.
 *
 * @param fullName - `owner/repo`.
 * @param maxChars - truncation budget; READMEs are routinely 50k+ characters.
 * @param options - token and cancellation.
 * @returns decoded text plus a truncation flag, or an `error` explaining absence.
 */
export async function getReadme(
  fullName: string,
  maxChars: number,
  options: RequestOptions = {},
): Promise<ReadmeResult> {
  try {
    const { body } = await requestJson(`/repos/${repoPath(fullName)}/readme`, options)
    const payload = body as { content?: unknown; encoding?: unknown; size?: unknown }
    const raw = typeof payload.content === 'string' ? payload.content : ''
    if (raw.length === 0) return { text: '', truncated: false, error: 'README 没有正文内容' }
    // GitHub returns base64 with embedded newlines; Buffer tolerates them, but
    // the encoding field is honoured in case that ever changes.
    const encoding = typeof payload.encoding === 'string' ? payload.encoding : 'base64'
    const decoded = encoding === 'base64'
      ? Buffer.from(raw, 'base64').toString('utf8')
      : raw
    const clipped = decoded.slice(0, Math.max(0, maxChars))
    return { text: clipped, truncated: decoded.length > clipped.length }
  } catch (error) {
    if (error instanceof GitHubSearchRateLimited) throw error
    return { text: '', truncated: false, error: describeFailure(error) }
  }
}

/** A file entry from the repository tree. */
export interface TreeEntry {
  path: string
  type: string
  size?: number
}

/**
 * List a repository's file tree at one depth.
 *
 * Used to pick which files are worth reading without guessing at names: the
 * ranking of "which files explain this project's architecture" is far more
 * reliable when made over the real tree than over a hardcoded guess list.
 *
 * @param fullName - `owner/repo`.
 * @param maxEntries - cap on returned entries, to bound the token cost.
 * @param options - token and cancellation, plus an optional branch.
 * @returns entries (`path`, `type`, `size`), or an empty list with an `error`.
 */
export async function getTree(
  fullName: string,
  maxEntries: number,
  options: RequestOptions & { branch?: string } = {},
): Promise<{ entries: TreeEntry[]; error?: string; truncated: boolean }> {
  const ref = options.branch === undefined || options.branch.length === 0 ? 'HEAD' : encodeURIComponent(options.branch)
  try {
    const { body } = await requestJson(`/repos/${repoPath(fullName)}/git/trees/${ref}?recursive=1`, options)
    const payload = body as { tree?: Array<Record<string, unknown>>; truncated?: unknown }
    const all = (payload.tree ?? []).map((item) => {
      const size = Number(item.size)
      return {
        path: String(item.path ?? ''),
        type: String(item.type ?? ''),
        size: Number.isFinite(size) ? size : undefined,
      }
    })
    const cap = Math.max(1, Math.floor(maxEntries))
    return { entries: all.slice(0, cap), truncated: payload.truncated === true || all.length > cap }
  } catch (error) {
    if (error instanceof GitHubSearchRateLimited) throw error
    return { entries: [], error: describeFailure(error), truncated: false }
  }
}

/**
 * Fetch one file's text.
 *
 * @param fullName - `owner/repo`.
 * @param path - repository-relative path, e.g. `src/index.ts`.
 * @param maxChars - truncation budget per file.
 * @param options - token and cancellation, plus an optional branch.
 * @returns file text, or an empty string with an `error`.
 */
export async function getFileContent(
  fullName: string,
  path: string,
  maxChars: number,
  options: RequestOptions & { branch?: string } = {},
): Promise<{ text: string; truncated: boolean; error?: string }> {
  const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const ref = options.branch === undefined || options.branch.length === 0 ? '' : `?ref=${encodeURIComponent(options.branch)}`
  try {
    const { body } = await requestJson(`/repos/${repoPath(fullName)}/contents/${encodedPath}${ref}`, options)
    const payload = body as { content?: unknown; encoding?: unknown; type?: unknown }
    if (payload.type === 'dir') return { text: '', truncated: false, error: '这是一个目录，不是文件' }
    const raw = typeof payload.content === 'string' ? payload.content : ''
    if (raw.length === 0) return { text: '', truncated: false, error: '文件没有正文内容' }
    const encoding = typeof payload.encoding === 'string' ? payload.encoding : 'base64'
    const decoded = encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw
    const clipped = decoded.slice(0, Math.max(0, maxChars))
    return { text: clipped, truncated: decoded.length > clipped.length }
  } catch (error) {
    if (error instanceof GitHubSearchRateLimited) throw error
    return { text: '', truncated: false, error: describeFailure(error) }
  }
}

/**
 * Reciprocal-rank-fusion constant, from the original RRF paper.
 *
 * 60 damps the weight of rank position: at rank 0 a row scores 1/61, at rank 29
 * it scores 1/90 — a factor of 1.48 rather than the 30x a raw reciprocal would
 * give. That flatness is the point: it lets a row that is rank 3 in THREE
 * channels outrank a row that is rank 0 in one, which is what makes agreement
 * across the language channels matter more than head position in any single one.
 *
 * Left un-tuned on purpose. The A/B probes ran at 60 only, so any other value
 * would be a guess dressed as a measurement.
 */
export const RRF_K = 60

/**
 * How many rows each query may force into the pool regardless of star count.
 *
 * This is the fix for a measured failure that RRF alone made WORSE. On the idea
 * "self-hosted RSS reader with full-text search and offline reading", global RRF
 * replaced the 37,411-star field anchor `glanceapp/glance` with a 488-star repo,
 * because RRF ranks by agreement across queries and a niche query's entire result
 * list is "agreement". Per-channel quota restores it: `glance` is rank 0 in the
 * `self-hosted rss` channel, so it claims a seat before RRF orders anything.
 *
 * Two seats per channel, and at most 3 channels, bounds the quota at 6 of 30
 * slots — the other 24 still go to RRF order, so this narrows the fusion rather
 * than replacing it.
 */
export const CHANNEL_QUOTA = 2

/**
 * Rank one channel's rows by reciprocal rank, keeping the first occurrence.
 *
 * Duplicate `full_name` inside a single channel is possible and would double
 * that channel's weight for the row, so it is collapsed first.
 *
 * @param rows - one query's candidates, already in that query's own rank order.
 * @returns score and rank per unique repo, keyed by lowercase `full_name`.
 */
function rankChannel(rows: RepoCandidate[]): Map<string, { score: number; row: RepoCandidate }> {
  const out = new Map<string, { score: number; row: RepoCandidate }>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined) continue
    const key = row.full_name.toLowerCase()
    if (out.has(key)) continue
    out.set(key, { score: 1 / (RRF_K + i + 1), row })
  }
  return out
}

/**
 * Run several queries and merge the results into one candidate list.
 *
 * One narrow query cannot fill a card. A live probe of the same query across
 * time returned 30 rows at `total_count: 30` and 2 rows minutes later, and
 * "markdown note bidirectional" (30 matches) misses the field's actual anchors
 * while the broad "markdown note" (15766 matches) surfaces memos, notable and
 * claude-obsidian at the top. Merging a precise query with broader ones is
 * therefore the difference between a 2-row card and a full one.
 *
 * Queries run **sequentially**, not in parallel: the anonymous budget is 10
 * requests per minute for the whole egress IP, so firing three at once makes a
 * rate-limited failure more likely, not less. A query that fails after the
 * first success is recorded in `failures` rather than thrown, because partial
 * results are still worth showing — the caller degrades with a note instead of
 * losing everything.
 *
 * @param queries - queries to run in order, most specific first.
 * @param limit - per-query page size.
 * @param options - token and cancellation.
 * @returns merged, de-duplicated candidates plus any per-query failures.
 * @throws {GitHubSearchRateLimited} only when the first query is rate limited
 *   and produced nothing, so the caller can report a clean quota failure.
 */
export async function searchMerged(
  plan: Array<{ query: string; sort: 'stars' | 'updated'; role?: QueryRole }>,
  limit: number,
  options: SearchOptions = {},
): Promise<{
  candidates: RepoCandidate[]
  failures: string[]
  /**
   * The same failures as structured records, so the caller can ask whether the
   * TAIL was lost without parsing a message string. `failures` is kept because
   * its wording is what the card shows; the two are built from the same loop and
   * cannot disagree.
   */
  failureDetails: QueryFailure[]
  remaining?: number
  totals: number[]
  tailIncluded: number
  /**
   * How many rows in the returned candidate list are at or below
   * `TAIL_STAR_CEILING` — the POOL side of §7.6 / AC12.
   *
   * Counted here, at the boundary where the list is produced, so the number has
   * one definition on both the cold and the replayed path. It is a pure function
   * of the returned rows (see `countLowStar`), which is why the cached path
   * recomputes it instead of storing it: `CachedSearch` holds only facts that
   * cannot be recovered from the rows, and this is not one of them.
   *
   * Deliberately NOT {@link tailIncluded}, which counts the seats the
   * reservation rule PAID for. The two diverge in the case that matters: an
   * all-small pool has every row below the ceiling while almost none of them
   * were seated by the reservation, so a single number would hide exactly the
   * loss this field exists to expose.
   *
   * The scoring formula is unchanged; this only makes the loss visible. The
   * FINAL-LIST counterpart is counted separately by the ranking layer, after its
   * own truncation, because the difference between the two counts IS the
   * measurement: a low-star row that is in the pool and absent from the ranked
   * card is precisely the long-tail loss §7.6 asks to see.
   */
  lowStarInPool: number
  /**
   * B6: solo `total_count` per distinct query term, keyed by the term exactly as
   * it appeared in the query. A term missing from this map was not probed or its
   * probe failed — absence means unknown, never zero.
   */
  termTotals: Map<string, number>
  /**
   * What happened to the B6 diagnostic probes — including when they did NOT run.
   *
   * Always present, because "no per-term counts on this card" has three
   * different meanings and the caller cannot tell them apart from the empty map
   * alone: the terms matched nothing, the guard skipped the probes to protect
   * the quota, or GitHub never reported the quota so no guard was possible.
   * Reporting only the map would let the first meaning be read into the other
   * two.
   */
  probe: ProbeReport
}> {
  const channels: RepoCandidate[][] = []
  const roles: (QueryRole | undefined)[] = []
  const failures: string[] = []
  const failureDetails: QueryFailure[] = []
  const totals: number[] = []
  /**
   * B6 (user m00929): per-term match counts, fetched alongside the real page.
   *
   * GitHub's `total_count` answers "how many repositories match this whole AND",
   * which is exactly the number that hides a dead term: the observed
   * `browser extension web page translation translate` returned 30 rows at a
   * large `total_count` because `browser extension` matched a huge population,
   * while `translate` contributed nothing. A card cannot distinguish "the query
   * fits 30 repos" from "one term dominates and the rest are decoration".
   *
   * Probing each term alone gives that distinction: a term whose solo count is
   * near the combined count adds almost no constraint, and a term whose solo
   * count is enormous is a platform word masquerading as a topic word.
   *
   * Cost: one request per term, run AFTER the plan and only when the first call
   * succeeded, because the anonymous budget is 10 requests/minute for the whole
   * egress IP. Bounded by {@link MAX_TERM_PROBES}, and a probe that fails is
   * simply absent from the map — a missing count is reported as unknown, never
   * as zero.
   */
  const termTotals = new Map<string, number>()
  let remaining: number | undefined
  // The SEARCH bucket's reset time, carried forward from the plan's own
  // responses. Kept alongside `remaining` because the guard needs to explain
  // WHEN the probes become possible again, and the search bucket refills every
  // minute — a message built from the core bucket's hourly clock would overstate
  // the wait by roughly 60x.
  let searchResetAt: string | undefined
  let firstError: unknown
  let firstSuccess = false

  for (const step of plan) {
    try {
      const outcome = await searchRepositories(step.query, limit, { ...options, sort: step.sort })
      if (outcome.remaining !== undefined) remaining = outcome.remaining
      if (outcome.resetAt !== undefined) searchResetAt = outcome.resetAt
      if (outcome.totalCount !== undefined) totals.push(outcome.totalCount)
      channels.push(outcome.candidates)
      // `roles` stays index-aligned with `channels`. An unknown role is recorded
      // as undefined rather than defaulted, because defaulting would invent a
      // fact about the plan — and T6's seat attribution depends on knowing the
      // difference between "this channel is not the tail" and "nobody said".
      roles.push(step.role)
      firstSuccess = true
    } catch (error) {
      if (!firstSuccess && firstError === undefined) firstError = error
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${step.query} (sort=${step.sort}): ${message}`)
      failureDetails.push({ query: step.query, sort: step.sort, role: step.role, message })
    }
  }

  if (channels.length === 0 && firstError !== undefined) throw firstError

  // B6: probe each distinct term on its own, after the plan has run. Deliberately
  // after, and deliberately aborted on the first rate-limit: the plan's rows are
  // the product, and a diagnostic must never cost the caller the search itself.
  //
  // `no_first_success` is reported rather than left implicit: when every query
  // failed there was nothing to probe, and that is a different statement from
  // "the probes were skipped to save quota". Both leave `termTotals` empty.
  const probe = firstSuccess
    ? await probeTermTotals(plan, termTotals, remaining, searchResetAt, options)
    : {
        skipped: 'no_first_success' as ProbeSkipReason,
        planned: 0,
        attempted: 0,
        ...(remaining === undefined ? {} : { searchRemaining: remaining }),
        ...(searchResetAt === undefined ? {} : { resetAt: searchResetAt }),
      }
  if (probe.searchRemaining !== undefined) remaining = probe.searchRemaining

  return {
    ...selectPool(channels, limit, roles),
    failures,
    failureDetails,
    remaining,
    totals,
    termTotals,
    probe,
  }
}

/**
 * How many terms get an individual match count.
 *
 * Three, matching the plan's own query budget: the plan has at most three
 * channels, so probing more terms than the plan itself uses would spend the
 * anonymous request budget on diagnostics for words that no query was built
 * from. The terms chosen are the longest, which are the most specific and
 * therefore the ones where "this term matched nothing" is most informative.
 */
export const MAX_TERM_PROBES = 3

/**
 * Requests held back from the probes so the caller's NEXT call can still run.
 *
 * The probes are diagnostics. They must never be the reason a real search
 * fails, so the guard below refuses to spend the last requests of the window on
 * them. One for the retry `requestJson` may need, one as a margin against
 * another process sharing the egress IP.
 */
export const PROBE_RETRY_RESERVE = 1
export const PROBE_SAFETY_MARGIN = 1

/** Why the diagnostic probes did not run. */
export type ProbeSkipReason =
  /** The search bucket was already at zero. */
  | 'search_quota_exhausted'
  /** The search bucket could not cover the probes plus the reserves. */
  | 'search_quota_low'
  /**
   * GitHub sent no usable search-bucket reading, so the guard could not judge.
   *
   * Distinct from the two reasons above, and distinct from "the probes ran": the
   * brief is that an unknown budget must not be assumed comfortable (which would
   * spend requests nobody counted) nor assumed empty (which would report a
   * shortfall nobody measured). Refusing to spend an unmeasured budget is the
   * only option that asserts neither.
   */
  | 'search_quota_unknown'
  /** No query succeeded, so there was nothing to probe. */
  | 'no_first_success'

/**
 * What happened to the diagnostic probes, reported whether or not they ran.
 *
 * This exists because "no probe counts on the card" has three different causes
 * that used to render identically: the terms genuinely matched nothing, the
 * probes were skipped to protect the quota, or GitHub never told us the quota
 * so no guard was possible. A reader who cannot tell those apart will read the
 * first as a fact about the repositories when it is a fact about the budget.
 */
export interface ProbeReport {
  /** Why the probes were skipped, or `null` when they ran or were not needed. */
  skipped: ProbeSkipReason | null
  /** How many probes the plan called for, bounded by `MAX_TERM_PROBES`. */
  planned: number
  /** How many probes actually went on the wire. */
  attempted: number
  /**
   * The SEARCH-bucket `remaining` GitHub last reported, if it reported one.
   *
   * Absent means "not observed", never "zero". That distinction is the whole
   * point of the field: a reader must be able to tell an exhausted bucket (`0`)
   * from an unreadable one (absent), because the two call for different actions
   * and only the first is a fact about GitHub's accounting.
   */
  searchRemaining?: number
  /**
   * ISO reset time for the SEARCH bucket, when GitHub sent it.
   *
   * The search bucket refills every MINUTE, so this is what makes "wait for the
   * reset" a usable instruction instead of a wrong one. The core bucket's hourly
   * clock has nothing to do with it.
   */
  resetAt?: string
}

/**
 * Explain a probe outcome in the caller's language, or `''` when there is
 * nothing to explain.
 *
 * Empty means "the probes ran and their counts are on the card", so the caller
 * prints nothing extra. Every other case produces a sentence, because the
 * alternative — printing no diagnostic section at all — reads as "the probes
 * ran and found nothing", which is a claim about the repositories that the code
 * is not entitled to make when the truth is a claim about the budget.
 *
 * The reset wording uses the SEARCH bucket's own clock (per minute). The core
 * bucket refills hourly, and reusing that number here would tell the caller to
 * wait roughly 60x longer than necessary.
 */
export function describeProbeOutcome(probe: ProbeReport): string {
  const remaining = probe.searchRemaining === undefined ? '' : `（剩余 ${probe.searchRemaining} 次）`
  switch (probe.skipped) {
    case 'search_quota_exhausted':
      return (
        `本轮「每个词单独命中多少」的诊断探针被跳过：GitHub 搜索配额已用尽${remaining}。` +
        '搜索配额按分钟重置，稍后重试即可恢复。跳过是刻意的——诊断只是附加信息，' +
        '不该花掉你下一次真正检索所需的配额。'
      )
    case 'search_quota_low':
      return (
        `本轮「每个词单独命中多少」的诊断探针被跳过：搜索配额${remaining}不足以在预留重试余量后` +
        `跑完 ${probe.planned} 个探针。搜索配额按分钟重置，稍后重试即可恢复。`
      )
    case 'search_quota_unknown':
      return (
        '本轮「每个词单独命中多少」的诊断探针没有执行：GitHub 没有返回可用的搜索配额读数，' +
        '守卫无从判断余量，因此没有花掉一笔没人量过的配额。' +
        '这是「配额未知」，既不是「配额不足」，也不是「检索词命中为零」——' +
        '未列出的词是「未测」，稍后重试即可拿到诊断。'
      )
    case 'no_first_success':
      return '本轮没有任何查询成功，因此没有可供诊断的检索词——这不是「检索词命中为零」。'
    default:
      break
  }
  // The probes ran. One honest caveat remains: a partial run. The terms it did
  // not reach are unmeasured, and saying so is what keeps their absence from
  // reading as "matched nothing".
  const parts: string[] = []
  if (probe.attempted < probe.planned) {
    parts.push(`诊断探针只跑了 ${probe.attempted}/${probe.planned} 个，其余在首个失败后中止——未列出的词是「未测得」，不是零命中。`)
  }
  return parts.join('')
}

/**
 * What to say when the per-term diagnostic was never saved.
 *
 * A cache replay carries no probe counts, and the old card printed nothing —
 * indistinguishable from "every term was measured and none stood out". The
 * stored entry has no probe data, so the honest statement is that the diagnostic
 * was not saved, not that it came back clean.
 */
export function describeUnavailableProbeDiagnostic(): string {
  return '本次命中缓存：诊断未保存——逐词命中数的诊断结果未随缓存条目写入，因此下面没有「查询词覆盖」区块。这不代表检索词都有效。'
}

/**
 * Fetch a solo `total_count` for each of the longest distinct terms.
 *
 * Never throws: every failure mode here is a missing diagnostic, not a failed
 * search, so a probe that 403s, times out or returns nothing usable is recorded
 * by absence.
 *
 * The guard reads the SEARCH bucket, not the core bucket. Both are reported by
 * the same header name (`x-ratelimit-remaining`) but they are different budgets
 * on different clocks, and this function calls `/search/repositories`
 * ({@link searchRepositories}). Reading the core bucket here would compare a
 * per-minute search allowance against an hourly request allowance, and a token
 * would read as a licence to spend: it raises the CORE quota to 5000/h, while
 * the search quota these probes actually draw on only goes from 10/min to
 * 30/min. A token is therefore not an input to this guard at all — only the
 * search reading is. `remaining` below is carried forward from the plan's own
 * search responses, so it is already the search bucket and costs no extra
 * request to obtain.
 *
 * @param plan - the same plan that was searched, used for its query text.
 * @param into - map to fill, keyed by the term as it appears in the query.
 * @param remaining - SEARCH-bucket reading carried from the plan's last call.
 * @param resetAt - SEARCH-bucket reset time from the same response, if any.
 * @param options - token and cancellation.
 */
async function probeTermTotals(
  plan: Array<{ query: string; sort: 'stars' | 'updated'; role?: QueryRole }>,
  into: Map<string, number>,
  remaining: number | undefined,
  resetAt: string | undefined,
  options: SearchOptions,
): Promise<ProbeReport> {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const step of plan) {
    // Split on whitespace; quoted CJK runs stay whole, which is what makes a
    // probe for `"本地优先的"` comparable to the phrase the plan actually sent.
    for (const raw of step.query.split(/\s+/)) {
      const term = raw.trim()
      if (term.length === 0 || seen.has(term)) continue
      seen.add(term)
      terms.push(term)
    }
  }
  terms.sort((a, b) => b.length - a.length)
  const planned = Math.min(terms.length, MAX_TERM_PROBES)

  const report = (skipped: ProbeSkipReason | null, attempted: number, current: number | undefined): ProbeReport => ({
    skipped,
    planned,
    attempted,
    ...(current === undefined ? {} : { searchRemaining: current }),
    ...(resetAt === undefined ? {} : { resetAt }),
  })

  if (planned === 0) return report(null, 0, remaining)

  // The guard. Skipping is the correct outcome, not a failure: a card with no
  // diagnostic counts is honest, while a card that spent the caller's last
  // request on diagnostics has cost them the search they came for.
  //
  // Three outcomes, and the third is not a fallback for the first two. When
  // GitHub sends no reading the guard cannot judge, and an unjudged budget is
  // spent as if it were infinite — so it is not spent at all. The probes are
  // diagnostics; refusing them costs a footnote, while sending them can cost the
  // caller's next search. That asymmetry is why unknown skips rather than runs.
  if (remaining === undefined) return report('search_quota_unknown', 0, remaining)
  if (remaining <= 0) return report('search_quota_exhausted', 0, remaining)
  if (planned + PROBE_RETRY_RESERVE + PROBE_SAFETY_MARGIN > remaining) {
    return report('search_quota_low', 0, remaining)
  }

  let current = remaining
  let attempted = 0
  for (const term of terms.slice(0, MAX_TERM_PROBES)) {
    attempted += 1
    try {
      const outcome = await searchRepositories(term, 1, { ...options, sort: 'stars' })
      if (outcome.remaining !== undefined) current = outcome.remaining
      if (outcome.totalCount !== undefined) into.set(term, outcome.totalCount)
    } catch {
      // A diagnostic that cannot be fetched is absent, not zero. Returning early
      // also stops the probes from eating a quota the caller may still need for
      // the next scout_projects call.
      return report(null, attempted, current)
    }
  }
  return report(null, attempted, current)
}

/**
 * One fused row: the candidate, its summed reciprocal-rank score, and the set of
 * channel indices that contributed it.
 *
 * The named type exists because the inline `{ row; score }` shape was written out
 * three times and drifted the moment `sources` was added — the type predicate
 * still accepted the old shape, so the compiler rejected the new one.
 */
interface FusedEntry {
  row: RepoCandidate
  score: number
  /** Channel indices that ranked this row. Used by stage 3 to attribute seats. */
  sources: Set<number>
}

/**
 * Project a fused entry to the row the pool returns, carrying its channel count.
 *
 * This is the ONLY moment the count exists. `sources` lives on the fused entry,
 * and the projection to plain rows — which every caller downstream sees — is
 * exactly what used to discard it: the number was computed, used to attribute
 * tail seats, and then dropped on the same line that produced the card's rows.
 *
 * A row that two or three independent queries returned is stronger evidence than
 * one only a single query saw, and nothing in the rendered card let a reader tell
 * them apart. Attaching the count here means it survives into the cache and the
 * card, and it is attached on BOTH `selectPool` return paths rather than only the
 * stage-3 one, because a pool with no reserved seats is still a fused pool.
 *
 * @param entry - a fused row together with the channel indices that ranked it.
 * @returns the row, with `channels_hit` set to the number of those channels.
 */
function withChannelCount(entry: FusedEntry): RepoCandidate {
  return { ...entry.row, channels_hit: entry.sources.size }
}

/**
 * Build the final candidate pool from the per-query result channels.
 *
 * ## Why this is not a plain star sort
 *
 * Sorting every merged row by stars and slicing silently deletes the long tail.
 * Measured: merging three queries produced 59 unique repos of which 25 had ≤100
 * stars, and star ordering returned **zero** of them — the smallest survivor had
 * 2,528 stars. Star ordering can never reach the tail, and the fetch had already
 * paid for those rows.
 *
 * It is also the source of the "meaningless results" this plugin was reported
 * for. Star-descending order puts the largest generic suite at the top of every
 * list regardless of what it does, so an AI-memory layer (13,390★, an AI Office
 * suite (9,142★ and an HTML editor (9,056★ crowded out actual note apps. An
 * independent blind-judged A/B (three judges, 30 rows per strategy per case,
 * stars and strategy hidden) measured on-topic rate at 43%/47%/47% for star
 * ordering versus **70%/60%/63%** for this function, with pure noise falling
 * from 11/6/10 rows to 5/2/3.
 *
 * ## How it works, in three stages
 *
 * 1. **Channel quota.** Each query's top {@link CHANNEL_QUOTA} rows claim a seat
 *    unconditionally. Without this, fusion alone is a regression: global RRF
 *    pushed the 37,411★ `glanceapp/glance` out of the RSS pool in favour of a
 *    488★ repo, because a narrow query's whole list is "agreement". The quota is
 *    what keeps one channel's head from being erased by another's consensus.
 * 2. **Reciprocal rank fusion** over every channel, ordering the remaining seats.
 *    A repo appearing high in several channels outranks one that leads a single
 *    channel — which is how the Chinese half of the corpus, invisible to every
 *    Latin query, gets in at all.
 * 3. **Tail reservation**, as before, but drawn from the fused order rather than
 *    the star order, so the reserved slots land on rows the fusion actually
 *    believed in rather than on whichever tiny repos happened to sort first.
 *
 * ## Fix: membership and presentation were the same `sort`, and it was the wrong one
 *
 * The first version of this function truncated the pool with
 * `[...ordered.map(e => e.row)].sort(byStars).slice(0, size)` — i.e. it re-sorted
 * by stars *before* slicing, on every return path. That destroyed the work of
 * stages 1 and 2: quota seats and fusion scores only decide an ORDER, and
 * re-sorting the whole candidate list by stars collapses that order back into
 * plain star-descending truncation, which is exactly the behaviour this function
 * exists to replace.
 *
 * Isolated measurement (`scripts/probes/fusion-isolate.mjs`, case C5): a channel whose
 * head is 900★ up against 30 anchors at 60,000★ pool size 10, and no row under
 * `TAIL_STAR_CEILING` (so stage 3 cannot fire) returned `real/anchor0..anchor9`
 * with the 900★ channel head absent — **byte-identical to plain star
 * truncation**, quota seat paid for and then thrown away. Stage 3 was the only
 * path that ever produced a non-star-truncation membership, so quota appeared to
 * work in the tail cases and silently did nothing everywhere else.
 *
 * The fix separates the two concerns that were conflated:
 *
 * - **Membership** is decided by `ordered` (quota seats, then fusion), sliced to
 *   `size`. This is what stages 1-3 are for.
 * - **Presentation** is a final star-descending sort of the selected rows only,
 *   so the returned pool still reads top-down by popularity. Callers and the
 *   rendered card read position as a quality signal, and a 917★ row listed above
 *   a 46,706★ one reads as a bug. Ordering within the pool was never load-bearing
 *   for `rank_candidates`, which re-ranks by `relevance × (1 + log10(max(stars, 10) + 1)) / 2` itself.
 *
 * The `sort` is now applied AFTER `slice`, never before it. That one-word move is
 * the difference between the fusion order mattering and not mattering.
 *
 * @param channels - one candidate list per query that succeeded, each in its own
 *   rank order (index 0 is that query's best match).
 * @param limit - size of the pool to return.
 * @param roles - optional, index-aligned with `channels`: the plan role of each
 *   query that produced a channel. Omitted by callers that build channels by
 *   hand (the eval harness, the probes, the regression scripts), and omitting it
 *   is not a degradation — it means "roles unknown", and every stage behaves
 *   exactly as it did before roles existed. T6 uses it to attribute reserved
 *   seats to the channel that actually claimed them.
 * @returns the selected pool, the count of tail rows admitted **because of a
 *   reserved slot** (not every low-star row — the rest of an all-tail pool
 *   arrives as ordinary seats), the threshold those slots target, and the size
 *   of the low-star population actually present in the pool.
 */
export function selectPool(
  channels: RepoCandidate[][],
  limit: number,
  roles?: readonly (QueryRole | undefined)[],
): { candidates: RepoCandidate[]; tailIncluded: number; tailThreshold: number; lowStarInPool: number } {
  const size = Math.max(1, Math.floor(limit))

  // Stage 1 + 2: fuse by reciprocal rank, then lift the per-channel heads.
  //
  // `sources` records WHICH channels contributed each row. Fusion used to keep
  // only the summed score, which is enough to ORDER the pool but not enough to
  // explain it: stage 3 then reserved seats for the long tail by scanning the
  // fused order for any row under the ceiling, with no idea whether that row came
  // from the tail channel that was fetched to find it or from a broad anchor
  // channel that happened to return small repos anyway. Measured on the frozen
  // suite, the tail channel's marginal contribution is as low as 2 rows
  // (api-mock-en), so most reserved seats were being credited to a query that
  // never aimed at the tail at all.
  const fused = new Map<string, { row: RepoCandidate; score: number; sources: Set<number> }>()
  for (let index = 0; index < channels.length; index++) {
    const rows = channels[index] ?? []
    for (const [key, entry] of rankChannel(rows)) {
      const existing = fused.get(key)
      if (existing === undefined) fused.set(key, { row: entry.row, score: entry.score, sources: new Set([index]) })
      else {
        existing.score += entry.score
        existing.sources.add(index)
      }
    }
  }

  const quota: string[] = []
  const quotaSeen = new Set<string>()
  for (const rows of channels) {
    for (const row of rows.slice(0, CHANNEL_QUOTA)) {
      const key = row.full_name.toLowerCase()
      if (quotaSeen.has(key)) continue
      quotaSeen.add(key)
      quota.push(key)
    }
  }

  // The remainder seats go to the fusion in RRF order, not insertion order.
  //
  // Stages 1-2 compute a reciprocal-rank score for every row and then this line
  // used to throw the ORDER away: `[...fused.keys()]` is Map insertion order,
  // which is the order the channels happened to be walked. So a row that two
  // channels both ranked highly could sit behind a row only one channel saw, and
  // the score that was summed for exactly this purpose decided nothing. The
  // quota seats are kept at the head (they are the measured fix for RRF's own
  // failure mode, `CHANNEL_QUOTA`), and everything after them is RRF-descending.
  //
  // Ties break on lowercase `full_name` so the pool does not depend on Map
  // insertion order — the pool feeds an order-sensitive presentation, and a
  // flapping pool would make the card unreproducible.
  const rest = [...fused.keys()]
    .filter((key) => !quotaSeen.has(key))
    .sort((a, b) => {
      const delta = (fused.get(b)?.score ?? 0) - (fused.get(a)?.score ?? 0)
      return delta !== 0 ? delta : a < b ? -1 : a > b ? 1 : 0
    })
  const ordered = [...quota, ...rest]
    .map((key) => fused.get(key))
    .filter((entry): entry is FusedEntry => entry !== undefined)
  // The quota can name a row the fusion never saw only if channels disagree on
  // identity, which they cannot: both are keyed by `full_name.toLowerCase()`.
  //
  // `byStars` orders the pool for PRESENTATION and must only ever run after the
  // membership slice. Sorting before slicing was the bug fixed in this revision:
  // it collapsed quota + fusion back into plain star-descending truncation, so
  // the seats stages 1-2 paid for were discarded whenever stage 3 did not fire.
  const byStars = (a: RepoCandidate, b: RepoCandidate): number => b.stars - a.stars
  const truncate = (entries: typeof ordered): RepoCandidate[] =>
    entries.slice(0, size).map(withChannelCount).sort(byStars)

  // The pool-side count of §7.6 (see `lowStarInPool` above). The definition is
  // shared with the ranking layer through `countLowStar` rather than restated
  // here, so the two sides of the measurement cannot drift apart: a second,
  // subtly different ceiling rule would still produce two plausible numbers
  // while quietly changing the difference that is the whole point.
  //
  // Both counts are needed to see the loss the scoring formula causes: the POOL
  // is where small repos arrive, the final ranking is where
  // `relevance × (1 + log10(max(stars, 10) + 1)) / 2` pushes them back down, and
  // a row that survives the first and vanishes from the second is only visible
  // if the two populations are counted separately. Reported from here because
  // this is the last place the pool exists as a pool.
  const plain = truncate(ordered)
  const orderedOut = {
    candidates: plain,
    tailIncluded: 0,
    tailThreshold: TAIL_STAR_CEILING,
    lowStarInPool: countLowStar(plain),
  }

  // Stage 3: reserve seats for the long tail.
  //
  // ## Why the seats are now attributed to a channel
  //
  // This stage used to scan the FUSED order for any row under the ceiling and
  // seat the first `reserve` of them. Nothing in that rule referred to the tail
  // channel, so the seats were filled by whichever low-star rows happened to rank
  // highest in the fusion — and a broad anchor query returns small repos as
  // collateral. Measured on the frozen suite, the tail channel's own marginal
  // contribution is 2 rows for api-mock-en and 5-8 for the rest, so a reserve of
  // 8 was mostly paying for rows the anchor had already produced. `tailIncluded`
  // then reported 8 whether or not the tail channel had done anything, which made
  // the one number that exists to show the reservation working blind to its own
  // subject.
  //
  // ## The rule
  //
  // When the plan's roles are known, a reserved seat must be filled by a row the
  // TAIL channel actually returned. If that channel returned nothing under the
  // ceiling, the seats are not claimed at all and the pool is the plain fused
  // one — an honest "the tail is unreachable" rather than a reserve that looks
  // satisfied. When roles are unknown (callers that build channels by hand: the
  // eval harness, the probes, the regression scripts) the old fused-order rule
  // applies unchanged, because inventing an attribution would be worse than
  // having none.
  //
  // Never let the tail become the whole pool: if a query legitimately returned
  // only tiny repos, taking `limit` of them is correct and reserving would be
  // pointless. Capping the reservation at half keeps the anchors in view, and at
  // limit 1 the reserve is 0, so the single seat stays with the best anchor.
  const reserve = Math.min(TAIL_RESERVED_SLOTS, Math.floor(size / 2))
  if (reserve === 0) return orderedOut

  // The channel indices whose role is `tail`. Empty means "no tail was planned,
  // or nobody said which channel it was" — both fall back to the old rule.
  const tailChannels = new Set<number>()
  if (roles !== undefined) {
    for (let index = 0; index < roles.length; index++) {
      if (roles[index] === 'tail') tailChannels.add(index)
    }
  }
  const attributed = tailChannels.size > 0

  const candidatesForTail = ordered.filter((entry) => {
    if (entry.row.stars > TAIL_STAR_CEILING) return false
    if (!attributed) return true
    // Attributed: the row must come from a tail channel. A row the tail channel
    // shares with an anchor channel still counts — the tail did return it, which
    // is the fact the seat is paying for.
    for (const source of entry.sources) {
      if (tailChannels.has(source)) return true
    }
    return false
  })
  const tail = candidatesForTail.slice(0, reserve)
  if (tail.length === 0) return orderedOut

  const tailNames = new Set(tail.map((entry) => entry.row.full_name.toLowerCase()))
  const head = ordered.filter((entry) => !tailNames.has(entry.row.full_name.toLowerCase()))
  // Reserved seats are taken from the fused order, so the head slice must leave
  // room for them: `size - tail.length` entries from the fusion, then the tail.
  // Both are already selected by the time `byStars` runs, so presentation cannot
  // change membership.
  const selected = [...head.slice(0, size - tail.length), ...tail].map(withChannelCount).sort(byStars)
  return {
    candidates: selected,
    tailIncluded: tail.length,
    tailThreshold: TAIL_STAR_CEILING,
    lowStarInPool: countLowStar(selected),
  }
}
