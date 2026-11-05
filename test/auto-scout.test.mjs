// The second half of 0.5.0: the settings, the two modes, and the budget.
//
// WHAT THIS PINS DOWN
// -------------------
// Three decisions were made by the user after the first batch, and each one is
// a promise that prose alone cannot keep:
//
//   1. `autoScout` has three positions — `always` (search on your own
//      judgement), `ask` (never search without the user agreeing), `off` (do not
//      advertise at all). The default is `always`. A typo in the config file
//      must fail the plugin load loudly rather than silently become the default.
//   2. `scout_projects` takes a `mode`: `brief` (default) is a first look that
//      shows names and one-liners and does NOT ask for ranking; `full` is a
//      deliberate comparison that does. The MUST to call `rank_candidates` used
//      to be unconditional, and one such call costs 8.2 KB–18 KB of arguments
//      (measured over 12 real calls) — a large price for answering "有什么建议".
//   3. An unprompted search budget of TWO per session, enforced by the guard,
//      not by the prompt. After it is spent the model must ask the user; when
//      the user answers, one more search is released.
//
// The budget is the interesting one, because the two obvious implementations
// are both wrong: counting `tool/call` charges refused and failed attempts to
// the budget, and reading every `user/message` finds "the user just spoke" on
// almost every step — of 831 `user/message` events in 58 real logs only 140 are
// typed by the user, the rest are time-context, runtime-context, the skill
// catalog, approval results and background-job notices.
//
// Run with:  npm test
// Or directly: node test/auto-scout.test.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)
const readSrc = (rel) => readFileSync(join(pkgRoot, 'src', rel), 'utf8')

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

const activation = await load('activation.js')
const brief = await load('brief.js')
const index = await load('index.js')

/** A fake context that records sections and guards, with an optional session store. */
function fakeHost({ sessions } = {}) {
  const sections = []
  const guards = []
  const defs = new Map()
  const ctx = {
    tools: {
      register: (definition) => { defs.set(definition.name, definition); return () => {} },
      guard: (guard) => { guards.push(guard); return () => {} },
    },
    get: (name) => {
      if (name === 'systemPrompt') return { section: (section) => { sections.push(section); return () => {} } }
      if (name === 'sessions' && sessions !== undefined) return sessions
      return undefined
    },
  }
  return { ctx, sections, guards, defs }
}

const assistantText = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const userSays = (text, kind = 'user') => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind }, role: 'user', id: `u-${text.length}` },
})
const scoutCall = (callId, seq = 0) => ({
  type: 'tool/call',
  seq,
  data: { turn: 1, step: 1, callId, name: 'scout_projects', arguments: '{"idea":"x"}' },
})
const scoutOk = (callId, seq = 0) => ({
  type: 'tool/result',
  seq,
  data: {
    turn: 1,
    step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'rows' }], isError: false, id: `r-${callId}` },
  },
})
const scoutFail = (callId, seq = 0) => ({
  type: 'tool/result',
  seq,
  data: {
    turn: 1,
    step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'Error: refused' }], isError: true, id: `r-${callId}` },
  },
})
const sessionWith = (events) => ({ snapshotEvents: () => events })

