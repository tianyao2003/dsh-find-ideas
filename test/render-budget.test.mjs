// Regression tests for the render budget.
//
// The failure this suite pins down, measured end to end in the field:
//
// GitHub does not bound the `description` field. Four repositories in one
// 25-candidate pool carried descriptions of 241,979 / 143,365 / 143,333 /
// 139,284 characters. `renderCandidates` interpolated them verbatim, so a
// single `scout_projects` result reached 674,064 bytes — 99.2% of it those four
// rows, while the other 21 candidates together needed 5,655 bytes. The harness
// truncated the observation and the model silently lost candidates 5-15: the
// 324-2,600 star mid-tier ones it actually needed, because the surviving rows
// were the low-star tail. The resulting card was 6/10 repositories at or below
// 22 stars.
//
// Run with:  npm test
// Or directly: node test/render-budget.test.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { renderCandidates, renderRanked, clipDescription, MAX_DESCRIPTION_CHARS } = await load('render.js')

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

const repo = (full_name, stars, description, extra = {}) => ({
  full_name,
  url: `https://github.com/${full_name}`,
  owner: full_name.split('/')[0],
  name: full_name.split('/')[1],
  description,
  stars,
  language: 'TypeScript',
  pushed_at: '2026-01-01T00:00:00Z',
  archived: false,
  topics: [],
  ...extra,
})

// The four descriptions that caused the blow-up. The byte lengths are the real
// measured values from a live pool; the names are neutral stand-ins, because
// what this test pins down is the size bound, not the identity of the offender.
const SPAM = [
  ['spam/page-scrape-blob', 267, 241979],
  ['spam/keyword-stuffed-a', 371, 143365],
  ['spam/keyword-stuffed-b', 3260, 143333],
  ['spam/keyword-stuffed-c', 2038, 139284],
]

// The real mid-tier candidates that the truncation swallowed.
const MID = [
  ['Reportr/dashboard', 2576, "Your life's personal dashboard."],
  ['onejgordon/flow-dashboard', 1686, '[UNMAINTAINED] A goal, task & habit tracker + personal dashboard to focus on what matters'],
  ['leon-kfd/Dashboard', 1100, 'A personal dashboard for organising bookmarks and services'],
  ['EkiZR/Portofolio_V5', 737, 'A portfolio and personal start page'],
  ['Cloeille/picsou-finance', 529, 'Personal finance tracking dashboard'],
  ['usetrmnl/trmnl-kindle', 446, 'An e-ink dashboard'],
  ['ahmetb/personal-dashboard', 337, ':bar_chart: Programmatically collecting and reporting various stats about myself daily'],
  ['jchultarsky/mirador', 324, 'A self-hosted personal dashboard'],
]

// The tail that survived, and the one honest high-star anchor.
const TAIL = [
  ['lissy93/dashy', 26671, 'A self-hostable personal dashboard built for you. Includes status-checking, widgets, themes, icon packs, a UI editor and tons more!'],
  ['wtfutil/wtf', 17117, 'The personal information dashboard for your terminal'],
  ['Volmarg/personal-management-system', 4170, 'Your web application for managing personal data.'],
  ['initialstate/wunderground-sensehat', 263, 'Tutorial and code for using the Raspberry PI Sense HAT plus a weather API'],
  ['xmynscnq/Simple-Nav-Page', 22, 'A modern personal start page with no server required'],
  ['StartPanelApp/StartPanelApp.github.io', 5, 'A customizable personal browser start page / dashboard'],
  ['yingxiaomo/home', 4, 'A minimalist personal homepage'],
  ['frozendark01/argusapp', 3, 'A lightweight self-hosted personal infrastructure dashboard'],
  ['pal537/Janky-Nav', 2, 'A minimal personal navigation page'],
  ['vivalucas/zpanel', 1, 'A lightweight self-hosted navigation panel'],
  ['LakenH/launchpad', 1, 'Personal "Startpage"/Dashboard'],
  ['Pantrion09/Homely', 1, 'A cozy and aesthetic personal startpage with dark mode and quick links'],
]

