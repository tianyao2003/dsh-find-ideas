// The trigger corpus must stay a corpus, and the shipped guidance must cover it.
//
// THE DEFECT THIS PINS DOWN
// -------------------------
// v0.5.0 replaced "the user said GitHub" with "the user has an idea" as the
// activation trigger, and put that policy in prose: the `SCOUT_GUIDANCE` system
// section plus the `scout_projects` description. Prose is edited by hand and
// nothing else in this repository reads it against a fixed set of situations, so
// an edit that reads better can silently drop the "already building" boundary or
// one of the Chinese example sentences the trigger leans on. The failure is
// invisible in CI and shows up as a real user's idea going unsearched.
//
// WHAT IS FROZEN HERE
// -------------------
// `eval/trigger/corpus.mjs` holds labelled user phrasings — the six situations
// where an unprompted search is right, the five where it is not — each carrying
// exact substrings the guidance must contain. `eval/harness/trigger-coverage.mjs`
// is the canonical runner over that corpus; this test repeats its coverage
// predicate (six lines, deliberately duplicated rather than imported, because the
// harness is a script with a top-level `process.exit`) and adds the corpus shape
// rules, the reporter's three original sentences, and the session-budget promise.
//
// WHAT THIS DOES NOT PROVE
// ------------------------
// Substring presence is not comprehension. A green run says the shipped section
// still names every situation in the corpus; it does not say a model will
// classify a new message correctly. That needs a model-in-the-loop replay, which
// this repository does not do offline.
//
// Run with:  npm test
// Or directly: node test/trigger-corpus.test.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

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

const { TRIGGER_CASES } = await import(pathToFileURL(join(pkgRoot, 'eval', 'trigger', 'corpus.mjs')).href)
const { SCOUT_GUIDANCE } = await load('activation.js')

// The corpus contract. The six leading categories are situations where an
// unprompted search is correct; the last five are boundaries where it is not.
const CATEGORIES = [
  'idea-plus-advice',
  'vague-idea',
  'wish-for-a-tool',
  'how-to-start',
  'explicit-github',
  'explicit-search-request',
  'capability-question',
  'pure-technical-qa',
  'already-building',
  'already-searched',
  'user-said-no',
]
const SEARCH_CATEGORIES = new Set(CATEGORIES.slice(0, 6))
const EXPECT_BY_CATEGORY = new Map(CATEGORIES.map((c) => [c, SEARCH_CATEGORIES.has(c) ? 'search' : 'no-search']))
const REPORTER_PHRASINGS = [
  { text: '我想制作一个番茄钟你有什么建议嘛', category: 'idea-plus-advice' },
  { text: '你可以帮我做什么嘛', category: 'capability-question' },
  { text: '你可以去帮我查下我该怎么做嘛', category: 'explicit-search-request' },
]

console.log('\n=== 1. the corpus is a corpus (size, categories, ids, expectations) ===')
{
  check('TRIGGER_CASES is an array', Array.isArray(TRIGGER_CASES))
  const cases = Array.isArray(TRIGGER_CASES) ? TRIGGER_CASES : []
  check(`it has at least 26 cases`, cases.length >= 26, `${cases.length} cases`)

  const known = new Set(CATEGORIES)
  const unknown = cases.filter((c) => !known.has(c?.category))
  check('every category is one of the 11 fixed strings', unknown.length === 0,
    unknown.map((c) => String(c?.category)).join(', '))

  const missingCategories = CATEGORIES.filter((cat) => !cases.some((c) => c?.category === cat))
  check('all 11 categories are present', missingCategories.length === 0, missingCategories.join(', '))

  const thin = CATEGORIES
    .map((cat) => [cat, cases.filter((c) => c?.category === cat).length])
    .filter(([, n]) => n < 2)
  check('every category has at least 2 cases', thin.length === 0,
    thin.map(([cat, n]) => `${cat}=${n}`).join(', '))

  const ids = cases.map((c) => c?.id)
  const unique = new Set(ids)
  check('ids are unique', unique.size === ids.length, `${ids.length} ids, ${unique.size} unique`)
  const badIds = ids.filter((id) => typeof id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))
  check('ids are short kebab-case', badIds.length === 0, badIds.map(String).join(', '))

  const badExpect = cases.filter((c) => c?.expect !== 'search' && c?.expect !== 'no-search')
  check('every expect is "search" or "no-search"', badExpect.length === 0,
    badExpect.map((c) => `${c?.id}=${String(c?.expect)}`).join(', '))

  // The label must follow the category, not be set per case: capability-question
  // is 'no-search' precisely because there is no idea yet to search for.
  const wrongExpect = cases.filter((c) => EXPECT_BY_CATEGORY.has(c?.category) && c.expect !== EXPECT_BY_CATEGORY.get(c.category))
  check('expect agrees with the category', wrongExpect.length === 0,
    wrongExpect.map((c) => `${c?.id}: ${c?.category} must be ${EXPECT_BY_CATEGORY.get(c?.category)}`).join(', '))

  const emptyText = cases.filter((c) => typeof c?.text !== 'string' || c.text.trim() === '')
  check('every case has message text', emptyText.length === 0, emptyText.map((c) => String(c?.id)).join(', '))
  const emptyWhy = cases.filter((c) => typeof c?.why !== 'string' || c.why.trim() === '')
  check('every case has a why', emptyWhy.length === 0, emptyWhy.map((c) => String(c?.id)).join(', '))

  const badSignals = cases.filter((c) => !Array.isArray(c?.promptSignal) || c.promptSignal.length < 1 || c.promptSignal.length > 3)
  check('every promptSignal is an array of 1-3 entries', badSignals.length === 0,
    badSignals.map((c) => String(c?.id)).join(', '))
  const nonString = cases.flatMap((c) => (Array.isArray(c?.promptSignal) ? c.promptSignal : [])
    .filter((s) => typeof s !== 'string' || s.length === 0)
    .map((s) => `${c?.id}=${JSON.stringify(s)}`))
  check('every promptSignal entry is a non-empty string', nonString.length === 0, nonString.join(', '))
}