console.log('\n=== 1. autoScout is a three-position setting with a safe default ===')
{
  const { Config, AUTO_SCOUT_MODES, DEFAULT_AUTO_SCOUT, normalizeAutoScout, resolveAutoScout } = activation

  check('the default is "always" (search on your own judgement)', DEFAULT_AUTO_SCOUT === 'always', String(DEFAULT_AUTO_SCOUT))
  check('there are exactly three positions', AUTO_SCOUT_MODES.length === 3, String(AUTO_SCOUT_MODES.length))
  check('the three positions are always / ask / off',
    AUTO_SCOUT_MODES.join(',') === 'always,ask,off', AUTO_SCOUT_MODES.join(','))

  // cordis only ever calls Config['~standard'].validate(config) and reads
  // { value } or { issues } back. This is the whole contract.
  const standard = Config?.['~standard']
  check('Config exposes the ~standard interface cordis validates', typeof standard?.validate === 'function')
  check('the interface is synchronous, as cordis requires', typeof standard.validate(undefined) === 'object')
  check('it declares standard version 1', standard.version === 1, String(standard.version))
  check('it names its vendor', standard.vendor === 'dsh-find-ideas', String(standard.vendor))

  for (const mode of ['always', 'ask', 'off']) {
    const result = standard.validate({ autoScout: mode })
    check(`a configured "${mode}" is accepted and normalised`,
      result.value?.autoScout === mode && result.issues === undefined, JSON.stringify(result))
  }

  // No config at all must mean "default", not "invalid": every pre-0.5.0 host
  // passes no config, and a plugin that failed to load there would be a
  // regression for every existing user.
  for (const empty of [undefined, null, {}]) {
    const result = standard.validate(empty)
    check(`an absent config (${JSON.stringify(empty)}) resolves to the default`,
      result.value?.autoScout === 'always', JSON.stringify(result))
  }

  // A typo must fail loudly and name the offending value: a silent fallback
  // would leave the user believing auto-scouting is off while it is on.
  const bogus = standard.validate({ autoScout: 'bogus' })
  check('an unknown mode is reported as an issue, not a value', bogus.issues !== undefined && bogus.value === undefined, JSON.stringify(bogus))
  check('the issue names the field', bogus.issues?.[0]?.path?.[0] === 'autoScout', JSON.stringify(bogus.issues))
  check('the issue quotes the offending value', /bogus/.test(bogus.issues?.[0]?.message ?? ''), JSON.stringify(bogus.issues))
  check('the issue lists the allowed values', /always/.test(bogus.issues?.[0]?.message ?? '') && /ask/.test(bogus.issues?.[0]?.message ?? '') && /off/.test(bogus.issues?.[0]?.message ?? ''), JSON.stringify(bogus.issues))
  check('a non-string mode is an issue too', standard.validate({ autoScout: 3 }).issues !== undefined, JSON.stringify(standard.validate({ autoScout: 3 })))

  check('normalizeAutoScout reads a valid mode', normalizeAutoScout('ask') === 'ask')
  check('normalizeAutoScout rejects anything else', normalizeAutoScout('ASK') === undefined && normalizeAutoScout(1) === undefined && normalizeAutoScout(undefined) === undefined)

  // The second `apply` argument is absent in 21 older tests and every older
  // host, so this cannot throw on a shape it does not recognise.
  check('resolveAutoScout(undefined) is the default', resolveAutoScout(undefined) === 'always')
  check('resolveAutoScout reads the field', resolveAutoScout({ autoScout: 'off' }) === 'off')
  check('resolveAutoScout survives an unknown value', resolveAutoScout({ autoScout: 'bogus' }) === 'always')
  check('resolveAutoScout survives a non-object', resolveAutoScout('always') === 'always')
}

console.log('\n=== 2. the mode parameter is registered, and defaults to brief ===')
{
  const { defs } = fakeHost()
  index.apply({ tools: { register: (d) => { defs.set(d.name, d); return () => {} } }, get: () => undefined })
  const scout = defs.get('scout_projects')
  const properties = scout.parameters.properties ?? {}
  const mode = properties.mode ?? {}

  check('scout_projects still exists', scout !== undefined)
  check('it takes a mode parameter', mode.type === 'string', JSON.stringify(mode))
  check('mode is restricted to brief and full', Array.isArray(mode.enum) && mode.enum.join(',') === 'brief,full', JSON.stringify(mode.enum))
  check('mode is optional (idea is the only required field)',
    Array.isArray(scout.parameters.required) && scout.parameters.required.join(',') === 'idea', JSON.stringify(scout.parameters.required))
  check('the parameter description says brief is the default', /brief.*default|default.*brief/i.test(mode.description ?? ''), String(mode.description))
  check('the description explains when to use full', /compare|comparison/i.test(mode.description ?? ''), String(mode.description))

  // The MUST to rank moved out of the description and into the result text of
  // the mode that wants it — but the description must still point at the tool,
  // because that pointer is how a `full` call is ever reached.
  check('the description still names rank_candidates', /rank_candidates/.test(scout.description), scout.description.slice(0, 300))
  check('the description says the default is brief', /mode "brief"/.test(scout.description), scout.description.slice(0, 300))
  check('the old unconditional MUST is gone', !/you MUST then call rank_candidates/.test(scout.description), scout.description.slice(0, 400))
}

