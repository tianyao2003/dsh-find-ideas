// Golden-fixture regression harness for `inspect_projects` rendering.
//
// WHY THIS EXISTS
// ---------------
// M1/M2/M3 of the v0.4.1 cost work change how big a card is and how fast it is
// produced. The acceptance criterion for those tasks is "the effect does not
// change". A criterion that vague cannot be checked by reading a diff, and the
// end-to-end A/B run cannot check it either: it has ten runs, and ten runs cannot
// distinguish "same information" from "same-ish information".
//
// So the check is done at the layer where "same" has a definition: take the 48
// real inspections recorded during the v0.4.0 A/B run, feed them back through the
// CURRENT renderer, and compare.
//
// Two comparison modes, because two different things must be preserved:
//
//   --mode=bytes    Every card is byte-identical to the recorded baseline.
//                   Required by M1 (schema text) and M3 (parallel reads): those
//                   changes must not touch what the model sees AT ALL.
//
//   --mode=info     The card may shrink, but it must not lose information it
//                   cannot name: same `files_read`, same tree entry count, same
//                   skeleton signature count, and every cut is still reported
//                   in the trim notice. Required by M2 and M4 (budget changes),
//                   where shrinking IS the point.
//
// The distinction matters. Applying --mode=bytes to M2 would fail on every
// change and teach nothing; applying --mode=info to M1 would pass while the
// schema silently changed. Each task names the mode it must satisfy.
//
// THE FIXTURE IS NOT SYNTHETIC
// ----------------------------
// `eval/fixtures/inspect-golden-raw.json` is the `inspections` array captured
// from 12 real `inspect_projects` calls during the v0.4.0 A/B run (48 distinct
// repositories, 531,831 bytes of raw block content). It is checked in because a
// fixture regenerated today would not be the same fixture: the repositories
// have moved on, and a regression test whose input drifts with GitHub tests
// GitHub, not this code.
//
// Usage:
//   node eval/harness/golden-inspect.mjs --write          # record the baseline
//   node eval/harness/golden-inspect.mjs --mode=bytes     # verify byte equality
//   node eval/harness/golden-inspect.mjs --mode=info      # verify information equality
//   node eval/harness/golden-inspect.mjs --mode=bytes --report   # dump current state
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const FIXTURE = join(ROOT, 'eval', 'fixtures', 'inspect-golden-raw.json')
const BASELINE = join(ROOT, 'eval', 'fixtures', 'inspect-golden-baseline.json')

// The budgets the real A/B calls actually used, plus the two ends of the
// documented range. Testing only the default would leave the trim path (the code
// M2 and M4 actually change) untested at every other budget.
const BUDGETS = [8000, 12000, 16000, 24000, 28000, 40000, 60000, 64000]

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}

const { renderInspections, INSPECT_BYTES_DEFAULT } = await import(
  new URL('../../lib/render.js', import.meta.url).href
)

const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'))

/**
 * Structural signature of a rendered card: the information a smaller card is
 * still allowed to carry, expressed without reference to how it is laid out.
 *
 * Counts rather than content, because the point of M2 is to change content.
 * `filesRead` is listed in full because "which files were read" is the evidence
 * chain: dropping a file from it would be a real loss even if the card got
 * smaller.
 */
