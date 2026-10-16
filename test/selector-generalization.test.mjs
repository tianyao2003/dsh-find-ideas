// Generalization tests for the architecture-file selector (task item 2.6.5).
//
// WHY THIS FILE EXISTS
// --------------------
// Every rule in the selector was measured on one of five repositories and then
// written as an ABSOLUTE rule. Two of them were worse than absolute: they
// DELETED their matches from the candidate list before anything was scored.
//
//   if (JUNK_DIR_RE.test(lower)) return false
//   if (PLATFORM_SHELL_RE.test(lower)) return false
//
// A rule that deletes its subject cannot be revisited when nothing else is
// left, and the cost was measured on two trees from the design doc:
//
//   - an Android app:  README.md + build.gradle.kts +
//                      android/app/src/main/java/{App,Service}.java
//                      -> ZERO Java source picked
//   - a Python CLI:    README.md + package.json + scripts/{main,tool}.py
//                      -> ZERO Python source picked
//
// Both reads showed a README and a manifest and called that the architecture.
// "This is a build target, not the product" is a claim about RANK, and a claim
// that deletes its subject cannot be revisited when nothing else is left.
//
// Three changes fix it, and this file pins all three:
//   1. the two exclusions became score PENALTIES, so a soft-excluded path stays
//      in the candidate list and is reached once the ranking has nothing better;
//   2. a zero-source fallback spends a slot on code when the ranking would
//      otherwise return only prose (slots 1 and 4 are prose by construction);
//   3. `isEntryPoint` learned `java` and `cs`, plus C#'s `Program` filename, so
//      a Java or C# project has an entry point at all.
//
// Every fixture below is a TREE SHAPE rather than a repository name, and every
// assertion is on what `pickArchitectureFiles` RETURNS. The three design trees
// are reproduced verbatim as the regression that motivated the change
// (design.md:293 requires all three to keep at least one source file).
//
// Run with:  node test/selector-generalization.test.mjs
// (NOT `node --test` — this file prints its own verdicts and `node --test`
// reports false negatives for that shape.)
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { pickArchitectureFiles } = await load('select.js')

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

// "Is this source?" is deliberately answered here rather than imported: the
// selector's `SOURCE_EXT_RE` is private, and a test that re-derived it would
// restate the implementation instead of checking the behaviour. This is the
// wider evidence-side list, so it can only under-report a source pick, never
// invent one.
const isSource = (p) =>
  /\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|ex|exs|erl|hs|ml|scala|clj|cljs|cljc|edn|vue|svelte|dart|lua|sh|ps1|sql)$/i.test(p)

// The three trees the design doc measured the failure on, verbatim.
const ANDROID_TREE = [
  'README.md', 'build.gradle.kts',
  'android/app/src/main/java/App.java', 'android/app/src/main/java/Service.java',
]
const PYTHON_CLI_TREE = ['README.md', 'package.json', 'scripts/main.py', 'scripts/tool.py']
const TAURI_TREE = [
  'README.md', 'package.json', 'src-tauri/Cargo.toml', 'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs', 'src/main.ts', 'src/App.vue', 'src/components/Editor.vue',
]

// ---------------------------------------------------------------------------
console.log('\n=== G1. the three measured design trees each keep source evidence ===')
{
  // design.md:293 states the required regression as "Android / Python CLI /
  // Tauri 三棵树都至少有一个源码文件入选" — all three must keep at least one
  // source file. Before this change the first two picked ZERO.
  const android = pickArchitectureFiles(tree(ANDROID_TREE), 4)
  check('Android tree: the pick is not empty', android.length > 0, JSON.stringify(android))
  check('Android tree: at least one source file is picked',
    android.some(isSource), JSON.stringify(android))

  const pycli = pickArchitectureFiles(tree(PYTHON_CLI_TREE), 4)
  check('Python CLI tree: the pick is not empty', pycli.length > 0, JSON.stringify(pycli))
  check('Python CLI tree: at least one source file is picked',
    pycli.some(isSource), JSON.stringify(pycli))

  const tauri = pickArchitectureFiles(tree(TAURI_TREE), 4)
  check('Tauri tree: still keeps its frontend AND its native side',
    tauri.some((p) => p.startsWith('src/')) && tauri.some((p) => p.startsWith('src-tauri/')),
    JSON.stringify(tauri))
  check('Tauri tree: still keeps the README and the manifest',
    tauri.includes('README.md') && tauri.includes('package.json'), JSON.stringify(tauri))
}

