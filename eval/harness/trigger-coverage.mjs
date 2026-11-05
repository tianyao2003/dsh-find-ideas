// Does the shipped prompt section actually name the situations users phrase?
//
// WHY THIS EXISTS
// ---------------
// v0.5.0 moved the activation surface from "the user said GitHub" to "the user
// has an idea", carried by the system-prompt section `SCOUT_GUIDANCE`. That
// section is prose, and prose drifts: an edit that reads better can quietly drop
// the "already building" boundary, the "said not to search" boundary, or the
// Chinese examples the trigger depends on. Nothing else in this repository reads
// that text against a fixed set of situations, so a regression there is silent
// and only shows up as a real user's idea going unsearched.
//
// `eval/trigger/corpus.mjs` freezes the situations as labelled cases, each with
// `promptSignal` — exact substrings the section must contain for that case to
// count as covered. This script re-checks them on every run and prints a
// per-category table so a gap names the category it broke, not just a count.
//
// WHAT THIS PROVES
// ----------------
// The shipped section contains, verbatim, the phrasing that names every
// situation in the corpus, and the corpus itself is well-formed (size, category
// coverage, unique ids, category/expect agreement, the three phrasings the
// original user report used). It is a coverage check on TEXT, recomputed offline
// over a frozen corpus — no model, no network, no session.
//
// WHAT THIS DOES NOT PROVE
// ------------------------
// It does NOT prove a model will classify these messages correctly. Substring
// presence is not comprehension: a section can contain "already building" and a
// model can still search. That question needs a model-in-the-loop run (replay
// the corpus through a live session and record whether `scout_projects` fired),
// which this repository does not do offline. Treat a green run as "the prompt
// did not lose a named situation", never as "the trigger works".
//
// Usage:
//   node eval/harness/trigger-coverage.mjs
//   node eval/harness/trigger-coverage.mjs --verbose
//   node eval/harness/trigger-coverage.mjs --json
import { TRIGGER_CASES } from '../trigger/corpus.mjs'
import { SCOUT_GUIDANCE } from '../../lib/activation.js'

const argv = process.argv.slice(2)
const VERBOSE = argv.includes('--verbose')
const JSON_OUT = argv.includes('--json')

// The 11 categories are fixed. Order is meaningful: the first six are the
// situations where an unprompted search is correct, the last five are the
// boundaries where it is not (capability-question is the odd one: no idea
// exists yet, so the answer is to OFFER the capability, not to search).
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
const MIN_CASES = 26
const MIN_PER_CATEGORY = 2

// The three sentences from the original user report. They are in the corpus
// verbatim, under these categories; losing any of them means the corpus no
// longer contains the evidence that motivated the whole activation surface.
const REPORTER_PHRASINGS = [
  { text: '我想制作一个番茄钟你有什么建议嘛', category: 'idea-plus-advice' },
  { text: '你可以帮我做什么嘛', category: 'capability-question' },
  { text: '你可以去帮我查下我该怎么做嘛', category: 'explicit-search-request' },
]

// --- shape rules: the corpus must stay a usable corpus ----------------------
const shapeProblems = []
const ids = new Set()
const seenPhrasings = new Map()

if (!Array.isArray(TRIGGER_CASES)) {
  shapeProblems.push('TRIGGER_CASES is not an array')
} else {
  if (TRIGGER_CASES.length < MIN_CASES) {
    shapeProblems.push(`corpus has ${TRIGGER_CASES.length} cases, needs at least ${MIN_CASES}`)
  }
  for (const c of TRIGGER_CASES) {
    if (c === null || typeof c !== 'object') {
      shapeProblems.push('a case is not an object')
      continue
    }
    if (typeof c.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) {
      shapeProblems.push(`case id is not short kebab-case: ${JSON.stringify(c.id)}`)
    } else if (ids.has(c.id)) {
      shapeProblems.push(`duplicate case id: ${c.id}`)
    } else {
      ids.add(c.id)
    }
    if (!CATEGORIES.includes(c.category)) {
      shapeProblems.push(`${c.id}: unknown category ${JSON.stringify(c.category)}`)
    }
    if (c.expect !== 'search' && c.expect !== 'no-search') {
      shapeProblems.push(`${c.id}: expect must be 'search' or 'no-search', got ${JSON.stringify(c.expect)}`)
    } else if (EXPECT_BY_CATEGORY.has(c.category) && c.expect !== EXPECT_BY_CATEGORY.get(c.category)) {
      shapeProblems.push(`${c.id}: category ${c.category} must expect ${EXPECT_BY_CATEGORY.get(c.category)}, got ${c.expect}`)
    }
    if (typeof c.text !== 'string' || c.text.trim() === '') {
      shapeProblems.push(`${c.id}: text is empty`)
    }
    if (typeof c.why !== 'string' || c.why.trim() === '') {
      shapeProblems.push(`${c.id}: why is empty`)
    }
    if (!Array.isArray(c.promptSignal) || c.promptSignal.length < 1 || c.promptSignal.length > 3) {
      shapeProblems.push(`${c.id}: promptSignal must be an array of 1-3 strings`)
    } else if (!c.promptSignal.every((s) => typeof s === 'string' && s.length > 0)) {
      shapeProblems.push(`${c.id}: promptSignal contains a non-string or empty entry`)
    }
    if (typeof c.text === 'string') seenPhrasings.set(c.text, c)
  }
  for (const cat of CATEGORIES) {
    const n = TRIGGER_CASES.filter((c) => c.category === cat).length
    if (n < MIN_PER_CATEGORY) shapeProblems.push(`category ${cat} has ${n} cases, needs at least ${MIN_PER_CATEGORY}`)
  }
  for (const want of REPORTER_PHRASINGS) {
    const hit = seenPhrasings.get(want.text)
    if (hit === undefined) {
      shapeProblems.push(`reporter phrasing missing from corpus: ${JSON.stringify(want.text)}`)
    } else if (hit.category !== want.category) {
      shapeProblems.push(`reporter phrasing ${JSON.stringify(want.text)} is ${hit.category}, expected ${want.category}`)
    }
  }
}