console.log('\n=== 3. brief and full differ in what they ask next, never in the rows ===')
{
  const { defs } = fakeHost()
  index.apply({ tools: { register: (d) => { defs.set(d.name, d); return () => {} } }, get: () => undefined })
  const scout = defs.get('scout_projects')

  const value = {
    idea: '番茄钟',
    cached: false,
    degraded: null,
    candidates: [
      { full_name: 'a/b', url: 'https://github.com/a/b', owner: 'a', name: 'b', description: 'a pomodoro timer', stars: 120, language: 'TypeScript', pushed_at: '2025-01-01T00:00:00Z', archived: false, topics: [] },
      { full_name: 'c/d', url: 'https://github.com/c/d', owner: 'c', name: 'd', description: 'another timer', stars: 8, language: 'Rust', pushed_at: '2025-02-01T00:00:00Z', archived: false, topics: [] },
    ],
    tail_included: 1,
    low_star_in_pool: 1,
    query_terms: [],
    probe_note: '',
    prior_context: [],
  }

  const briefOut = scout.output.render({ idea: '番茄钟' }, value)[0].text
  const fullOut = scout.output.render({ idea: '番茄钟', mode: 'full' }, value)[0].text
  const briefModeOf = brief.scoutModeOf(undefined)

  check('omitting mode renders the brief text', briefModeOf === 'brief', String(briefModeOf))
  check('brief says it is an unscored first look', /速览/.test(briefOut) && /未打分/.test(briefOut), briefOut.slice(-120))
  check('brief does not demand a ranking', !/接下来调用 rank_candidates/.test(briefOut), briefOut.slice(-120))
  check('brief still says ranking is available on request', /rank_candidates/.test(briefOut), briefOut.slice(-120))
  check('full says it is the complete mode', /完整模式/.test(fullOut), fullOut.slice(-160))
  check('full asks for the three dimension scores', /problem_fit/.test(fullOut) && /workflow_fit/.test(fullOut) && /technical_fit/.test(fullOut), fullOut.slice(-200))
  check('full asks for rank_candidates next', /接下来调用 rank_candidates/.test(fullOut), fullOut.slice(-200))
  check('full still forbids hand-ordering', /不要自己给这些原始结果排序/.test(fullOut), fullOut.slice(-200))

  // The rows are identical in both modes: mode is a next-step instruction, not
  // a filter. Any test that reads value.candidates must keep passing.
  for (const row of ['a/b', 'c/d', 'pomodoro timer', 'another timer']) {
    check(`both modes carry the row ${row}`, briefOut.includes(row) && fullOut.includes(row))
  }
  check('both modes carry the same low-star note', /8/.test(briefOut) && /8/.test(fullOut))

  // A row that was truncated away is not resurrected by mode either.
  const empty = { ...value, candidates: [] }
  const briefEmpty = scout.output.render({}, empty)[0].text
  const fullEmpty = scout.output.render({ mode: 'full' }, empty)[0].text
  check('an empty result still frames as brief by default', /速览/.test(briefEmpty), briefEmpty.slice(0, 120))
  check('an empty result in full still asks for the comparison step', /完整模式/.test(fullEmpty), fullEmpty.slice(0, 120))

  check('normalizeScoutMode reads a valid mode', brief.normalizeScoutMode('full') === 'full')
  check('normalizeScoutMode rejects anything else', brief.normalizeScoutMode('FULL') === undefined && brief.normalizeScoutMode(undefined) === undefined)
  check('scoutModeOf falls back to brief on a malformed argument', brief.scoutModeOf('nope') === 'brief' && brief.scoutModeOf(null) === 'brief')
}

