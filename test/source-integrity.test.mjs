// Source-text integrity: no replacement characters, no lost punctuation spacing,
// and the measured numbers the incident silently corrupted are still the right
// numbers.
//
// WHY THIS FILE EXISTS
// --------------------
// On the night of 2026-10-12 a lossy encoding round-trip rewrote the source
// tree. The unit of damage was: **one 3-byte character plus the single byte that
// followed it**, rewritten as U+FFFD + `?`. `—` `–` `≤` `★` `→` and every CJK
// ideograph are 3 bytes, so the byte that followed them is what disappeared.
//
// That gives two very different failure modes, and only the first was loud:
//
//   1. LOUD. Where the following byte was part of a multi-byte sequence, the
//      result was U+FFFD and tsc reported `Unterminated string literal`, 28 of
//      them. A broken build is a working alarm.
//
//   2. SILENT, and this is the reason the file exists. Where the following byte
//      was a space, only the space vanished:
//
//        '* ... the field anchors'   ->  '* ... the field anchors'
//        '* far cheaper to read — which is exactly ...'
//                                    ->  '* far cheaper to read —which is exactly ...'
//
//      and where it was a DIGIT, a measured number changed value:
//
//        '30 repos spanning 2,528–73,328 stars'  ->  '... 2,528—3,328 stars'
//        '... of which 25 had ≤100 stars'        ->  '... of which 25 had ≤00 stars'
//
//      Note the second pair: the en-dash became an em-dash AND the `7` was gone.
//      tsc is blind to all of it. A comment that reads `2,528—3,328` compiles.
//
// The suite still reported 10/10 throughout, because every test imports `lib/` —
// the BUILD output — while the source on disk no longer compiled. A green run
// said nothing about the file being edited.
//
// HOW THE DAMAGE WAS RECOVERED (and why the checks below are shaped this way)
// ---------------------------------------------------------------------------
// A line's correct text is knowable if any pre-corruption revision contains the
// same line. Two sources qualified: HEAD, and dangling blobs left in the object
// store by an earlier `git add` (13 snapshots in total). A line was rewritten
// only when those sources agreed; where none of them knew the line, the repo's
// own convention was applied. The convention is unambiguous because HEAD has
// ZERO cases of `—`/`★`/`→` touching a Latin word, against 186 spaced ones.
//
// One line could not be recovered and is still wrong: `src/types.ts:82` reads
//
//   * related). The previous mapping — `>=9→, >=7→, >=5→, >=3→, else 1` — was
//
// where each `→` lost the star value that followed it. No commit, no blob and no
// build artefact contains that line, so the values are unknown. It is left
// visibly broken rather than filled with a guess.
//
// So the invariants pinned here are about SOURCE TEXT, not behaviour. All of
// them are cheap, and none of them were checked before.
//
// Run with:  npm test
// Or directly: node test/source-integrity.test.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(pkgRoot, 'src')

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

// Only committed, human-written text. `lib/` is build output, `eval/runs/` is
// gitignored runtime data, and `node_modules` is neither.
//
// `.scratch/` is skipped for the same reason, and the omission was a real defect
// rather than a convenience: the directory is gitignored by design (see
// `.gitignore`) and holds one-off probe output, including dumps of OTHER
// projects' build artefacts. Those dumps contain U+FFFD legitimately — it is
// their own minified text, not this repo's damage — so the gatekeeper failed on
// a directory its own header says it does not cover, and passed on a fresh clone
// where the directory does not exist. A check that depends on whether someone
// happened to run a probe is not a check.
//
// `.archify/` failed the same way, for the same reason. It is the diagram
// renderer's working directory, gitignored by design; its `finalize.json` and
// `validate.json` receipts quote local paths that a GBK console had already
// mangled, so they contain U+FFFD as recorded DATA, not as damage to this repo.
// The three diagram artefacts that ARE committed live under `docs/` and are
// still scanned.
const SKIP_DIRS = new Set(['node_modules', 'lib', '.git', 'runs', 'isolated-home', '.scratch', '.archify'])
const TEXT_EXT = /\.(ts|mjs|cjs|js|json|md|yml|yaml|txt)$/

function walk(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) found.push(...walk(p))
    else if (TEXT_EXT.test(name)) found.push(p)
  }
  return found
}

// The six modules. Every spacing check runs over all of them: the incident hit
// `src/types.ts` (19 lines) and `src/github.ts` (25) harder than the two files
// the first version of this test looked at.
const MODULES = ['query', 'lexicon', 'index', 'render', 'types', 'github']
const readModule = (name) => readFileSync(join(SRC, `${name}.ts`), 'utf8')

// ---------------------------------------------------------------------------
console.log('\n=== T1. no replacement characters anywhere in the tree ===')
{
  const files = walk(pkgRoot)
  const offenders = []
  let scanned = 0
  for (const p of files) {
    let text
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    scanned++
    const n = (text.match(/\uFFFD/g) ?? []).length
    if (n > 0) offenders.push(`${relative(pkgRoot, p)}: ${n}`)
  }

  check('the scan actually found files to scan', scanned > 20, String(scanned))
  check('no file contains U+FFFD', offenders.length === 0, offenders.slice(0, 8).join(', '))
}