console.log('\n=== 2. the shipped guidance covers 100% of the corpus ===')
{
  // The canonical runner is `node eval/harness/trigger-coverage.mjs`; this is
  // the same predicate duplicated so a regression fails the test suite too.
  const uncovered = TRIGGER_CASES
    .map((c) => ({ id: c.id, missing: c.promptSignal.filter((sig) => !SCOUT_GUIDANCE.includes(sig)) }))
    .filter((r) => r.missing.length > 0)
  check('every case is covered by SCOUT_GUIDANCE', uncovered.length === 0,
    uncovered.map((r) => `${r.id}: ${JSON.stringify(r.missing)}`).join(' | '))

  const searchCases = TRIGGER_CASES.filter((c) => c.expect === 'search')
  const searchUncovered = searchCases
    .map((c) => ({ id: c.id, missing: c.promptSignal.filter((sig) => !SCOUT_GUIDANCE.includes(sig)) }))
    .filter((r) => r.missing.length > 0)
  check('every search case is covered', searchUncovered.length === 0,
    searchUncovered.map((r) => r.id).join(', '))

  const noSearchCases = TRIGGER_CASES.filter((c) => c.expect === 'no-search')
  const noSearchUncovered = noSearchCases
    .map((c) => ({ id: c.id, missing: c.promptSignal.filter((sig) => !SCOUT_GUIDANCE.includes(sig)) }))
    .filter((r) => r.missing.length > 0)
  check('every no-search case is covered', noSearchUncovered.length === 0,
    noSearchUncovered.map((r) => r.id).join(', '))
}

console.log('\n=== 3. the three sentences from the original user report are present ===')
{
  // These are the evidence the whole activation change rests on: the first was
  // answered without a search, the second named no capability, the third only
  // worked because it said "查". They must stay in the corpus verbatim, under
  // the categories that encode what should happen.
  for (const want of REPORTER_PHRASINGS) {
    const hit = TRIGGER_CASES.find((c) => c.text === want.text)
    check(`reporter phrasing present verbatim: ${want.text}`, hit !== undefined)
    check(`  ... under category ${want.category}`, hit?.category === want.category,
      `got ${String(hit?.category)}`)
    check(`  ... with expect ${EXPECT_BY_CATEGORY.get(want.category)}`, hit?.expect === EXPECT_BY_CATEGORY.get(want.category),
      `got ${String(hit?.expect)}`)
  }
}

console.log('\n=== 4. the guidance still carries the session-budget promise ===')
{
  // The corpus relies on "at most two unprompted searches per session": the
  // 'already-searched' cases are only a boundary because that budget exists and
  // the model is told to ask before exceeding it. Losing the sentence would make
  // those cases assert a rule the prompt no longer states.
  check('the guidance mentions two unprompted searches', /two unprompted searches/.test(SCOUT_GUIDANCE),
    SCOUT_GUIDANCE.slice(0, 200))
  check('the guidance says to ask before searching again', /ask before searching again/.test(SCOUT_GUIDANCE),
    SCOUT_GUIDANCE.slice(0, 200))
}

console.log('\n=== 5. the guidance is the shipped section, not a stand-in ===')
{
  check('SCOUT_GUIDANCE is a non-empty string', typeof SCOUT_GUIDANCE === 'string' && SCOUT_GUIDANCE.length > 200,
    `${typeof SCOUT_GUIDANCE} ${SCOUT_GUIDANCE.length}`)
  // The section is the only surface the corpus asserts against; if the examples
  // move to the tool description, the corpus must move with them.
  check('the guidance carries the Chinese advice example', SCOUT_GUIDANCE.includes('我想做个番茄钟，有什么建议？'))
  check('the guidance carries the wish-for-a-tool example', SCOUT_GUIDANCE.includes('要是有个……就好了'))
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