console.log('\n=== 4. only a search that actually returned rows is charged to the budget ===')
{
  const { countCompletedScoutCalls, MAX_UNPROMPTED_SEARCHES } = activation
  check('the budget is two', MAX_UNPROMPTED_SEARCHES === 2, String(MAX_UNPROMPTED_SEARCHES))
  check('an empty log has spent nothing', countCompletedScoutCalls([]) === 0)

  const one = [scoutCall('c1'), scoutOk('c1')]
  check('one call with one success counts as one', countCompletedScoutCalls(one) === 1, String(countCompletedScoutCalls(one)))

  // A refusal or a transport failure returned no rows, so it must not consume
  // one of the two searches — otherwise two rejected attempts would use up the
  // whole budget and the model would conclude the tool is broken.
  const refused = [scoutCall('c1'), scoutFail('c1')]
  check('a refused call is not charged', countCompletedScoutCalls(refused) === 0, String(countCompletedScoutCalls(refused)))
  check('a call with no result yet is not charged', countCompletedScoutCalls([scoutCall('c1')]) === 0, String(countCompletedScoutCalls([scoutCall('c1')])))
  check('an error field on the result is enough to not charge it',
    countCompletedScoutCalls([scoutCall('c1'), { type: 'tool/result', data: { error: 'boom', message: { toolCallId: 'c1', isError: false } } }]) === 0)

  const two = [scoutCall('c1'), scoutOk('c1'), scoutCall('c2'), scoutOk('c2')]
  check('two successes count as two', countCompletedScoutCalls(two) === 2, String(countCompletedScoutCalls(two)))

  // Other tools' calls never touch this budget.
  const other = [
    { type: 'tool/call', data: { callId: 'x1', name: 'inspect_projects' } },
    { type: 'tool/result', data: { message: { toolCallId: 'x1', isError: false } } },
  ]
  check('another tool\'s call is not counted', countCompletedScoutCalls(other) === 0, String(countCompletedScoutCalls(other)))

  // The host may commit tool/call before or after the guard runs; the current
  // call is excluded by id so the count is the same either way.
  check('the call being guarded is excluded by id', countCompletedScoutCalls([...two, scoutCall('c3')], 'c3') === 2, String(countCompletedScoutCalls([...two, scoutCall('c3')], 'c3')))
  check('excluding an id that is not there changes nothing', countCompletedScoutCalls(two, 'c9') === 2, String(countCompletedScoutCalls(two, 'c9')))

  // The result id is read from either shape found in real logs.
  const sourceOnly = [{ type: 'tool/call', data: { callId: 'c1', name: 'scout_projects' } }, {
    type: 'tool/result',
    data: { message: { source: { kind: 'tool', callId: 'c1' }, isError: false } },
  }]
  check('a result carrying only source.callId is still paired', countCompletedScoutCalls(sourceOnly) === 1, String(countCompletedScoutCalls(sourceOnly)))

  check('malformed events do not throw', countCompletedScoutCalls([null, {}, { type: 'tool/call' }, { type: 'tool/result', data: null }]) === 0)
}

