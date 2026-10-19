// Regression tests for what one inspected file is worth showing, and for the
// card-level framing that keeps a 1200-character window from being read as a
// whole file.
//
// THE FAILURE THIS SUITE PINS DOWN, measured on the 12 real `inspect_projects`
// dumps from the A/B eval:
//
//   * the file-excerpt section was 47.5% of every payload, and 45.0% of that was
//     files no scanner reads (`.md` prose, `.json`/`.toml`/`.mod` manifests),
//     plus another 10.4% in source languages the scanner does not cover;
//   * the skeleton section was 23.7%, of which the disclaimer boilerplate was
//     82.1% and the real declaration lines were 4.7% -- the same five sentences
//     repeated once per FILE when they are a claim about the METHOD;
//   * the README was emitted twice (121.7KB + 68.9KB in the same payloads), so
//     a quarter of every card was README text.
//
// The rule the fix follows is not "show less". It is: show the window when a
// scanner actually reads that window, state the framing once per card, and when
// something is NOT shown, say WHICH thing is true -- "not looked at" must never
// read as "looked at, found nothing".
//
// Run with:  node test/run-all.test.mjs
// Or directly: node test/excerpt-disposition.test.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const {
  classifyExcerpt,
  describeExcerpt,
  extractReadmeLead,
  isRootReadmePath,
  renderReadmeExcerpt,
  README_ALREADY_SHOWN,
} = await load('excerpts.js')
const {
  renderSkeletonCard,
  renderSkeleton,
  README_LEAD_CHARS,
  SKELETON_DISCLAIMER,
  INSPECT_FORMAT_VERSION,
} = await load('render.js')
const { scanSignatures, EXCERPT_WINDOW_CHARS, SCANNED_EXTENSIONS, isDeclarationHit } = await load('skeleton.js')

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

// The predicate `describeExcerpt` uses internally, re-exported from this module
// so the test calls the same one the product calls.
const isSource = (path) => loadIsSource(path)
const selectModule = await load('select.js')
function loadIsSource(path) {
  return selectModule.isSourcePath(path)
}

console.log('--- the root README is the only README treated as already shown ---')
check('README.md is the root README', isRootReadmePath('README.md'))
check('readme.rst is too', isRootReadmePath('readme.rst'))
check('a nested README is a different artifact', !isRootReadmePath('docs/README.md'), 'logseq keeps one inside a vendored HEIF decoder')
check('a non-README file is not', !isRootReadmePath('src/index.ts'))

console.log('\n--- classifyExcerpt: four outcomes, four different claims ---')
{
  const d = (path) => classifyExcerpt(path, isSource)

  const readme = d('README.md')
  check('the root README is readme-lead', readme.kind === 'readme-lead', JSON.stringify(readme))

  const nestedReadme = d('docs/README.md')
  check('a nested README is title-only, not readme-lead', nestedReadme.kind === 'title-only', JSON.stringify(nestedReadme))

  const doc = d('docs/architecture.md')
  check('a non-README doc is title-only', doc.kind === 'title-only', JSON.stringify(doc))

  const manifest = d('package.json')
  check('a manifest is path-only', manifest.kind === 'path-only' && manifest.reason === 'not-source', JSON.stringify(manifest))

  const lockfile = d('go.sum')
  check('a lockfile is path-only', lockfile.kind === 'path-only' && lockfile.reason === 'not-source', JSON.stringify(lockfile))

  const ts = d('src/index.ts')
  check('a scanned language gets its window', ts.kind === 'window', JSON.stringify(ts))

  // The gap this module exists to close: `SOURCE_EXT_RE` accepts 35 extensions,
  // the scanner reads 11. A file in the 24-extension gap is SOURCE, so the old
  // code dumped its 1200-char head verbatim -- and then never scanned it. The
  // head was pure cost carrying no signature evidence.
  for (const path of ['src/plugin.lua', 'src/App.swift', 'lib/helper.rb']) {
    const verdict = d(path)
    check(`${path} is source the scanner cannot read`, verdict.kind === 'path-only' && verdict.reason === 'unscanned-language', JSON.stringify(verdict))
  }

  // Every scanned extension must reach `window`, and every non-source path must
  // NOT: this is the subset relation the module was created to enforce.
  const scannedMisses = SCANNED_EXTENSIONS.filter((ext) => d(`src/probe.${ext}`).kind !== 'window')
  check('every scanner extension reaches the window', scannedMisses.length === 0, `missed: ${scannedMisses.join(',')}`)

  const classified = ['README.md', 'docs/x.md', 'package.json', 'go.sum', 'src/a.ts', 'src/a.lua', '', 'x']
  check('classification is total: every input gets a disposition',
    classified.every((p) => typeof d(p).kind === 'string'), JSON.stringify(classified.map((p) => [p, d(p)])))
}

