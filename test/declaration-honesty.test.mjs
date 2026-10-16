// Declaration honesty (§8.11 / AC3): the ranked card must keep its three-class
// declaration even when the caller hands it metadata that cannot be true.
//
// WHY THIS FILE EXISTS
// --------------------
// The `【代码计算区】` block on the `rank_candidates` card used to open with
// 「以下每个数字均由代码算出，调用方不能指定或改动」 — a claim the tool cannot
// back. A caller passing `stars: 99999` and `pushed_at: '2099-01-01'` gets both
// rendered, first row, with no complaint, because the tool never re-queries
// GitHub for a caller-supplied pool. The sentence was replaced by a three-class
// split (caller judgement / caller-supplied unverified metadata / code-derived
// score·rating·order) plus an honesty sentence. This file exists so the split
// cannot be flattened and the sentence cannot come back.
//
// WHY IT DRIVES THE REAL TOOL INSTEAD OF THE RENDERER
// ---------------------------------------------------
// `test/render-table.test.mjs` already pins the same wording, but it builds the
// `RankedCandidate[]` by hand and calls `renderRanked` directly. That is not the
// claim §8.11 makes. What a model actually reads is
// `apply()` → `rank_candidates.execute` → `output.render`, and the projection
// lives at `def.output.render` — NOT at `def.render`, which does not exist. So
// hand-constructing the argument list skips exactly the layer where the
// declaration can silently go missing or be fed different values (a render that
// drops `pool_source`, or passes `[]` for `suspicious`, or reorders its
// arguments). Every assertion below runs on text the real tool produced from an
// argument object of the shape the host sends.
//
// THE INJECTED ROW IS THE COUNTEREXAMPLE, NOT A CURIOSITY
// ------------------------------------------------------
// `stars: 99999` / `pushed_at: '2099-01-01'` is the input that makes the old
// sentence false. The card is honest about provenance, it is NOT a validator:
// it must not invent a warning about metadata it never checked either, because
// a warning would claim a check that did not happen. So this file pins the
// silence too — and carries a control showing the ⚠️ machinery is live in the
// same pipeline, so "no warning" is measured, not vacuous.
//
// Run: node test/declaration-honesty.test.mjs   (NOT `node --test`)

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

let pass = 0
let fail = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}`)
    if (detail !== '') console.log(`        ${detail}`)
  }
}

const { apply } = await load('index.js')

// ---------------------------------------------------------------------------
// Registration: the same fake ctx the sibling suites use. `rank_candidates`
// needs no credentials, so `get` stays undefined.
// ---------------------------------------------------------------------------

const defs = new Map()
apply({ tools: { register: (def) => defs.set(def.name, def) }, get: () => undefined })

const rankTool = defs.get('rank_candidates')

// The whole point of this file: reach the card the way the host does. `execute`
// returns the raw value; the projection the model sees is `output.render`.
const callTool = async (args) => {
  const value = await rankTool.execute(args, {})
  const blocks = rankTool.output.render(args, value)
  return { value, blocks, text: blocks.map((block) => block.text ?? '').join('\n') }
}

// ---------------------------------------------------------------------------
// Fixtures. `INJECTED` carries the impossible metadata; `HONEST` is a plausible
// row so the card is not a one-row special case. Notes are long (>= 12 chars)
// and distinct, and the two descriptions are dissimilar, so no diagnostic rule
// fires on its own — the silence measured below is real silence.
// ---------------------------------------------------------------------------

const IDEA = 'a local-first markdown notes app with bidirectional links'
const INJECTED = 'inject/huge'
const HONEST = 'honest/small'
const INJECTED_STARS = 99999
const INJECTED_PUSHED_AT = '2099-01-01T00:00:00Z'
const POOL_SOURCE = 'scout_projects'

const row = (fullName, extra = {}) => ({
  full_name: fullName,
  url: `https://github.com/${fullName}`,
  owner: fullName.split('/')[0],
  name: fullName.split('/')[1],
  description: IDEA,
  stars: 120,
  language: 'TypeScript',
  pushed_at: '2026-01-01T00:00:00Z',
  archived: false,
  topics: [],
  ...extra,
})

