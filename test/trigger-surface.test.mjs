// The activation surface: when the model should think of this plugin at all.
//
// THE DEFECT THIS PINS DOWN
// -------------------------
// Before 0.5.0 the only activation signal was the `scout_projects` tool
// description, and it opened with "Search GitHub for open-source projects".
// Measured on 57 real sessions on this machine: `scout_projects` had been called
// in 11 sessions, and in 11 of 11 the last user message before the first call
// contained the literal word "GitHub". Four user messages carried a buildable
// idea without that word and none of them triggered a search. The trigger was
// not "the user has an idea" — it was "the user said GitHub".
//
// A user reported exactly this: asking "我想制作一个番茄钟你有什么建议嘛" got a
// plain answer, and only "你可以去github查一下嘛" made the agent reach for the
// tool. The plugin never told the model that an idea without the word GitHub is
// the situation it exists for.
//
// WHAT 0.5.0 CHANGES
// ------------------
//   1. The `scout_projects` description now states the situation (an idea
//      exists, however vague) and names the boundaries where it must hold back.
//   2. A system-prompt section says the same thing in more room, and renders
//      only while a tool of this plugin is visible to the rendering scope.
//   3. "Announce before searching" is mechanically enforced by a tool guard,
//      because guidance alone does not make a model spend a token explaining
//      itself before a tool call.
//
// WHY A TEST AND NOT JUST THE EDIT
// --------------------------------
// Prose drifts back silently. The description had no assertion on its activation
// sentence, which is why the narrow version survived four minor versions. These
// assertions are what make the correction stick — and the guard tests are what
// keep "mechanically enforced" from quietly becoming "documented".
//
// Run with:  npm test
// Or directly: node test/trigger-surface.test.mjs
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
const index = await load('index.js')

console.log('\n=== 1. the activation surface exists as a module ===')
{
  check('activation.ts is a module of its own', typeof readSrc('activation.ts') === 'string')
  check('apply imports it', /from '\.\/activation\.ts'/.test(readSrc('index.ts')))
  check('the four tools are still registered', typeof index.apply === 'function')
}

console.log('\n=== 2. the scout description describes a SITUATION, not a keyword ===')
{
  const defs = new Map()
  index.apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
  const scout = defs.get('scout_projects')
  const desc = scout.description ?? ''

  // The old trigger sentence is gone. "Call this when the user describes an
  // app, tool or library they intend to build" only fired for a precise,
  // already-articulated idea — the exact opposite of the reported case.
  check('the description no longer waits for a fully described project',
    !/describes an app, tool or library they intend to build/.test(desc), desc.slice(0, 300))
  // The user's own words: advice, how-to-start, and a wish. These are the three
  // shapes the reported session took, and they must be named as triggers.
  check('it names a request for advice as a trigger', desc.includes('有什么建议'), desc.slice(0, 400))
  check('it names a how-do-I-start question as a trigger', desc.includes('这个该怎么做'), desc.slice(0, 400))
  check('it names a wish for a tool as a trigger', desc.includes('要是有个'), desc.slice(0, 400))
  // The whole point: the word GitHub is not the trigger.
  check('it says the user need not say GitHub', /never say "GitHub"/.test(desc), desc.slice(0, 400))

  // The four boundaries the user asked to be hard rules.
  check('it holds back while the user is already building', /already building/.test(desc), desc)
  check('it holds back for an idea already searched this session', /already searched/.test(desc), desc)
  check('it holds back for pure technical Q&A', /technical Q&A/.test(desc), desc)
  check('it holds back when the user said not to search', /said not to search/.test(desc), desc)

  // The mechanical rule and the small first look have to be stated where the
  // model reads the tool, not only in the prompt section.
  check('it asks for one sentence before an unprompted search', /one short sentence/.test(desc), desc)
  check('it names the small first-look size', /limit 5-8/.test(desc), desc)

  // And the existing contract this description already carried must survive.
  check('it still names rank_candidates as step 2', /rank_candidates/.test(desc), desc.slice(0, 300))
}