console.log('\n--- extractReadmeLead: the paragraph that answers "what is this" ---')
{
  const badgeWall = '# Proj\n\n[![build](https://img.shields.io/x.svg)](https://ci)\n\nA local-first notes tool with a SQLite backend. Second sentence.\n\n## Install\n\nnpm i\n'
  const lead = extractReadmeLead(badgeWall, README_LEAD_CHARS)
  check('the badge wall is skipped and the description survives',
    lead.text === 'A local-first notes tool with a SQLite backend. Second sentence.', JSON.stringify(lead.text))
  check('the skip is reported rather than silent', /已跳过/.test(lead.note), JSON.stringify(lead.note))
  check('the lead never contains the install steps', !/npm i/.test(lead.text), JSON.stringify(lead.text))

  // The regression this filter exists for, taken from the real fixture:
  // `make-all/tuya-local` opens with a contribution note. Markdown link syntax
  // sits in the middle of the sentence, so the test must see the VISIBLE text --
  // matching the raw string fails on the `[` and lets it through.
  const contributionFirst = '# tuya-local\n\nPlease report any [issues](https://github.com/make-all/tuya-local/issues) and feel free to raise pull requests.\n\nLocal Tuya integration for Home Assistant.\n'
  const recovered = extractReadmeLead(contributionFirst, README_LEAD_CHARS)
  check('a contribution note is skipped even when it contains a Markdown link',
    recovered.text === 'Local Tuya integration for Home Assistant.', JSON.stringify(recovered.text))
  check('and the skip is counted in the note', /已跳过 1 段贡献\/许可说明/.test(recovered.note), JSON.stringify(recovered.note))

  // A real description may legitimately mention issues; only the OPENING counts.
  const mentionsIssues = '# Proj\n\nA CLI that files issues to your tracker and closes them when merged.\n'
  const kept = extractReadmeLead(mentionsIssues, README_LEAD_CHARS)
  check('a real description that mentions issues is kept', kept.text === 'A CLI that files issues to your tracker and closes them when merged.', JSON.stringify(kept.text))

  // Fallback, not rejection: "no description" would be a false claim here.
  const allBoilerplate = '# P\n\nContributions are welcome.\n\nLicence: MIT\n'
  const fallback = extractReadmeLead(allBoilerplate, README_LEAD_CHARS)
  check('when every paragraph looks like boilerplate the first is used anyway',
    fallback.text === 'Contributions are welcome.', JSON.stringify(fallback.text))

  // A title-only README must SAY it has no prose. `''` would read as "the
  // README is empty", which is a different and false claim.
  const titleOnly = '# Proj\n\n![a](https://x/b.svg)\n![b](https://x/c.svg)\n'
  const empty = extractReadmeLead(titleOnly, README_LEAD_CHARS)
  check('a title-only README returns no text', empty.text === '', JSON.stringify(empty.text))
  check('and says so explicitly rather than returning a bare empty string',
    /没有正文段落/.test(empty.note) && /没有可摘录的项目描述/.test(empty.note), JSON.stringify(empty.note))

  // A heading that starts the install section ends the description.
  const stopsAtInstall = '# P\n\n## Usage\n\nDo the thing.\n'
  check('the install/usage section is not read as the description',
    extractReadmeLead(stopsAtInstall, README_LEAD_CHARS).text === '', JSON.stringify(extractReadmeLead(stopsAtInstall, README_LEAD_CHARS).text))

  // The lead is capped, and the cap is stated.
  const long = '# P\n\n' + 'This is a sentence. '.repeat(60) + '\n'
  const capped = extractReadmeLead(long, README_LEAD_CHARS)
  check('an over-long paragraph is cut to the budget', capped.text.length <= README_LEAD_CHARS + 1, `${capped.text.length} chars`)
  // The cut lands on a sentence boundary and the ellipsis marks it as elided, so
  // the text reads "…sentence.…" rather than stopping mid-word.
  check('the cut is at a sentence end, not mid-word', /\.…$/.test(capped.text), JSON.stringify(capped.text.slice(-30)))
  check('the elision is reported', /已按句末截断/.test(capped.note), JSON.stringify(capped.note))

  check('an empty README is not an error', JSON.stringify(extractReadmeLead('', 400)) === JSON.stringify({ text: '', note: '' }))
  check('a non-string input does not throw', JSON.stringify(extractReadmeLead(null, 400)) === JSON.stringify({ text: '', note: '' }))
}