// ---------------------------------------------------------------------------
console.log('\n=== G2. a platform-shell path is OUTRANKED, not removed ===')
{
  // (a) the half that was broken: when the product lives under `android/`, the
  // directory must still be reachable. Deleting it made the repository look
  // like a README plus a Gradle file.
  const androidOnly = pickArchitectureFiles(tree(ANDROID_TREE), 4)
  check('a shell path holding the only code is still reachable',
    androidOnly.some((p) => p.startsWith('android/')), JSON.stringify(androidOnly))

  // (b) the half the deletion was protecting: a shell that is merely DENSER
  // than the real core must still lose. This is the logseq shape — Kotlin under
  // `android/` outnumbers ClojureScript under `src/` — and it is the case the
  // calibration comment in select.ts is written against.
  const logseqShape = [
    'README.md', 'package.json', 'deps.edn',
    'src/main/frontend/core.cljs', 'src/main/frontend/handler.cljs',
    'android/app/src/main/java/A.kt', 'android/app/src/main/java/B.kt',
    'android/app/src/main/java/C.kt', 'android/app/src/main/java/D.kt',
    'android/app/src/main/java/E.kt', 'android/app/src/main/java/F.kt',
  ]
  const picks = pickArchitectureFiles(tree(logseqShape), 4)
  check('a denser shell still loses to the conventional source root',
    picks.some((p) => p.startsWith('src/')), JSON.stringify(picks))
  check('the shell spends no slot while the core is available',
    !picks.some((p) => p.startsWith('android/')), JSON.stringify(picks))
}

// ---------------------------------------------------------------------------
console.log('\n=== G3. a junk-directory path is OUTRANKED, not deleted ===')
{
  // (a) outranked: with a real core present, `examples/` must not take a slot.
  const withCore = pickArchitectureFiles(tree([
    'README.md', 'package.json', 'src/main.ts', 'src/App.vue',
    'examples/demo.ts', 'examples/helper.ts',
  ]), 4)
  check('examples/ is outranked by the core directory',
    !withCore.some((p) => p.startsWith('examples/')), JSON.stringify(withCore))

  // (b) not deleted: when `examples/` IS the product, the pick must still show
  // code. This is the Python CLI shape — the measured tree kept its Python in
  // `scripts/`, which the old filter deleted outright.
  const junkOnly = pickArchitectureFiles(tree([
    'README.md', 'package.json', 'examples/demo.ts', 'examples/helper.ts',
  ]), 4)
  check('a junk path holding the only code is still reachable',
    junkOnly.some((p) => p.startsWith('examples/')), JSON.stringify(junkOnly))
  check('and the pick still contains source', junkOnly.some(isSource), JSON.stringify(junkOnly))

  const scriptsOnly = pickArchitectureFiles(tree(PYTHON_CLI_TREE), 4)
  check('scripts/ holding the only code is reachable too',
    scriptsOnly.some((p) => p.startsWith('scripts/')), JSON.stringify(scriptsOnly))
}

// ---------------------------------------------------------------------------
console.log('\n=== G4. a tree with no recognisable source directory still picks ===')
{
  // The zero-source fallback. Slots 1 and 4 are prose BY CONSTRUCTION (the root
  // README; a manifest or a design doc), so a repository that never wins a
  // source slot reads as "a README and a manifest" and the agent calls that the
  // architecture. The fallback spends an already-taken slot on code.
  const lone = pickArchitectureFiles(tree([
    'README.md', 'Cargo.toml', 'package.json', 'src/main.rs',
  ]), 2)
  check('two slots and only prose competing still yields the source file',
    lone.includes('src/main.rs'), JSON.stringify(lone))
  check('the root README is never the file evicted',
    lone.includes('README.md'), JSON.stringify(lone))

  // Flat repositories have no directory to score at all, so the density signal
  // finds nothing. They must not return nothing.
  const flat = pickArchitectureFiles(tree([
    'README.md', 'package.json', 'index.js', 'util.js', 'config.js',
  ]), 4)
  check('a flat repository still fills its budget', flat.length === 4, JSON.stringify(flat))
  check('a flat repository still shows source', flat.some(isSource), JSON.stringify(flat))

  // What the fallback does NOT do: invent code. A manifest-only repository is a
  // real repository, and the honest pick is the prose that is actually there.
  const prose = pickArchitectureFiles(tree(['README.md', 'package.json']), 4)
  check('a prose-only repository keeps its honest pick',
    prose.includes('README.md') && prose.includes('package.json'), JSON.stringify(prose))
  check('a prose-only repository invents no source path',
    !prose.some(isSource), JSON.stringify(prose))
}

