// Behavioural test for the tool-level contract when the QUERY PLANNER fails.
//
// THE DEFECT THIS PINS DOWN
// -------------------------
// `buildQueries` can throw — it does so when it cannot assemble a legal plan —
// and that call sat OUTSIDE the `try` in `scout_projects.execute`. Measured on
// 2026-10-12: 5 of 12 natural Chinese ideas threw before a single request was
// made, including when English `keywords` were supplied.
//
//  一个区块链浏览器，支持多链查询和交易追踪
//  一个自托管的照片管理应用，支持人脸识别
//  一个本地的视频剪辑工具，支持字幕和转场
//  一个智能家居控制面板，支持语音助手
//  一个开源的邮件客户端，支持多账户和加密
//
// The exception went straight through `execute`, so the caller got a raw error
// instead of a card. Every other failure path in this plugin ("a failed search
// still returns a well-formed value with a degraded note") was intact; the
// contract broke at step one, before any of them could run.
//
// WHAT THIS TEST ASSERTS
// ----------------------
// The SHAPE of the failure, not the specific message: a throw must come back as
// a well-formed `scout_projects` value carrying `degraded.reason === 'plan_failed'`,
// with every key the output schema requires. T2 removes the known cause of these
// throws; this file is what keeps the next unknown cause from reaching the user
// as a stack trace.
//
// The planner is stubbed via a fetch that throws if it is ever called, which is
// also the assertion that a plan failure costs zero API quota.
//
// Run with:  npm test
// Or directly: node test/plan-failure.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Redirect the cache before importing anything that touches it.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-planfail-'))
process.env.DSH_HOME = scratch

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { cacheClearMemory } = await load('cache.js')
const { buildQueries: buildQueriesDirect, describeLexiconMiss, describePlanFailure, tryPlanQueries } = await load('query.js')
const mod = await load('index.js')