// --- coverage: every signal must occur verbatim in the shipped section ------
const results = []
for (const c of TRIGGER_CASES) {
  const missing = c.promptSignal.filter((sig) => !SCOUT_GUIDANCE.includes(sig))
  results.push({ id: c.id, category: c.category, expect: c.expect, covered: missing.length === 0, missing })
}

const covered = results.filter((r) => r.covered).length
const searchResults = results.filter((r) => r.expect === 'search')
const noSearchResults = results.filter((r) => r.expect === 'no-search')
const searchCovered = searchResults.filter((r) => r.covered).length
const noSearchCovered = noSearchResults.filter((r) => r.covered).length
const uncovered = results.filter((r) => !r.covered)
const ok = uncovered.length === 0 && shapeProblems.length === 0

const categories = CATEGORIES.map((cat) => {
  const rows = results.filter((r) => r.category === cat)
  return {
    category: cat,
    cases: rows.length,
    search: rows.filter((r) => r.expect === 'search').length,
    noSearch: rows.filter((r) => r.expect === 'no-search').length,
    covered: rows.filter((r) => r.covered).length,
  }
})

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok,
    guidanceChars: SCOUT_GUIDANCE.length,
    totals: {
      cases: results.length,
      covered,
      search: { total: searchResults.length, covered: searchCovered },
      noSearch: { total: noSearchResults.length, covered: noSearchCovered },
    },
    categories,
    uncovered,
    shapeProblems,
  }, null, 2))
  process.exit(ok ? 0 : 1)
}

// --- human-readable report --------------------------------------------------
console.log('=== trigger coverage: does the shipped section name every situation? ===')
console.log('')
console.log(`  corpus   : ${results.length} cases across ${CATEGORIES.length} categories`)
console.log(`  guidance : ${SCOUT_GUIDANCE.length} chars from lib/activation.js`)
console.log('')

const pad = (s, n) => String(s).padEnd(n)
console.log(`  ${pad('category', 24)} ${pad('cases', 5)} ${pad('search', 6)} ${pad('no-search', 9)} covered`)
for (const row of categories) {
  console.log(`  ${pad(row.category, 24)} ${pad(row.cases, 5)} ${pad(row.search, 6)} ${pad(row.noSearch, 9)} ${row.covered}/${row.cases}`)
}
console.log('')

if (VERBOSE) {
  console.log('--- cases ---')
  for (const r of results) {
    const mark = r.covered ? 'covered  ' : 'UNCOVERED'
    console.log(`  ${mark}  ${pad(r.category, 24)} ${pad(r.expect, 10)} ${r.id}`)
    if (!r.covered) {
      for (const sig of r.missing) console.log(`             missing signal: ${JSON.stringify(sig)}`)
    }
  }
  console.log('')
}

console.log(`  covered ${covered}/${results.length} cases`)
console.log(`  search cases covered ${searchCovered}/${searchResults.length}`)
console.log(`  no-search cases covered ${noSearchCovered}/${noSearchResults.length}`)

if (shapeProblems.length > 0) {
  console.log('')
  console.log(`  corpus shape problems (${shapeProblems.length}):`)
  for (const p of shapeProblems) console.log(`    - ${p}`)
}

if (uncovered.length > 0) {
  console.log('')
  console.log(`  uncovered cases (${uncovered.length}):`)
  for (const r of uncovered) {
    console.log(`    - ${r.id} [${r.category}]`)
    for (const sig of r.missing) console.log(`        missing in SCOUT_GUIDANCE: ${JSON.stringify(sig)}`)
  }
}

console.log('')
if (ok) {
  console.log('  result: the shipped guidance names every situation in the corpus')
} else {
  console.log('  result: FAILED — the guidance or the corpus must be fixed')
}
process.exit(ok ? 0 : 1)