// ---------------------------------------------------------------------------
console.log('\n=== G5. Java and C# entry points are recognised ===')
{
  // `java` and `cs` were missing from `isEntryPoint`'s extension alternation
  // while `NATIVE_EXT_RE` always had them, so slot 3 ("what backs it?") asked
  // for a native entry point and answered "none" on a repository made of
  // nothing else. The cap is 3 on purpose: slot 3 is the one under test, and at
  // cap 4 the flat fill loop could supply the same path for the wrong reason.
  const java = pickArchitectureFiles(tree([
    'README.md', 'build.gradle',
    'src/main/java/Alpha.java', 'src/main/java/Main.java', 'src/main/java/Beta.java',
  ]), 3)
  check('a Java Main.java claims the backend slot',
    java.includes('src/main/java/Main.java'), JSON.stringify(java))

  // C# is the reason the NAME list changed too, not just the extension list:
  // the language puts its `Main` method inside a file called `Program`, so a
  // name list built from `main` alone never matches the one file a C# reader
  // opens first. `Program.cs` used to reach the pick only by not being
  // eliminated, which is not the same as being recognised.
  const csharp = pickArchitectureFiles(tree([
    'README.md', 'src/Alpha.cs', 'src/Program.cs', 'src/Beta.cs',
  ]), 3)
  check('a C# Program.cs claims the backend slot',
    csharp.includes('src/Program.cs'), JSON.stringify(csharp))

  // The entry-point name list must not swallow unrelated files: `Program.cs`
  // being an entry point does not make every `.cs` file one.
  const noEntry = pickArchitectureFiles(tree([
    'README.md', 'src/Alpha.cs', 'src/Beta.cs',
  ]), 4)
  check('an entry-point-shaped name is required, not the extension alone',
    noEntry.length > 0 && noEntry.every((p) => !/Program|Main/.test(p)), JSON.stringify(noEntry))
}