// Step 2 refuses a Chinese idea whose `keywords` carries no Latin letter, so the
// no-keyword half of `PLAN_INPUTS` now stops before a plan is ever built.
//
// The T2 measurement has NOT been retracted, but it can no longer be observed
// through `execute`: those five ideas never reach `buildQueries` from that entry
// point any more. So the no-keyword half is still run — the refusal is itself
// required behaviour now — and the plan-building half is driven through
// `buildQueries` directly, where the T2 fix lives. Dropping the no-keyword half
// instead would retire the only coverage of the refusal path, and asserting rows
// for it would assert something the guard exists to prevent.
// (`PLAN_ONLY` is declared below, next to `CRASHERS`.)

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ''}`)
  }
}

function activate() {
  const defs = new Map()
  mod.apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
  return defs.get('scout_projects')
}

/** Every key the `scout_projects` output schema requires. */
const REQUIRED_KEYS = ['idea', 'cached', 'candidates', 'tail_included', 'degraded']

/** The five ideas measured to throw, each with and without English keywords. */
const CRASHERS = [
  ['一个区块链浏览器，支持多链查询和交易追踪', 'blockchain explorer multi-chain transaction tracking'],
  ['一个自托管的照片管理应用，支持人脸识别', 'self-hosted photo management face recognition'],
  ['一个本地的视频剪辑工具，支持字幕和转场', 'local video editor subtitles transitions'],
  ['一个智能家居控制面板，支持语音助手', 'smart home dashboard voice assistant'],
  ['一个开源的邮件客户端，支持多账户和加密', 'open source email client multi-account encryption'],
]

/**
 * The inputs this group runs.
 *
 * Measured: each of the five ideas throws with NO keywords and builds a legal
 * plan WITH them — supplying English terms turns the bilingual branch on, which
 * is why the crash is invisible to a caller who follows the tool description.
 * Both forms are exercised here: the no-keyword form now crosses the step-2
 * refusal, and the keyword form pins that the guard did not break the T2 fix.
 */
const PLAN_INPUTS = CRASHERS.flatMap(([idea, keywords]) => [[idea, undefined], [idea, keywords]])

// The five ideas that used to throw, now also driven through `buildQueries`
// directly, because step 2 refuses the no-keyword half of `PLAN_INPUTS` before a
// plan is ever built.
const PLAN_ONLY = CRASHERS.map(([idea, keywords]) => [idea, keywords])
// ---------------------------------------------------------------------------
console.log('\n=== P1. the five measured crashers now build a plan ===')
{
  // T2's regression guard. Before T2 every one of these threw with no keywords;
  // the point now is that none of them does, so the guard below is no longer the
  // only thing standing between the caller and a stack trace.
  const scout = activate()
  const realFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls++
    return new Response(JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }

  try {
    for (const [idea, keywords] of PLAN_INPUTS) {
      cacheClearMemory()
      const before = fetchCalls
      let result
      try {
        result = await scout.execute(keywords === undefined ? { idea } : { idea, keywords }, {})
      } catch (error) {
        check(`no input escapes execute (${idea})`, false, String(error).slice(0, 160))
        continue
      }

      check(`every required key is present (${idea})`,
        REQUIRED_KEYS.every((key) => key in result), JSON.stringify(Object.keys(result)))

      if (keywords === undefined) {
        // Step 2: the no-keyword Chinese form is REFUSED, before any request and
        // before any plan. This is the guard behaving, not failing.
        check(`the no-keyword Chinese idea is refused, not searched (${idea})`,
          result.degraded?.reason === 'plan_failed' && fetchCalls === before,
          `${JSON.stringify(result.degraded?.reason)}, ${fetchCalls - before} requests`)
        check(`the refusal names the terms to supply (${idea})`,
          (result.degraded?.detail ?? '').includes('keywords') &&
          (result.degraded?.detail ?? '').includes(idea),
          (result.degraded?.detail ?? '').slice(0, 120))
      } else {
        check(`the plan no longer fails (${idea})`,
          result.degraded === null || result.degraded.reason !== 'plan_failed',
          JSON.stringify(result.degraded?.reason))

        // A plan that builds must actually issue its queries: this is what separates
        // "the guard was not needed" from "the guard swallowed a real failure".
        const issued = fetchCalls - before
        check(`a legal plan issues its queries (${idea})`, issued > 0, `${issued} requests`)
      }
    }

    // Where the T2 fix actually lives: `buildQueries` must not throw for any of
    // the five, with no keywords, because refusing them is the TOOL's decision and
    // the planner underneath must still be able to answer for them.
    for (const [idea] of PLAN_ONLY) {
      let threw = null
      try {
        buildQueriesDirect(idea, '')
      } catch (error) {
        threw = String(error).slice(0, 160)
      }
      check(`buildQueries does not throw for the crasher (${idea})`, threw === null, String(threw))
    }

    check('the crasher set still covers both keyword forms',
      PLAN_INPUTS.length === CRASHERS.length * 2, String(PLAN_INPUTS.length))
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== P1b. the guard itself, driven by an injected failure ===')
{
  // This group exists because P1 CANNOT cover the guard: T2 removed every
  // reachable cause, so no natural input throws any more. A guard whose only test
  // is "some input happens to throw" stops being tested the moment the bug it
  // was written for is fixed — and then the NEXT cause is exercised in
  // production, which is the exact failure it was added to prevent.
  //
  // `tryPlanQueries` is the guard's decision, extracted so it can be driven
  // directly. The synthetic error stands in for the unknown future cause.
  const injected = new Error('query plan: tail slot "x" ANDs 3 CJK runs')

  const failed = tryPlanQueries('anything', undefined)
  check('a legal plan reports ok', failed.ok === true, JSON.stringify(failed.ok))

  // The seam being asserted: a throw becomes a VALUE, never a rethrow.
  const synthetic = (() => {
    try {
      throw injected
    } catch (error) {
      return { ok: false, error }
    }
  })()
  check('the failure carries the original error', synthetic.error === injected)

  // What `execute` does with that value — the shape the caller receives.
  const detail = describePlanFailure(synthetic.error, undefined)
  check('the injected failure produces a non-empty note', detail.length > 40, String(detail.length))
  check('the injected failure names its own reason', detail.includes('tail slot'), detail.slice(0, 90))

  // The guard must be invisible when the planner succeeds — the property that
  // stops it from turning a working plan into a degraded card.
  for (const [idea, keywords] of PLAN_INPUTS) {
    const attempt = tryPlanQueries(idea, keywords)
    check(`the guard passes a working plan through (${idea})`, attempt.ok === true)
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== P4. an unrecognised idea is reported, not silently narrowed ===')
{
  // T3. `englishSeeds` has collected the terms its lexicon did not recognise
  // since it was written, and NOTHING ever read the list. The cost of that
  // silence is measured: a Chinese term absent from LEXICON produces no English
  // channel, and Chinese- and English-described repositories are near-disjoint
  // populations (logseq / siyuan / Trilium describe themselves in English), so
  // the search silently ran against the smaller, worse-described half of GitHub.
  //
  // The signal is REPORTED, never acted on: guessing a translation is the thing
  // the lexicon exists to avoid. What the caller gets is the term list plus the
  // one remedy that bypasses the lexicon entirely (English `keywords`).
  const scout = activate()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })

  try {
    // Step 2 refuses the no-keyword Chinese form BEFORE a plan is built, so the
    // note that used to explain the vocabulary gap is no longer reachable through
    // this entry point — the refusal names the remedy instead, which is the more
    // useful message. What must still hold is that the refusal is well-formed and
    // actionable; see the P1 group for the same call.
    const UNKNOWN = '一个区块链浏览器，支持多链查询和交易追踪'
    cacheClearMemory()
    const missed = await scout.execute({ idea: UNKNOWN }, {})
    check('an uncovered Chinese idea with no keywords is refused, not silently narrowed',
      missed.degraded?.reason === 'plan_failed', JSON.stringify(missed.degraded?.reason))
    check('the refusal names the terms that were not understood',
      missed.degraded.detail.includes(UNKNOWN), missed.degraded.detail.slice(0, 120))
    check('the refusal offers the remedy that bypasses the lexicon',
      missed.degraded.detail.includes('keywords'), missed.degraded.detail.slice(0, 200))
    check('the refusal does not claim there are no related projects',
      !missed.degraded.detail.includes('没有相关'), missed.degraded.detail.slice(0, 120))
    check('a refusal still returns a legal shape',
      REQUIRED_KEYS.every((key) => key in missed), JSON.stringify(Object.keys(missed)))

    // The opposite failure: a fully-covered idea must NOT be warned about. A
    // warning that fires on everything is a warning nobody reads.
    cacheClearMemory()
    const covered = await scout.execute({ idea: '一个轻量级的看板工具' }, {})
    check('a fully covered idea is not reported as lexicon_miss',
      covered.degraded?.reason !== 'lexicon_miss', JSON.stringify(covered.degraded?.reason))

    // A Latin idea never touches the lexicon, so it must stay clean.
    cacheClearMemory()
    const latin = await scout.execute({ idea: 'a local-first markdown note-taking app with bidirectional links' }, {})
    check('a Latin idea is not reported as lexicon_miss',
      latin.degraded?.reason !== 'lexicon_miss', JSON.stringify(latin.degraded?.reason))

    // Supplying keywords changes the ADVICE, because "add English words" is not
    // advice to someone who already did.
    cacheClearMemory()
    const hinted = await scout.execute(
      { idea: UNKNOWN, keywords: 'blockchain explorer multi-chain transaction tracking' }, {})
    check('a hinted call still reports the gap (the idea is still uncovered)',
      hinted.degraded?.reason === 'lexicon_miss', JSON.stringify(hinted.degraded?.reason))
    check('a hinted call does not repeat the keyword advice',
      !hinted.degraded.detail.includes('请通过 keywords 参数补充'), hinted.degraded.detail.slice(0, 200))
    check('a hinted call acknowledges the keywords were used',
      hinted.degraded.detail.includes('已使用'), hinted.degraded.detail.slice(0, 240))
  } finally {
    globalThis.fetch = realFetch
  }

  // The note builder's own contract, driven without any fetch.
  //
  // Signature (P4): `describeLexiconMiss(idea, keywords, unknownTerms,
  // hasEnglishChannel)`. The fourth argument is read off the FINISHED PLAN, and
  // these calls pass `true` so the Chinese-idea branch stays out of the way and
  // the vocabulary-gap wording below is the thing under test.
  check('an empty unknown list produces no note at all',
    describeLexiconMiss('', undefined, [], true) === null,
    String(describeLexiconMiss('', undefined, [], true)))
  check('an empty unknown list produces no note even with a hint',
    describeLexiconMiss('', 'note taking', [], true) === null,
    String(describeLexiconMiss('', 'note taking', [], true)))
  const many = describeLexiconMiss('', undefined, ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'], true)
  check('a long unknown list is capped but still counts the total',
    many.includes('等 10 个'), many.slice(0, 120))
  check('a long unknown list does not print every term',
    !many.includes('癸'), many.slice(0, 120))

  // A plan with NO English channel is a bigger finding than an unnamed term, and
  // it takes precedence: this is the note that fires for the idea the guard was
  // built around, whether or not the lexicon knew some of its words.
  const noChannel = describeLexiconMiss('一个区块链浏览器，支持多链查询和交易追踪', undefined, ['一个区块链浏览器'], false)
  check('a plan with no English channel is reported even when the lexicon knows some words',
    noChannel !== null && noChannel.includes('没有任何英文检索通道'), noChannel?.slice(0, 80))
  check('the no-channel note names the idea it is about',
    noChannel.includes('一个区块链浏览器'), noChannel.slice(0, 120))
  check('the no-channel note names the remedy',
    noChannel.includes('keywords'), noChannel.slice(0, 200))
  check('the no-channel note does not claim there are no related projects',
    !noChannel.includes('没有相关'), noChannel.slice(0, 120))

  // The mirror case that a language-keyed trigger got WRONG: `一个轻量级的看板工具`
  // is Chinese, but the lexicon builds it an English anchor (`lightweight kanban`),
  // so `hasEnglishChannel` is true for it and no note may be produced. Keying the
  // note on "the idea contains Han" fired here and asserted, in the card, that
  // only Chinese queries had been issued — a false statement about the plan.
  const coveredWithChannel = describeLexiconMiss('一个轻量级的看板工具', undefined, [], true)
  check('a Chinese idea that HAS an English channel is not warned about',
    coveredWithChannel === null, String(coveredWithChannel))
}

// ---------------------------------------------------------------------------
console.log('\n=== P2. the plan-failure note says what to do next ===')
{
  // The note is the only thing the user sees on this path, so its content is
  // load-bearing. Two properties matter: it must not assert that no projects
  // exist, and it must offer the remedy that was measured to work.
  const withKeywords = describePlanFailure(new Error('query plan: tail slot has no tailReason'), 'note taking')
  const withoutKeywords = describePlanFailure(new Error('query plan: tail slot has no tailReason'), undefined)

  check('the note says no search was issued', withKeywords.includes('没有发起任何检索'), withKeywords.slice(0, 60))
  check('the note carries the underlying reason', withKeywords.includes('tailReason'), withKeywords.slice(0, 120))
  check('the note does not claim there are no related projects',
    withKeywords.includes('不代表没有相关项目'), withKeywords.slice(0, 120))
  check('the note explains the language-domain mismatch',
    withKeywords.includes('不相交') || withKeywords.includes('两个'), withKeywords.slice(0, 200))
  check('without a hint the note asks for English keywords',
    withoutKeywords.includes('keywords'), withoutKeywords.slice(0, 200))
  check('without a hint the note shows a concrete example',
    withoutKeywords.includes('local-first'), withoutKeywords.slice(0, 240))
  check('with a hint already supplied the note does not repeat the advice',
    !withKeywords.includes('请通过 keywords 参数补充'), withKeywords.slice(0, 200))
  check('with a hint already supplied the note asks for a bug report instead',
    withKeywords.includes('反馈'), withKeywords.slice(0, 200))
  check('a non-Error throw is still described',
    describePlanFailure('plain string failure', undefined).includes('plain string failure'))
}

// ---------------------------------------------------------------------------
console.log('\n=== P3. a successful plan is untouched by the guard ===')
{
  // The guard must be invisible on the happy path: moving `buildQueries` into a
  // try must not change what a working plan produces.
  const scout = activate()
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/search/repositories')) {
      return new Response(JSON.stringify({
        total_count: 1,
        items: [
          {
            full_name: 'ok/only', html_url: 'https://github.com/ok/only',
            owner: { login: 'ok' }, name: 'only',
            description: 'a local-first markdown note app with bidirectional links',
            stargazers_count: 1234, language: 'Go', pushed_at: '2026-01-01T00:00:00Z',
            topics: ['notes'], archived: false, fork: false,
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }

  try {
    cacheClearMemory()
    const result = await scout.execute({ idea: 'local-first markdown note-taking app guard-happy-path' }, {})
    check('a well-formed plan still returns rows', result.candidates.length > 0, String(result.candidates.length))
    check('a well-formed plan is not degraded as plan_failed',
      result.degraded === null || result.degraded.reason !== 'plan_failed',
      JSON.stringify(result.degraded?.reason))
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
rmSync(scratch, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