const candidates = [
  row(INJECTED, {
    stars: INJECTED_STARS,
    pushed_at: INJECTED_PUSHED_AT,
    // Names all three classes on purpose: if the card ever quoted this text
    // back as its own claim, the class checks below would be reading the
    // caller's words instead of the tool's.
    description:
      'injected row: relevance is the caller judgement, stars 99999 and pushed_at 2099-01-01 are caller-supplied metadata, 得分 is derived by code',
  }),
  row(HONEST, { stars: 12 }),
]

const args = {
  idea: IDEA,
  candidates,
  scores: [
    { full_name: INJECTED, relevance: 9, note: 'injected row scored high on purpose' },
    { full_name: HONEST, relevance: 7, note: 'genuinely on topic but small' },
  ],
  pool_source: POOL_SOURCE,
}

// ---------------------------------------------------------------------------
// S1 — wiring, then the end-to-end card.
// ---------------------------------------------------------------------------

console.log('\nS1 · the real apply() → execute → output.render path')

check(
  'rank_candidates is registered by apply()',
  typeof rankTool === 'object' && rankTool !== null && rankTool.name === 'rank_candidates',
  `defs: ${[...defs.keys()].join(', ')}`,
)
check(
  'the card projection lives at output.render and is callable',
  typeof rankTool?.output?.render === 'function',
  `typeof rankTool.output.render = ${typeof rankTool?.output?.render}; ` +
    `own keys = ${JSON.stringify(Object.keys(rankTool ?? {}))}`,
)

let card = ''
let value = null
let blocks = []
let threw = ''
try {
  const result = await callTool(args)
  card = result.text
  value = result.value
  blocks = result.blocks
} catch (error) {
  threw = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
}

check('execute + output.render complete without throwing', threw === '', threw)
check(
  'the projection returns non-empty text content blocks',
  Array.isArray(blocks) &&
    blocks.length > 0 &&
    blocks.every((block) => block.type === 'text' && typeof block.text === 'string' && block.text.length > 0),
  `blocks = ${JSON.stringify(blocks.map((b) => ({ type: b.type, len: (b.text ?? '').length })))}`,
)
check('the card is a well-formed multi-line string', typeof card === 'string' && card.split('\n').length > 8, `lines = ${card.split('\n').length}`)

// Anti-vacuity: the injected row really did reach the card. Without this the
// declaration checks below would pass on an empty card.
const dataRows = card.split('\n').filter((line) => /^\| \d+ \|/.test(line))
const injectedRow = dataRows.find((line) => line.includes(INJECTED)) ?? ''

check(
  'anti-vacuity: the injected row is rendered as a ranked table row',
  injectedRow !== '',
  `data rows = ${JSON.stringify(dataRows.map((l) => l.slice(0, 40)))}`,
)
check(
  'anti-vacuity: the honest row is rendered too (the card is not a one-row special case)',
  dataRows.some((line) => line.includes(HONEST)),
  `data rows = ${dataRows.length}`,
)

// The counterexample itself: the caller's impossible numbers are on the card,
// in the row that ranks FIRST, and nothing complained. This is the fact the
// removed sentence denied.
check(
  'the caller-supplied 99999 stars survive execute as a raw number',
  value?.ranked?.[0]?.stars === INJECTED_STARS,
  `ranked[0].stars = ${JSON.stringify(value?.ranked?.[0]?.stars)} (${typeof value?.ranked?.[0]?.stars})`,
)
check(
  'the injected row ranks first, on the caller\'s own stars and relevance',
  value?.ranked?.[0]?.full_name === INJECTED,
  `order = ${JSON.stringify(value?.ranked?.map((r) => r.full_name))}`,
)
check(
  'the card renders the impossible star count in the stars column',
  injectedRow.includes('100.0k'),
  `row = ${injectedRow}`,
)
check(
  'the card renders the future pushed_at verbatim',
  injectedRow.includes(INJECTED_PUSHED_AT),
  `row = ${injectedRow}`,
)

// ---------------------------------------------------------------------------
// S2 — the three classes, inside the 代码计算区 block, before the numbers.
// ---------------------------------------------------------------------------

console.log('\nS2 · the three-class declaration')

const BLOCK_HEAD = '【代码计算区】本区字段分三类'
const tableDivider = card.indexOf('─'.repeat(62))
const declarationBlock = card.slice(card.indexOf(BLOCK_HEAD), tableDivider === -1 ? undefined : tableDivider)