console.log('\n=== 5. the budget is released by the USER speaking, not by the runtime ===')
{
  const { lastUserMessageIndex, lastScoutCallIndex, scoutBudgetSpent } = activation

  check('no user message means index -1', lastUserMessageIndex([]) === -1)
  check('a user message is found', lastUserMessageIndex([userSays('我想做个番茄钟')]) === 0)
  check('the LAST user message wins', lastUserMessageIndex([userSays('a'), userSays('b')]) === 1)

  // The critical filter: of 831 user/message events in 58 real logs only 140
  // are typed by the user. The rest arrive on almost every step, so counting
  // them would find "the user just spoke" always and release the budget forever.
  const runtimeContext = userSays('Current time: 2026-11-05', 'time-context')
  check('a time-context message is not user speech', lastUserMessageIndex([runtimeContext]) === -1, String(lastUserMessageIndex([runtimeContext])))
  check('a runtime-context message is not user speech', lastUserMessageIndex([userSays('cwd', 'runtime-context')]) === -1)
  check('an approval result is not user speech', lastUserMessageIndex([userSays('approved', 'user-approval')]) === -1)
  check('a real message after injected ones is still found',
    lastUserMessageIndex([runtimeContext, userSays('我想做个番茄钟'), userSays('time', 'time-context')]) === 1)
  check('a message with no source counts as the user (older logs)',
    lastUserMessageIndex([{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }]) === 0)

  const spent = [scoutCall('c1'), scoutOk('c1'), scoutCall('c2'), scoutOk('c2')]
  check('two searches with no user message in between spend the budget', scoutBudgetSpent(spent) === true)
  check('one search does not spend it', scoutBudgetSpent([scoutCall('c1'), scoutOk('c1')]) === false)
  check('nothing searched means nothing spent', scoutBudgetSpent([userSays('hi')]) === false)

  // The release valve: the denial tells the model to ask; the user answers; the
  // next search must be allowed, or "ask first" would be a dead end.
  const afterAnswer = [...spent, userSays('好，你搜吧')]
  check('a user reply after the second search releases the budget', scoutBudgetSpent(afterAnswer) === false)
  check('the released search is one more, not a reset',
    scoutBudgetSpent([...afterAnswer, scoutCall('c3'), scoutOk('c3')]) === true)
  // And an injected context message must NOT release it.
  check('an injected time-context does not release the budget',
    scoutBudgetSpent([...spent, userSays('now', 'time-context')]) === true)

  check('lastScoutCallIndex finds the last search', lastScoutCallIndex(spent) === 2, String(lastScoutCallIndex(spent)))
  check('lastScoutCallIndex ignores other tools',
    lastScoutCallIndex([{ type: 'tool/call', data: { callId: 'x', name: 'rank_candidates' } }]) === -1)
}

console.log('\n=== 6. the guard refuses on budget first, then on the missing sentence ===')
{
  const sessions = new Map()
  const host = fakeHost({ sessions: { get: (id) => sessions.get(id) } })
  index.apply(host.ctx)
  check('one guard is registered', host.guards.length === 1, String(host.guards.length))
  const guard = host.guards[0]
  const execution = (name, id = 's1') => ({ name, agent: { id }, callId: 'now' })

  // Two completed searches, then a silent third attempt: the budget refusal is
  // the one that matters, because "say a sentence and retry" would be refused
  // again immediately.
  sessions.set('s1', sessionWith([
    scoutCall('c1'), scoutOk('c1'), scoutCall('c2'), scoutOk('c2'),
  ]))
  const budgetDenial = guard(execution('scout_projects'))
  check('the third silent search is refused', typeof budgetDenial === 'string', String(budgetDenial))
  check('the refusal is the budget one, not the announcement one',
    budgetDenial === activation.BUDGET_DENIAL, String(budgetDenial).slice(0, 80))

  // Even a properly announced search is refused once the budget is spent: the
  // budget is a harder stop than the announcement rule.
  sessions.set('s1', sessionWith([
    scoutCall('c1'), scoutOk('c1'), scoutCall('c2'), scoutOk('c2'),
    { type: 'turn/start', data: { turn: 3 } },
    assistantText('我再搜一下。'),
  ]))
  check('an announced search is still refused when the budget is spent',
    guard(execution('scout_projects')) === activation.BUDGET_DENIAL)

  // The user answered, so one more is released — and that one still needs the
  // announcement, which is the ordinary rule.
  sessions.set('s1', sessionWith([
    scoutCall('c1'), scoutOk('c1'), scoutCall('c2'), scoutOk('c2'),
    userSays('好，你搜吧'),
    { type: 'turn/start', data: { turn: 3 } },
  ]))
  check('the released search still needs a sentence',
    guard(execution('scout_projects')) === activation.ANNOUNCEMENT_DENIAL)
  sessions.set('s1', sessionWith([
    scoutCall('c1'), scoutOk('c1'), scoutCall('c2'), scoutOk('c2'),
    userSays('好，你搜吧'),
    { type: 'turn/start', data: { turn: 3 } },
    assistantText('好，我再去小搜一下。'),
  ]))
  check('the released search passes after a sentence', guard(execution('scout_projects')) === undefined, String(guard(execution('scout_projects'))))

  // The refusal must not leak onto the other three tools.
  sessions.set('s1', sessionWith([scoutCall('c1'), scoutOk('c1'), scoutCall('c2'), scoutOk('c2')]))
  check('rank_candidates is never refused', guard(execution('rank_candidates')) === undefined)
  check('inspect_projects is never refused', guard(execution('inspect_projects')) === undefined)
  check('read_repo_files is never refused', guard(execution('read_repo_files')) === undefined)

  // Still fails open where it cannot judge.
  sessions.delete('s1')
  check('an unknown session fails open', guard(execution('scout_projects')) === undefined)
  sessions.set('s1', { snapshotEvents: () => { throw new Error('gone') } })
  check('an unreadable log fails open', guard(execution('scout_projects')) === undefined)
}