// Every pattern below is anchored on the exact bytes the renderer emits, and each
// one was checked against the fixture's own recorded content before being trusted.
// Three earlier versions were vacuous or inverted and still reported PASS:
//   - `line.includes('📝')` never matched: section headers print `📦`.
//   - `/^\s{2,}(?:class|interface|…)` never matched: declaration rows are
//     `     method \`x\` — #L12`, and inside the quoted block they gain a `  │ `
//     gutter, so the kind is never at the start of the line.
//   - `line.includes('📦')` over-counted: a README excerpt can itself contain a
//     📦 bullet, so the header must be anchored at column 0.
// A check that cannot fail is worse than no check: it certifies the thing it never
// looked at. Each pattern is therefore paired with `assertPatternsStillMatch()`,
// which refuses to run if the current renderer stops producing matching lines.
const PATTERN = {
  repoHeader: /^📦 \S/,
  filesRead: /读取文件（(\d+)）：(.+)$/,
  // Quoted-block body lines: the `  │ ` gutter plus the tree glyphs it wraps. The
  // baseline's recorded values for this field are valid (the regex always worked),
  // so the field keeps its historical name and stays comparable.
  treeLine: /^\s{2,}[│├└]|^\s{2,}[\w.\-/]+\/$/,
  // Declaration rows, current format and the older per-file format both.
  declaration: /^\s*(?:│\s*)?(?:·\s*)?(?:class|interface|enum|type|function|method|struct|trait|impl|const)\s+`/,
  cutNotice: /裁剪|省略|dropped|trimmed/,
}

function signature(card) {
  const lines = card.split('\n')
  const filesRead = []
  let treeEntries = 0
  let skeletonHits = 0
  let cutNotices = 0
  let repos = 0
  for (const line of lines) {
    if (PATTERN.repoHeader.test(line)) repos++
    const read = PATTERN.filesRead.exec(line)
    if (read !== null) {
      filesRead.push(...read[2].split(', ').map((s) => s.trim()))
    }
    if (PATTERN.treeLine.test(line)) treeEntries++
    if (PATTERN.declaration.test(line)) skeletonHits++
    if (PATTERN.cutNotice.test(line)) cutNotices++
  }
  return {
    bytes: Buffer.byteLength(card, 'utf8'),
    repos,
    filesRead,
    treeEntries,
    skeletonHits,
    cutNotices,
  }
}

/**
 * What the fixture says the card must contain, derived from the recorded
 * `inspections` rather than from a previously rendered card.
 *
 * This is the only part of the harness that cannot go stale when the renderer
 * changes: `files_read` is data the tool returned, `inspections.length` is how many
 * repositories were read, and the declaration rows are already present in the
 * stored `skeleton_summary` string (the renderer only re-wraps them).
 */
function fixtureTruth(value) {
  const filesRead = []
  let declarations = 0
  for (const inspection of value.inspections) {
    if (!inspection.ok) continue
    filesRead.push(...inspection.files_read)
    for (const line of String(inspection.skeleton_summary ?? '').split('\n')) {
      if (PATTERN.declaration.test(line)) declarations++
    }
  }
  return { repos: value.inspections.length, filesRead, declarations }
}

/**
 * Guards against the failure mode this harness already had: a regex that silently
 * matches nothing, so the check comparing its count to itself passes forever.
 */
function assertPatternsStillMatch() {
  const problems = []
  let repos = 0
  let declarations = 0
  let tree = 0
  let files = 0
  for (const key of Object.keys(raw)) {
    const value = raw[key].value
    const card = renderInspections(value.idea, value.inspections, value.degraded ?? null, value.cached ?? false, Number.POSITIVE_INFINITY)
    const s = signature(card)
    repos += s.repos
    declarations += s.skeletonHits
    tree += s.treeEntries
    files += s.filesRead.length
  }
  if (repos === 0) problems.push('repoHeader never matched a section header')
  if (declarations === 0) problems.push('declaration never matched a signature row')
  if (tree === 0) problems.push('treeLine never matched a quoted body line')
  if (files === 0) problems.push('filesRead never matched a read-files line')
  if (problems.length > 0) {
    console.error('the signature patterns no longer describe the renderer:')
    for (const p of problems) console.error('  - ' + p)
    console.error('fix the patterns (and re-check them against the fixture) before trusting any result')
    process.exit(2)
  }
}

function build() {
  const out = []
  for (const key of Object.keys(raw)) {
    const entry = raw[key]
    const value = entry.value
    const row = { name: entry.name, idea: value.idea, budgets: {} }
    for (const budget of BUDGETS) {
      const card = renderInspections(
        value.idea,
        value.inspections,
        value.degraded ?? null,
        value.cached ?? false,
        budget,
      )
      row.budgets[String(budget)] = {
        sha256: createHash('sha256').update(card, 'utf8').digest('hex'),
        ...signature(card),
      }
    }
    // The default budget is named separately because it is the one every caller
    // that passes no `budget_bytes` gets — the common path, not a special case.
    if (!BUDGETS.includes(INSPECT_BYTES_DEFAULT)) {
      const card = renderInspections(
        value.idea,
        value.inspections,
        value.degraded ?? null,
        value.cached ?? false,
      )
      row.budgets[String(INSPECT_BYTES_DEFAULT)] = {
        sha256: createHash('sha256').update(card, 'utf8').digest('hex'),
        ...signature(card),
      }
    }
    out.push(row)
  }
  return {
    generatedFrom: 'eval/fixtures/inspect-golden-raw.json',
    pluginVersion: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
    formatVersion: currentFormatVersion(),
    entries: out,
  }
}

function currentFormatVersion() {
  const src = readFileSync(join(ROOT, 'lib', 'render.js'), 'utf8')
  const m = /INSPECT_FORMAT_VERSION\s*=\s*(\d+)/.exec(src)
  return m === null ? null : Number(m[1])
}

const now = build()
now.formatVersion = currentFormatVersion()

// Before ANY output, including a freshly recorded baseline: recording counts from
// patterns that no longer match would freeze the vacuity into the baseline itself,
// which is exactly how the original `repos`/`skeletonHits` fields became constants.
assertPatternsStillMatch()

if (flag('write')) {
  // The baseline is the ONLY byte-level record of what the model saw before M1/M2.
  // Re-recording it silently would erase the evidence that those tasks changed
  // nothing but layout: after a re-record, `--mode=bytes` compares the new renderer
  // to itself and always passes. So it takes an explicit flag, and the previous
  // baseline is kept beside it.
  if (!flag('force')) {
    console.error('refusing to overwrite the baseline without --force')
    console.error(`  ${BASELINE}`)
    console.error('  this file is the frozen record of the pre-M1/M2 bytes; overwriting it')
    console.error('  makes --mode=bytes compare the renderer to itself, which cannot fail.')
    console.error('  pass --force if the change to what the model sees is intended and recorded.')
    process.exit(2)
  }
  if (existsSync(BASELINE)) {
    writeFileSync(BASELINE.replace(/\.json$/, '.prev.json'), readFileSync(BASELINE))
  }
  writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n', 'utf8')
  const cards = now.entries.reduce((s, e) => s + Object.keys(e.budgets).length, 0)
  console.log(`wrote ${BASELINE}`)
  console.log(`  entries=${now.entries.length} cards=${cards} formatVersion=${now.formatVersion}`)
  console.log(`  previous baseline kept at ${BASELINE.replace(/\.json$/, '.prev.json')}`)
  process.exit(0)
}

if (flag('report')) {
  console.log(JSON.stringify(now, null, 2))
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error(`no baseline at ${BASELINE} — run with --write first`)
  process.exit(2)
}

const mode = opt('mode', 'bytes')
const base = JSON.parse(readFileSync(BASELINE, 'utf8'))

// What the card must contain, according to the recorded tool output rather than to
// any previously rendered card. Two of the baseline's fields are unusable
// (`repos` was counted with a `📝` that never appears, `skeletonHits` with a regex
// that never matched), so the truth for those two comes from here instead.
const truthByEntry = new Map(
  Object.values(raw).map((entry) => [entry.name, fixtureTruth(entry.value)]),
)

let pass = 0
let fail = 0
const failures = []
function check(label, cond, detail = '') {
  if (cond) {
    pass++
  } else {
    fail++
    failures.push(`${label}${detail === '' ? '' : '  -> ' + detail}`)
  }
}

// `assertPatternsStillMatch()` already ran above, before the --write/--report
// exits: repeating it here would only re-render all 96 cards to reach the same
// conclusion.

check('same number of fixture entries', now.entries.length === base.entries.length,
  `${now.entries.length} vs ${base.entries.length}`)
for (const want of base.entries) {
  const got = now.entries.find((e) => e.name === want.name)
  if (got === undefined) {
    check(`${want.name}: entry still renders`, false, 'entry missing')
    continue
  }
  const truth = truthByEntry.get(want.name)
  if (truth === undefined) {
    check(`${want.name}: fixture still carries this entry`, false, 'not in fixture')
    continue
  }
  // The untrimmed render of the same input, used as the "nothing was dropped"
  // reference. Comparing a card to its own untrimmed form is renderer-independent:
  // it holds whether the renderer got smaller or larger, which is exactly what the
  // old baseline-relative checks got wrong.
  const value = Object.values(raw).find((entry) => entry.name === want.name).value
  const full = signature(renderInspections(
    value.idea, value.inspections, value.degraded ?? null, value.cached ?? false,
    Number.POSITIVE_INFINITY,
  ))

  for (const budget of Object.keys(want.budgets)) {
    const w = want.budgets[budget]
    const g = got.budgets[budget]
    if (g === undefined) {
      check(`${want.name}@${budget}: budget still produced`, false, 'missing')
      continue
    }
    if (mode === 'bytes') {
      check(`${want.name}@${budget}: byte-identical`,
        g.sha256 === w.sha256,
        `bytes ${w.bytes} -> ${g.bytes}`)
    } else if (mode === 'info') {
      // The evidence chain. Checked against the recorded tool output, so this stays
      // meaningful no matter how the card is laid out or how often the baseline is
      // re-recorded.
      check(`${want.name}@${budget}: same files_read`,
        JSON.stringify(g.filesRead) === JSON.stringify(truth.filesRead),
        `${truth.filesRead.length} -> ${g.filesRead.length}`)
      check(`${want.name}@${budget}: every inspected repo still has a section`,
        g.repos === truth.repos,
        `${truth.repos} -> ${g.repos}`)
      // Structural evidence may not shrink below what the baseline already showed.
      // The baseline's treeEntries count is valid (that regex always worked); its
      // skeletonHits is 0 for every card, so only the tree half can be compared.
      const baselineInfo = w.treeEntries + w.skeletonHits
      check(`${want.name}@${budget}: structural evidence not reduced`,
        g.treeEntries + g.skeletonHits >= baselineInfo,
        `${baselineInfo} -> ${g.treeEntries + g.skeletonHits}`)
      // Anything dropped relative to this card's own untrimmed form must be named.
      check(`${want.name}@${budget}: every dropped block is announced`,
        g.bytes >= full.bytes || g.cutNotices > 0,
        `card ${g.bytes}B vs untrimmed ${full.bytes}B, notices=${g.cutNotices}`)
      // Staying inside the budget is the contract; the one documented exception is
      // a card that says out loud it could not fit. The phrase below is bound to
      // `src/render.ts`; it changed in v0.4.0 when the byte cap stopped being a
      // caller-supplied parameter (`budget_bytes` -> 卡片字节预算).
      check(`${want.name}@${budget}: within budget, or says it cannot fit`,
        g.bytes <= Number(budget) || /仍超过卡片字节预算=/.test(renderInspections(
          value.idea, value.inspections, value.degraded ?? null, value.cached ?? false, Number(budget),
        )),
        `${g.bytes}B vs budget ${budget}`)
      // Growth is allowed ONLY where the baseline itself had over-trimmed: the
      // smaller untrimmed card then stops one rung earlier on the trim ladder and
      // carries more. An untrimmed card growing is a real regression, and is what
      // this catches. (The old `no growth` check failed in exactly this case: it
      // fired on the 25 cards the baseline had trimmed, and passed on nothing else.)
      check(`${want.name}@${budget}: grows only where the baseline over-trimmed`,
        g.bytes <= w.bytes || w.cutNotices > 0,
        `${w.bytes} -> ${g.bytes} (baseline cut notices=${w.cutNotices})`)
    } else {
      console.error(`unknown --mode=${mode}`)
      process.exit(2)
    }
  }
}

console.log(`\n=== golden-inspect (--mode=${mode}) ===`)
console.log(`  fixture entries : ${now.entries.length}`)
console.log(`  budgets         : ${BUDGETS.join(', ')}`)
console.log(`  checks          : ${pass} PASS / ${fail} FAIL`)
if (fail > 0) {
  console.log('\nfirst failures:')
  for (const f of failures.slice(0, 20)) console.log('  FAIL  ' + f)
  if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`)
  process.exit(1)
}
console.log('  result          : OK')
