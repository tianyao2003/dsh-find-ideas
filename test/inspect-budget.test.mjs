// Regressions for the card's byte cap, the response-size half of the byte-budget work.
//
// WHY THIS FILE EXISTS
// --------------------
// Before that work the plugin bounded how many GitHub requests it spends but not
// how many bytes it returns, and the model pays for every returned byte on every
// later turn. The cap puts a ceiling on the card. A ceiling applied carelessly
// would be worse than none at all, so the properties pinned here are:
//
//   * the cap is a CONSTANT, not a caller-supplied parameter. v0.4.0 removed
//     `budget_bytes` because the frozen A/B baseline showed the advice attached
//     to it ("call again with a larger budget") was a net loss: 3 of 12 extra
//     calls were trim recovery, 9 asked for a different repository set, and
//     raising the default to the old ceiling cost ~11,343 billed tokens per run
//     to save at most 898. A stale caller that still passes the argument must be
//     ignored, not honoured and not broken.
//   * a card that fits is returned BYTE FOR BYTE as it would be with no cap at
//     all. A cap the caller never hits must cost nothing.
//   * the trimming ladder is ordered by what is cheapest to lose, and the
//     signature skeleton (the evidence the tool exists to produce) goes last;
//   * nothing is withheld silently: the card states the count, names paths it can
//     name, and gives the recovery paths that do not require guessing a number —
//     point-read the file, or send fewer repositories;
//   * an excerpt block is ONE block even when its source window contains blank
//     lines. `split('\n\n')` shattered blocks and swallowed the next block's
//     `--- path ---` header, which made the withholding note under-report how much
//     evidence was removed — an under-report is a silent loss of evidence.
//
// Run: node test/inspect-budget.test.mjs   (NOT `node --test`)

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { apply } = await load('index.js')
const { renderInspections, CARD_RULE, INSPECT_BYTES_DEFAULT } = await load('render.js')
const renderModule = await load('render.js')

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

const bytes = (text) => Buffer.byteLength(text, 'utf8')
const UNTRIMMED = Number.POSITIVE_INFINITY

/** Tool definitions as `apply` registers them. */
const toolDefs = () => {
  const defs = new Map()
  apply({ tools: { register: (def) => defs.set(def.name, def) }, get: () => undefined })
  return defs
}

/** One inspection row, with the fields under test overridable. */
const row = (extra = {}) => ({
  full_name: 'owner/repo',
  url: 'https://github.com/owner/repo',
  ok: true,
  files_read: ['src/main.ts'],
  readme_excerpt: '',
  manifest_excerpt: '',
  tree_summary: '顶层目录（1）：src',
  skeleton_summary: '',
  error: '',
  ...extra,
})

/**
 * A `tree_summary` in the exact shape `inspectOne` builds.
 *
 * `blocks` are joined with a blank line, which is how the producer emits them, and
 * each block's body may contain blank lines of its own — that is the case that
 * broke block splitting.
 */
const treeWith = (blocks) =>
  ['顶层目录（2）：src, tests', '文件总数：42', '其中源文件：12　测试文件：3', '依赖清单：共 1 个，根目录：package.json', '读取的文件：src/main.ts', '文件摘录：\n'].join('\n') +
  blocks.map((block) => `--- ${block.path} ---\n${block.body}`).join('\n\n')

/** A block body big enough to matter, with a blank line inside it. */
const bodyOf = (marker, lines) =>
  Array.from({ length: lines }, (_, i) => `export function ${marker}${i}(): number { return ${i} }`).join('\n') +
  '\n\n' +
  Array.from({ length: lines }, (_, i) => `export const ${marker}Value${i} = ${i}`).join('\n')

/** The per-repository note line for `full_name`, or ''. */
const noteLine = (card, fullName) =>
  card.split('\n').find((line) => line.startsWith(`   · ${fullName}：`)) ?? ''

/** The repository's own slice of the card, between two rules. */
const repoSection = (card, fullName) =>
  card.split(CARD_RULE).find((part) => part.includes(`📦 ${fullName}`)) ?? ''

// The trim notice no longer names a parameter, so this is anchored on the phrase
// that is still the card's own claim: the budget is a byte budget for the card.
const cutNote = (card) => card.includes('本次返回已按卡片字节预算裁剪')