// The fifth noise row, unrelated to the idea and rejected at ranking time.
const JUNK = [
  ['Tisha-runwal/Personalized-Federated-Learning-for-Privacy--Preserving-and-Scalable-IoT-Driven-Smart-Healthcare', 266, 'A federated learning framework for privacy-preserving IoT-driven smart healthcare'],
]

const pool = [
  ...SPAM.map(([name, stars, len]) => repo(name, stars, 'x'.repeat(len))),
  ...MID.map(([name, stars, desc]) => repo(name, stars, desc)),
  ...TAIL.map(([name, stars, desc]) => repo(name, stars, desc)),
  ...JUNK.map(([name, stars, desc]) => repo(name, stars, desc)),
]

console.log('--- clipDescription ---')
check('MAX_DESCRIPTION_CHARS is exported and bounded', Number.isInteger(MAX_DESCRIPTION_CHARS) && MAX_DESCRIPTION_CHARS > 0 && MAX_DESCRIPTION_CHARS <= 400, String(MAX_DESCRIPTION_CHARS))

const huge = clipDescription('x'.repeat(241979))
check('a 241,979-char description is clipped to roughly the budget', huge.length <= MAX_DESCRIPTION_CHARS + 40, `got ${huge.length}`)
check('the clip is marked as a truncation', /描述过长/.test(huge), huge.slice(-40))
check('the clip reports the original length', /241979/.test(huge), huge.slice(-40))

const normal = 'A self-hostable personal dashboard built for you. Includes status-checking, widgets, themes, icon packs, a UI editor and tons more!'
check('a normal description is left intact', clipDescription(normal) === normal, clipDescription(normal))

check('newlines are collapsed so the row stays one line', !/\n/.test(clipDescription('line one\nline two')), JSON.stringify(clipDescription('line one\nline two')))
check('empty stays empty', clipDescription('') === '')
check('a description exactly at the budget is not marked truncated', !/描述过长/.test(clipDescription('y'.repeat(MAX_DESCRIPTION_CHARS))))

console.log('\n--- renderCandidates on the real 25-candidate pool ---')
const rendered = renderCandidates('个人工作台网页项目', pool, null, false, 8)
const bytes = Buffer.byteLength(rendered, 'utf8')
const rawBytes = pool.reduce((sum, c) => sum + Buffer.byteLength(c.description, 'utf8'), 0)

check('every candidate is still rendered', (rendered.match(/https:\/\/github\.com\//g) ?? []).length === 25, String((rendered.match(/https:\/\/github\.com\//g) ?? []).length))
check('the pool renders under 15 KB', bytes < 15000, `${bytes} B`)
check('the pool renders at least 40x smaller than the raw descriptions', rawBytes / bytes > 40, `${rawBytes} -> ${bytes} B (${(rawBytes / bytes).toFixed(0)}x)`)
check('no single rendered row exceeds 1 KB', rendered.split('\n').every((line) => Buffer.byteLength(line, 'utf8') < 1024), 'longest line ' + Math.max(...rendered.split('\n').map((l) => Buffer.byteLength(l, 'utf8'))) + ' B')

console.log('\n--- the mid-tier candidates survive ---')
for (const [name] of MID) {
  check(`${name} is present`, rendered.includes(name))
}

console.log('\n--- renderRanked clips too ---')
const ranked = pool.slice(0, 4).map((c, i) => ({ ...c, rank: i + 1, relevance: 5, stars_rating: 3, score: 5 }))
const card = renderRanked('个人工作台网页项目', ranked, [], [], [])
check('the ranked card is also bounded', Buffer.byteLength(card, 'utf8') < 4000, `${Buffer.byteLength(card, 'utf8')} B`)
check('the ranked card marks the clipped rows', /描述过长/.test(card))

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