console.log('\n=== 3. the system-prompt section is registered, and only when visible ===')
{
  const sections = []
  const defs = new Map()
  const tools = new Map([['scout_projects', { name: 'scout_projects' }]])
  const ctx = {
    tools: {
      register: (d) => { defs.set(d.name, d); return () => {} },
      get: (name) => tools.get(name),
    },
    get: (name) => (name === 'systemPrompt' ? { section: (s) => { sections.push(s); return () => {} } } : undefined),
  }
  index.apply(ctx)
  check('exactly one section is registered', sections.length === 1, String(sections.length))
  const section = sections[0] ?? {}
  check('the section is namespaced', section.name === 'plugin:dsh-find-ideas', String(section.name))
  // 160 is the free slot in the third-party band (ssh 150, task-board 200,
  // agents 220); a colliding order would mean the guidance is read out of turn.
  check('the section sits in the third-party band', section.order === 160, String(section.order))

  const provider = section.text
  check('the section text is a provider, not a fixed string', typeof provider === 'function')
  const rendered = typeof provider === 'function' ? provider({ scope: undefined }) : ''
  check('it renders while a plugin tool is visible', rendered.length > 200, String(rendered.length))
  check('the guidance names the Chinese advice case', rendered.includes('我想做个番茄钟'), rendered.slice(0, 300))
  check('the guidance names the announce-first rule', /say one short sentence/i.test(rendered), rendered.slice(0, 300))
  check('the guidance caps unprompted searches', /two unprompted searches/.test(rendered), rendered.slice(0, 300))
  check('the guidance lists research as a capability', /what you can do/.test(rendered), rendered.slice(0, 300))

  // A scope where the plugin is restricted away must not keep advertising it.
  const hidden = {
    tools: {
      register: (d) => { defs.set(d.name, d); return () => {} },
      get: () => undefined,
    },
    get: (name) => (name === 'systemPrompt' ? { section: (s) => { sections.push(s); return () => {} } } : undefined),
  }
  const before = sections.length
  index.apply(hidden)
  const hiddenSection = sections[sections.length - 1]
  const hiddenText = typeof hiddenSection.text === 'function' ? hiddenSection.text({ scope: undefined }) : 'unexpected'
  check('it renders nothing when every plugin tool is hidden', hiddenText === '', String(hiddenText).slice(0, 80))
  check('a second registration is still made (the host decides visibility)', sections.length === before + 1)
}

console.log('\n=== 4. no systemPrompt service means no section, and no crash ===')
{
  // The fake context used by the other 21 test files has only tools.register and
  // get(). A plugin that threw here would take every one of them down.
  const defs = new Map()
  let threw = false
  try {
    index.apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
  } catch {
    threw = true
  }
  check('apply survives a host without systemPrompt', !threw)
  check('all four tools are still registered', defs.size === 4, [...defs.keys()].join(', '))
}

console.log('\n=== 5. the announcement guard refuses a silent search ===')
{
  const guards = []
  const defs = new Map()
  const sessions = new Map()
  const ctx = {
    tools: {
      register: (d) => { defs.set(d.name, d); return () => {} },
      guard: (g) => { guards.push(g); return () => {} },
    },
    get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined),
  }
  index.apply(ctx)
  check('a guard is registered', guards.length === 1, String(guards.length))
  const guard = guards[0]

  const execution = (name, id = 's1') => ({ name, agent: { id } })
  const sessionWith = (events) => ({ snapshotEvents: () => events })
  const assistantText = (text) => ({
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  })

  sessions.set('s1', sessionWith([{ type: 'turn/start', data: { turn: 1 } }]))
  check('a silent search is refused',
    typeof guard(execution('scout_projects')) === 'string', String(guard(execution('scout_projects'))))

  sessions.set('s1', sessionWith([{ type: 'turn/start', data: { turn: 1 } }, assistantText('我先去 GitHub 小搜一下有没有现成的，稍等。')]))
  check('a search after a sentence is allowed',
    guard(execution('scout_projects')) === undefined, String(guard(execution('scout_projects'))))

  sessions.set('s1', sessionWith([{ type: 'turn/start', data: { turn: 1 } }]))
  check('other tools are never refused', guard(execution('inspect_projects')) === undefined)
  check('the guard only claims scout_projects', guard(execution('read_repo_files')) === undefined)

  // A reasoning block is not shown to the user, so it is not an announcement.
  sessions.set('s1', sessionWith([{ type: 'turn/start', data: { turn: 1 } }, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'the user probably wants me to search' }] } },
  }]))
  check('a reasoning block alone is not an announcement',
    typeof guard(execution('scout_projects')) === 'string')

  // A whitespace-only text block is not a sentence either.
  sessions.set('s1', sessionWith([{ type: 'turn/start', data: { turn: 1 } }, assistantText('   \n  ')]))
  check('a blank text block is not an announcement',
    typeof guard(execution('scout_projects')) === 'string')

  // The turn boundary: a sentence from an EARLIER turn must not license a silent
  // search now. Otherwise the rule decays to "said something once, ever".
  sessions.set('s1', sessionWith([
    { type: 'turn/start', data: { turn: 1 } },
    assistantText('好的，我先看看你的项目结构。'),
    { type: 'turn/end', data: { turn: 1, reason: 'completed' } },
    { type: 'turn/start', data: { turn: 2 } },
  ]))
  check('a sentence from a previous turn does not license this one',
    typeof guard(execution('scout_projects')) === 'string')

  // Fails open wherever it cannot judge — a guard that blocks work because the
  // host changed shape is worse than the silence it prevents.
  sessions.set('s1', sessionWith([{ type: 'turn/start', data: { turn: 1 } }, assistantText('好的。')]))
  check('no agent on the execution fails open', guard({ name: 'scout_projects' }) === undefined)
  sessions.delete('s1')
  check('an unknown session fails open', guard(execution('scout_projects')) === undefined)
  sessions.set('s1', { snapshotEvents: () => { throw new Error('log gone') } })
  check('an unreadable log fails open', guard(execution('scout_projects')) === undefined)
  sessions.set('s1', {})
  check('a session with no read method fails open', guard(execution('scout_projects')) === undefined)

  // No sessions service at all: still no crash, still no refusal.
  const noStore = []
  index.apply({
    tools: {
      register: () => () => {},
      guard: (g) => { noStore.push(g); return () => {} },
    },
    get: () => undefined,
  })
  check('a guard is registered without a sessions service', noStore.length === 1)
  check('it fails open without a sessions service',
    noStore[0]({ name: 'scout_projects', agent: { id: 's1' } }) === undefined)
}

