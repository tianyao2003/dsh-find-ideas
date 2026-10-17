// Tests for the ranked-candidate TABLE and the file-head skeleton block.
//
// WHY THIS FILE EXISTS
// --------------------
// Two changes landed together, and each one has a failure mode that is invisible
// in the output it produces.
//
// 1. `renderRanked` used to print one card per candidate. It now prints an
//    eight-column Markdown table. A card could absorb a stray `|` and still read
//    as a card; a table cannot. `description` and `full_name` come from GitHub
//    and are adversarial input, so one `|` inside a description shifts every
//    following cell on that row by one — the row then presents another
//    repository's stars and score as this repository's, while looking perfectly
//    well-formed. The row count and the cell count are therefore asserted, not
//    eyeballed.
//
// 2. The `【代码计算区】` header used to say every number in the area was
//    computed by the code and could not be supplied or altered by the caller.
//    That was measured false: a caller passing `stars=99999`,
//    `pushed_at=2099-01-01` and `pool_source=scout_projects` rendered a full card
//    with no warning, because the tool never re-queries GitHub for a
//    caller-supplied pool. The replacement sorts the columns into three classes.
//    Both halves are asserted: the old sentence is GONE (from the output AND
//    from the source text, so it cannot come back as a comment), and the three
//    classes are named.
//
// 3. `renderSkeleton` renders the file-head signature scan. Its whole reason for
//    existing is that the evidence is PARTIAL, so the tests are about the
//    distinctions the renderer must not blur: "not covered by the scanner" is
//    not "no declarations found", zero hits is not "this repository has no
//    classes", and a filled window is not a complete file. A declaration count
//    taken from `hits.length` would report 1 for a file with zero declarations,
//    because `hits[0]` is always the file-level fact record — that is asserted
//    directly.
//
// Run with:  npm test
// Or directly: node test/render-table.test.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { renderRanked, renderSkeleton, renderInspections, SKELETON_DISCLAIMER } = await load('render.js')
const { scanSignatures, isDeclarationHit, MAX_HITS_PER_FILE, EXCERPT_WINDOW_CHARS } = await load('skeleton.js')
const { formatStars } = await load('types.js')

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

// A ranked row, with every field overridable so each test states only what it is
// about. `stars_rating` is included on purpose: it is a pure function of
// `relevance`, so the table must NOT spend a column on it.
const rankedRow = (rank, extra = {}) => ({
  full_name: `owner/repo-${rank}`,
  url: `https://github.com/owner/repo-${rank}`,
  owner: 'owner',
  name: `repo-${rank}`,
  description: `a plain description for row ${rank}`,
  stars: 1200 + rank,
  language: 'TypeScript',
  pushed_at: '2026-01-01T00:00:00Z',
  archived: false,
  topics: [],
  rank,
  relevance: 7,
  stars_rating: 3,
  score: 8.42,
  ...extra,
})

// Split a table row on cell boundaries. A row of eight columns is ten pieces:
// the empty string before the leading `|`, eight cells, and the empty string
// after the trailing `|`. A `|` that was NOT escaped adds a piece, which is
// exactly the damage this counts.
const cells = (line) => line.split(/(?<!\\)\|/)
const dataRows = (text) => text.split('\n').filter((line) => /^\| \d+ \|/.test(line))
const tableLines = (text) => text.split('\n').filter((line) => line.startsWith('|'))

// ---------------------------------------------------------------------------
console.log('\n=== T1. the eight columns, in order ===')
const card = renderRanked(
  '个人工作台网页项目',
  [rankedRow(1), rankedRow(2), rankedRow(3)],
  [],
  [],
  [],
  [],
  null,
  'scout_projects',
)
{
  const header = tableLines(card)[0] ?? ''
  const COLUMNS = ['#', '项目', '最近更新', 'relevance', 'stars', '得分', '语言', '简介']
  check('a table header line exists', header.startsWith('| # |'), JSON.stringify(header))
  check('the header has exactly the eight columns', cells(header).length === 10, `${cells(header).length - 2} columns: ${header}`)
  for (const column of COLUMNS) {
    check(`the header names the ${column} column`, header.includes(`| ${column} |`), header)
  }
  // Order, not just presence: a table whose columns are permuted still contains
  // every name, and the design fixes the order.
  const positions = COLUMNS.map((c) => header.indexOf(`| ${c} |`))
  check('the columns are in the fixed order', positions.every((p, i) => i === 0 || p > positions[i - 1]), positions.join(','))
  check('the divider row follows the header', /^\|-{3,}(\|-{3,}){7}\|$/.test(tableLines(card)[1] ?? ''), JSON.stringify(tableLines(card)[1]))

  // No star-rating column: `stars_rating` is `ratingFromRelevance(relevance)` and
  // the table already shows relevance.
  check('the header has no star-rating column', !header.includes('评级') && !header.includes('stars_rating'), header)
  check('no row spends a cell on star glyphs', !tableLines(card).some((line) => /[★☆]/.test(line)), tableLines(card).find((l) => /[★☆]/.test(l)) ?? '')
}

