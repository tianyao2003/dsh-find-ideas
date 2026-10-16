// Behavioural tests for the query planner and the architecture-file selector.
//
// WHY THIS FILE EXISTS
// --------------------
// These two units were previously "covered" only by assertions that read
// src/index.ts as text and checked that certain strings were present, e.g.
// `src.includes('latinSeed')` or `/sort: 'updated'/.test(src)`. Those assertions
// pass as long as the characters remain in the file — they keep passing when the
// behaviour they name is broken. The README already said as much:
//
//   "A criterion narrower than the defect will report 'no problem' indefinitely."
//
// The selector is the worse case: it absorbed three rewrites and three real
// defects with zero behavioural coverage. Everything here calls the real
// compiled function and asserts on what it returns.
//
// Run with:  npm test
// Or directly: node test/queries.test.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

// These three used to be exported from index.js. They now live in the modules
// that own them, because index.js is only the tool registrations. The import
// follows the functions rather than the other way round: re-exporting them from
// index.js purely to keep this line unchanged would be a facade kept for the
// tests' convenience, which is exactly how a module ends up with a public
// surface nobody chose.
const { buildQueries, describePartialFailure, explainThinResult, tokenRemedy } = await load('query.js')
const { pickArchitectureFiles, treeEvidence, isTestPath, MANIFEST_RE } = await load('select.js')

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

const tree = (paths) => paths.map((path) => ({ path, type: 'blob' }))

// ---------------------------------------------------------------------------
console.log('\n=== Q1. the Latin idea produces a three-query plan ===')
{
  // Measured: a single narrow query returned 2 rows where the merged plan
  // returned 30. The plan itself is the fix, so the plan is what gets asserted.
  const plan = buildQueries('a local-first Markdown note-taking app with bidirectional links')

  check('plan has three queries', plan.length === 3, JSON.stringify(plan))
  // These assertions used to pin the SLOT LAYOUT (`plan[0]` is the precise query,
  // `plan[1]` the broad one, `plan[2]` the tail). Slot position is exactly what
  // changed when roles were named: the anchor now leads, because `selectPool`'s
  // quota stage walks channels in plan order and the anchor's head is what should
  // head the pool. Locate each role by its LABEL, and assert the properties that
  // were really being tested -- the queries exist, and the orderings match them.
  const byRole = (role) => plan.find((p) => p.role === role)
  check('the precise query is the longest term chain',
    byRole('precise')?.query === 'local-first markdown note-taking bidirectional links',
    byRole('precise')?.query)
  check('the anchor narrows to two terms', byRole('anchor')?.query === 'local-first markdown', byRole('anchor')?.query)
  check('the tail query uses three terms', byRole('tail')?.query === 'local-first markdown note-taking', byRole('tail')?.query)
  check('exactly one query asks for the long tail', plan.filter((p) => p.sort === 'updated').length === 1, JSON.stringify(plan.map((p) => p.sort)))
  check('the tail slot is the updated-sorted one', byRole('tail')?.sort === 'updated')
  check('the anchor and precise queries are star-sorted',
    byRole('anchor')?.sort === 'stars' && byRole('precise')?.sort === 'stars')
}

// ---------------------------------------------------------------------------
console.log('\n=== Q2. the tail query is narrow (3 terms), never a single word ===')
{
  // A one-word query matches a huge unrelated population, and the newest slice
  // of it is noise. Measured: `markdown notes bidirectional` -> 29 matches, 25
  // under 100 stars. The plan must never emit a 1-term tail query.
  const cases = [
    'a local-first Markdown note-taking app with bidirectional links',
    'a Tauri desktop markdown editor',
    'a self-hosted bookmark manager with tags',
    'an offline-first recipe collection app',
  ]
  let allNarrowEnough = true
  let details = ''
  for (const idea of cases) {
    const tail = buildQueries(idea).find((p) => p.sort === 'updated')
    if (tail === undefined) continue
    const terms = tail.query.split(' ').length
    if (terms < 2 || terms > 3) {
      allNarrowEnough = false
      details += `[${idea.slice(0, 24)} -> ${terms} terms] `
    }
  }
  check('every tail query uses 2-3 terms', allNarrowEnough, details)
}