check('the three-class declaration block is present', card.includes(BLOCK_HEAD), `card starts: ${card.slice(0, 80)}`)
check(
  'the declaration block sits BEFORE the table (a reader meets the classes before the numbers)',
  card.indexOf(BLOCK_HEAD) !== -1 && tableDivider !== -1 && card.indexOf(BLOCK_HEAD) < tableDivider,
  `block at ${card.indexOf(BLOCK_HEAD)}, divider at ${tableDivider}`,
)

// Class 1: the caller's own judgement.
check(
  'class 1 present: relevance is the CALLER\'s judgement',
  declarationBlock.includes('relevance：调用方自己的判断') && declarationBlock.includes('工具不计算、也不校验'),
  `block = ${JSON.stringify(declarationBlock.slice(0, 240))}`,
)
// Class 2: caller-supplied metadata whose provenance the tool has not checked.
check(
  'class 2 present: stars / pushed_at / description are caller-supplied and UNVERIFIED',
  declarationBlock.includes('stars / pushed_at / description：调用方传入的元数据') &&
    declarationBlock.includes('来源未经工具核实') &&
    declarationBlock.includes('不会去 GitHub 复查'),
  `block = ${JSON.stringify(declarationBlock.slice(0, 240))}`,
)
// Class 3: what the code really does own.
check(
  'class 3 present: 得分 / 评级 / 顺序 are derived from the other two classes',
  declarationBlock.includes('得分 / 评级 / 顺序：由上面两类派生') && declarationBlock.includes('可按公式复算'),
  `block = ${JSON.stringify(declarationBlock.slice(0, 240))}`,
)

// ---------------------------------------------------------------------------
// S3 — the honesty sentence, both halves.
// ---------------------------------------------------------------------------

console.log('\nS3 · the honesty sentence')

check(
  'honesty half A present: arithmetic is recomputable, the input is not therefore true',
  card.includes('算术可复算，不等于输入是真的'),
  `card = ${JSON.stringify(card.slice(0, 400))}`,
)
check(
  'honesty half B present: no alarm does NOT mean the tool verified anything',
  card.includes('工具没有报警，也不等于它核实过任何东西'),
  `card = ${JSON.stringify(card.slice(0, 400))}`,
)
check(
  'the honesty sentence is inside the declaration block, not stranded elsewhere',
  declarationBlock.includes('算术可复算，不等于输入是真的') &&
    declarationBlock.includes('工具没有报警，也不等于它核实过任何东西'),
  `block = ${JSON.stringify(declarationBlock)}`,
)

// ---------------------------------------------------------------------------
// S4 — the forbidden overclaim is ABSENT.
//
// Negation tolerance is explicit here, because the live card DOES contain a
// 「不可…指定」-shaped phrase: 「排序与星级均由代码按公式计算，不可由模型指定。」
// That one is true — order and the stars COLUMN are code-computed from the
// caller's own relevance and star count — and it is a negation about the model,
// not a claim that the caller's numbers are immutable. So the phrase is removed
// from the text before the 「不可指定」 family is searched, and the phrase's
// presence is itself asserted, so the tolerance cannot silently become a hole.
// ---------------------------------------------------------------------------

console.log('\nS4 · the forbidden overclaim')

const FORBIDDEN_EXACT = '以下每个数字均由代码算出，调用方不能指定或改动'
const NEGATION_SAFE = '排序与星级均由代码按公式计算，不可由模型指定。'
const withoutNegationSafe = card.split(NEGATION_SAFE).join('')

check(
  'the negation-safe live sentence is present (so the tolerance below is not vacuous)',
  card.includes(NEGATION_SAFE),
  `card tail = ${JSON.stringify(card.slice(-320))}`,
)
check(
  `the removed overclaim is absent: 「${FORBIDDEN_EXACT}」`,
  !card.includes(FORBIDDEN_EXACT),
  `found in card = ${JSON.stringify(card.slice(Math.max(0, card.indexOf(FORBIDDEN_EXACT) - 60), card.indexOf(FORBIDDEN_EXACT) + 80))}`,
)
check(
  'the weaker form is absent: 「均由代码算出」 (the live line says 按公式计算 about order/stars, never 算出 about every number)',
  !card.includes('均由代码算出'),
  `card = ${JSON.stringify(card)}`,
)
check(
  'the 「不可指定」 family is absent once the negation-safe phrase is set aside',
  !withoutNegationSafe.includes('不可指定') &&
    !withoutNegationSafe.includes('不能指定或改动') &&
    !withoutNegationSafe.includes('调用方不能指定'),
  `stripped card = ${JSON.stringify(withoutNegationSafe)}`,
)
check(
  'no line claims every number is code-computed (the "every number" quantifier is the overclaim)',
  !/每(一)?个数字(都)?(均|全)?(由|是)代码算出/.test(card) && !/所有(的)?数字(都)?(均|全)?(由|是)代码算出/.test(card),
  `card = ${JSON.stringify(card)}`,
)