console.log('\n=== T2. one row per candidate, and numbers the reader can recompute ===')
{
  const rows = dataRows(card)
  check('every candidate got exactly one row', rows.length === 3, String(rows.length))
  check('every row has exactly eight cells', rows.every((line) => cells(line).length === 10), rows.map((l) => cells(l).length - 2).join(','))
  check('the rank is the first cell', rows.map((l) => cells(l)[1].trim()).join(',') === '1,2,3', rows.map((l) => cells(l)[1].trim()).join(','))

  const first = cells(rows[0])
  check('the project cell links to the repository', /\[owner\/repo-1\]\(https:\/\/github\.com\/owner\/repo-1\)/.test(first[2]), first[2])
  check('relevance renders as n/10', first[4].trim() === '7/10', first[4])
  check('stars renders through formatStars', first[5].trim() === formatStars(1201), `${first[5].trim()} vs ${formatStars(1201)}`)
  check('得分 renders as score.toFixed(1)', first[6].trim() === '8.4', first[6])
  check('the language is shown as given', first[7].trim() === 'TypeScript', first[7])
  check('the description is shown', first[8].trim() === 'a plain description for row 1', first[8])

  // Recomputed from the inputs rather than compared to a hardcoded string, so a
  // change to the score formula does not silently make this test vacuous.
  const scored = renderRanked('x', [rankedRow(1, { score: 3.14159, relevance: 9 })], [], [], [])
  const scoredCells = cells(dataRows(scored)[0])
  check('a different score renders at one decimal', scoredCells[6].trim() === '3.1', scoredCells[6])
  check('a different relevance renders as n/10', scoredCells[4].trim() === '9/10', scoredCells[4])
}

console.log('\n=== T3. a pipe in the text does not tear the row apart ===')
{
  const hostile = renderRanked(
    'x',
    [
      rankedRow(1, { description: 'before | after | and | more' }),
      rankedRow(2, { description: 'plain' }),
      rankedRow(3, { full_name: 'we|ird/repo', description: 'x' }),
    ],
    [],
    [],
    [],
  )
  const rows = dataRows(hostile)
  check('all three rows survive a piped description', rows.length === 3, String(rows.length))
  check('no row gained a cell from a pipe', rows.every((line) => cells(line).length === 10), rows.map((l) => `${cells(l).length - 2}`).join(','))
  check('the pipe is escaped, not deleted', rows[0].includes('before \\| after \\| and \\| more'), cells(rows[0])[8])
  check('a pipe in full_name is escaped too', rows[2].includes('we\\|ird/repo'), cells(rows[2])[2])
  check('the escaped text still reads as the original', cells(rows[0])[8].trim() === 'before \\| after \\| and \\| more', cells(rows[0])[8])

  // A newline is the same class of damage: it ends the row.
  const newlined = renderRanked('x', [rankedRow(1, { description: 'line one\nline two' })], [], [], [])
  check('a newline in the description does not split the row', dataRows(newlined).length === 1, String(dataRows(newlined).length))
  check('the description stays on one line', cells(dataRows(newlined)[0])[8].trim() === 'line one line two', cells(dataRows(newlined)[0])[8])
}