console.log('\n--- renderReadmeExcerpt: a cut README must not claim the file has no description ---')
{
  // The two notes describe different things and must not be confused:
  // `extractReadmeLead`'s note is about the PARAGRAPH it picked, the coverage
  // note is about the FILE. A README cut by the read budget whose visible part is
  // only a title and badges is the case where both are true at once, and saying
  // only "没有正文段落" there would be a claim about the whole file drawn from a
  // fragment of it -- the exact dishonesty this codebase's tests exist to stop.
  const normal = extractReadmeLead('# P\n\nA tool that does things.\n\n## Install\n\nnpm i\n', README_LEAD_CHARS)
  const whole = renderReadmeExcerpt(normal, false, 4000)
  check('the lead comes first', whole.startsWith('A tool that does things.'), JSON.stringify(whole))
  check('a whole README carries no coverage note', !/读取预算/.test(whole), JSON.stringify(whole))

  const cut = renderReadmeExcerpt(normal, true, 4000)
  check('a cut README says how much of it was available', /README 长于 4000 字符的读取预算/.test(cut), JSON.stringify(cut))
  check('and says the text is from its beginning', /以上取自其开头部分/.test(cut), JSON.stringify(cut))
  check('the paragraph note and the coverage note both survive',
    /已跳过/.test(cut) && /读取预算/.test(cut), JSON.stringify(cut))

  // The honesty case. Without the coverage note this string would assert that a
  // README of unknown length has no description, when only its first 4000
  // characters were ever read.
  const titleOnly = extractReadmeLead('# P\n\n![a](https://x/b.svg)\n', README_LEAD_CHARS)
  const titleOnlyCut = renderReadmeExcerpt(titleOnly, true, 4000)
  check('a title-only README that was also cut reports BOTH facts',
    /没有正文段落/.test(titleOnlyCut) && /读取预算/.test(titleOnlyCut), JSON.stringify(titleOnlyCut))
  check('and the two claims are on separate lines, not merged into one sentence',
    titleOnlyCut.split('\n').filter((l) => /没有正文段落|读取预算/.test(l)).length === 2, JSON.stringify(titleOnlyCut))

  // An empty README that was NOT cut has nothing true to say; an empty one that
  // WAS cut still has to say the file was longer than what was read.
  const empty = extractReadmeLead('', README_LEAD_CHARS)
  check('a whole empty README renders as the empty string', renderReadmeExcerpt(empty, false, 4000) === '', JSON.stringify(renderReadmeExcerpt(empty, false, 4000)))
  check('a cut empty README still reports the cut', /读取预算/.test(renderReadmeExcerpt(empty, true, 4000)))

  // The budget quoted in the note is the one the read actually used, not a
  // hardcoded default -- a wrong number here is a false measurement.
  check('the note quotes the budget it was given', /长于 1200 字符/.test(renderReadmeExcerpt(empty, true, 1200)), JSON.stringify(renderReadmeExcerpt(empty, true, 1200)))
}