// ---------------------------------------------------------------------------
// S5 — pool_source is echoed where the card says it puts it.
// ---------------------------------------------------------------------------

console.log('\nS5 · pool_source provenance')

check(
  'the pool source is echoed on the card, on the line above the declaration',
  card.includes(`候选池来源：${POOL_SOURCE}`),
  `card head = ${JSON.stringify(card.split('\n').slice(0, 5))}`,
)
check(
  'pool_source reaches the renderer through execute, not through the test',
  value?.pool_source === POOL_SOURCE &&
    card.split('\n').findIndex((line) => line.includes(`候选池来源：${POOL_SOURCE}`)) <
      card.split('\n').findIndex((line) => line.includes(BLOCK_HEAD)),
  `value.pool_source = ${JSON.stringify(value?.pool_source)}`,
)

// ---------------------------------------------------------------------------
// S6 — the card does NOT invent a warning about the metadata it never checked,
//      with a control proving the ⚠️ machinery is live in this pipeline.
// ---------------------------------------------------------------------------

console.log('\nS6 · honest about provenance, not a validator')

const METADATA_KINDS = ['term_gap', 'score_gap', 'note_gap', 'note_echo']
const warnLines = (text) => text.split('\n').filter((line) => line.includes('⚠️'))
const namesMetadata = (line) => /99999|2099-01-01|pushed_at|stars/.test(line)

check(
  'no diagnostic entry is invented for the injected row',
  Array.isArray(value?.suspicious) && value.suspicious.every((entry) => entry.full_name !== INJECTED),
  `suspicious = ${JSON.stringify(value?.suspicious)}`,
)
check(
  'every diagnostic the tool can emit is about a score or a note, never about metadata provenance',
  Array.isArray(value?.suspicious) && value.suspicious.every((entry) => METADATA_KINDS.includes(entry.kind)),
  `kinds = ${JSON.stringify(value?.suspicious?.map((e) => e.kind))}`,
)
check(
  'no ⚠️ line on the card names the unverifiable metadata (a warning would claim a check that never ran)',
  warnLines(card).every((line) => !namesMetadata(line)),
  `warn lines = ${JSON.stringify(warnLines(card))}`,
)

// Control: the same two candidates, same impossible metadata, but the injected
// row is given a confident score with NO reason. That is a contradiction the
// tool really does report, so a card with no ⚠️ at all above is not a card
// whose warning path is broken.
const controlArgs = {
  ...args,
  scores: [{ full_name: INJECTED, relevance: 9 }],
}
let controlCard = ''
let controlValue = null
try {
  const control = await callTool(controlArgs)
  controlCard = control.text
  controlValue = control.value
} catch (error) {
  controlCard = `THREW ${error?.message ?? String(error)}`
}

check(
  'control: the ⚠️ machinery is live in this same pipeline (a confident score with no reason is reported)',
  warnLines(controlCard).length > 0 &&
    controlValue?.suspicious?.some((entry) => entry.kind === 'note_gap' && entry.full_name === INJECTED),
  `warn lines = ${JSON.stringify(warnLines(controlCard))}; suspicious = ${JSON.stringify(controlValue?.suspicious)}`,
)
check(
  'control: even when warning, the card still says nothing about the impossible metadata',
  warnLines(controlCard).every((line) => !namesMetadata(line)),
  `warn lines = ${JSON.stringify(warnLines(controlCard))}`,
)
check(
  'control: the three-class declaration is still present on a card that carries a warning',
  controlCard.includes(BLOCK_HEAD) &&
    controlCard.includes('得分 / 评级 / 顺序：由上面两类派生') &&
    controlCard.includes('工具没有报警，也不等于它核实过任何东西'),
  `control card head = ${JSON.stringify(controlCard.slice(0, 200))}`,
)