console.log('\n=== T4. a missing value renders as the placeholder, never as undefined ===')
{
  const missing = renderRanked(
    'x',
    [
      rankedRow(1, { pushed_at: '' }),
      rankedRow(2, { pushed_at: undefined }),
      rankedRow(3, { description: '' }),
      rankedRow(4, { language: '', pushed_at: '2026-05-05T00:00:00Z' }),
    ],
    [],
    [],
    [],
  )
  const rows = dataRows(missing)
  check('all four rows are present', rows.length === 4, String(rows.length))
  check('the output never contains the literal undefined', !missing.includes('undefined'), missing.split('\n').find((l) => l.includes('undefined')) ?? '')
  check('the output never contains the literal null', !missing.includes('null'), missing.split('\n').find((l) => l.includes('null')) ?? '')
  check('an empty pushed_at renders as the placeholder', cells(rows[0])[3].trim() === '\u2014', JSON.stringify(cells(rows[0])[3]))
  check('an undefined pushed_at renders as the placeholder', cells(rows[1])[3].trim() === '\u2014', JSON.stringify(cells(rows[1])[3]))
  check('a missing description renders as the placeholder', cells(rows[2])[8].trim() === '\u2014', JSON.stringify(cells(rows[2])[8]))
  check('a present pushed_at is passed through unchanged', cells(rows[3])[3].trim() === '2026-05-05T00:00:00Z', cells(rows[3])[3])
  // An empty language keeps a WORD, not the placeholder: it says which fact is
  // missing, and `—` alone would not.
  check('an empty language says which fact is missing', cells(rows[3])[7].trim().includes('未知'), cells(rows[3])[7])
  check('no cell is empty', rows.every((line) => cells(line).slice(1, 9).every((c) => c.trim().length > 0)), rows.map((l) => l).join(' | '))
}

console.log('\n=== T5. the archived marker survives, because nothing else derives it ===')
{
  const mixed = renderRanked('x', [rankedRow(1, { archived: true }), rankedRow(2, { archived: false })], [], [], [])
  const rows = dataRows(mixed)
  check('the archived row is marked', rows[0].includes('[已归档]'), rows[0])
  check('the live row is not marked', !rows[1].includes('[已归档]'), rows[1])
  check('the marker does not add a cell', rows[0].split(/(?<!\\)\|/).length === 10, String(rows[0].split(/(?<!\\)\|/).length - 2))
}

console.log('\n=== T6. the three-class declaration replaced the old overclaim ===')
{
  const OLD = '以下每个数字均由代码算出，调用方不能指定或改动。'
  const source = readFileSync(join(pkgRoot, 'src', 'render.ts'), 'utf8')

  check('the old overclaim is gone from the rendered output', !card.includes(OLD), card.split('\n').find((l) => l.includes(OLD)) ?? '')
  check('the old overclaim is gone from the source text', !source.includes(OLD), 'still present in src/render.ts')
  check('the old overclaim is gone from the empty branch too', !renderRanked('x', [], [], [], []).includes(OLD))

  check('the code-computed area is still its own section', card.includes('【代码计算区】'), '')
  check('the caller-notes area is still separate', !card.includes('【调用方说明区】') || card.indexOf('【代码计算区】') < card.indexOf('【调用方说明区】'), '')
  check('class 1: relevance is the caller\'s own judgement', /relevance：调用方自己的判断/.test(card), '')
  check('class 1: and the tool does not verify it', /工具不计算、也不校验/.test(card), '')
  check('class 2: stars/pushed_at/description are caller-supplied metadata', /stars \/ pushed_at \/ description：调用方传入的元数据/.test(card), '')
  check('class 2: and their source is unverified', /来源未经工具核实/.test(card), '')
  check('class 2: and no GitHub re-check happens for a caller pool', /不会去 GitHub 复查/.test(card), '')
  check('class 3: 得分/评级/顺序 are derived by code', /得分 \/ 评级 \/ 顺序：由上面两类派生/.test(card), '')
  check('class 3: and are recomputable', /可按公式复算/.test(card), '')
  check('the closing claim separates arithmetic from truth', /算术可复算，不等于输入是真的/.test(card), '')
  check('the closing claim separates silence from verification', /工具没有报警，也不等于它核实过任何东西/.test(card), '')

  check('the formula line is unchanged', card.includes('排序与星级均由代码按公式计算，不可由模型指定。'), '')
  check('the empty branch carries the declaration too', /relevance：调用方自己的判断/.test(renderRanked('x', [], [], [], [])), '')
  check('the empty branch prints no table header', !renderRanked('x', [], [], [], []).includes('| # |'), '')
}