console.log('\n--- describeExcerpt: the block and the skeleton entry agree ---')
{
  // The README's body was already rendered under `[README 摘录]`. Repeating it in
  // the file-excerpt section was 68.9KB of pure duplication. The replacement is
  // a POINTER, not a blank: blank reads as "this file is empty".
  const readme = describeExcerpt('README.md', { text: '# Proj\n\nA tool.', truncated: false }, 4000)
  check('the duplicated README is replaced by a pointer', readme.block.includes(README_ALREADY_SHOWN), JSON.stringify(readme.block))
  check('the README entry is marked readme-shown, not "no declarations"', readme.entry.skipped === 'readme-shown', JSON.stringify(readme.entry))
  check('the README block still names the file', readme.block.includes('README.md'), JSON.stringify(readme.block))

  // A scanned file keeps its window AND is scanned over exactly that window, so
  // a line number can never point at text the reader cannot see.
  const source = 'export function alpha(): void {}\nexport class Beta {}\n'
  const scanned = describeExcerpt('src/a.ts', { text: source, truncated: false }, 4000)
  check('a scanned file keeps its text verbatim', scanned.block.includes(source.trim()), JSON.stringify(scanned.block))
  const declarations = (scanned.entry.hits ?? []).filter(isDeclarationHit)
  check('and is scanned for declarations', declarations.length === 2, JSON.stringify(declarations.map((h) => h.name)))
  check('the line numbers point inside the shown window',
    declarations.every((h) => h.startLine >= 1 && h.startLine <= source.split('\n').length), JSON.stringify(declarations.map((h) => h.startLine)))

  // "Not looked at" must never read as "looked at, found nothing".
  const unscanned = describeExcerpt('src/plugin.lua', { text: 'local x = 1\n', truncated: false }, 4000)
  check('an unscanned language is reported as not looked at', /没有被扫描过/.test(unscanned.block), JSON.stringify(unscanned.block))
  check('an unscanned language carries no hit list', unscanned.entry.hits === undefined, JSON.stringify(unscanned.entry))
  check('its entry reason is unscanned-language, not not-source', unscanned.entry.skipped === 'unscanned-language', JSON.stringify(unscanned.entry))
  check('and the file text is NOT dumped anyway', !unscanned.block.includes('local x = 1'), JSON.stringify(unscanned.block))

  const manifest = describeExcerpt('package.json', { text: '{"name":"x"}\n', truncated: false }, 4000)
  check('a manifest is reduced to its path', !manifest.block.includes('"name"'), JSON.stringify(manifest.block))
  check('and says why', /非源码文件/.test(manifest.block), JSON.stringify(manifest.block))

  const doc = describeExcerpt('docs/arch.md', { text: '# Architecture\n\nThe system has three parts.\n', truncated: false }, 4000)
  check('a non-README doc shows its heading', doc.block.includes('Architecture'), JSON.stringify(doc.block))
  check('but not its prose', !doc.block.includes('three parts'), JSON.stringify(doc.block))

  // Both truncations are stated in the header, in characters, because a
  // 1200-char head of a 200KB file was previously indistinguishable from a whole
  // file. The read budget and the window are DIFFERENT cuts and each says so.
  const windowOnly = describeExcerpt('src/mid.ts', { text: 'x'.repeat(2000), truncated: false }, 4000)
  const windowHeader = windowOnly.block.split('\n')[0]
  check('a file longer than the window states the window cut', new RegExp(`本摘录只含开头 ${EXCERPT_WINDOW_CHARS} 字符`).test(windowHeader), windowHeader)
  check('and does not claim a read-budget cut that did not happen', !/读取预算/.test(windowHeader), windowHeader)

  const both = describeExcerpt('src/big.ts', { text: 'x'.repeat(4000), truncated: true }, 4000)
  const bothHeader = both.block.split('\n')[0]
  check('the header states the read-budget cut', /4000 字符的读取预算，已截断/.test(bothHeader), bothHeader)
  check('and also states the window cut', new RegExp(`${EXCERPT_WINDOW_CHARS} 字符`).test(bothHeader), bothHeader)

  const whole = describeExcerpt('src/small.ts', { text: 'export const x = 1\n', truncated: false }, 4000)
  check('a whole small file carries no coverage caveat', !/截断|未展示/.test(whole.block.split('\n')[0]), whole.block.split('\n')[0])

  // Honest about the limit of what it knows: a head of exactly one window with
  // no true file length cannot claim the window cut anything, because it cannot
  // tell "this is the whole file" from "there is more". Saying nothing is the
  // only claim that is true in both cases.
  const unknown = describeExcerpt('src/exact.ts', { text: 'y'.repeat(EXCERPT_WINDOW_CHARS), truncated: false }, 4000)
  check('an exactly-window-sized head of unknown total length claims no cut',
    !/未展示|截断/.test(unknown.block.split('\n')[0]), unknown.block.split('\n')[0])
}