// ---------------------------------------------------------------------------
console.log('\n=== G6. the cap is respected, and [] means genuinely unpickable ===')
{
  const big = tree([
    'README.md', 'package.json',
    ...Array.from({ length: 40 }, (_, i) => `src/mod/file${i}.ts`),
  ])
  for (const cap of [1, 2, 3, 4, 8, 50]) {
    const picks = pickArchitectureFiles(big, cap)
    check(`maxFiles=${cap} is never exceeded`, picks.length <= cap, String(picks.length))
  }
  check('a large cap returns unique paths',
    new Set(pickArchitectureFiles(big, 8)).size === pickArchitectureFiles(big, 8).length)

  // `[]` is reserved for the trees where there is genuinely no architecture to
  // read. The soft exclusions must not have widened this set: `logo.png` and
  // `LICENSE` are still DELETED rather than charged for, because "not
  // architecture in ANY repository" is a claim about kind, not about rank.
  check('an empty tree returns nothing', pickArchitectureFiles([], 4).length === 0)
  check('a tree of only junk returns nothing',
    pickArchitectureFiles(tree(['logo.png', 'LICENSE']), 4).length === 0)
  check('maxFiles=0 returns nothing',
    pickArchitectureFiles(tree(['README.md', 'src/a.ts']), 0).length === 0)
  check('a negative cap behaves like zero',
    pickArchitectureFiles(tree(ANDROID_TREE), -1).length === 0)

  // And the complement: any tree that DOES hold a non-junk file yields a pick,
  // which is the property the fallback exists to guarantee.
  for (const [label, paths] of [
    ['Android design tree', ANDROID_TREE],
    ['Python CLI design tree', PYTHON_CLI_TREE],
    ['Tauri design tree', TAURI_TREE],
    ['a lone source file', ['README.md', 'Cargo.toml', 'src/main.rs']],
    ['a prose-only tree', ['README.md', 'package.json']],
  ]) {
    check(`${label}: a non-empty tree yields a non-empty pick`,
      pickArchitectureFiles(tree(paths), 4).length > 0, label)
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== G7. the same tree yields the same picks ===')
{
  // Determinism is not decoration here: the slot allocator walks a `ranked`
  // array whose ties break on `localeCompare`, and the fallback indexes into
  // `picked` and `ranked` by position. A selector that returned different
  // files for the same repository on two calls would make every downstream
  // reading unreproducible.
  const fixtures = [
    ['Android', ANDROID_TREE],
    ['Python CLI', PYTHON_CLI_TREE],
    ['Tauri', TAURI_TREE],
    ['flat', ['README.md', 'package.json', 'index.js', 'util.js', 'config.js']],
    ['lone source', ['README.md', 'Cargo.toml', 'package.json', 'src/main.rs']],
    ['junk-only source', ['README.md', 'package.json', 'examples/demo.ts', 'examples/helper.ts']],
    ['C# entry', ['README.md', 'src/Alpha.cs', 'src/Program.cs', 'src/Beta.cs']],
  ]

  for (const [label, paths] of fixtures) {
    for (const cap of [1, 2, 3, 4, 8]) {
      const first = pickArchitectureFiles(tree(paths), cap)
      const second = pickArchitectureFiles(tree(paths), cap)
      check(`${label} @ cap ${cap}: repeated calls agree`,
        JSON.stringify(first) === JSON.stringify(second), JSON.stringify(first))

      // The tree arrives from a JSON listing, so its ORDER is not a property of
      // the repository. Reversing and rotating it must not change the pick —
      // if it does, some tie is being broken by input position.
      const reversed = pickArchitectureFiles(tree([...paths].reverse()), cap)
      const rotated = pickArchitectureFiles(tree([...paths.slice(3), ...paths.slice(0, 3)]), cap)
      check(`${label} @ cap ${cap}: input order does not decide the pick`,
        JSON.stringify(first) === JSON.stringify(reversed) && JSON.stringify(first) === JSON.stringify(rotated),
        `${JSON.stringify(first)} vs ${JSON.stringify(reversed)} vs ${JSON.stringify(rotated)}`)
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== G8. a src-tauri-only tree is not deleted by the platform rule ===')
{
  // The Tauri fixture in G1 carries BOTH a `src/` and a `src-tauri/`, so it
  // cannot show whether the platform pattern would have removed the native side
  // on its own: the frontend satisfies the pick either way. A Rust project whose
  // ONLY code lives under `src-tauri/` is the shape the old
  // `if (PLATFORM_SHELL_RE.test(lower)) return false` erased outright — the
  // repository came back as a README plus a Cargo.toml, which reads as "no
  // architecture" rather than as "the architecture is in Rust".
  const rustOnly = [
    'README.md', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json',
    'src-tauri/src/main.rs', 'src-tauri/src/lib.rs', 'src-tauri/src/commands.rs',
  ]
  const picks = pickArchitectureFiles(tree(rustOnly), 4)
  check('a src-tauri-only tree still picks', picks.length > 0, JSON.stringify(picks))
  check('a src-tauri-only tree still reaches its native side',
    picks.some((p) => p.startsWith('src-tauri/')), JSON.stringify(picks))
  check('a src-tauri-only tree still shows source, not just manifests',
    picks.some(isSource), JSON.stringify(picks))
}

// ---------------------------------------------------------------------------
console.log('\n=== G9. a tree with no recognised source extension still picks ===')
{
  // The literal zero-source case: not one path carries an extension the
  // selector knows. Returning `[]` here is indistinguishable from "this
  // repository has no architecture", so the honest answer — the config and
  // manifest files that ARE there — was replaced by silence. The fallback must
  // return something usable instead.
  const configOnly = [
    'README.md', 'package.json', 'config.yaml', 'data.json', 'tsconfig.json', 'Makefile',
  ]
  const picks = pickArchitectureFiles(tree(configOnly), 4)
  check('a tree with no source extension still picks', picks.length > 0, JSON.stringify(picks))
  check('a tree with no source extension returns real paths, not placeholders',
    picks.every((p) => configOnly.includes(p)), JSON.stringify(picks))
  check('a tree with no source extension invents no source path',
    !picks.some(isSource), JSON.stringify(picks))
  check('a tree with no source extension keeps its manifest',
    picks.includes('package.json'), JSON.stringify(picks))
}

// ---------------------------------------------------------------------------
console.log('\n=== G10. an explicit files list overrides the selector ===')
{
  // `inspect_projects` documents `files` to the model as "Explicit paths
  // override the selector". That promise is kept in `index.ts`, which branches
  // on the requested list BEFORE it ever calls `pickArchitectureFiles` — so a
  // selector-only test cannot see it, because the property under test is that
  // the selector is not consulted at all. This drives the REGISTERED tool
  // against a mocked GitHub and reads back what it actually fetched.
  //
  // The forced path is `CHANGELOG.md`, which the selector DELETES outright (it
  // is not architecture in any repository). That is the strongest form of
  // "honoured even when it looks disqualified": a heuristic pick can never
  // produce this path, so its presence in `files_read` can only come from the
  // override.
  const realFetch = globalThis.fetch
  const realHome = process.env.DSH_HOME
  const scratch = join(tmpdir(), `dsh-sel-gen-${process.pid}-${Date.now()}`)
  mkdirSync(scratch, { recursive: true })
  // Point the inspect cache at a throwaway directory. `cache.ts` reads DSH_HOME
  // lazily on every call, so setting it here — after the module was imported —
  // is enough, and it keeps the run from writing into the real `~/.dsh` cache.
  process.env.DSH_HOME = scratch
  // Held for the duration so the event loop never empties mid-await: the HTTP
  // layer caps every attempt with `AbortSignal.timeout`, which is UNREF'd, and
  // an unref'd timer alone does not keep the process alive.
  const keepAlive = setInterval(() => {}, 1000)

  const OVERRIDE_TREE = [
    'README.md', 'package.json', 'src/main.ts', 'src/App.vue', 'src/util.ts',
    'CHANGELOG.md', 'LICENSE',
  ]
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
  let contentCalls = []

  try {
    globalThis.fetch = async (url) => {
      const href = String(url)
      const json = (payload) => new Response(JSON.stringify(payload), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
      if (href.includes('/rate_limit')) return json({})
      if (href.includes('/readme')) return json({ content: b64('# Demo\nA demo repository.'), encoding: 'base64' })
      if (href.includes('/git/trees/')) {
        return json({ tree: OVERRIDE_TREE.map((path) => ({ path, type: 'blob' })), truncated: false })
      }
      if (href.includes('/contents/')) {
        const path = decodeURIComponent(href.split('/contents/')[1].split('?')[0])
        contentCalls.push(path)
        return json({ content: b64(`// ${path}\n`), encoding: 'base64' })
      }
      return json({})
    }

    const index = await load('index.js')
    const tools = new Map()
    const ctx = {
      get: () => undefined,
      tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    }
    index.apply(ctx)
    const inspect = tools.get('inspect_projects')
    check('inspect_projects is registered for the override test', inspect !== undefined)

    // --- (a) the control: with no `files`, the heuristic decides, and on this
    // tree it reaches the `src/` sources.
    const heuristic = await inspect.execute({ idea: 'x', repos: ['acme/demo'], depth: 'shallow' }, {})
    const heuristicFiles = heuristic.inspections?.[0]?.files_read ?? []
    check('without files, the selector picks the source directory',
      heuristicFiles.some((p) => p.startsWith('src/')), JSON.stringify(heuristicFiles))

    // --- (b) the override. Same repository, same tree: only `files` differs.
    contentCalls = []
    const forced = await inspect.execute(
      { idea: 'x', repos: ['acme/demo'], depth: 'shallow', files: ['CHANGELOG.md'] }, {})
    const forcedFiles = forced.inspections?.[0]?.files_read ?? []
    check('an explicit files list is exactly what gets read',
      JSON.stringify(forcedFiles) === JSON.stringify(['CHANGELOG.md']), JSON.stringify(forcedFiles))
    check('an explicit files list is read even though the selector deletes that path',
      contentCalls.includes('CHANGELOG.md'), JSON.stringify(contentCalls))
    check('an explicit files list suppresses the selector entirely',
      !forcedFiles.some((p) => p.startsWith('src/')), JSON.stringify(forcedFiles))
    check('an explicit files list does not cost more slots than the cap',
      forcedFiles.length <= 4, String(forcedFiles.length))
  } catch (error) {
    check('an explicit files list overrides the selector', false,
      String(error?.message ?? error).slice(0, 200))
  } finally {
    clearInterval(keepAlive)
    globalThis.fetch = realFetch
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