// ---------------------------------------------------------------------------
// S7 — the empty branch carries the same declaration. "There are no rows" is
//      itself a claim about the caller's input, and a reader who learns the
//      columns are code-computed here carries that reading into the next call.
// ---------------------------------------------------------------------------

console.log('\nS7 · the empty-result branch')

let emptyCard = ''
try {
  const empty = await callTool({ idea: IDEA, candidates: [], scores: [], pool_source: POOL_SOURCE })
  emptyCard = empty.text
} catch (error) {
  emptyCard = `THREW ${error?.message ?? String(error)}`
}

check(
  'empty branch: the three classes and the honesty sentence are all present',
  emptyCard.includes(BLOCK_HEAD) &&
    emptyCard.includes('relevance：调用方自己的判断') &&
    emptyCard.includes('stars / pushed_at / description：调用方传入的元数据') &&
    emptyCard.includes('得分 / 评级 / 顺序：由上面两类派生') &&
    emptyCard.includes('算术可复算，不等于输入是真的'),
  `empty card = ${JSON.stringify(emptyCard.slice(0, 400))}`,
)
check(
  'empty branch: the forbidden overclaim is absent there too',
  !emptyCard.includes(FORBIDDEN_EXACT) &&
    !emptyCard.includes('均由代码算出') &&
    !emptyCard.includes('不能指定或改动'),
  `empty card = ${JSON.stringify(emptyCard)}`,
)
// NOTE: the empty branch does NOT echo `pool_source`, although the caller did
// supply one — the line is only pushed in the table branch. Recorded here as an
// observation rather than asserted either way: §8.11 does not require it, and
// pinning today's behaviour would freeze a possible asymmetry instead of
// reporting it. See the result note sent with this file.
check(
  'empty branch: it really is the empty branch (no table rows)',
  !emptyCard.includes('| # | 项目 |') && emptyCard.includes('没有可展示的候选项目'),
  `empty card = ${JSON.stringify(emptyCard.slice(0, 200))}`,
)

// ---------------------------------------------------------------------------
// S8 — §8.11 point 6: `pool_source` is descriptive ONLY. The same rows rendered
//      with and without it must produce identical numbers; the only difference
//      the caller is allowed to cause is the provenance line itself.
//
// This is the half of the requirement that the wording checks cannot reach. A
// card can carry a perfect three-class declaration and still let a caller move
// a number by relabelling where the pool came from — at which point "得分 is
// derived from the two classes above" would be false in the direction that
// matters. So the columns are compared as data, not as prose.
// ---------------------------------------------------------------------------

console.log('\nS8 · pool_source changes no number')

// `delete` rather than `pool_source: undefined`: the host validates arguments
// as a lossless JSON object, and an explicit `undefined` value is rejected
// before the tool ever runs (`ToolArgsError: "arguments" must be a lossless
// JSON object`). Omitting the key is the honest "caller did not send it" case.
const withoutPoolArgs = { ...args }
delete withoutPoolArgs.pool_source

let withoutPoolCard = ''
let withoutPoolValue = null
let withoutPoolThrew = ''
try {
  const result = await callTool(withoutPoolArgs)
  withoutPoolCard = result.text
  withoutPoolValue = result.value
} catch (error) {
  withoutPoolThrew = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
}

check('the pool_source-free call completes without throwing', withoutPoolThrew === '', withoutPoolThrew)

// Column extraction: `| # | 项目 | 最近更新 | relevance | stars | 得分 | 语言 | 简介 |`
const splitRow = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim())
const COMPUTED = { rank: 0, relevance: 3, stars: 4, score: 5 }
const computedColumns = (text) =>
  text
    .split('\n')
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => {
      const cells = splitRow(line)
      return Object.fromEntries(Object.entries(COMPUTED).map(([name, index]) => [name, cells[index]]))
    })

const withCols = computedColumns(card)
const withoutCols = computedColumns(withoutPoolCard)