console.log('\n=== T7. the surrounding structure still stands ===')
{
  const full = renderRanked(
    'x',
    [rankedRow(1, { note: 'caller supplied note' }), rankedRow(2, { note: 'caller supplied note' })],
    ['ghost/one'],
    ['dropped/one'],
    ['weak/one'],
    [],
    null,
    'scout_projects',
  )
  check('the idea and count header is present', /针对 idea 排序后的候选（共 2 个/.test(full), '')
  check('the pool source is stated', full.includes('候选池来源：scout_projects'), '')
  check('the formula line follows the table', full.indexOf('排序与星级均由代码按公式计算，不可由模型指定。') > full.indexOf('| 1 |'), '')
  check('dropped candidates are counted', /已排除 1 个 relevance=0 的噪声项目/.test(full), '')
  check('below-threshold candidates are counted', /已排除 1 个 relevance<3 的弱相关项目/.test(full), '')
  check('unknown names are reported', /1 个 full_name 未匹配到候选/.test(full), '')
  check('noiseAdvice still runs', full.includes('【代码计算区】本轮未记录评分分布。'), '')
  check('caller notes get their own area', full.includes('【调用方说明区】'), '')
  check('caller notes are marked unverified', full.includes('[未验证]'), '')
}

// ---------------------------------------------------------------------------
// T7b. The card now tells the model what it may NOT do to the table.
//
// WHY THIS IS ON THE CARD AND NOT ONLY IN THE TOOL DESCRIPTION
// -----------------------------------------------------------
// `rank_candidates`' description already forbade dropping a column (commit
// e34ce4a), and it still happened: the one observed trial session rendered a
// correct eight-column card and the agent re-presented it with 简介 deleted and
// `relevance` translated to 「相关性」. Two things made that possible.
//
//   1. A tool description is read once, at planning time; the card is read again
//      on every call. A rule that only lives in the description competes with the
//      table itself for the agent's attention, and the table wins.
//   2. The description rule was unreachable for a whole day: the host process had
//      been started before e34ce4a landed, and a plugin's `defineTool` payload is
//      built at load time. Every model call after the fix still carried the old
//      text. That failure mode is invisible from inside the plugin — the disk copy
//      was correct the whole time — so the card cannot assume the description
//      arrived.
//
// The sentence below is therefore a RULE, not a measurement: it makes no claim
// about what the code computed, so it is compatible with the honesty rules in
// T6. It must not be worded as a claim about the data, and it must not be folded
// into the safe sentence — `test/declaration-honesty.test.mjs` strips that
// sentence by exact match, and concatenating would leave a fragment behind.
{
  const RESTATE_RULE =
    '复述本卡时，每一行与每一列都必须保留（共八列，含「简介」列）：删掉一行或一列是丢失信息，不是缩短表格。'
  const SAFE = '排序与星级均由代码按公式计算，不可由模型指定。'

  check('the card states the restatement rule', card.includes(RESTATE_RULE), card.split('\n').find((l) => l.includes('复述本卡')) ?? '(absent)')
  check('the rule names the column count and the 简介 column', /八列/.test(RESTATE_RULE) && RESTATE_RULE.includes('简介'), '')
  check('the rule names both losses: a row AND a column', RESTATE_RULE.includes('一行') && RESTATE_RULE.includes('一列'), '')
  check('the rule follows the table it protects', card.indexOf(RESTATE_RULE) > card.indexOf('| 1 |'), '')

  // Separate lines, deliberately. `declaration-honesty` cuts the safe sentence out
  // of the card by exact match before scanning for the banned family; if the two
  // were one line the cut would leave the second half behind as a fragment.
  const cardLines = card.split('\n')
  check('the safe sentence still occupies its own line', cardLines.includes(SAFE), '')
  check('the rule occupies its own line', cardLines.includes(RESTATE_RULE), '')
  check('the two are adjacent and rule-last', cardLines[cardLines.indexOf(SAFE) + 1] === RESTATE_RULE, String(cardLines.indexOf(SAFE)))

  // The empty branch has no table, so it must not pretend to protect one. It
  // carries the three-class declaration instead (asserted in T6), and neither the
  // safe sentence nor this rule — both are statements about a table.
  const emptyBranch = renderRanked('x', [], [], [], [])
  check('the empty branch does not carry the rule', !emptyBranch.includes(RESTATE_RULE), '')
  check('the empty branch does not carry the safe sentence either', !emptyBranch.includes(SAFE), emptyBranch.split('\n').find((l) => l.includes('排序与星级')) ?? '')

  // Mutation guard: the assertion above must be able to fail. Proven in this same
  // file by rendering a card from a mutated copy — see the note in
  // `.trellis/spec/frontend/quality-guidelines.md`, "Mutation-test a new honesty
  // assertion". The mutation that matters is deleting the sentence from
  // `lib/render.js`; the recorded result is FAIL on the first check.
}