console.log('\n=== 7. autoScout "off" advertises nothing and refuses nothing ===')
{
  const sessions = new Map()
  const host = fakeHost({ sessions: { get: (id) => sessions.get(id) } })
  index.apply(host.ctx, { autoScout: 'off' })

  check('no system-prompt section is registered', host.sections.length === 0, String(host.sections.length))
  check('no guard is registered', host.guards.length === 0, String(host.guards.length))
  check('the four tools are still registered', host.defs.size === 4, [...host.defs.keys()].join(', '))

  // "off" means "do not advertise", not "uninstall": a user who asks for a
  // search by hand must still get one, so the tool executes normally.
  check('scout_projects is still callable', typeof host.defs.get('scout_projects')?.execute === 'function')

  // And a host that supplies nothing gets the default behaviour back.
  const fallback = fakeHost({ sessions: { get: () => undefined } })
  index.apply(fallback.ctx, { autoScout: 'bogus' })
  check('an unvalidated bogus config falls back to the default, not to off',
    fallback.sections.length === 1 && fallback.guards.length === 1,
    `${fallback.sections.length} sections / ${fallback.guards.length} guards`)
}

console.log('\n=== 8. autoScout "ask" swaps the guidance, keeps the mechanics ===')
{
  const askHost = fakeHost()
  index.apply(askHost.ctx, { autoScout: 'ask' })
  check('a section is still registered in ask mode', askHost.sections.length === 1, String(askHost.sections.length))
  const askText = askHost.sections[0].text({ scope: undefined })
  check('the ask section says to ask first', /ASK FIRST/.test(askText), askText.slice(0, 200))
  check('the ask section still names the trigger situations', askText.includes('我想做个番茄钟') && askText.includes('要是有个'), askText.slice(0, 300))
  check('the ask section still names the four boundaries',
    /already building/.test(askText) && /already searched/.test(askText) && /technical Q&A/.test(askText) && /said not to search/.test(askText))
  check('the ask section does not promise unprompted searching', !/At most two unprompted searches/.test(askText), askText.slice(-300))
  check('the ask section still requires the announcement', /say one short sentence|one short sentence/i.test(askText), askText.slice(-300))
  check('a guard is still registered in ask mode', askHost.guards.length === 1, String(askHost.guards.length))

  const alwaysHost = fakeHost()
  index.apply(alwaysHost.ctx, { autoScout: 'always' })
  const alwaysText = alwaysHost.sections[0].text({ scope: undefined })
  check('the always section keeps the two-search promise', /two unprompted searches/.test(alwaysText))
  check('the always section does not say ASK FIRST', !/ASK FIRST/.test(alwaysText))
  check('the two texts are different', askText !== alwaysText)

  // The default path — no config at all — is "always".
  const defaultHost = fakeHost()
  index.apply(defaultHost.ctx)
  check('no config means the always guidance', defaultHost.sections[0].text({ scope: undefined }) === alwaysText)
}

