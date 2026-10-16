/**
 * §8.7 / AC9 — the in-plugin idea→English translation wiring, branch by branch.
 *
 * `scout_projects` translates the caller's idea into English search terms itself,
 * inside the plugin, through `ctx.get('llm')` (`src/translate.ts`). This file pins
 * the four branches of that wiring as they are observable from OUTSIDE the tool —
 * through the real `execute` path, with a stubbed LLM and a stubbed `fetch`, so
 * nothing here touches a model or the network.
 *
 *   §8.7.1  pure-Chinese idea, no `keywords`, LLM available  → translated, not refused
 *   §8.7.2  mixed Han+Latin idea, no `keywords`              → never `plan_failed`
 *   §8.7.3  pure-English idea                                → works with no LLM at all
 *   §8.7.4  caller supplied `keywords`                       → caller wins, LLM untouched
 *   §5.8    degraded paths                                   → degrade, never throw
 *
 * The proof that translation happened is the search request itself: the `q=`
 * parameter of what actually reached `/search/repositories`. The translated
 * channel does not REPLACE the idea's own channel (a pure-Chinese idea still
 * sends one Chinese query), so the assertions ask for "at least one query carries
 * the LLM's Latin term", never "every query is Latin".
 *
 * Every branch is isolated twice — `cacheClearMemory()` for the in-process map and
 * a wipe of the on-disk cache under `DSH_HOME` — because a replayed cache entry
 * from an earlier branch would satisfy a later branch without running it.
 *
 * Run `npx tsc -p tsconfig.json` first. This file loads the BUILT modules in
 * `lib/`, so a stale `lib/` is a false pass waiting to happen.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const scratchRoot = join(pkgRoot, '.scratch')
mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(join(scratchRoot, 'translation-routing-'))
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = scratch

const { cacheClearMemory } = await load('cache.js')
const { apply } = await load('index.js')

const realFetch = globalThis.fetch
let pass = 0
let fail = 0

function check(label, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}\n        ${detail}`)
  }
}

const LIMIT = 3
const PURE_CHINESE_IDEA = '一个本地优先的笔记应用，支持双向链接'
const MIXED_IDEA = '本地优先的 Markdown 笔记应用，支持双向链接'
const ENGLISH_IDEA = 'a local-first markdown notes app with bidirectional links'
const CALLER_KEYWORDS = 'local-first note-taking bidirectional links'
const TRANSLATED_TERMS = 'local-first note-taking bidirectional links'
const REQUIRED_KEYS = ['idea', 'cached', 'candidates', 'tail_included', 'degraded']

const REFUSAL_MARKER = '拒绝执行'
const TRANSLATION_NOTE_MARKER = '检索词由插件内的 LLM 译出'

const hasHan = (text) => /\p{Script=Han}/u.test(text)
const hasLatin = (text) => /[A-Za-z]/.test(text)

const delta = (text) => ({ type: 'text-delta', text })

/**
 * A stand-in for the LLM service `ctx.get('llm')` returns. The object handed to
 * the plugin must BE the service (`{ stream }`) — wrapping it in `{ calls, service }`
 * and passing the wrapper makes `typeof llm.stream !== 'function'`, which degrades
 * to `llm_unavailable` and silently satisfies nothing.
 */