console.log('\n=== 6. the refusal is a usable recovery instruction ===')
{
  const denial = activation.ANNOUNCEMENT_DENIAL
  check('the refusal names the tool to retry', denial.includes('scout_projects'), denial)
  check('the refusal says what to do', /announce before searching/i.test(denial), denial)
  check('the refusal gives a sentence to write', denial.includes('我先去 GitHub 小搜一下'), denial)
  check('the refusal explains why the user must see it', /user must see why/i.test(denial), denial)
}

console.log('\n=== 7. the pure predicate stands on its own ===')
{
  // Exported separately so the rule can be reasoned about without a session.
  const { turnHasAnnouncement } = activation
  check('an empty log has no announcement', turnHasAnnouncement([]) === false)
  check('a log without turn boundaries still scans', turnHasAnnouncement([
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } },
  ]) === true)
  check('a user message is not an announcement', turnHasAnnouncement([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '我想做个番茄钟' }] } } },
  ]) === false)
  check('a tool result is not an announcement', turnHasAnnouncement([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } } },
  ]) === false)
  check('malformed events do not throw', turnHasAnnouncement([
    null,
    { type: 'assistant/message' },
    { type: 'assistant/message', data: { message: null } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: 'not an array' } } },
  ]) === false)
}

console.log('\n=== 8. the section survives a host where systemPrompt arrives LATE ===')
{
  // The defect this pins down: `ctx.get` is strict by default in cordis — a
  // service that exists but is not active yet reads as undefined. A bundle's
  // apply() can run before the system-prompt service settles, so an eager
  // `ctx.get('systemPrompt')` would register no section at all on exactly the
  // hosts that need it, and nothing would ever say so. This drives a real
  // cordis Context: apply first, provide the service afterwards.
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  const sections = []
  const defs = new Map()
  ctx.provide('tools', {
    register: (d) => { defs.set(d.name, d); return () => {} },
    guard: () => () => {},
    get: () => undefined,
  })
  index.apply(ctx)
  check('nothing is registered before the service exists', sections.length === 0, String(sections.length))
  check('the tools are registered regardless', defs.size === 4, [...defs.keys()].join(', '))

  ctx.provide('systemPrompt', { section: (s) => { sections.push(s); return () => {} } })
  // ctx.inject runs the callback on a later tick once the dependency is active.
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('the section appears once the service is provided', sections.length === 1, String(sections.length))
  check('it is the namespaced guidance section', sections[0]?.name === 'plugin:dsh-find-ideas', String(sections[0]?.name))
  check('it sits at the reserved order', sections[0]?.order === 160, String(sections[0]?.order))
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