check(
  'the control card really is the same table (same rows, same order)',
  withCols.length === withoutCols.length &&
    withCols.length > 0 &&
    withoutPoolCard.split('\n').filter((line) => /^\| \d+ \|/.test(line)).every((line, index) => {
      const cells = splitRow(line)
      const reference = splitRow(card.split('\n').filter((l) => /^\| \d+ \|/.test(l))[index] ?? '')
      return cells[1] === reference[1]
    }),
  `with = ${JSON.stringify(withCols)}; without = ${JSON.stringify(withoutCols)}`,
)
check(
  'pool_source does not move the rank column',
  JSON.stringify(withCols.map((r) => r.rank)) === JSON.stringify(withoutCols.map((r) => r.rank)),
  `with = ${JSON.stringify(withCols.map((r) => r.rank))}; without = ${JSON.stringify(withoutCols.map((r) => r.rank))}`,
)
check(
  'pool_source does not move the relevance column',
  JSON.stringify(withCols.map((r) => r.relevance)) === JSON.stringify(withoutCols.map((r) => r.relevance)),
  `with = ${JSON.stringify(withCols.map((r) => r.relevance))}; without = ${JSON.stringify(withoutCols.map((r) => r.relevance))}`,
)
check(
  'pool_source does not move the stars column',
  JSON.stringify(withCols.map((r) => r.stars)) === JSON.stringify(withoutCols.map((r) => r.stars)),
  `with = ${JSON.stringify(withCols.map((r) => r.stars))}; without = ${JSON.stringify(withoutCols.map((r) => r.stars))}`,
)
check(
  'pool_source does not move the code-computed 得分 column',
  JSON.stringify(withCols.map((r) => r.score)) === JSON.stringify(withoutCols.map((r) => r.score)),
  `with = ${JSON.stringify(withCols.map((r) => r.score))}; without = ${JSON.stringify(withoutCols.map((r) => r.score))}`,
)
check(
  'the whole data row is byte-identical with and without pool_source',
  JSON.stringify(withCols) === JSON.stringify(withoutCols),
  `with = ${JSON.stringify(withCols)}; without = ${JSON.stringify(withoutCols)}`,
)
check(
  'the ranked VALUE is identical too (pool_source reaches neither ordering nor score)',
  JSON.stringify(value?.ranked?.map((r) => [r.full_name, r.relevance, r.score])) ===
    JSON.stringify(withoutPoolValue?.ranked?.map((r) => [r.full_name, r.relevance, r.score])),
  `with = ${JSON.stringify(value?.ranked?.map((r) => [r.full_name, r.relevance, r.score]))}; ` +
    `without = ${JSON.stringify(withoutPoolValue?.ranked?.map((r) => [r.full_name, r.relevance, r.score]))}`,
)

// The other side of the same claim: the difference that IS allowed. Without
// this, the assertions above would also pass if `pool_source` were dropped on
// the floor — i.e. if the tool silently ignored a caller's provenance.
const poolLine = (text) => text.split('\n').filter((line) => line.includes('候选池来源：'))
check(
  'the provenance line is the ONE difference: present with pool_source, absent without it',
  poolLine(card).length === 1 &&
    poolLine(card)[0].includes(POOL_SOURCE) &&
    poolLine(withoutPoolCard).length === 0,
  `with = ${JSON.stringify(poolLine(card))}; without = ${JSON.stringify(poolLine(withoutPoolCard))}`,
)
check(
  'value.pool_source echoes the caller, and is empty when the caller sent nothing',
  value?.pool_source === POOL_SOURCE && withoutPoolValue?.pool_source === '',
  `with = ${JSON.stringify(value?.pool_source)}; without = ${JSON.stringify(withoutPoolValue?.pool_source)}`,
)
check(
  'the declaration is unchanged by pool_source (provenance does not reword the classes)',
  withoutPoolCard.includes(BLOCK_HEAD) &&
    withoutPoolCard.includes('relevance：调用方自己的判断') &&
    withoutPoolCard.includes('得分 / 评级 / 顺序：由上面两类派生') &&
    withoutPoolCard.includes('工具没有报警，也不等于它核实过任何东西'),
  `without-pool card = ${JSON.stringify(withoutPoolCard.slice(0, 300))}`,
)
check(
  'the declaration block is the only difference-free zone: both cards put it before the table',
  withoutPoolCard.indexOf(BLOCK_HEAD) !== -1 &&
    withoutPoolCard.indexOf(BLOCK_HEAD) < withoutPoolCard.indexOf('─'.repeat(62)),
  `block at ${withoutPoolCard.indexOf(BLOCK_HEAD)}, divider at ${withoutPoolCard.indexOf('─'.repeat(62))}`,
)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