function stubLlm(chunks) {
  const calls = []
  return {
    calls,
    service: {
      stream(request) {
        calls.push(request)
        return (async function* generate() {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
}

const defaultModel = { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }

const row = (n) => ({
  full_name: `stub/repo${n}`,
  html_url: `https://github.com/stub/repo${n}`,
  owner: { login: 'stub' },
  name: `repo${n}`,
  description: 'stubbed search result',
  stargazers_count: 42,
  language: 'TypeScript',
  pushed_at: '2026-01-01T00:00:00Z',
  topics: ['stub'],
  archived: false,
  fork: false,
})

/**
 * Every request the plugin makes is answered locally. Exactly `per_page` rows come
 * back so no result is thin enough to add a note of its own, and the rate-limit
 * headers are present because the probe guard reads the SEARCH bucket before it
 * spends a probe (`src/github.ts`).
 *
 * `per_page === 1` identifies a probe; the plan asks for `limit` rows.
 */
function installFetch() {
  const calls = []
  globalThis.fetch = async (url) => {
    const href = typeof url === 'string' ? url : typeof url?.url === 'string' ? url.url : String(url)
    const parsed = new URL(href)
    const perPage = Number(parsed.searchParams.get('per_page'))
    calls.push({
      q: parsed.searchParams.get('q'),
      sort: parsed.searchParams.get('sort'),
      perPage,
      onSearchEndpoint: parsed.origin === 'https://api.github.com' && parsed.pathname === '/search/repositories',
    })
    const items = Array.from({ length: perPage }, (_, i) => row(calls.length * 100 + i))
    return new Response(
      JSON.stringify({ total_count: perPage, incomplete_results: false, items }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-limit': '30',
          'x-ratelimit-remaining': String(Math.max(0, 30 - calls.length)),
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
        },
      },
    )
  }
  return {
    calls,
    planQueries: () => calls.filter((call) => call.perPage !== 1).map((call) => call.q),
    allOnSearchEndpoint: () => calls.every((call) => call.onSearchEndpoint),
  }
}

/**
 * Drive one branch through the real `scout_projects` tool. Services are supplied
 * per call so a branch can run with no LLM, a stub LLM, a stub LLM without a
 * model selection, and so on.
 */
async function runCase({ idea, keywords, stub, model }) {
  cacheClearMemory()
  rmSync(join(scratch, 'cache'), { recursive: true, force: true })
  const net = installFetch()

  const defs = new Map()
  const services = new Map()
  if (stub !== undefined) services.set('llm', stub.service)
  if (model !== undefined) services.set('agentDefaultModel', model)

  apply({
    tools: { register: (def) => defs.set(def.name, def) },
    get: (name) => services.get(name),
  })
  const scout = defs.get('scout_projects')
  if (scout === undefined) return { result: null, thrown: new Error('scout_projects was not registered'), net }

  const args = keywords === undefined ? { idea, limit: LIMIT } : { idea, keywords, limit: LIMIT }
  let result = null
  let thrown = null
  try {
    result = await scout.execute(args, {})
  } catch (error) {
    thrown = error
  }
  return { result, thrown, net }
}

const missingKeys = (result) => {
  if (result === null || typeof result !== 'object') return REQUIRED_KEYS
  return REQUIRED_KEYS.filter((key) => !(key in result))
}
const degradedReason = (result) => result?.degraded?.reason ?? null
const degradedDetail = (result) => String(result?.degraded?.detail ?? '')
const refused = (result) => degradedDetail(result).includes(REFUSAL_MARKER)
const describe = (value) => JSON.stringify(value)

try {
  // ── §8.7.1 pure-Chinese idea, no keywords, LLM available ────────────────────
  console.log('\n--- §8.7.1  pure-Chinese idea, no keywords, LLM available ---')
  {
    const stub = stubLlm([delta(TRANSLATED_TERMS)])
    const { result, thrown, net } = await runCase({ idea: PURE_CHINESE_IDEA, stub, model: defaultModel })
    const queries = net.planQueries()

    check(
      'the fixture is a pure-Chinese idea with no Latin character to fall back on',
      hasHan(PURE_CHINESE_IDEA) && !hasLatin(PURE_CHINESE_IDEA),
      `idea=${describe(PURE_CHINESE_IDEA)}`,
    )
    check(
      'a pure-Chinese idea with no keywords consults the LLM exactly once',
      stub.calls.length === 1,
      `llm stream calls=${stub.calls.length}`,
    )
    check(
      "the translation request carries the caller's idea verbatim",
      String(stub.calls[0]?.messages?.[0]?.content ?? '').includes(PURE_CHINESE_IDEA),
      `messages=${describe(stub.calls[0]?.messages ?? null)}`,
    )
    check('the pure-Chinese branch returns a card instead of throwing', thrown === null, `${thrown?.stack ?? thrown}`)
    check(
      'a pure-Chinese idea with no keywords is translated, not refused',
      degradedReason(result) !== 'plan_failed' && !refused(result),
      `degraded=${describe(result?.degraded ?? null)}`,
    )
    check(
      'the card discloses that its search terms were machine-translated',
      degradedReason(result) === 'translation_degraded' && degradedDetail(result).includes(TRANSLATION_NOTE_MARKER),
      `degraded=${describe(result?.degraded ?? null)}`,
    )
    check(
      'the queries actually sent to GitHub carry Latin search terms',
      queries.some((query) => hasLatin(query)),
      `plan queries=${describe(queries)}`,
    )
    check(
      'the term the LLM produced reaches a real GitHub query',
      queries.some((query) => query.includes('local-first')),
      `plan queries=${describe(queries)}`,
    )
    check(
      'translation yields a usable candidate set, not an empty card',
      (result?.candidates?.length ?? 0) > 0,
      `candidates=${describe(result?.candidates ?? null)}`,
    )
    check(
      "the branch ran cold rather than replaying another branch's cache entry",
      result?.cached === false,
      `cached=${describe(result?.cached ?? null)}`,
    )
    check(
      'the branch really searched GitHub, so the terms above are not a vacuous pass',
      net.calls.length > 0 && net.allOnSearchEndpoint(),
      `fetch calls=${describe(net.calls)}`,
    )
  }

  // ── §8.7.2 mixed Han+Latin idea, no keywords ────────────────────────────────
  console.log('\n--- §8.7.2  mixed Han+Latin idea, no keywords ---')
  {
    const stub = stubLlm([delta('SHOULD NOT BE CALLED')])
    const { result, thrown, net } = await runCase({ idea: MIXED_IDEA, stub, model: defaultModel })
    const queries = net.planQueries()

    check(
      'the fixture really mixes Han and Latin characters',
      hasHan(MIXED_IDEA) && hasLatin(MIXED_IDEA),
      `idea=${describe(MIXED_IDEA)}`,
    )
    check(
      'a mixed-script idea needs no translation, so the LLM is never consulted',
      stub.calls.length === 0,
      `llm stream calls=${stub.calls.length}`,
    )
    check('the mixed-script branch returns a card instead of throwing', thrown === null, `${thrown?.stack ?? thrown}`)
    check(
      'a mixed Han+Latin idea is planned without keywords instead of failing the plan',
      degradedReason(result) !== 'plan_failed' && !refused(result),
      `degraded=${describe(result?.degraded ?? null)}`,
    )
    check(
      'a mixed-script idea is planned entirely without translation, so nothing is marked degraded',
      result?.degraded === null,
      `degraded=${describe(result?.degraded ?? null)}`,
    )
    check(
      'the mixed-script plan reaches GitHub with Latin search terms',
      queries.length > 0 && queries.some((query) => hasLatin(query)),
      `plan queries=${describe(queries)}`,
    )
    check(
      'the mixed-script branch returns candidates',
      (result?.candidates?.length ?? 0) > 0,
      `candidates=${describe(result?.candidates ?? null)}`,
    )
    check(
      'the mixed-script branch actually searched GitHub, so "no plan_failed" is not true merely because nothing ran',
      net.calls.length > 0 && net.allOnSearchEndpoint(),
      `fetch calls=${describe(net.calls)}`,
    )
  }

  // ── §8.7.3 pure-English idea, no LLM at all ─────────────────────────────────
  console.log('\n--- §8.7.3  pure-English idea, no LLM available at all ---')
  {
    const { result, thrown, net } = await runCase({ idea: ENGLISH_IDEA })
    const queries = net.planQueries()

    check(
      'the fixture is a pure-English idea with no Han character',
      hasLatin(ENGLISH_IDEA) && !hasHan(ENGLISH_IDEA),
      `idea=${describe(ENGLISH_IDEA)}`,
    )
    check('the pure-English branch returns a card instead of throwing', thrown === null, `${thrown?.stack ?? thrown}`)
    check(
      'a pure-English idea needs no translation and produces no degraded card',
      result?.degraded === null,
      `degraded=${describe(result?.degraded ?? null)}`,
    )
    check(
      'the pure-English plan searches GitHub with terms taken from the idea itself',
      queries.length > 0 && queries.some((query) => query.includes('local-first')),
      `plan queries=${describe(queries)}`,
    )
    check(
      'the pure-English branch returns candidates without any LLM service',
      (result?.candidates?.length ?? 0) > 0,
      `candidates=${describe(result?.candidates ?? null)}`,
    )
    check(
      'the pure-English branch actually searched GitHub',
      net.calls.length > 0 && net.allOnSearchEndpoint(),
      `fetch calls=${describe(net.calls)}`,
    )
  }

  // ── §8.7.4 caller supplied keywords win ─────────────────────────────────────
  console.log('\n--- §8.7.4  caller supplied keywords ---')
  {
    const stub = stubLlm([delta('SHOULD NOT BE CALLED')])
    const { result, thrown, net } = await runCase({
      idea: PURE_CHINESE_IDEA,
      keywords: CALLER_KEYWORDS,
      stub,
      model: defaultModel,
    })
    const queries = net.planQueries()

    check(
      "caller-supplied keywords suppress the translation call entirely",
      stub.calls.length === 0,
      `llm stream calls=${stub.calls.length}`,
    )
    check('the caller-keywords branch returns a card instead of throwing', thrown === null, `${thrown?.stack ?? thrown}`)
    check(
      'caller-supplied keywords mean no refusal, even for a pure-Chinese idea',
      degradedReason(result) !== 'plan_failed' && !refused(result),
      `degraded=${describe(result?.degraded ?? null)}`,
    )
    check(
      "the caller's own terms are what reached GitHub",
      queries.some((query) => query.includes('local-first') && query.includes('note-taking')),
      `plan queries=${describe(queries)}`,
    )
    check(
      'the caller-keywords branch returns candidates',
      (result?.candidates?.length ?? 0) > 0,
      `candidates=${describe(result?.candidates ?? null)}`,
    )
    check(
      'the caller-keywords branch actually searched GitHub',
      net.calls.length > 0 && net.allOnSearchEndpoint(),
      `fetch calls=${describe(net.calls)}`,
    )

    // Control: the same stub IS consulted for the same idea when keywords are
    // absent, so "the LLM was not consulted" above is about the keywords and not
    // about a stub that could never have been called.
    const control = stubLlm([delta(TRANSLATED_TERMS)])
    await runCase({ idea: PURE_CHINESE_IDEA, stub: control, model: defaultModel })
    check(
      'control: the identical stub IS consulted when the same idea arrives without keywords',
      control.calls.length === 1,
      `control llm stream calls=${control.calls.length}`,
    )
  }

  // ── §5.8 degraded paths ─────────────────────────────────────────────────────
  console.log('\n--- §5.8  degraded paths degrade instead of throwing ---')
  {
    // No LLM service at all.
    const noLlm = await runCase({ idea: PURE_CHINESE_IDEA })
    check(
      'a missing LLM service does not throw out of scout_projects',
      noLlm.thrown === null,
      `${noLlm.thrown?.stack ?? noLlm.thrown}`,
    )
    check(
      'a missing LLM service still returns a well-formed card',
      missingKeys(noLlm.result).length === 0,
      `missing keys=${describe(missingKeys(noLlm.result))} result=${describe(noLlm.result)}`,
    )
    check(
      'a pure-Chinese idea with no keywords and no LLM degrades rather than returning nothing',
      degradedReason(noLlm.result) === 'plan_failed' && refused(noLlm.result),
      `degraded=${describe(noLlm.result?.degraded ?? null)}`,
    )
    check(
      'the degraded card carries no candidates',
      (noLlm.result?.candidates?.length ?? -1) === 0,
      `candidates=${describe(noLlm.result?.candidates ?? null)}`,
    )
    check(
      'the refusal short-circuits before any GitHub request is made',
      noLlm.net.calls.length === 0,
      `fetch calls=${describe(noLlm.net.calls)}`,
    )

    // LLM answers, but with unusable output.
    const badOutput = stubLlm([delta('本地优先的笔记应用')])
    const invalid = await runCase({ idea: PURE_CHINESE_IDEA, stub: badOutput, model: defaultModel })
    check(
      'the invalid-output case really did consult the LLM',
      badOutput.calls.length === 1,
      `llm stream calls=${badOutput.calls.length}`,
    )
    check(
      'unusable LLM output does not throw out of scout_projects',
      invalid.thrown === null,
      `${invalid.thrown?.stack ?? invalid.thrown}`,
    )
    check(
      'unusable LLM output degrades instead of being used as search terms',
      degradedReason(invalid.result) === 'plan_failed' && refused(invalid.result),
      `degraded=${describe(invalid.result?.degraded ?? null)}`,
    )
    check(
      'the invalid-output card carries no candidates and no query was sent',
      (invalid.result?.candidates?.length ?? -1) === 0 && invalid.net.calls.length === 0,
      `candidates=${describe(invalid.result?.candidates ?? null)} fetch calls=${describe(invalid.net.calls)}`,
    )

    // LLM service present, but no model selection to call it with.
    const noModel = stubLlm([delta(TRANSLATED_TERMS)])
    const unselected = await runCase({ idea: PURE_CHINESE_IDEA, stub: noModel })
    check(
      'a missing model selection does not throw out of scout_projects',
      unselected.thrown === null,
      `${unselected.thrown?.stack ?? unselected.thrown}`,
    )
    check(
      'a missing model selection degrades without ever streaming a request',
      degradedReason(unselected.result) === 'plan_failed' && noModel.calls.length === 0,
      `degraded=${describe(unselected.result?.degraded ?? null)} llm stream calls=${noModel.calls.length}`,
    )

    // LLM service whose stream throws.
    const throwing = { calls: [], service: { stream() { throw new Error('stub llm exploded') } } }
    const exploded = await runCase({ idea: PURE_CHINESE_IDEA, stub: throwing, model: defaultModel })
    check(
      'an LLM that throws does not throw out of scout_projects',
      exploded.thrown === null,
      `${exploded.thrown?.stack ?? exploded.thrown}`,
    )
    check(
      'an LLM that throws degrades rather than propagating the failure',
      degradedReason(exploded.result) === 'plan_failed' && refused(exploded.result) && exploded.net.calls.length === 0,
      `degraded=${describe(exploded.result?.degraded ?? null)} fetch calls=${describe(exploded.net.calls)}`,
    )
  }
} catch (error) {
  fail += 1
  console.log(`  FAIL  the suite ran to completion\n        ${error?.stack ?? error}`)
} finally {
  globalThis.fetch = realFetch
  cacheClearMemory()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