console.log('\n=== 9. the budget refusal is a usable instruction ===')
{
  const denial = activation.BUDGET_DENIAL
  check('it says the budget is spent', /already run 2 unprompted searches/.test(denial), denial)
  check('it says to stop and ask', /Stop and ask the user/.test(denial), denial)
  check('it says what to ask', /what you would look for and why/.test(denial), denial)
  check('it says to wait for the answer', /wait for their answer/.test(denial), denial)
  check('it says the user-approved search is free', /not charged to this budget/.test(denial), denial)
  check('it is not the announcement refusal', denial !== activation.ANNOUNCEMENT_DENIAL)
}

console.log('\n=== 10. the real cordis host validates Config and honours it ===')
{
  // The end-to-end contract: a host that reads `Config` validates the user's
  // config, and `apply` receives the validated value. This drives a real cordis
  // Context rather than a fake, because the fake cannot prove the schema is
  // shaped the way cordis consumes it.
  const { Context } = await import('@deepseek-ai/cordis')
  const sections = []
  const guards = []
  const defs = new Map()

  const makeCtx = () => {
    const ctx = new Context()
    ctx.provide('tools', {
      register: (d) => { defs.set(d.name, d); return () => {} },
      guard: (g) => { guards.push(g); return () => {} },
      // A tool runtime that KNOWS its tools: the section text is a visibility
      // provider, so a runtime answering undefined for every name renders ''
      // and the assertion below would pass on an empty string.
      get: (name) => (name === 'scout_projects' ? { name } : undefined),
    })
    ctx.provide('systemPrompt', { section: (s) => { sections.push(s); return () => {} } })
    return ctx
  }

  // A valid config reaches apply.
  makeCtx().plugin(index, { autoScout: 'ask' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('the host loaded the plugin', defs.size === 4, [...defs.keys()].join(', '))
  check('the configured mode reached the section', sections.length === 1, String(sections.length))
  const text = sections[0]?.text?.({ scope: undefined }) ?? ''
  check('the ask guidance is what got registered', /ASK FIRST/.test(text), text.slice(0, 160))

  // A typo must fail the plugin load rather than silently default.
  const sectionsBefore = sections.length
  let threw = false
  try {
    makeCtx().plugin(index, { autoScout: 'bogus' })
    await new Promise((resolve) => setTimeout(resolve, 20))
  } catch {
    threw = true
  }
  check('an invalid config fails the plugin load', threw || sections.length === sectionsBefore,
    `threw=${threw} sections=${sections.length - sectionsBefore}`)
  // The schema has to be on the entry module's namespace: when `runtime.Config`
  // is undefined cordis passes the raw config through with no validation at all.
  // Measured: before this export existed, `plugin(index, {autoScout:'bogus'})`
  // loaded happily and registered the default guidance.
  check('the entry module exports the schema cordis reads', typeof index.Config?.['~standard']?.validate === 'function',
    String(typeof index.Config))
}

console.log('\n=== 11. the source keeps the two halves honest ===')
{
  check('the mode constants live in their own module', typeof readSrc('brief.ts') === 'string')
  check('apply imports the framing helper', /from '\.\/brief\.ts'/.test(readSrc('index.ts')))
  check('the scout render frames by mode', /frameScoutResult\(card, scoutModeOf\(args\), prior\)/.test(readSrc('index.ts')))
  check('apply reads the config', /resolveAutoScout\(config\)/.test(readSrc('index.ts')))
  check('the budget constant is exported for the test to pin', /export const MAX_UNPROMPTED_SEARCHES = 2/.test(readSrc('activation.ts')))
  check('the config is hand-written, with no schemastery import',
    /export const Config = \{/.test(readSrc('activation.ts')) && !/from '@deepseek-ai\/schemastery'/.test(readSrc('activation.ts')))
  check('the entry module re-exports the schema cordis reads', /export \{ Config \} from '\.\/activation\.ts'/.test(readSrc('index.ts')))
  check('the package still declares no runtime dependencies',
    Object.keys(JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).dependencies ?? {}).length === 0)
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