try {
  const defs = toolDefs()
  const inspect = defs.get('inspect_projects')

  // =========================================================================
  console.log('\n=== B1. The cap is a constant, and the caller cannot set it ===')
  {
    check('the fixed cap is 24000 bytes', INSPECT_BYTES_DEFAULT === 24000, `${INSPECT_BYTES_DEFAULT}`)
    // The floor and ceiling only existed to bound a parameter. With the parameter
    // gone they would be dead constants advertising a range nothing enforces.
    check('no floor constant survives', renderModule.INSPECT_BYTES_FLOOR === undefined,
      String(renderModule.INSPECT_BYTES_FLOOR))
    check('no ceiling constant survives', renderModule.INSPECT_BYTES_CEILING === undefined,
      String(renderModule.INSPECT_BYTES_CEILING))

    // The parameter itself must be gone: a schema that still advertises it is the
    // same failure in a different place, because the model reads the schema.
    const properties = inspect.parameters.properties
    check('the tool no longer exposes budget_bytes',
      properties.budget_bytes === undefined, JSON.stringify(Object.keys(properties)))
    check('the four remaining parameters are the ones the tool actually reads',
      JSON.stringify(Object.keys(properties).sort()) === JSON.stringify(['depth', 'files', 'idea', 'repos']),
      JSON.stringify(Object.keys(properties).sort()))
    check('budget_bytes is not part of the output schema either (it is a request, not evidence)',
      inspect.output.schema.properties.budget_bytes === undefined,
      JSON.stringify(Object.keys(inspect.output.schema.properties)))
  }

  // =========================================================================
  console.log('\n=== B2. A card that fits is unchanged, to the byte ===')
  {
    const rows = [row({
      readme_excerpt: '# Owner/repo\n\nA small tool.',
      manifest_excerpt: '{"name":"repo","version":"1.0.0"}',
      skeleton_summary: '文件头局部声明证据：\n   · src/main.ts: function main@1',
      tree_summary: treeWith([{ path: 'src/main.ts', body: 'export function main(): void {}' }]),
    })]
    // The idea string is part of the card, so both sides of every comparison
    // below must be rendered from the SAME idea — a different length would show
    // up as a byte difference that has nothing to do with the budget.
    const idea = 'a local-first note app'
    const noArgument = renderInspections(idea, rows, null, false)
    const explicitDefault = renderInspections(idea, rows, null, false, INSPECT_BYTES_DEFAULT)
    const huge = renderInspections(idea, rows, null, false, 64000)

    check('an explicit budget equal to the cap is byte-identical to passing none',
      noArgument === explicitDefault, `${bytes(noArgument)} vs ${bytes(explicitDefault)}`)
    check('a budget far above the card size is byte-identical too',
      noArgument === huge, `${bytes(noArgument)} vs ${bytes(huge)}`)
    check('a fitting card carries no withholding note', !cutNote(noArgument), noArgument.slice(-200))
    check('a fitting card is under the cap',
      bytes(noArgument) <= INSPECT_BYTES_DEFAULT, `${bytes(noArgument)} bytes`)

    // The same guarantee through the tool's own projection.
    const value = { idea, cached: false, depth: 'shallow', requests_used: 1, inspections: rows, degraded: null }
    const viaRender = inspect.output.render({}, value)[0].text
    check('the tool projection renders the same card the renderer does',
      viaRender === noArgument, `${bytes(viaRender)} / ${bytes(noArgument)}`)
  }

  // =========================================================================
  console.log('\n=== B3. The ladder drops the cheapest evidence first ===')
  {
    // Sizes are deliberately lopsided so the deficit each rung has to cover is
    // unambiguous: manifest is small but not tiny, readme is big, excerpts are
    // medium, the skeleton is big.
    //
    // The manifest must be LARGER than the withholding note itself (a few hundred
    // bytes of prose plus one line per repository, ~2 KB). If it were smaller, no
    // budget could ever stop at "manifest dropped": freeing it would not pay for
    // the note, so the ladder would jump straight to two rungs and the intermediate
    // state would not exist. That is a property of the note's cost, not a defect,
    // but a fixture that cannot reach the state cannot test it.
    const big = (marker, lines) => Array.from({ length: lines }, (_, i) => `${marker} ${i} ${'x'.repeat(40)}`).join('\n')
    const oneRow = row({
      manifest_excerpt: big('manifest', 60),
      readme_excerpt: big('readme', 90),
      tree_summary: treeWith([
        { path: 'src/a.ts', body: bodyOf('alpha', 20) },
        { path: 'src/b.ts', body: bodyOf('beta', 20) },
      ]),
      skeleton_summary: `文件头局部声明证据：\n${big('skeleton', 45)}`,
    })
    const full = renderInspections('x', [oneRow], null, false, UNTRIMMED)
    const fullBytes = bytes(full)

    // THE LADDER'S REAL CONTRACT. Sweep every budget from 1 to just past the full
    // card and require that (a) raising the budget never takes evidence away, and
    // (b) no rung is dropped while a cheaper one survives. Those two properties
    // are what "ordered by what is cheapest to lose" means. The exact budget at
    // which each rung falls is an implementation detail — it depends on the note's
    // size — so the assertions below read the transition points off the sweep
    // instead of guessing them.
    const RUNGS = ['依赖清单摘录', 'README 摘录', '个文件的摘录', '文件头声明（骨架）']
    const droppedAt = (card) => {
      const line = noteLine(card, 'owner/repo')
      return RUNGS.map((name) => line.includes(name))
    }
    const sweep = []
    for (let budget = 1; budget <= fullBytes + 64; budget += 1) {
      const card = renderInspections('x', [oneRow], null, false, budget)
      sweep.push({ budget, card, dropped: droppedAt(card) })
    }
    const rungCount = (step) => step.dropped.filter(Boolean).length
    const monotoneBreaks = []
    const orderBreaks = []
    for (let i = 1; i < sweep.length; i += 1) {
      const prev = sweep[i - 1]
      const cur = sweep[i]
      for (let rung = 0; rung < RUNGS.length; rung += 1) {
        // Raising the budget must never take evidence away. A rung COMING BACK as
        // the budget grows is the correct direction; a rung disappearing is not.
        if (!prev.dropped[rung] && cur.dropped[rung]) {
          monotoneBreaks.push(`budget ${cur.budget}: ${RUNGS[rung]} dropped although ${prev.budget} kept it`)
        }
      }
      for (let rung = 1; rung < RUNGS.length; rung += 1) {
        // Dropping rung N while rung N-1 (cheaper to lose) survives inverts the order.
        if (cur.dropped[rung] && !cur.dropped[rung - 1]) {
          orderBreaks.push(`budget ${cur.budget}: ${RUNGS[rung]} dropped before ${RUNGS[rung - 1]}`)
        }
      }
    }
    check(`the ladder is monotone across every budget 1..${fullBytes + 64}`,
      monotoneBreaks.length === 0, monotoneBreaks.slice(0, 3).join('; '))
    check('no rung is ever dropped while a cheaper one survives',
      orderBreaks.length === 0, orderBreaks.slice(0, 3).join('; '))
    check('the sweep exercises all five states (0–4 rungs dropped)',
      new Set(sweep.map(rungCount)).size === 5,
      JSON.stringify([...new Set(sweep.map(rungCount))].sort()))

    // Now pin what each state actually looks like, using the sweep's own budget
    // for that state (the first budget at which the state is reached).
    const stateAt = (n) => sweep.find((step) => rungCount(step) === n)

    const oneRung = stateAt(1)
    check('a small deficit drops the manifest excerpt alone',
      oneRung !== undefined && oneRung.dropped[0] && !oneRung.dropped[1] && !oneRung.dropped[2] && !oneRung.dropped[3],
      oneRung && noteLine(oneRung.card, 'owner/repo'))
    check('that card keeps the README excerpt',
      oneRung !== undefined && repoSection(oneRung.card, 'owner/repo').includes('readme 0 '),
      oneRung && noteLine(oneRung.card, 'owner/repo'))
    check('that card keeps the skeleton',
      oneRung !== undefined && repoSection(oneRung.card, 'owner/repo').includes('skeleton 0 '),
      oneRung && noteLine(oneRung.card, 'owner/repo'))
    check('that card is within its budget',
      oneRung !== undefined && bytes(oneRung.card) <= oneRung.budget,
      oneRung && `${bytes(oneRung.card)} vs ${oneRung.budget}`)

    const twoRungs = stateAt(2)
    check('a bigger deficit also drops the README excerpt',
      twoRungs !== undefined && twoRungs.dropped[1], twoRungs && noteLine(twoRungs.card, 'owner/repo'))
    check('the manifest excerpt is still reported when the README goes too',
      twoRungs !== undefined && twoRungs.dropped[0], twoRungs && noteLine(twoRungs.card, 'owner/repo'))
    check('the per-file excerpts survive two dropped rungs',
      twoRungs !== undefined && !twoRungs.dropped[2] && repoSection(twoRungs.card, 'owner/repo').includes('alpha0'),
      twoRungs && noteLine(twoRungs.card, 'owner/repo'))

    const threeRungs = stateAt(3)
    check('a larger deficit reaches the per-file excerpts',
      threeRungs !== undefined && threeRungs.dropped[2], threeRungs && noteLine(threeRungs.card, 'owner/repo'))
    check('the skeleton is still present when the excerpts are gone',
      threeRungs !== undefined && !threeRungs.dropped[3] && repoSection(threeRungs.card, 'owner/repo').includes('skeleton 0 '),
      threeRungs && noteLine(threeRungs.card, 'owner/repo'))
    check('the collapsed excerpt section says the tool omitted it, not that it was empty',
      threeRungs !== undefined &&
        repoSection(threeRungs.card, 'owner/repo').includes('本工具省略') &&
        !repoSection(threeRungs.card, 'owner/repo').includes('文件摘录：\n（无）'),
      threeRungs && repoSection(threeRungs.card, 'owner/repo').slice(0, 400))

    // Everything droppable dropped: the skeleton goes last, and the card says so.
    const everything = stateAt(4)
    check('with almost no budget the skeleton is dropped too',
      everything !== undefined && everything.dropped[3], everything && noteLine(everything.card, 'owner/repo'))
    const noBudget = renderInspections('x', [oneRow], null, false, 1)
    check('a card that cannot fit even trimmed says so instead of silently exceeding',
      noBudget.includes('即使裁到只剩结构信息，本次返回仍超过卡片字节预算=1'),
      noBudget.slice(-200))
  }

  // =========================================================================
  console.log('\n=== B4. Nothing is withheld silently, and both recovery paths are named ===')
  {
    const blocks = [
      { path: 'src/alpha.ts', body: bodyOf('alpha', 30) },
      { path: 'src/beta.ts', body: bodyOf('beta', 30) },
      { path: 'src/gamma.ts', body: bodyOf('gamma', 30) },
      { path: 'src/delta.ts', body: bodyOf('delta', 30) },
    ]
    const oneRow = row({
      manifest_excerpt: 'manifest',
      readme_excerpt: 'readme',
      tree_summary: treeWith(blocks),
      skeleton_summary: 'skeleton',
    })
    const full = renderInspections('x', [oneRow], null, false, UNTRIMMED)
    const trimmed = renderInspections('x', [oneRow], null, false, Math.floor(bytes(full) * 0.35))
    const line = noteLine(trimmed, 'owner/repo')

    check('the note states how many excerpts were withheld',
      line.includes(`${blocks.length} 个文件的摘录`), line)
    check('the note names the first three paths', blocks.slice(0, 3).every((b) => line.includes(JSON.stringify(b.path))), line)
    check('the note does not pretend to list all four (read_repo_files takes at most four, and this is a suggestion)',
      !line.includes(JSON.stringify(blocks[3].path)), line)
    check('the note gives a read_repo_files call with the repo and paths',
      /read_repo_files\(repo="owner\/repo", paths=\[/.test(line), line)

    // v0.4.0: the "re-call with a bigger budget" advice is GONE, because there is
    // no bigger budget to name. What remains are the two paths that do not need a
    // number: point-read the file, or send fewer repositories.
    check('the note names the point-read recovery',
      trimmed.includes('read_repo_files 点读'), trimmed.slice(-400))
    check('the note names the fewer-repositories recovery',
      trimmed.includes('减少 repos 数量后分批调用'), trimmed.slice(-400))
    check('the note no longer tells the caller to raise a budget that does not exist',
      !trimmed.includes('budget_bytes') && !trimmed.includes('调大'),
      trimmed.slice(-400))
    check('the note warns against inferring what was not returned',
      trimmed.includes('不要根据仓库名或「读取文件」列表推断'), trimmed.slice(-300))

    // A card that is still over its budget after every rung has fallen must say so
    // rather than silently exceed it. This branch is what the golden harness's
    // `--mode=info` fifth check reads, so the wording is load-bearing.
    //
    // It is REACHABLE ONLY AT A SYNTHETIC WIDTH: the untrimmable part of a card —
    // the framing, the untrusted-content declaration, the repository headers and
    // the tree summary prefix — is a few KB, and the fixed cap is 24,000. Measured
    // worst case for the largest batch the tool accepts (5 repositories, every
    // droppable field enormous): 8,687 bytes with everything dropped. So the
    // branch cannot fire through the tool, and asserting it on the fixed cap would
    // be asserting a card production cannot produce. It is pinned at budget 1
    // instead, which is where B3 also reads it.
    const huge = row({
      manifest_excerpt: 'manifest '.repeat(400),
      readme_excerpt: 'readme '.repeat(3000),
      tree_summary: treeWith([
        { path: 'src/a.ts', body: bodyOf('alpha', 150) },
        { path: 'src/b.ts', body: bodyOf('beta', 150) },
      ]),
      skeleton_summary: 'skeleton '.repeat(2500),
    })
    const hugeFull = renderInspections('x', [huge], null, false, UNTRIMMED)
    check('the oversized fixture really does exceed the cap untrimmed',
      bytes(hugeFull) > INSPECT_BYTES_DEFAULT, `${bytes(hugeFull)} vs ${INSPECT_BYTES_DEFAULT}`)

    const overCap = renderInspections('x', [huge], null, false, 1)
    check('a card that still exceeds its budget after every drop says so out loud',
      /仍超过卡片字节预算=1/.test(overCap), overCap.slice(-300))

    // The other half of the same property: at the FIXED cap the worst batch the
    // tool accepts still fits once trimmed, so the branch above never fires in
    // production and no caller can receive an over-cap card.
    const worst = Array.from({ length: 5 }, (_, i) => row({
      full_name: `owner-with-a-long-name/repository-with-a-long-name-${i}`,
      url: `https://github.com/owner-with-a-long-name/repository-with-a-long-name-${i}`,
      files_read: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      manifest_excerpt: 'manifest '.repeat(400),
      readme_excerpt: 'readme '.repeat(3000),
      tree_summary: treeWith([{ path: 'src/a.ts', body: bodyOf('alpha', 150) }]),
      skeleton_summary: 'skeleton '.repeat(2500),
    }))
    const worstAtCap = renderInspections('x', worst, null, false, INSPECT_BYTES_DEFAULT)
    check('the largest batch the tool accepts fits the fixed cap once trimmed',
      bytes(worstAtCap) <= INSPECT_BYTES_DEFAULT && !/仍超过/.test(worstAtCap),
      `${bytes(worstAtCap)} bytes at cap ${INSPECT_BYTES_DEFAULT}`)
  }

  // =========================================================================
  console.log('\n=== B5. An excerpt block is one block even when its source has blank lines ===')
  {
    // THE REGRESSION. Splitting the joined section on '\n\n' treats a blank line
    // inside a 1200-character source window as a block boundary: it shatters one
    // excerpt into several fragments and — when a block's own last line is blank —
    // pushes the NEXT block's `--- path ---` header onto a fragment's second line,
    // where only a first-line reader can see it. That under-reported the withheld
    // count, i.e. it understated how much evidence the budget had removed.
    const blocks = [
      { path: 'src/one.ts', body: bodyOf('one', 25) },
      { path: 'src/two.ts', body: bodyOf('two', 25) },
      { path: 'src/three.ts', body: bodyOf('three', 25) },
    ]
    check('the fixture blocks really do contain blank lines',
      blocks.every((b) => b.body.includes('\n\n')), 'a block without a blank line would not test the defect')

    const oneRow = row({ tree_summary: treeWith(blocks), skeleton_summary: 'skeleton' })
    const full = renderInspections('x', [oneRow], null, false, UNTRIMMED)
    const trimmed = renderInspections('x', [oneRow], null, false, Math.floor(bytes(full) * 0.4))
    const line = noteLine(trimmed, 'owner/repo')

    check('three blocks are reported as three, not as more fragments',
      line.includes('3 个文件的摘录'), line)
    check('every block path is named (the first three are all of them here)',
      blocks.every((b) => line.includes(JSON.stringify(b.path))), line)
    check('no header was swallowed: all three paths appear in the note',
      blocks.map((b) => line.includes(b.path)).filter(Boolean).length === 3, line)

    // The control: when nothing is trimmed the blocks are rendered untouched.
    check('an untrimmed card still shows every excerpt header',
      blocks.every((b) => full.includes(`--- ${b.path} ---`)), full.slice(0, 300))
    check('an untrimmed card has no withholding note', !cutNote(full), full.slice(-200))
  }

  // =========================================================================
  console.log('\n=== B6. A stale budget_bytes argument is ignored, not honoured and not fatal ===')
  {
    // The parameter is gone from the schema, and the framework's property-map
    // compiler does not set `additionalProperties`, so an unknown key is dropped
    // before the handler runs. That is the behaviour a caller from the previous
    // release meets: their call still works, at the fixed cap, with no request
    // spent on explaining a parameter that no longer exists.
    const stale = [
      ['below the old floor', 7999],
      ['above the old ceiling', 64001],
      ['zero', 0],
      ['negative', -1],
      ['a string', '64000'],
      ['null', null],
      ['the old default', 24000],
    ]
    for (const [label, value] of stale) {
      const result = await inspect.execute(
        { idea: 'a local-first note app', repos: [], budget_bytes: value },
        {},
      )
      // `repos: []` is the first refusal, so reaching it proves the budget
      // argument neither raised nor crashed anything on the way in.
      check(`${label}: ignored, and the call proceeds to its normal validation`,
        result.degraded?.reason === 'no_repos', JSON.stringify(result.degraded))
      check(`${label}: nothing was read`, result.inspections.length === 0 && result.requests_used === 0,
        `${result.inspections.length} rows, ${result.requests_used} requests`)
    }

    // Non-finite values are refused even earlier — by the framework's JSON
    // round-trip check, before the schema is consulted. Pinned because it is the
    // only remaining path that throws rather than returns.
    for (const [label, value] of [['Infinity', Number.POSITIVE_INFINITY], ['NaN', Number.NaN]]) {
      let frameworkRefused = false
      try {
        await inspect.execute(
          { idea: 'a local-first note app', repos: ['owner/repo'], budget_bytes: value },
          {},
        )
      } catch (error) {
        frameworkRefused = error?.code === 'INVALID_ARGS'
      }
      check(`${label} is refused by the framework before the handler runs`,
        frameworkRefused, `expected an INVALID_ARGS throw for budget_bytes=${label}`)
    }
  }

  // =========================================================================
  console.log('\n=== B7. The projection cannot be talked into a different card ===')
  {
    // `render` used to read `budget_bytes` off its args. It no longer reads any
    // argument at all, so every args object must produce the same card — this is
    // the property that makes the cap a constant rather than a parameter with a
    // default.
    const big = row({
      manifest_excerpt: 'manifest '.repeat(50),
      readme_excerpt: 'readme '.repeat(300),
      tree_summary: treeWith([{ path: 'src/a.ts', body: bodyOf('alpha', 40) }]),
      skeleton_summary: 'skeleton '.repeat(200),
    })
    const value = { idea: 'x', cached: false, depth: 'shallow', requests_used: 1, inspections: [big], degraded: null }
    const atCap = inspect.output.render({}, value)[0].text
    const probes = [
      ['a huge number', 999999],
      ['a tiny number', 1],
      ['the old cap', INSPECT_BYTES_DEFAULT],
      ['a string', '64000'],
      ['null', null],
      ['NaN', Number.NaN],
      ['a missing object', undefined],
    ]
    for (const [label, budget] of probes) {
      const rendered = inspect.output.render({ budget_bytes: budget }, value)[0].text
      check(`${label} renders the same card`,
        rendered === atCap, `${bytes(rendered)} vs ${bytes(atCap)}`)
    }
    check('the rendered card is within the fixed cap',
      bytes(atCap) <= INSPECT_BYTES_DEFAULT, `${bytes(atCap)} bytes`)
  }
} finally {
  // Nothing global is mutated here (no fetch stub, no cache), but the suite runs
  // files in one process, so leave no state behind for the next file.
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