// ---------------------------------------------------------------------------
console.log('\n=== T8. renderSkeleton: zero declarations is not "no declarations" ===')
{
  // A copyright header and an import block — the window a real file head gives.
  const quiet = scanSignatures('src/a.ts', '// Copyright 2026 someone\nimport { x } from "y"\n')
  check('a declaration-free window still returns the fact record', quiet.length === 1, String(quiet.length))
  check('the fact record is not a declaration', !isDeclarationHit(quiet[0]), JSON.stringify(quiet[0]))
  check('the fact record has an empty name', quiet[0].name === '' && quiet[0].startLine === 0, JSON.stringify(quiet[0]))

  const out = renderSkeleton('src/a.ts', quiet)
  check('the path is rendered', out.includes('src/a.ts'), out)
  check('the count is 0, taken from isDeclarationHit and not from hits.length', /声明 0 条/.test(out), out.split('\n')[1])
  check('the count is not hits.length, which is 1', !/声明 1 条/.test(out), out.split('\n')[1])
  // The renderer is ALLOWED to say "该文件没有类/函数" only inside a denial
  // ("这不等于该文件没有类/函数"). So the check is not "the phrase is absent" —
  // that would fail on the correct output, which is what the first version of
  // this assertion did. Every occurrence must be negated.
  const claims = [...out.matchAll(/该文件没有(类|函数|声明)/g)]
  const unnegated = claims.filter((m) => !out.slice(Math.max(0, m.index - 3), m.index).includes('不等于'))
  check('zero declarations never claims the file has none', unnegated.length === 0, unnegated.map((m) => out.slice(Math.max(0, m.index - 12), m.index + 12)).join(' / '))
  check('zero declarations says the window is what was empty', /这段文件头里没有扫到声明形态/.test(out), out)
  check('and it denies the repository-level reading', /不等于该文件没有类\/函数，更不等于该仓库没有/.test(out), out)
  check('the output is never empty', out.trim().length > 0, '')
}

console.log('\n=== T9. renderSkeleton: unsupported is not "none found" ===')
{
  const unsupported = scanSignatures('README.md', '# A readme\n')
  check('the fact record reports the file as unsupported', unsupported[0].supported === false, JSON.stringify(unsupported[0]))

  const out = renderSkeleton('README.md', unsupported)
  check('it says the extension is outside the scanner coverage', /不在扫描器的语言覆盖内/.test(out), out)
  check('it says nothing was scanned', /没有扫描任何内容/.test(out), out)
  check('it does NOT say no declarations were found', !/没有扫到声明形态/.test(out), out)
  check('it explicitly separates the two claims', /这既不是「没有声明」，也不是「没有类\/函数」/.test(out), out)
  check('it says the file type was never looked at', /根本没有被看过/.test(out), out)
}

console.log('\n=== T10. renderSkeleton: a filled window and a capped list are both flagged ===')
{
  const long = scanSignatures('src/b.ts', `export function first() {}\n// ${'z'.repeat(EXCERPT_WINDOW_CHARS + 100)}\n`)
  check('a filled window is reported as truncated', long[0].truncated === true, JSON.stringify(long[0]))
  const truncatedOut = renderSkeleton('src/b.ts', long)
  check('the truncation is stated', new RegExp(`${EXCERPT_WINDOW_CHARS} 字符窗口填满`).test(truncatedOut), truncatedOut.split('\n')[2])
  check('and the list is called possibly incomplete', /可能不完整/.test(truncatedOut), truncatedOut)

  const many = scanSignatures('src/c.ts', Array.from({ length: MAX_HITS_PER_FILE + 20 }, (_, i) => `export function fn${i}() {}`).join('\n'))
  check('the scan stops at the per-file cap', many.length === MAX_HITS_PER_FILE, String(many.length))
  const cappedOut = renderSkeleton('src/c.ts', many)
  check('the cap is stated', new RegExp(`上限 ${MAX_HITS_PER_FILE} 条`).test(cappedOut), cappedOut)
  check('and the capped list is called possibly incomplete', /可能不完整/.test(cappedOut), cappedOut)
  check('the declaration count excludes the fact record', new RegExp(`声明 ${MAX_HITS_PER_FILE - 1} 条`).test(cappedOut), cappedOut.split('\n')[1])
}