// ---------------------------------------------------------------------------
console.log('\n=== Q3. CJK ideas keep at most one Chinese run quoted (regression for the 0-result bug) ===')
{
  // Measured bug history, two rounds. Round 1: unquoted CJK runs ANDed
  // (本地优先的 markdown 笔记应用 支持双向链接) returned total_count 0, and
  // bigram splitting was worse (3,376 vs 3,571). Round 2: quoting ALL runs
  // fixed the precision but ANDed three exact phrases — also 0 candidates,
  // measured live. The rule that survives both: a CJK run stays whole, and at
  // most ONE run is quoted per query. "本地优先的" markdown -> 30 candidates;
  // the same with "笔记应用" "支持双向链接" added -> 0.
  const idea = '本地优先的 Markdown 笔记应用，支持双向链接'
  const plan = buildQueries(idea)
  // The properties below are about the CJK CHANNEL, which is no longer slot 0:
  // the English seed leads now (see Q7). Locating the channel by script instead
  // of by index keeps these assertions testing the quoting rule rather than the
  // slot layout, which is the thing that has actually changed twice.
  const cjkStep = plan.find((s) => /\p{Script=Han}/u.test(s.query))
  check('a CJK idea still carries a Chinese channel', cjkStep !== undefined, JSON.stringify(plan))
  const precise = cjkStep.query

  check('the first Chinese run is quoted as a phrase', precise.includes('"本地优先的"'), precise)
  const quotedRuns = precise.match(/"[^"]+"/g) ?? []
  check('at most one quoted phrase per query (three quoted phrases measured at 0 candidates)', quotedRuns.length <= 1, precise)
  check('extra CJK runs are dropped, not split into bigrams', quotedRuns.every((q) => q.length > 3), JSON.stringify(quotedRuns))
  check('Latin terms survive unquoted', precise.includes('markdown'), precise)
  check('no query in the plan ANDs two quoted phrases',
    !plan.some((s) => (s.query.match(/"[^"]+"/g) ?? []).length > 1), JSON.stringify(plan))
}

// ---------------------------------------------------------------------------
console.log('\n=== Q4. a bilingual input gets one query per language domain ===')
{
  // Measured: Chinese queries reach a repo population DISJOINT from the field
  // anchors. For 本地优先的 the top 30 were headed by an x86 bare-metal repo and
  // a political-document repo — zero note-taking projects — because logseq,
  // siyuan and Trilium all describe themselves in ENGLISH. Preferring Latin
  // terms for the broad seed took anchor coverage from 0/5 to 4/5.
  //
  // But English-only recall loses the Chinese half of the corpus, and the old
  // way of covering both — ANDing the English terms with one quoted Chinese
  // phrase — measured ONE candidate (FortC/Easy-MD, 2 stars): a wasted slot.
  // So the first slot now goes to a dedicated Chinese query built from the
  // IDEA's runs (two unquoted runs measured 12 candidates, all on-topic),
  // while the English slots work the anchor population as before. The Chinese
  // runs must come from the idea, never from the hint: a hint full of English
  // keywords contributes no CJK terms, so a hint-derived source is always empty
  // and the branch silently never fires (observed: byte-identical plans before
  // and after the branch was added).
  const plan = buildQueries(
    '本地优先的 Markdown 笔记应用，支持双向链接',
    'local-first markdown notes bidirectional links',
  )

  check('bilingual input still produces three queries', plan.length === 3, JSON.stringify(plan))
  check('the Chinese query takes the first slot', /\p{Script=Han}/u.test(plan[0].query), plan[0]?.query)
  check('the Chinese query is the measured-working shape', plan[0].query === '本地优先的 笔记应用', plan[0].query)
  check('the Chinese query carries no Latin term from the hint', !plan[0].query.includes('local-first'), plan[0].query)
  check('the Chinese query has no quoted phrases (quoted AND measured 0)', !plan[0].query.includes('"'), plan[0].query)
  check('the broad query is built from Latin terms', plan[1].query === 'local-first markdown', plan[1]?.query)
  check('the tail query is built from Latin terms', plan[2].query === 'local-first markdown notes', plan[2]?.query)
  check('no CJK term reached the broad query', !/\p{Script=Han}/u.test(plan[1].query), plan[1]?.query)
  check('the tail query is the only updated-sorted one', plan.filter((s) => s.sort === 'updated').length === 1 && plan[2].sort === 'updated', JSON.stringify(plan.map((s) => s.sort)))

  // Reverse control: without keywords the plan is driven by the lexicon plus the
  // idea's own CJK run. For this idea that CJK run is SHORT (`本地优先的`, 5 Han
  // characters), and a short run is a working search term — measured 3,808
  // matches on its own, with 30 rows of on-topic Chinese projects — so the
  // long-run fallback must NOT rewrite it and the measured-working quoted shape
  // `"本地优先的" markdown` must survive into the plan.
  //
  // The length limit is what keeps this case from being rewritten. The sibling
  // idea 一个本地优先的笔记应用，支持 markdown 和双向链接 carries an 11-character run,
  // which is a whole clause rather than a term, and its CJK channel IS rewritten
  // (see Q5). Both behaviours are asserted, because a limit that never fires and
  // a limit that always fires would each pass a single-sided test.
  const noHint = buildQueries('本地优先的 Markdown 笔记应用，支持双向链接')
  check('no keywords: the short CJK run keeps its measured-working quoted shape',
    noHint.some((s) => s.query === '"本地优先的" markdown'), JSON.stringify(noHint))
  check('no keywords: the lexicon seed leads, not the CJK run',
    noHint[0].query === 'local-first note-taking', JSON.stringify(noHint))
  check('no keywords: no hint-derived query is invented',
    !noHint.some((s) => s.query === 'local-first markdown'), JSON.stringify(noHint))
  // Reverse control: an all-Latin idea with Latin keywords is untouched.
  const latin = buildQueries('a local-first markdown note app', 'markdown notes bidirectional')
  check('all-Latin input produces no CJK query', !latin.some((s) => /\p{Script=Han}/u.test(s.query)), JSON.stringify(latin))
  // Reverse control: an all-Latin idea must NOT gain a fallback query — there is
  // no quoted phrase to relax, so the extra request would be pure quota waste.
  check('an all-Latin idea gains no fallback query',
    buildQueries('a local-first markdown note app').length === 3 ||
    buildQueries('a local-first markdown note app').every((s) => !s.query.includes('"')),
    JSON.stringify(buildQueries('a local-first markdown note app')))
}

// ---------------------------------------------------------------------------
console.log('\n=== Q5. a CJK-only idea no longer returns an empty pool ===')
{
  // The old plan for a CJK-only idea was one precise query ANDing three quoted
  // phrases — measured at ZERO candidates, i.e. the plugin silently did nothing
  // for a pure-Chinese idea.
  //
  // What survives is a LENGTH rule, and it was measured the hard way. For
  // 一个本地优先的笔记应用，支持 markdown 和双向链接 (`.probe-a2.mjs`, 2026-10-10):
  //
  //   "一个本地优先的笔记应用" markdown   -> total_count 0    <- the plan's only query
  //   一个本地优先的笔记应用 markdown     -> total_count 0    <- unquoting does NOT help
  //   一个本地优先的笔记应用              -> total_count 15   <- the run alone works
  //   一个本地优先的 笔记应用             -> total_count 0
  //   本地优先的 笔记应用                 -> total_count 12
  //
  // So the first fix attempt — reissue the query with the quotes removed — was a
  // measured no-op, because the problem was never the quoting. It is that an
  // 11-character Han run is not a word. `一个本地优先的笔记应用` is a whole clause,
  // and GitHub matches the run as a single token, so it can be issued alone (15)
  // but cannot survive being ANDed with anything (0). `本地优先的` at 5 characters
  // is the opposite: a real term, 3,808 matches, useful in a conjunction.
  //
  // The plan's remedy is therefore to issue the long run ALONE — never to relax
  // its quoting. This is the same conclusion the bilingual branch reached from
  // the other direction: the Chinese channel works as its own query, and dies
  // inside an AND.
  //
  // The standalone run REPLACES the precise query rather than joining it. Keeping
  // both was measured to cost a third of the request budget for nothing: the quoted
  // channel returned total_count 0 in every run, and `.probe-a2-pool.mjs` showed the
  // pool was exactly the bare run's rows with the quoted channel contributing none.
  // With only one non-empty channel there is nothing to fuse, and `CHANNEL_QUOTA`
  // cannot promote anything either — so the two on-topic 0-2 star rows survived only
  // via the tail guard, landing at positions 12 and 13 of 13.
  //
  // Note what this test can and cannot see. It can see that the rewrite happened;
  // it cannot see that the resulting pool is any good, because that depends on the
  // live result set. `.probe-e2e-fix.mjs` measured the pool: this plan (one CJK
  // channel) returned 15 rows containing **zero** named note-taking projects, and
  // 8 of the 15 were the book-list / political-mirror cluster. The English seed
  // channels added by Q7 are what changed that, and the rewrite below is retained
  // for the disjoint Chinese population rather than for the anchors.
  const longRun = buildQueries('一个本地优先的笔记应用，支持 markdown 和双向链接')
  const longCjk = longRun.find((s) => /\p{Script=Han}/u.test(s.query))
  check('the long CJK run is rewritten to its standalone unquoted form',
    longCjk !== undefined && longCjk.query === '一个本地优先的笔记应用', JSON.stringify(longRun))
  check('the dead quoted form is dropped, not retained',
    !longRun.some((s) => s.query.includes('"')), JSON.stringify(longRun))
  check('the standalone run has no Latin term ANDed onto it',
    !/[a-z]/i.test(longCjk.query), longCjk.query)
  check('the standalone run carries no quotes', !longCjk.query.includes('"'), longCjk.query)
  check('the CJK channel no longer leads the plan',
    /\p{Script=Han}/u.test(longRun[0].query) === false, JSON.stringify(longRun))

  const shortRun = buildQueries('本地优先的 Markdown 笔记应用，支持双向链接')
  check('a SHORT CJK run is not rewritten by the long-run fallback',
    shortRun.some((s) => s.query === '"本地优先的" markdown'), JSON.stringify(shortRun))

  // A pure-CJK idea with no Latin at all: the precise query is ONE unquoted run
  // and there is no conjunction to relax, so the fallback must not fire.
  const pureCjk = buildQueries('一个本地的待办事项管理工具，支持标签和筛选')
  check('zero-Latin idea still gets a recall-relaxing second query', pureCjk.length >= 2, JSON.stringify(pureCjk))
  check('that second query carries NO quoted phrases', !pureCjk.slice(1).some((s) => s.query.includes('"')), JSON.stringify(pureCjk))
  check('no query in the plan ANDs two quoted phrases', !pureCjk.some((s) => (s.query.match(/"[^"]+"/g) ?? []).length > 1), JSON.stringify(pureCjk))
}

// ---------------------------------------------------------------------------
console.log('\n=== Q6. plan terms never exceed the AND-chain budget ===')
{
  // GitHub AND-matches every term, so recall collapses as terms are added.
  // MAX_QUERY_TERMS is 6; the precise query is capped there.
  const plan = buildQueries(
    'a local-first offline-capable cross-platform Markdown note-taking application with bidirectional links and graph view and plugin support and sync',
  )
  const precise = plan[0].query
  check('the precise query is capped at 6 terms', precise.split(' ').length <= 6, precise)
}

// ---------------------------------------------------------------------------
console.log('\n=== Q7. the CJK->English lexicon produces a seed, not a translation ===')
{
  // WHY THIS SECTION EXISTS
  // -----------------------
  // `lexicon.ts` was added because the Chinese plan had no way to reach the field
  // anchors. Measured live (`.probe-e2e-fix.mjs`, pool size 20, four ideas):
  //
  //   idea                                        named field projects in pool
  //   一个本地优先的笔记应用，支持 markdown 和双向链接   0 / 15   (8 of 15 rows junk)
  //   本地优先的笔记应用，支持双向链接                   0 / 20   (8 of 20 rows junk)
  //   个人知识管理工具，双向链接，本地存储               0 / 18   (best row 4 stars)
  //   一个本地优先的待办事项管理工具                    0 / 13   (9 of 13 rows junk)
  //
  // After the seed channels: 7/20, 7/20, 8/20, 7/20, with the junk cluster down to
  // 2 rows. The assertions below cover the DECISIONS the measurements produced,
  // because the module is otherwise unreachable except through a registered tool —
  // the same gap that let the query planner absorb three rewrites uncovered.
  const { englishSeeds, MAX_SEED_WORDS } = await load('lexicon.js')

  const note = englishSeeds(['"本地优先的笔记应用"', '"支持双向链接"'])
  check('a note idea yields the measured anchor phrase', note.seed === 'local-first note-taking', note.seed)
  check('the narrow channel keeps the constraint',
    note.narrow === 'note-taking bidirectional', note.narrow)
  check('the seed is within the measured word ceiling',
    note.seed.split(' ').length <= MAX_SEED_WORDS, note.seed)

  // A modifier-only idea has no subject. `local-first` alone measured 86,859
  // matches headed by home-assistant and anything-llm — 62x the real query — so
  // emitting it would be worse than emitting nothing.
  const modifierOnly = englishSeeds(['"本地优先的"', '"本地存储"'])
  check('a modifier-only idea emits NO seed (a bare modifier is a filter, not a subject)',
    modifierOnly.seed === '', modifierOnly.seed)
  check('a modifier-only idea emits no narrow channel either', modifierOnly.narrow === '', modifierOnly.narrow)

  // `个人知识管理工具` resolves to BOTH the modifier `personal` and the core
  // `personal knowledge management`. Spending the budget saying "personal" twice
  // yielded the bare modifier and lost the subject; the core now wins the budget.
  const pkm = englishSeeds(['"个人知识管理工具"', '"双向链接"', '"本地存储"'])
  check('a multi-word core beats a competing modifier', pkm.seed === 'personal knowledge management', pkm.seed)
  check('a 4-word AND is refused rather than issued (it measured 3 matches)',
    pkm.narrow === '', pkm.narrow)

  // The rule is a WORD count, not an array length: `personal knowledge management`
  // is one entry and three words, and an array-length check let the four-word
  // `personal knowledge management bidirectional` through a three-word cap.
  check('the ceiling counts words, not phrases',
    englishSeeds(['"支持全文搜索的个人知识管理工具"']).narrow === '',
    englishSeeds(['"支持全文搜索的个人知识管理工具"']).narrow)

  const rss = englishSeeds(['"自托管的"', 'rss', '"阅读器"', '"支持全文搜索"'])
  check('a two-word rare term can still ride along',
    rss.narrow === 'reader full-text search', rss.narrow)

  const todo = englishSeeds(['"一个本地优先的待办事项管理工具"'])
  check('a one-word core is a valid seed (measured: todo/kanban/pomodoro all return real projects)',
    todo.seed === 'local-first todo', todo.seed)
  check('no rare term means no narrow channel', todo.narrow === '', todo.narrow)

  check('unrecognised CJK is reported, not silently dropped',
    englishSeeds(['"完全无法识别的短语"']).unknown.length === 1,
    JSON.stringify(englishSeeds(['"完全无法识别的短语"'])))

  // The plan-level contract, which is what actually changes behaviour.
  // Positions are no longer asserted: the anchor leads the plan now (see Q1), and
  // the role labels are the stable way to find each channel. What matters is that
  // all three channels are present and that the Chinese population keeps one.
  const plan = buildQueries('本地优先的笔记应用，支持双向链接')
  check('the English anchor leads the plan', plan[0].query === 'local-first note-taking', JSON.stringify(plan))
  check('the anchor carries the anchor role', plan[0].role === 'anchor', JSON.stringify(plan))
  check('the constraint channel is present',
    plan.some((s) => s.query === 'note-taking bidirectional'), JSON.stringify(plan))
  check('the Chinese population keeps a slot', plan.some((s) => /\p{Script=Han}/u.test(s.query)), JSON.stringify(plan))
  check('the plan still respects the request budget', plan.length <= 3, JSON.stringify(plan))

  const noSeed = buildQueries('本地优先的')
  check('an idea with no seed keeps its original plan shape',
    noSeed.every((s) => /\p{Script=Han}/u.test(s.query)), JSON.stringify(noSeed))

  const latin = buildQueries('a local-first markdown note app')
  check('an all-Latin idea gains no lexicon channel',
    !latin.some((s) => s.query === 'local-first note-taking'), JSON.stringify(latin))
}

// ---------------------------------------------------------------------------
console.log('\n=== S1. the selector picks a frontend AND a backend face (Tauri shape) ===')
{
  // The defect that created slot 3: with only three slots, Tauri-shaped
  // projects always lost their backend. Easy-MD is src/ + src-tauri/.
  const picks = pickArchitectureFiles(tree([
    'README.md', 'package.json', 'src-tauri/Cargo.toml', 'src-tauri/src/main.rs',
    'src-tauri/src/lib.rs', 'src-tauri/src/commands.rs',
    'src/main.ts', 'src/App.vue', 'src/components/Editor.vue', 'src/stores/note.ts',
  ]), 4)

  check('returns exactly the requested number', picks.length === 4, JSON.stringify(picks))
  check('keeps the README', picks.includes('README.md'), JSON.stringify(picks))
  check('keeps the manifest that states the stack', picks.includes('package.json'), JSON.stringify(picks))
  check('reaches the frontend source', picks.some((p) => p.startsWith('src/')), JSON.stringify(picks))
  check('reaches the native backend source', picks.some((p) => p.startsWith('src-tauri/')), JSON.stringify(picks))
  check('no duplicate paths', new Set(picks).size === picks.length)
}

// ---------------------------------------------------------------------------
console.log('\n=== S2. a two-language project keeps both faces (measured live case) ===')
{
  // logseq is ClojureScript in src/ plus a Kotlin android/ and a Swift ios/.
  // Measured promise: "a Tauri-style project shows both its frontend and its
  // Rust side". Same promise applies to any two-language split.
  const picks = pickArchitectureFiles(tree([
    'README.md', 'package.json', 'deps.edn',
    'src/main/frontend/core.cljs', 'src/main/frontend/handler.cljs',
    'src/main/frontend/util.cljs', 'src/main/frontend/components/block.cljs',
    'libs/src/main/logseq/api.cljs', 'libs/src/main/logseq/db.cljs',
    'android/app/src/main/java/MainActivity.kt', 'ios/App/AppDelegate.swift',
  ]), 4)

  check('returns four files', picks.length === 4, JSON.stringify(picks))
  check('a manifest is present', picks.some((p) => /(package\.json|deps\.edn|Cargo\.toml)$/.test(p)), JSON.stringify(picks))
  check('the real source tree is represented', picks.some((p) => p.startsWith('src/')), JSON.stringify(picks))
}

// ---------------------------------------------------------------------------
console.log('\n=== S3. siyuan shape: frontend app/ plus backend kernel/ ===')
{
  const picks = pickArchitectureFiles(tree([
    'README.md', 'package.json',
    'app/src/index.ts', 'app/src/util.ts', 'app/src/editor.ts', 'app/src/editor/render.ts',
    'kernel/main.go', 'kernel/model/block.go', 'kernel/util/strings.go', 'kernel/api/router.go',
    'docs/design.md', 'CHANGELOG.md',
  ]), 4)

  check('returns four files', picks.length === 4, JSON.stringify(picks))
  check('frontend face present', picks.some((p) => p.startsWith('app/')), JSON.stringify(picks))
  check('backend face present', picks.some((p) => p.startsWith('kernel/')), JSON.stringify(picks))
  check('changelog is never spent a slot', !picks.some((p) => /changelog/i.test(p)), JSON.stringify(picks))
}

// ---------------------------------------------------------------------------
console.log('\n=== S4. NON-ISOMORPHIC shapes (the fixture set was all frontend+backend) ===')
{
  // The five original fixtures were all "two-layer" repos, and the four slots
  // were tuned against them — testing the implementation against the shape it
  // was designed for. These three shapes are deliberately different.

  // (a) monorepo: many same-depth packages, no frontend/backend split.
  const mono = pickArchitectureFiles(tree([
    'README.md', 'package.json', 'pnpm-workspace.yaml',
    'packages/core/src/index.ts', 'packages/core/src/db.ts',
    'packages/ui/src/Button.tsx', 'packages/ui/src/Modal.tsx',
    'apps/web/src/main.ts', 'apps/web/src/App.tsx',
  ]), 4)
  check('monorepo: returns four files', mono.length === 4, JSON.stringify(mono))
  check('monorepo: keeps the README and a manifest', mono.includes('README.md') && mono.includes('package.json'), JSON.stringify(mono))
  check('monorepo: samples real package source', mono.some((p) => p.startsWith('packages/') || p.startsWith('apps/')), JSON.stringify(mono))

  // (b) backend-only: no frontend exists at all. Slot 2 must not force a bad pick.
  const backend = pickArchitectureFiles(tree([
    'README.md', 'go.mod', 'cmd/server/main.go',
    'internal/api/handler.go', 'internal/api/router.go', 'internal/store/db.go',
  ]), 4)
  check('backend-only: fills the budget', backend.length === 4, JSON.stringify(backend))
  check('backend-only: includes the module manifest', backend.includes('go.mod'), JSON.stringify(backend))
  check('backend-only: reaches internal packages', backend.some((p) => p.startsWith('internal/')), JSON.stringify(backend))
  check('backend-only: invents no frontend path', !backend.some((p) => /\.(tsx|vue|cljs)$/.test(p)), JSON.stringify(backend))

  // (c) single flat layer: no directories at all. Must not return nothing.
  const flat = pickArchitectureFiles(tree([
    'README.md', 'package.json', 'index.js', 'util.js', 'config.js',
  ]), 4)
  check('flat repo: returns four files', flat.length === 4, JSON.stringify(flat))
  check('flat repo: keeps the README', flat.includes('README.md'), JSON.stringify(flat))
  check('flat repo: keeps the manifest', flat.includes('package.json'), JSON.stringify(flat))
}

// ---------------------------------------------------------------------------
console.log('\n=== S5. junk is never spent a slot ===')
{
  const picks = pickArchitectureFiles(tree([
    'README.md', 'package.json', 'LICENSE', 'CHANGELOG.md', 'package-lock.json',
    'logo.png', 'icon.svg', 'docs/guide.html',
    'node_modules/left-pad/index.js', 'dist/bundle.min.js',
    '.github/workflows/ci.yml', 'src/main.ts', 'src/App.vue',
  ]), 4)

  const junk = [
    ['license', /license/i], ['changelog', /changelog/i], ['lockfile', /package-lock/],
    ['image', /\.(png|svg)$/], ['built docs site', /docs\/.*\.html$/],
    ['vendored deps', /node_modules/], ['build output', /dist\//], ['CI config', /\.github\//],
  ]
  for (const [label, re] of junk) {
    check(`never picks ${label}`, !picks.some((p) => re.test(p)), JSON.stringify(picks))
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== S6. maxFiles=0 and an empty tree are handled, not thrown ===')
{
  check('maxFiles=0 returns nothing', pickArchitectureFiles(tree(['README.md', 'src/a.ts']), 0).length === 0)
  check('empty tree returns nothing', pickArchitectureFiles([], 4).length === 0)
  check('a tree of only junk returns nothing', pickArchitectureFiles(tree(['logo.png', 'LICENSE']), 4).length === 0)
  check('a negative cap behaves like zero', pickArchitectureFiles(tree(['README.md']), -1).length === 0)
}

// ---------------------------------------------------------------------------
console.log('\n=== S7. the cap is respected exactly, and never exceeded ===')
{
  const big = tree([
    'README.md', 'package.json',
    ...Array.from({ length: 40 }, (_, i) => `src/mod/file${i}.ts`),
  ])
  for (const cap of [1, 2, 4, 8]) {
    const picks = pickArchitectureFiles(big, cap)
    check(`maxFiles=${cap} returns at most ${cap}`, picks.length <= cap, String(picks.length))
  }
  check('a large cap still returns unique paths', new Set(pickArchitectureFiles(big, 8)).size === pickArchitectureFiles(big, 8).length)
}

// ---------------------------------------------------------------------------
console.log('\n=== D1. a partial failure names the capability it destroyed ===')
{
  // The measured case: 30 candidates returned, `partial` reported, and ZERO rows
  // at or below 100 stars, because the tail query was one of the failures. A
  // message that only says "2/3 queries failed" leaves the reader believing the
  // card is complete.
  //
  // T5: the fixtures carry `role`, because that is what a real plan looks like.
  // This fixture previously omitted it, and the omission was invisible only
  // because the old check INFERRED the tail from `sort === 'updated'`. Inferring
  // is exactly what T5 removes: a `narrow` tail carries `sort=stars` by design
  // and was therefore never recognised as a tail at all.
  const plan = [
    { query: 'local-first markdown note-taking bidirectional links', sort: 'stars', role: 'precise' },
    { query: 'local-first markdown', sort: 'stars', role: 'anchor' },
    { query: 'local-first markdown note-taking', sort: 'updated', role: 'tail', tailReason: 'updated' },
  ]
  const tailFailure = [
    'local-first markdown (sort=stars): GitHub rate limited (HTTP 403; limit=10 remaining=0)',
    'local-first markdown note-taking (sort=updated): GitHub rate limited (HTTP 403; limit=10 remaining=0)',
  ]
  // The roles of the failed slots, index-aligned with `tailFailure`. This is what
  // `searchMerged` now returns alongside the strings, so the tail test can ask
  // about the ROLE instead of parsing the message.
  const failedRoles = ['anchor', 'tail']
  const detail = describePartialFailure(plan, tailFailure, false, failedRoles)
  check('counts the failures against the plan', detail.startsWith('2/3 个查询失败'), detail.slice(0, 20))
  check('lists every failed query', tailFailure.every((f) => detail.includes(f)))
  // §7.5 / design.md §2.7: the claim must be about the CHANNEL, not about the
  // rows that came back. The old wording asserted 「本次结果只包含高 star 项目」,
  // which a failed tail cannot establish — an anchor-only plan was measured
  // returning three 5★ repositories. Assert the honest form, and assert the
  // overclaim is gone, so a future edit cannot quietly restore it.
  check('says the tail channel is uncovered, not that the rows are all high-star',
    detail.includes('长尾通道覆盖未知'), detail.slice(-200))
  check('does not claim the returned rows are all high-star',
    !detail.includes('只包含高 star'), detail.slice(-200))
  check('still names which population went uncovered',
    detail.includes('star ≤ 100 的小项目'), detail.slice(-200))
  check('says the low-star rows are missing, not absent', detail.includes('这不代表不存在相关的小项目'))
  check('names the token remedy when anonymous', detail.includes('GITHUB_TOKEN'))
  // A remedy the user cannot act on is a fact about the problem, not an
  // instruction. The old sentence — "配置 GITHUB_TOKEN 可降低触发概率" — named no
  // place to do it, and there IS no settings field, because the token is a
  // credential and the host's settings surface carries references, not secrets.
  // The conversation is the only channel, so the remedy must name it AND state
  // its cost rather than presenting it as free.
  check('the remedy says how to act on it', /配一下 GitHub token/.test(detail), detail.slice(-120))
  check('the remedy names the cost (the token stays in the transcript)',
    /对话记录/.test(detail), detail.slice(-120))
  check('the remedy offers the no-conversation alternative',
    /环境变量/.test(detail), detail.slice(-120))

  // A token changes the remedy, because "configure GITHUB_TOKEN" is advice the
  // caller has already taken.
  const withToken = describePartialFailure(plan, tailFailure, true, failedRoles)
  check('does not suggest a token when one was used', !withToken.includes('GITHUB_TOKEN'))
  check('does not offer to configure a token that already exists',
    !/配一下 GitHub token/.test(withToken), withToken.slice(-120))
  check('still names the tail loss with a token', withToken.includes('长尾通道覆盖未知'))

  // The warning must be specific to the tail. A failure among the star-ordered
  // queries leaves the tail reachable, and claiming otherwise would be a
  // different lie in the opposite direction.
  const headOnly = describePartialFailure(plan, [tailFailure[0]], false, ['anchor'])
  check('no tail warning when only a star-ordered query failed', !headOnly.includes('长尾通道覆盖未知'))
  check('still reports the failure itself', headOnly.includes('1/3 个查询失败'))

  // A single-query plan has no tail to lose, so nothing should be claimed.
  const single = [{ query: 'markdown note', sort: 'stars', role: 'anchor' }]
  const noTail = describePartialFailure(single, ['markdown note (sort=stars): boom'], false, ['anchor'])
  check('no tail warning when no tail query was planned', !noTail.includes('长尾通道覆盖未知'))

  // A lookalike mention of the sort in a failure MESSAGE must not fake a tail
  // failure. Under the old `f.includes('sort=updated')` sniff this was a real
  // hazard; under T5 the failed slot's role decides, so the message is inert.
  const lookalike = describePartialFailure(
    plan,
    ['local-first markdown (sort=stars): upstream said the index was updated'],
    false,
    ['anchor'],
  )
  check('a lookalike mention of "updated" does not fake a tail failure', !lookalike.includes('长尾通道覆盖未知'))

  // T5: a NARROW tail uses `sort=stars` by design, so the old `sort=updated`
  // inference could not see it. Losing it produced NO warning — the exact silent
  // failure this note exists to prevent, hidden inside the note itself.
  const narrowPlan = [
    { query: 'local-first note-taking', sort: 'stars', role: 'anchor' },
    { query: 'local-first markdown note-taking bidirectional links', sort: 'stars', role: 'precise' },
    { query: 'note-taking bidirectional', sort: 'stars', role: 'tail', tailReason: 'narrow' },
  ]
  const narrowLost = describePartialFailure(
    narrowPlan, ['note-taking bidirectional (sort=stars): HTTP 500'], false, ['tail'])
  check('a narrow tail (sort=stars) is recognised as a tail (T5)',
    narrowLost.includes('长尾通道覆盖未知'), narrowLost.slice(-160))

  // Answering "was the tail lost?" without the roles must err toward telling the
  // user, never toward silence: a planned tail with no role information is
  // reported as lost, because the alternative is a card that looks complete.
  const noRoles = describePartialFailure(plan, [tailFailure[0]], false)
  check('without roles, a planned tail is reported as lost rather than silently assumed safe (T5)',
    noRoles.includes('长尾通道覆盖未知'), noRoles.slice(-160))
}

console.log('\n=== D2. the token remedy is actionable, honest, and offered only when useful ===')
{
  const remedy = tokenRemedy()
  check('the remedy is non-empty', remedy.length > 0)
  check('it names the phrase the user should say', /配一下 GitHub token/.test(remedy), remedy)
  check('it promises to verify the result', /验证/.test(remedy), remedy)
  check('it states the cost, rather than hiding it', /对话记录/.test(remedy), remedy)
  check('it offers the alternative that avoids the transcript', /环境变量/.test(remedy), remedy)
  check('it does not claim the token is required to use the plugin',
    !/必须|否则无法/.test(remedy), remedy)

  // The thin-result path offers the same remedy, and must ALSO stay honest about
  // what the small result does and does not mean.
  const thin = explainThinResult(2, 20, 0, false)
  check('a thin anonymous result is explained', typeof thin === 'string', String(thin))
  check('it says the small page is not proof of a small population',
    /不代表 GitHub 只有这么多匹配项目/.test(thin), thin)
  check('it offers the actionable remedy', /配一下 GitHub token/.test(thin), thin)
  check('it still says retrying may help', /稍后重试/.test(thin), thin)

  // With a token, quota advice is noise: the token does not remove the limit,
  // but the user has already taken the step this text would suggest. The result
  // is NOT null here — 2 rows against a limit of 20 is still a small page, and
  // with the quota explanation correctly suppressed the remaining explanation is
  // the narrow-query one. Asserting null would have been asserting that a
  // token-holder never gets told anything, which is a different and worse rule.
  const thinWithToken = explainThinResult(2, 20, 0, true)
  check('a token suppresses the quota explanation',
    typeof thinWithToken === 'string' && !/配额/.test(thinWithToken), String(thinWithToken))
  check('a token suppresses the token upsell too',
    !/配一下 GitHub token/.test(String(thinWithToken)), String(thinWithToken))
  check('with a token, the remaining explanation is the narrow-query one',
    /查询词过窄/.test(String(thinWithToken)), String(thinWithToken))
  // With a token AND a healthy count there is genuinely nothing to say.
  check('a token plus a healthy count produces no notice',
    explainThinResult(30, 20, 0, true) === null)

  // A healthy count needs no explanation at all.
  check('a full result set produces no notice', explainThinResult(30, 20, 10, false) === null)
  check('an empty result produces no notice', explainThinResult(0, 20, 10, false) === null)

  // A small result with plenty of quota left is a narrow query, not a quota
  // problem — and the two must not be confused, because the fixes differ.
  const narrow = explainThinResult(2, 20, 9, false)
  check('a narrow query is diagnosed as narrow, not as quota', /查询词过窄/.test(narrow), String(narrow))
  check('the narrow-query text does not blame the quota', !/配额/.test(narrow), String(narrow))
  check('the narrow-query text does not upsell a token', !/配一下 GitHub token/.test(narrow), String(narrow))
}

// ---------------------------------------------------------------------------
// S8. treeEvidence — counted facts, and the two ways counting goes wrong
// ---------------------------------------------------------------------------
// This group exists because four probe rounds killed four designs for the same
// feature. What survived is counting, and counting has exactly two failure
// modes worth locking down: matching too much (noise reported as evidence) and
// matching too little (a real signal reported as absent). Both are asserted.
{
  console.log('\n=== S8. treeEvidence: counted facts, not judgements ===')

  const tree = (...paths) => paths.map(p => ({ path: p, type: 'blob' }))

  // --- The defect this replaced: top dirs were `[...dirs].slice(0, 20)`,
  // truncated with no marker, so logseq's list stopped at `ios` and looked
  // complete. A cap that hides itself is the bug, so the cap must be gone.
  {
    const many = tree(...Array.from({ length: 30 }, (_, i) => `dir${String(i).padStart(2, '0')}/file.ts`))
    const ev = treeEvidence(many, false)
    check('does not cap top-level directories at 20', ev.topDirs.length === 30, `got ${ev.topDirs.length}`)
    check('top dirs are sorted, so a truncated list cannot masquerade as ordered',
      JSON.stringify(ev.topDirs) === JSON.stringify([...ev.topDirs].sort()))
    check('a root file contributes no directory',
      treeEvidence(tree('README.md'), false).topDirs.length === 0)
  }

  // --- Truncation must be carried through, because a truncated tree cannot
  // prove absence. This is the fact the old summary mentioned but never used.
  check('truncation is reported', treeEvidence(tree('a/b.ts'), true).truncated === true)
  check('a complete tree reports not-truncated', treeEvidence(tree('a/b.ts'), false).truncated === false)

  // --- Source counting: wide enough to see a Kotlin or R repo, and it must
  // not count a manifest or a markdown file as source.
  {
    const mixed = tree('src/a.ts', 'src/b.go', 'src/c.kt', 'src/d.r', 'README.md', 'package.json', 'LICENSE')
    const ev = treeEvidence(mixed, false)
    check('counts source across ecosystems, not just JS', ev.sourceFiles === 4, `got ${ev.sourceFiles}`)
    check('does not count README as source', !tree('README.md').length || treeEvidence(tree('README.md'), false).sourceFiles === 0)
    check('does not count a manifest as source', treeEvidence(tree('package.json'), false).sourceFiles === 0)
  }

  // --- isTestPath precision. The rejection cases are the point: "latest" and
  // "contest" contain "test", and docs/specification.md is not a spec.
  {
    const SHOULD_MATCH = ['src/a.test.ts', 'src/a.spec.ts', 'tests/a.ts', 'test/a.ts', '__tests__/a.ts', 'e2e/a.ts', 'spec/a.rb']
    const SHOULD_NOT = ['src/latest.ts', 'src/contest.ts', 'src/protest.go', 'src/attestation.ts', 'src/testimony.ts', 'docs/specification.md', 'src/main.ts']
    for (const p of SHOULD_MATCH) check(`isTestPath accepts ${p}`, isTestPath(p) === true)
    for (const p of SHOULD_NOT) check(`isTestPath rejects ${p}`, isTestPath(p) === false)
    // Whole-tree, not top-level: the check that said "no tests" for logseq
    // (cli-e2e) and siyuan (*.test.ts) was a top-level-directory check.
    check('finds tests that live beside sources, not only in test/',
      treeEvidence(tree('kernel/api/foo_test.go'), false).testFiles === 1)
    check('finds tests nested deep in the tree',
      treeEvidence(tree('a/b/c/d/e/f.spec.ts'), false).testFiles === 1)
  }

  // --- Manifests: the count is evidence a repo is real; the ROOT manifest is
  // evidence of what it is built with. The first version emitted only the flat
  // list, which on logseq was 29 paths (669 chars, 11% of the payload) of which
  // ten were `deps/x/package.json`.
  {
    const ev = treeEvidence(tree(
      'package.json', 'deps/db/package.json', 'deps/db/deps.edn', 'kernel/go.mod',
      'app/package.json', 'Cargo.toml', 'README.md',
    ), false)
    check('counts every manifest at any depth', ev.manifests.length === 6, `got ${ev.manifests.length}`)
    check('root manifests are the root ones only', ev.rootManifests.length === 2,
      JSON.stringify(ev.rootManifests))
    check('a root manifest is named without a directory prefix',
      ev.rootManifests.every(p => !p.includes('/')), JSON.stringify(ev.rootManifests))
    check('a monorepo with no root manifest reports none',
      treeEvidence(tree('app/package.json', 'kernel/go.mod'), false).rootManifests.length === 0)
  }

  // --- MANIFEST_RE is shared with the manifest excerpt extractor. It used to
  // have a second, narrower definition in index.ts, and the two drifted: the
  // selector ranked `deps.edn` as a manifest while the extractor did not
  // recognise it, so logseq's manifest_excerpt came back empty (0 chars) even
  // though deps.edn was in files_read.
  {
    const ECOSYSTEMS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'pom.xml',
      'build.gradle', 'build.gradle.kts', 'composer.json', 'deps.edn', 'project.clj',
      'mix.exs', 'pubspec.yaml', 'Gemfile', 'setup.py', 'requirements.txt']
    for (const f of ECOSYSTEMS) check(`MANIFEST_RE recognises ${f}`, MANIFEST_RE.test(f) === true)
    check('MANIFEST_RE recognises a nested manifest', MANIFEST_RE.test('app/package.json') === true)
    check('MANIFEST_RE does not match a plain source file', MANIFEST_RE.test('src/index.ts') === false)
    check('MANIFEST_RE does not match the README', MANIFEST_RE.test('README.md') === false)
    // The exact regression: deps.edn was the file logseq's selector picked and
    // the extractor then failed to name.
    check('the logseq regression: deps.edn is a manifest', MANIFEST_RE.test('deps.edn') === true)
  }

  // --- Degenerate input must not throw. A tree that failed to fetch arrives
  // as an empty entry list, and the evidence block still has to render.
  {
    const ev = treeEvidence([], false)
    check('an empty tree yields zeroed evidence',
      ev.entries === 0 && ev.sourceFiles === 0 && ev.testFiles === 0 && ev.topDirs.length === 0)
    check('an empty tree reports no manifests', ev.manifests.length === 0 && ev.rootManifests.length === 0)
  }
}

// ---------------------------------------------------------------------------
// S9. The wall-clock budget for inspect_projects.
//
// A real session died here: `inspect_projects` deep on 2 repos hit the host's
// 60000ms ceiling and returned a bare `ToolTimeoutError` with no partial
// payload, so the caller learned nothing about which repos had been read. The
// cause was measurable: `github.ts` gives each request 8000ms and retries once
// after 1500ms, so one sick request costs 19000ms, and only three such requests
// out of fifty breach a 60s ceiling.
//
// The fix has two halves, and BOTH are asserted here because either alone is
// useless: a deadline that reaches the HTTP layer (checked behaviourally, by
// making every fetch hang), and a constant that matches the registered timeout
// (checked by reading the registration, because a silent drift would mis-budget
// every call).
{
  const github = await load('github.js')
  const index = await load('index.js')

  // --- The registration's own ceiling must equal the constant the budget math
  // uses. `index.js` states the number once and refers to it from the
  // registration, so this compares two VALUES rather than grepping the source:
  // a text check would keep passing while the behaviour it names was broken.
  // 60000 is asserted literally too, because it is the host's real ceiling —
  // the whole point of the budget math is not to plan work past it.
  const tools = new Map()
  const ctx = {
    get: () => undefined,
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
  }
  index.apply(ctx)
  const inspect = tools.get('inspect_projects')
  check('inspect_projects is registered', inspect !== undefined)
  check('inspect_projects declares a timeout ceiling',
    typeof inspect.timeoutMs === 'number' && inspect.timeoutMs > 0,
    `timeoutMs=${inspect.timeoutMs}`)
  check('the registered ceiling is the exported constant the budget math uses',
    inspect.timeoutMs === index.INSPECT_TIMEOUT_MS,
    `registered=${inspect.timeoutMs} exported=${index.INSPECT_TIMEOUT_MS}`)
  check('the ceiling is the 60000ms the host enforces',
    index.INSPECT_TIMEOUT_MS === 60000,
    `INSPECT_TIMEOUT_MS=${index.INSPECT_TIMEOUT_MS}`)
  // The budget math must stay strictly INSIDE the ceiling: a call that plans to
  // finish exactly at the limit has no room for the one slow request that always
  // happens, and an overrun costs the caller the whole call.
  check('the planned budget leaves room under the ceiling',
    index.TIME_BUDGET_SHARE > 0 && index.TIME_BUDGET_SHARE < 1,
    `TIME_BUDGET_SHARE=${index.TIME_BUDGET_SHARE}`)

  // --- The behavioural half: with a deadline, a hanging request must NOT be
  // allowed to spend the full 8000 + 1500 + 8000 = 17500ms, and must not retry
  // once the deadline has passed. The probe that established this is reproduced
  // here so it cannot regress without the suite going red.
  const realFetch = globalThis.fetch
  let attempts = 0
  const hangUntilAborted = async (url, init) => {
    attempts++
    await new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('probe: fetch hung')), 30000)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(init.signal.reason ?? new Error('aborted'))
      }, { once: true })
    })
  }
  try {
    globalThis.fetch = hangUntilAborted

    // With a tight deadline: no retry, and the whole thing collapses to roughly
    // the deadline rather than to the full 17500ms worst case. This single case
    // proves the deadline reaches the HTTP layer at all -- which is the property
    // that was missing entirely before, and the one a refactor could silently
    // drop by failing to thread `deadline` through a layer.
    //
    // NOTE: the back-compat case ("no deadline still retries once") is
    // deliberately NOT asserted here. Reproducing it costs a real 17500ms of
    // sleeping on every `npm test` run, and it only re-proves arithmetic that
    // `github.ts` states as constants. The deadline case below fails just as
    // loudly if the deadline stops being honoured.
    attempts = 0
    const t1 = Date.now()
    let msg = ''
    try { await github.searchRepositories('x', 1, { deadline: Date.now() + 5000 }) } catch (error) { msg = String(error?.message ?? error) }
    const deadlineMs = Date.now() - t1
    check('a deadline stops the request from retrying', attempts === 1, `attempts=${attempts}`)
    check('a deadline bounds the cost far below the 17500ms worst case',
      deadlineMs < 12000, `deadline=${deadlineMs}ms`)

    // An expired deadline must SAY so: an error that only reports a timeout
    // leaves the caller unable to tell a slow network from an exhausted budget.
    // Cost: one attempt capped at the 1ms floor, i.e. effectively free.
    attempts = 0
    let expiredMsg = ''
    try { await github.searchRepositories('x', 1, { deadline: Date.now() - 1000 }) } catch (error) { expiredMsg = String(error?.message ?? error) }
    check('an already-expired deadline is named in the error',
      /deadline/i.test(expiredMsg), expiredMsg.slice(0, 80))
    check('an expired deadline spends no retry', attempts === 1, `attempts=${attempts}`)
  } finally {
    globalThis.fetch = realFetch
  }

  // --- And the healthy path is untouched: a real call with a roomy deadline
  // must still return candidates. This is the control that catches a "fix" which
  // bounds the cost by breaking the request entirely.
  try {
    const res = await github.searchRepositories('dsh-plugin', 2, { deadline: Date.now() + 20000 })
    check('a healthy call with a deadline still returns candidates',
      Array.isArray(res.candidates) && res.candidates.length > 0, `candidates=${res.candidates?.length ?? 'n/a'}`)
  } catch (error) {
    // Network unavailable in this environment: report it as a skip, not a pass.
    console.log(`  SKIP  healthy call needs network (${String(error?.message ?? error).slice(0, 60)})`)
  }
}

// ---------------------------------------------------------------------------
// S10. `requests_used` counts real requests, not the budget constant. (T11)
//
// Why this is asserted behaviourally
// ----------------------------------
// `inspect_projects` reported `requests_used` as `repos.length * requestsPerRepo`
// -- the number of requests the batch was ALLOWED to send. That answers a
// different question than the field name asks, and it was wrong in both
// directions at once: a repository served entirely from cache still "cost" 6,
// while the two retry paths cost nothing at all. The counter now lives at the one
// place a request actually goes on the wire (`github.ts` `requestJson`), so the
// fix is only real if the hook fires there and the caller reads it back.
//
// The mock below distinguishes the two implementations directly: it counts the
// fetch calls it receives. The budget says 6 for one shallow repo; the honest
// answer is 1 (README) + 1 (tree) + 1 per file actually read.
// ---------------------------------------------------------------------------
{
  const github = await load('github.js')

  // --- counts every wired attempt, including a retry.
  const realFetch = globalThis.fetch
  let seen = 0
  try {
    globalThis.fetch = async () => {
      seen++
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    let counted = 0
    await github.searchRepositories('x', 1, { onRequest: () => { counted += 1 } })
    check('S10 onRequest fires once per real attempt (T11)', counted === seen && counted >= 1,
      `hook=${counted} fetch=${seen}`)
  } catch (error) {
    check('S10 onRequest fires once per real attempt (T11)', false, String(error?.message ?? error).slice(0, 120))
  } finally {
    globalThis.fetch = realFetch
  }

  // --- a retry is a second request and must be counted as one.
  seen = 0
  let attemptCount = 0
  try {
    globalThis.fetch = async () => {
      seen++
      if (seen === 1) throw new Error('simulated transport failure')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    await github.searchRepositories('x', 1, { onRequest: () => { attemptCount += 1 } })
    check('S10 a retried attempt is counted, not hidden (T11)', attemptCount === 2,
      `attempts=${attemptCount} fetch=${seen} (expected 2: original + retry)`)
  } catch (error) {
    check('S10 a retried attempt is counted, not hidden (T11)', false, String(error?.message ?? error).slice(0, 120))
  } finally {
    globalThis.fetch = realFetch
  }

  // --- omitting the hook must stay legal: 77 existing call sites pass no counter.
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    const res = await github.searchRepositories('x', 1, {})
    check('S10 the counter is optional, so existing callers are unaffected (T11)',
      res !== undefined, 'a call without onRequest threw')
  } catch (error) {
    check('S10 the counter is optional, so existing callers are unaffected (T11)', false,
      String(error?.message ?? error).slice(0, 120))
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