console.log('\n--- renderSkeletonCard: the framing is a claim about the METHOD ---')
{
  const card = renderSkeletonCard([
    { path: 'src/a.ts', hits: scanSignatures('src/a.ts', 'export function alpha() {}\nexport class Beta {}\n') },
    { path: 'src/empty.ts', hits: scanSignatures('src/empty.ts', 'const x = 1\n') },
    { path: 'src/plugin.lua', skipped: 'unscanned-language' },
    { path: 'README.md', skipped: 'readme-shown' },
    { path: 'package.json', skipped: 'not-source' },
  ])

  // The whole point: once per card, not once per file.
  const disclaimerCount = card.split(SKELETON_DISCLAIMER).length - 1
  check('the disclaimer appears exactly once per card', disclaimerCount === 1, `${disclaimerCount} occurrences`)

  // The saving is the reason for the change, so it is measured, not assumed.
  const perFile = [
    renderSkeleton('src/a.ts', scanSignatures('src/a.ts', 'export function alpha() {}\nexport class Beta {}\n')),
    renderSkeleton('src/empty.ts', scanSignatures('src/empty.ts', 'const x = 1\n')),
  ].join('\n')
  const perFileDisclaimers = perFile.split(SKELETON_DISCLAIMER).length - 1
  check('the old per-file renderer repeated it once per file', perFileDisclaimers === 2, `${perFileDisclaimers} occurrences`)
  check('so two files already cost two disclaimers of framing', perFile.length > card.length, `${perFile.length} vs ${card.length}`)

  check('declarations are still listed', card.includes('function `alpha`') && card.includes('class `Beta`'), card)
  check('declaration line numbers survive', /#L1/.test(card) && /#L2/.test(card), card)

  // Three populations that must never be conflated.
  check('a zero-declaration file says the window may be full, not that the file is empty',
    /src\/empty\.ts（窗口内零声明/.test(card) && /不等于该文件没有类\/函数/.test(card), card)
  check('an unscanned language says it was never looked at',
    /src\/plugin\.lua（扩展名不在扫描器的语言覆盖内：这个文件根本没有被看过/.test(card), card)
  check('a non-source file says it was not scanned',
    /package\.json（非源码文件，未扫描）/.test(card), card)
  check('a README says its body was shown elsewhere',
    /README\.md（正文已在上面单独给出/.test(card), card)

  // The summary counts DECLARATIONS, not entries: "1 个有声明" for a file with
  // two functions would make the label describe files.
  check('the summary counts declarations, not files', /1 个有声明（共 2 条）/.test(card), card)
  check('the summary counts the unscanned population', /3 个未扫描/.test(card), card)
  check('the counts are separated as a list, not joined as a ratio', /，1 个窗口内零声明，3 个未扫描/.test(card), card)
  check('the unscanned breakdown is stated, not hidden in the count',
    /未扫描 ≠ 没有声明，这些文件的内容没有被看过/.test(card), card)

  // A card-level block that can be empty would read as "nothing was read".
  const emptyCard = renderSkeletonCard([])
  check('an empty card is still a block, not an empty string', emptyCard.length > 0 && emptyCard.includes('[骨架'), JSON.stringify(emptyCard))
  check('a non-array input does not throw', renderSkeletonCard(null).length > 0)
  check('a null entry is dropped rather than crashing', renderSkeletonCard([null, { path: 'src/a.ts', hits: [] }]).includes('src/a.ts'))

  check('no field renders as undefined or null',
    !/undefined|null/.test(card), card.split('\n').filter((l) => /undefined|null/.test(l)).join(' | '))

  // One card-level block means one heading, too: `renderInspections` relies on
  // the heading living inside the block it emits.
  check('the block carries its own heading exactly once',
    (card.match(/\[骨架：文件头局部声明证据\]/g) ?? []).length === 1, card)

  // Every declaration in the card must be recoverable from the excerpt text the
  // card also carries -- otherwise the de-duplication would be data loss.
  // Checked end to end on a real-shaped file below rather than asserted.
  const sample = 'export interface Config { id: string }\nexport type Id = string\nexport function load(c: Config): void {}\n'
  const plan = describeExcerpt('src/sample.ts', { text: sample, truncated: false }, 4000)
  const hits = (plan.entry.hits ?? []).filter(isDeclarationHit)
  const recoverable = hits.filter((h) => plan.block.includes(h.signature))
  check('every signature the card cites is still readable in the excerpt it ships',
    hits.length > 0 && recoverable.length === hits.length, `${recoverable.length}/${hits.length}`)
}

console.log('\n--- the format version is bumped when the rendered shape changes ---')
{
  // `inspect_projects` caches the whole `Inspection` record, and every field of
  // it is an ALREADY-RENDERED string. A cache entry written by the old renderer
  // replays the old layout -- old skeleton framing, the README twice -- and
  // nothing in the entry says which renderer wrote it. That is why the format
  // version is part of the cache key and why it had to move for this change.
  check('INSPECT_FORMAT_VERSION is an exported integer', Number.isInteger(INSPECT_FORMAT_VERSION), String(INSPECT_FORMAT_VERSION))
  check('and it is at least 2, because the rendered shape changed', INSPECT_FORMAT_VERSION >= 2, String(INSPECT_FORMAT_VERSION))
  check('README_LEAD_CHARS is a bounded budget', Number.isInteger(README_LEAD_CHARS) && README_LEAD_CHARS > 0 && README_LEAD_CHARS <= 800, String(README_LEAD_CHARS))
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