console.log('\n=== T2. the destroyed lexicon keys are intact ===')
{
  // These 19 keys lost their final character in the incident. Each one is a real
  // lookup key: a truncated form is still a valid string, so nothing failed —
  // the entry simply stopped matching. Named individually rather than counted,
  // because the count would pass with the wrong 19 keys present.
  const lex = readModule('lexicon')
  const keys = ['本地优先的', '本地化', '自托管', '自部署', '开源', '轻量级', '跨平台',
    '命令行', '移动端', '分布式', '记事本', '知识库', '番茄钟', '阅读器', '剪贴板',
    '代码编辑器', '静态站点', '音乐播放器', '端到端加密']
  const missing = keys.filter((k) => !lex.includes(`'${k}'`))
  check(`all ${keys.length} restored keys are present as quoted keys`,
    missing.length === 0, missing.join(', '))

  // The agent-ecosystem entries the incident also damaged.
  const ecosystem = ['技能市场', '技能管理', '技能商店', '插件市场', '插件管理']
  const missEco = ecosystem.filter((k) => !lex.includes(`'${k}'`))
  check(`all ${ecosystem.length} agent-ecosystem keys are present`,
    missEco.length === 0, missEco.join(', '))
}

console.log('\n=== T3. user-facing strings keep their CJK/Latin spacing ===')
{
  // `≤ 100` and `AND` were both measured as regressions, not chosen for looks.
  const q = readModule('query')
  const SPOT = [
    ['本次仅返回 ${count} 个', 'the count is separated from the phrase'],
    ['多词 AND 匹配', 'the Latin operator keeps its spaces'],
    ['star ≤ 100 的小项目', 'the comparison keeps its space'],
    ['配额耗尽时 GitHub 可能不报错', 'CJK does not touch Latin'],
  ]
  for (const [needle, why] of SPOT) {
    check(`query.ts contains ${JSON.stringify(needle)} (${why})`, q.includes(needle))
  }

  // The broad form of the same invariant. HEAD has zero CJK-touching-Latin
  // occurrences in all six modules, so this is asserted as exactly zero rather
  // than as "small": the incident produced exactly this pattern, and it is the
  // one a reviewer would skim past.
  for (const name of MODULES) {
    const tight = (readModule(name).match(/[\u4e00-\u9fff][A-Za-z]/g) ?? []).length
    check(`src/${name}.ts has no CJK-touching-Latin regressions`, tight === 0, `${tight} occurrence(s)`)
  }
}

console.log('\n=== T4. punctuation keeps its trailing space before Latin text ===')
{
  // The other half of the silent damage: `— the field anchors` -> `—the field
  // anchors`. HEAD writes 186 spaced occurrences and ZERO unspaced ones, so the
  // convention is unambiguous. Asserted over every module because the two worst
  // hit files (types.ts, github.ts) were not covered at all before.
  //
  // `≤` is deliberately NOT in the mark class: the repo writes `≤100` unspaced
  // and `≤ 100 的小项目` spaced, so there is no single rule for it. `——` does not
  // match either, because the second em-dash is the character that follows the
  // first and it is not in the lookahead set.
  const MARK_BEFORE_LATIN = /[\u2014\u2605\u2192](?=[A-Za-z0-9`*])/g
  for (const name of MODULES) {
    const hits = readModule(name).match(MARK_BEFORE_LATIN) ?? []
    check(`src/${name}.ts spaces \u2014/\u2605/\u2192 before Latin text`,
      hits.length === 0, `${hits.length} occurrence(s): ${hits.join(' ')}`)
  }
}

console.log('\n=== T5. the measured numbers the incident changed value are restored ===')
{
  // These are the content losses, not spacing losses: a digit was the deleted
  // byte, so the sentence kept reading as a sentence while reporting a different
  // measurement. Recovered from 13 independent pre-corruption snapshots.
  const cases = [
    ['query', '2,528–73,328', 'the star span of the sort=stars channel'],
    ['query', '0–566', 'the star span of the sort=updated channel'],
    ['github', '2,528–73,328', 'the same span, quoted in the module that measures it'],
    ['github', '0–566', 'the same span, quoted in the module that measures it'],
    ['github', '≤100', 'how many of the 59 merged repos cleared the tail ceiling'],
  ]
  for (const [name, needle, why] of cases) {
    check(`src/${name}.ts still says ${JSON.stringify(needle)} (${why})`,
      readModule(name).includes(needle))
  }

  // And the em-dash form the corruption produced must be gone, so a future
  // re-corruption cannot pass T5 by leaving both spellings in the file.
  for (const name of ['query', 'github']) {
    check(`src/${name}.ts no longer contains the corrupted "2,528—3,328"`,
      !readModule(name).includes('2,528\u20143,328'))
  }
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