console.log('\n=== T11. renderSkeleton: declarations, lines, and the disclaimer ===')
{
  const hits = scanSignatures('src/d.ts', 'export function foo() {}\nexport class Bar {}\n')
  check('two declarations were found', hits.filter(isDeclarationHit).length === 2, String(hits.length))
  const out = renderSkeleton('src/d.ts', hits)
  check('the declaration count is right', /声明 2 条/.test(out), out.split('\n')[1])
  check('the kind is rendered', out.includes('function `foo`'), out)
  check('the name is rendered', out.includes('class `Bar`'), out)
  check('the signature is rendered', out.includes('export function foo() {}'), out)
  check('the line number is usable as an anchor', out.includes('src/d.ts#L1') && out.includes('src/d.ts#L2'), out)
  check('the disclaimer is present', out.includes(SKELETON_DISCLAIMER), '')
  check('the disclaimer denies completeness', /不是完整架构/.test(out), '')
  check('the disclaimer states the window size', new RegExp(`文件开头的 ${EXCERPT_WINDOW_CHARS} 字符`).test(out), '')
  check('the disclaimer says headers and imports fill the window', /版权头与 import 常常就把它填满/.test(out), '')
  check('the disclaimer denies the repository-level reading', /零命中不代表该仓库没有类或函数/.test(out), '')
  check('the disclaimer refuses topology claims', /推不出依赖方向、调用链或进程边界/.test(out), '')
  check('no topology conclusion is drawn', !/(依赖方向是|调用链为|进程边界是)/.test(out), out)

  // Every branch must carry the disclaimer, including the degenerate ones.
  const branches = [
    renderSkeleton('src/d.ts', hits),
    renderSkeleton('src/a.ts', scanSignatures('src/a.ts', '// nothing\n')),
    renderSkeleton('README.md', scanSignatures('README.md', '# hi\n')),
    renderSkeleton('src/e.ts', []),
  ]
  check('every branch carries the disclaimer', branches.every((b) => b.includes(SKELETON_DISCLAIMER)), '')
  check('no branch returns an empty string', branches.every((b) => b.trim().length > 0), '')
  check('a missing fact record is reported as missing', /没有文件级事实记录/.test(branches[3]), branches[3])
  check('a declaration-only list is not mistaken for a fact record', /没有文件级事实记录/.test(renderSkeleton('src/f.ts', hits.slice(1))), '')
  check('an unknown path is labelled, not left blank', renderSkeleton('', hits).includes('(未知路径)'), renderSkeleton('', hits).split('\n')[0])
}

console.log('\n=== T12. renderInspections prints the skeleton between the file list and the manifest ===')
{
  const row = (extra) => ({
    full_name: 'owner/repo',
    url: 'https://github.com/owner/repo',
    ok: true,
    files_read: ['src/d.ts'],
    readme_excerpt: '',
    manifest_excerpt: '{"name":"repo"}',
    tree_summary: 'src/\n  d.ts',
    skeleton_summary: renderSkeleton('src/d.ts', scanSignatures('src/d.ts', 'export function foo() {}\n')),
    error: '',
    ...extra,
  })
  const report = renderInspections('x', [row()], null, false)
  const skeletonAt = report.indexOf('[骨架：文件头局部声明证据]')
  check('the skeleton block is printed', skeletonAt > -1, '')
  check('it comes after the list of files read', skeletonAt > report.indexOf('读取文件（1）'), '')
  check('it comes before the manifest excerpt', skeletonAt < report.indexOf('[依赖清单摘录]'), '')
  check('the heading is printed exactly once per file', report.split('[骨架：文件头局部声明证据]').length - 1 === 1, String(report.split('[骨架：文件头局部声明证据]').length - 1))
  check('the skeleton content is included', report.includes('function `foo`'), '')

  // A cache written by an older format has no such key. The interface says the
  // field is required, so this is exactly the case that must not throw.
  const legacy = row()
  delete legacy.skeleton_summary
  let legacyReport = ''
  let threw = false
  try {
    legacyReport = renderInspections('x', [legacy], null, false)
  } catch (err) {
    threw = true
    legacyReport = String(err)
  }
  check('a row with no skeleton_summary does not throw', !threw, legacyReport)
  check('and the rest of the report still renders', legacyReport.includes('读取文件（1）') && legacyReport.includes('[依赖清单摘录]'), '')
  check('and no undefined leaks into the report', !legacyReport.includes('undefined'), legacyReport.split('\n').find((l) => l.includes('undefined')) ?? '')

  const empty = renderInspections('x', [row({ skeleton_summary: '' })], null, false)
  check('an empty skeleton_summary prints no heading', !empty.includes('[骨架：文件头局部声明证据]'), '')
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
