/**
 * Architecture file selection: which four files to read to understand a repo.
 *
 * This module exists because the selector went through three rewrites and three
 * real defects while living inside a tool registration, where no test could
 * reach it. It is a pure function over a repository tree, so it belongs in a
 * file of its own — and the reasoning behind every rule is preserved verbatim
 * below, because each one was paid for with a measured failure.
 */

/**
 * A dependency manifest: states the stack outright, which is what P2 is for.
 *
 * Exported because a second, narrower copy of this list used to live in
 * `index.ts`, where it decided which read file became the manifest excerpt. The
 * two drifted: the selector scored `deps.edn` as a manifest and the selector's
 * ranking promoted it into `files_read`, and then the excerpt extractor — not
 * recognising it — produced an empty `manifest_excerpt` for logseq. One fact
 * with two definitions disagrees with itself eventually; the fix is one
 * definition, shared. Covered by test/queries.test.mjs group S8.
 */
export const MANIFEST_RE = /(^|\/)(package\.json|cargo\.toml|go\.mod|pyproject\.toml|pom\.xml|build\.gradle|build\.gradle\.kts|composer\.json|deps\.edn|project\.clj|mix\.exs|pubspec\.yaml|gemfile|csproj|fsproj|vbproj|setup\.py|requirements\.txt)$/i

/**
 * Root-level files that carry no architectural information.
 *
 * These are the files that floated up once dotfiles were excluded: they sit at
 * the root, are short, and match no source-directory signal, so the depth
 * bonus alone promoted them. `AGENTS.md` and `CLAUDE.md` are instructions for
 * AI assistants, `LICENSE` is legal text, `CHANGELOG` is release history — none
 * of them describe how the software is built, which is the entire purpose of
 * the read.
 *
 * Applied at any depth, not just the root: a live read picked
 * `app/appearance/LICENSE` out of siyuan, which a root-only rule let through.
 * A licence is legal text wherever it sits.
 */
const NON_ARCH_FILE_RE = /^(agents|claude|license|licence|copying|changelog|changes|contributing|code_of_conduct|security|notice|authors|codeowners|funding|sponsors)(\.(md|rst|txt))?$/i

/**
 * Segments that mark a sub-package as tooling rather than the product.
 *
 * trilium's read picked `apps/build-docs/package.json` — the documentation
 * site's manifest — over the application itself. When a monorepo has no root
 * manifest, the picker has to descend, and this steers it away from the
 * build/docs tooling toward whatever actually ships.
 */
const TOOLING_SEGMENT_RE = /(^|\/)(build-docs|docs?|website|site|examples?|demo|fixtures?|benchmarks?|scripts?|tools?|e2e|tests?|specs?)(\/|$)/i

/**
 * Dotfiles and tool configs that are never architecture.
 *
 * A live shallow read spent one of logseq's three file slots on `.cljfmt.edn`
 * and `.i18n-lint.toml`, and one of trilium's on `.envrc` and `.editorconfig`,
 * while the actual entry points went unread. They match no source-directory
 * signal, but they sit at the repository root and are therefore
 * shallow, so the depth bonus alone floated them into the top three.
 *
 * The rule is structural rather than an enumeration: any dot-prefixed basename
 * (`.envrc`, `.cljfmt.edn`, `.editorconfig`, `.i18n-lint.toml`, `.gitignore`)
 * is tooling configuration, not source. Enumerating names fails the moment a
 * project picks a tool I did not anticipate — which is exactly what happened
 * twice.
 */
function isDotfileConfig(path: string): boolean {
  const base = path.split('/').pop() ?? ''
  return base.startsWith('.') && base.length > 1
}

/**
 * Files whose name says they are not architecture, at any depth.
 *
 * @param path - repository-relative path.
 * @returns true for LICENSE/CHANGELOG/AGENTS.md and friends.
 */
function isNonArchFile(path: string): boolean {
  return NON_ARCH_FILE_RE.test(path.split('/').pop() ?? '')
}

/**
 * README variants in non-primary languages.
 *
 * siyuan was read as `README.ja.md` + `README.md` + `README.tr.md` — three slots
 * spent on one document in three languages. Only the primary README earns a
 * slot; translations are the same architecture described again.
 */
function isTranslatedReadme(path: string): boolean {
  const base = path.split('/').pop() ?? ''
  return /^readme\.[a-z]{2}(-[a-z]{2,4})?\.(md|rst|txt)$/i.test(base)
}

/**
 * Extract directory and file names the README actually mentions.
 *
 * This is the replacement for guessing at path names. The README is the one
 * document that states what a project is made of, and it does so in the
 * project's own words: Cairn's README names `crates/cairn-core` and
 * `docs/PLAN.md`; Easy-MD's names `src-tauri` and its Rust indexer; note-gen's
 * names `src-tauri`.
 *
 * The heuristic it replaces was measured to fail on four of five real repos: on
 * siyuan it picked `app/appx/AppxManifest.xml` twice (Windows packaging), on
 * cairn it picked the empty `app/index.html` shell, on logseq an Android Gradle
 * file. Three rounds of exclusion rules only pushed the next unanticipated
 * metadata file forward (`.github/` → `.claude/`), because the information
 * needed to choose well is not in the file *name*.
 *
 * Deliberately NOT wired into the selector below. It is kept as the record of
 * a measured dead end — the README describes *what* a project is, not *where*
 * the code lives, and on the same five repos this approach left three
 * unchanged and made one worse. The selector uses source density instead.
 * It is not called anywhere; `test/queries.test.mjs` asserts only the behaviour
 * of `pickArchitectureFiles`, so nothing here is on the live path.
 *
 * @param readme - decoded README text.
 * @returns lowercase tokens that look like paths or directory names.
 */
export function readmeMentions(readme: string): Set<string> {
  const mentions = new Set<string>()
  // Backticked spans are where READMEs name real paths: `src-tauri`, `docs/PLAN.md`.
  for (const span of readme.matchAll(/`([^`\n]{2,80})`/g)) {
    const token = span[1]
    if (token === undefined) continue
    const cleaned = token.trim().replace(/^\.\//, '').replace(/[),.;:]+$/, '')
    if (/^[\w./-]+$/.test(cleaned)) mentions.add(cleaned.toLowerCase())
  }
  // Markdown links pointing inside the repo: [the manual](docs/manual/README.md)
  for (const link of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = link[1]
    if (target === undefined) continue
    const cleaned = target.trim().replace(/^\.\//, '').replace(/[),.;:]+$/, '')
    if (!/^https?:/i.test(cleaned) && /^[\w./-]+$/.test(cleaned)) mentions.add(cleaned.toLowerCase())
  }
  return mentions
}

/** Source-code extensions, used to measure how code-dense a directory is. */
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|ex|exs|erl|hs|ml|scala|clj|cljs|cljc|edn|vue|svelte|dart|lua|sh|ps1|sql)$/i

/**
 * Platform shells and asset directories: source files, but not the product.
 *
 * `android/` holding Kotlin is *source code*, so every source-based signal
 * welcomes it — and it then outranks `src/` on file count. But it is a build
 * target, not the architecture: logseq's real core is ClojureScript in `src/`,
 * and siyuan's is Go in `kernel/`. Same for icons and theme assets.
 */
const PLATFORM_SHELL_RE = /(^|\/)(android|ios|macos|mac|windows|win32|linux|appx|appearance|icons?|themes?|fonts?|sounds?)(\/|$)/i

/** Directories whose contents never describe the product. */
const JUNK_DIR_RE = /(^|\/)(node_modules|dist|build|out|target|vendor|coverage|website|site|examples?|demo|fixtures?|benchmarks?|e2e|tests?|specs?|scripts?|tools?|i18n|locales?|assets?|images?|img|static|public|screenshots?|media)(\/|$)/i

/**
 * What a soft-excluded directory gives up: a factor on its density score, and a
 * flat charge on every file inside it.
 *
 * `PLATFORM_SHELL_RE` and `JUNK_DIR_RE` used to DELETE their matches from the
 * candidate list before anything was scored. That was over-fitted to the five
 * repositories the rules were measured on, and it fails in the one direction
 * that matters most: a project whose whole product lives under a matching path
 * becomes invisible, with no trace that anything was excluded. Measured on two
 * of the three design trees — an Android app (`README.md` +
 * `build.gradle.kts` + `android/app/src/main/java/{App,Service}.java`) and a
 * Python CLI (`README.md` + `package.json` + `scripts/{main,tool}.py`) — the
 * pick was ZERO source files: the read showed a README and a manifest and
 * called that architecture. `android/` holding Java IS source code, and
 * `scripts/` holding Python IS source code. "This is a build target, not the
 * product" is a claim about RANK, and a claim that deletes its subject cannot be
 * revisited when nothing else is left.
 *
 * So the two patterns charge points instead. The path stays in the candidate
 * list, competes for every slot, and is reached once the ranking has nothing
 * better — which is what "outranked, not removed" has to mean for a repository
 * whose product sits under one of them.
 *
 * What the penalty trades away is exactly what the deletion bought: a
 * checked-in `node_modules/` tree or a large `android/` shell now counts toward
 * the density signal it used to be absent from, and can take a slot in a
 * repository whose real core is thin. The factors are calibrated against the
 * case that motivated the patterns — logseq's `android/` is denser than its
 * `src/`, and it must still lose to it. `src/` carries the ×1.1
 * conventional-name bonus, so a shell has to fall below ×0.909 to lose that
 * comparison, and both factors do.
 */
const PLATFORM_SHELL_DIR_FACTOR = 0.5
const JUNK_DIR_DIR_FACTOR = 0.35

/**
 * The same two soft exclusions, charged against a FILE's score.
 *
 * Larger than the `TOOLING_SEGMENT_RE` charge below (-15) because it is a
 * stronger claim: tooling sits off to the side of the product, while a junk
 * directory is not the product at all. Deliberately smaller than a whole
 * category's weight, so a soft-excluded entry point or manifest can still claim
 * the slot that is defined by being one — which is the entire point of keeping
 * it in the candidate list instead of deleting it.
 */
const PLATFORM_SHELL_FILE_PENALTY = 40
const JUNK_DIR_FILE_PENALTY = 45

/**
 * Conventional source-root names, which get a small density bonus.
 *
 * `deps/` in logseq scores 0.910 against `src/` at 0.897 — a 1.3% gap deciding
 * which directory is "the product", when `deps/` actually holds side tools
 * (db-sync, publish) and `src/` holds the application. Density alone is too
 * brittle at that margin, so a conventional name breaks the near-tie.
 *
 * `app` is deliberately absent. It was here briefly and it was a mistake: in
 * siyuan `app/` is the Electron shell over a Go `kernel/`, and in cairn it is
 * the Tauri shell over a Rust `crates/`. Boosting `app` re-created the exact
 * problem PLATFORM_SHELL_RE exists to solve.
 */
const CONVENTIONAL_SRC_DIR_RE = /^(src|source|lib|packages?|kernel|core|internal|pkg)$/i

/**
 * Any dot-prefixed *directory segment* is tooling, not the product.
 *
 * `isDotfileConfig` below only inspects the basename, so a file such as
 * `.clj-kondo/config.edn` slips through: `config.edn` does not start with a dot.
 * That blind spot was hit three times — first `.github/`, then `.claude/` after
 * `.github/` was excluded, then `.clj-kondo/` — because every fix added another
 * *name* to a list. This is the structural version: no enumeration, so
 * `.husky/`, `.storybook/` and whatever comes next are covered too.
 */
const DOT_DIR_RE = /(^|\/)\.[^/]+(\/|$)/

/**
 * Documentation files that are tooling, not design record.
 *
 * `docs/` cannot be excluded wholesale: cairn keeps its stack decisions in
 * `docs/PLAN.md`, which is exactly the kind of file the ranking below rewards.
 * What deserves exclusion is docs-site scaffolding — a VitePress/Docusaurus
 * config, a sidebar, an HTML shell.
 */
const DOCSITE_FILE_RE = /(^|\/)(docs?|website|site)\/([^/]*\.(html|css|scss|js|ts|json|yml|yaml)|\.vitepress|\.docusaurus|_sidebar\.md|index\.md)$/i

// ---------------------------------------------------------------------------
// Architecture file selection
//
// Three designs have been tried here, and the first two failed for the same
// reason — both guessed at *content* from *names*:
//
//   1. Path-name heuristic (a name-hint list plus a depth bonus). Kept floating
//      unpredictable metadata to the top: `.cljfmt.edn`, `.envrc`,
//      `AppxManifest.xml`, `.claude/skills/**/SKILL.md`. Every fix was an
//      enumeration, and the next unanticipated file won anyway (excluding
//      `.github/` promoted `.claude/`).
//   2. README-driven selection (read the README, follow the paths it names).
//      Measured on five real repos: three unchanged, one worse. READMEs link
//      outward (`[README](https://github.com/...)`) and describe *what* the
//      project is, not *where* the code lives; only Cairn named a real path
//      (`docs/PLAN.md`), and it was the only repo that improved.
//
// The current design uses a structural signal that neither needs nor guesses at
// names: **source density per directory**. The repository tree already says
// which directory is the product. Measured on the same five repos, siyuan's
// `kernel/` is all `.go` while `app/appx/` holds two `.xml` files, and logseq's
// `src/` is all `.cljs` while `android/` is Gradle packaging — visible in the
// tree without reading a single file.
//
// Directory choice alone was not enough, though. A first version of this
// density rule kept picking `app/src-tauri/Cargo.toml` for cairn because a
// sub-package manifest scored as a manifest; source density has to decide
// *where* to look, and the file ranking inside must then prefer code over
// manifests. Both halves are load-bearing.
// ---------------------------------------------------------------------------

/**
 * Selector contract version. Bump on ANY change that can move which paths are
 * picked: a new exclusion, a changed density signal, a reordered tie-break, a
 * different `maxFiles` interpretation.
 *
 * `src/index.ts` writes this into the inspect cache key, because that cache
 * stores the RESULT of this function. A cached answer produced by the previous
 * selector is an answer to a different question; replaying it would present a
 * stale pick as this selector's judgement — including, worst case, a pick the
 * current rules exist to prevent.
 *
 * Same idea as `SEARCH_PLAN_VERSION` in `types.ts`: when the contract moves, the
 * entries must expire by themselves rather than by someone remembering to clear
 * a directory.
 *
 * Version 2, and why three changed rules are one bump rather than three.
 *
 * Three rules in this file move which paths are picked: the soft exclusions that
 * replaced outright deletion, `java`/`cs` becoming entry-point extensions, and
 * the zero-source fallback that spends a slot on code. By the contract above,
 * each one is a bump on its own. They are covered by a single bump to 2 because
 * they landed together: the version names the RULES, not the edits, and no
 * caller can observe an intermediate state that had one of them and not the
 * others.
 *
 * The bump is not free to skip just because the plugin is unreleased. The stamp
 * reaches both the cache key and the stored metadata (`sel:2:scan:N`), so the
 * moment a build of the pre-change selector exists anywhere outside this working
 * tree — a packed tarball, a second clone, a fixture that outlives the branch —
 * a version-1 entry and a version-2 answer share one key and the replay is
 * silent. The worst case is exactly the one these changes exist to prevent: a
 * repository whose product sits under a soft-excluded path has a cached pick
 * that omits that product, and replaying it would present the old defect as this
 * selector's judgement. A bump with no stale entry costs nothing; a missing bump
 * with one costs a wrong answer that looks right.
 */
export const SELECTOR_VERSION = 2

/**
 * Pick the files most likely to explain how a project is built.
 *
 * Exported for tests. This function absorbed three rewrites and three real
 * defects, and for a long time it had NO automated coverage — the tests
 * asserted that certain strings appeared in the source instead of calling it.
 * A source-text assertion passes while the picks get worse, which is exactly
 * what happened. It is a pure function over `entries`, so it is testable
 * directly and now is.
 *
 * @param entries - blobs and trees from the repository.
 * @param maxFiles - how many paths to return.
 * @returns repository-relative paths, best first.
 */
export function pickArchitectureFiles(
  entries: Array<{ path: string; type: string }>,
  maxFiles: number,
): string[] {
  const cap = Math.max(0, maxFiles)
  if (cap === 0) return []

  // Two different claims live in this filter, and only one of them justifies
  // deletion.
  //
  // DELETED: files that are not architecture in ANY repository — binaries,
  // images, fonts, archives, lockfiles, legal text, changelogs, dotfile configs,
  // dot-directories, docs-site scaffolding. This is a general rule, not a
  // per-repo enumeration — the lesson from three rounds of the checker reporting
  // PASS while picks got worse. None of these becomes the right answer by being
  // the only thing left: a tree of nothing but `logo.png` and `LICENSE` has no
  // architecture to read, and returning nothing is the honest answer there.
  //
  // KEPT, and merely charged for: `PLATFORM_SHELL_RE` and `JUNK_DIR_RE`. Those
  // two are claims about RANK rather than about kind, so their matches stay in
  // the candidate list and pay points instead — see
  // `PLATFORM_SHELL_DIR_FACTOR` for the measured failure that forced the change.
  const blobs = entries.filter((entry) => {
    if (entry.type !== 'blob') return false
    const lower = entry.path.toLowerCase()
    // Structural: any dot-prefixed directory segment, not an enumeration of names.
    if (DOT_DIR_RE.test(entry.path)) return false
    if (DOCSITE_FILE_RE.test(entry.path)) return false
    if (isDotfileConfig(entry.path)) return false
    if (/\.(png|jpe?g|gif|svg|ico|webp|bmp|woff2?|ttf|otf|eot|pdf|zip|tar|gz|mp4|mov|lock|map|min\.js)$/i.test(lower)) return false
    if (/(^|\/)(license|licence|copying|notice|authors|codeowners)(\.(md|txt|rst))?$/i.test(lower)) return false
    if (/(^|\/)(changelog|changes|history)\.(md|rst|txt)$/i.test(lower)) return false
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock)$/i.test(lower)) return false
    if (isNonArchFile(entry.path)) return false
    if (isTranslatedReadme(entry.path)) return false
    return true
  })

  // -- Step 1: which directory holds the product? --------------------------
  // Group by top-level segment, then by the directory holding the file. A
  // directory's density is the share of its files that are source code; its
  // size is how many files it holds. Both matter: `kernel/` is dense, and it
  // must also be large enough to be the product rather than a stray utility.
  const byDir = new Map<string, { total: number; source: number }>()
  for (const entry of blobs) {
    const segments = entry.path.split('/')
    // Attribute a file to its immediate directory, which is what the density
    // question is about.
    const dir = segments.slice(0, -1).join('/')
    const bucket = byDir.get(dir) ?? { total: 0, source: 0 }
    bucket.total += 1
    if (SOURCE_EXT_RE.test(entry.path)) bucket.source += 1
    byDir.set(dir, bucket)
  }

  // Roll sub-directories up to their top-level segment, so `kernel/model/` and
  // `kernel/util/` count toward `kernel/`.
  //
  // But scoring only top-level segments hides a workspace core behind a shell:
  // cairn's `app/` (Tauri wrapper) outscored `crates/` (all the logic), because
  // `app/src` and `app/src-tauri` are both dense and roll up into one entry.
  // So sub-directories are scored too, and a workspace-member name (`crates/`,
  // `packages/`) gets its own bonus — those are, by convention, where monorepo
  // logic lives.
  const byTop = new Map<string, { total: number; source: number }>()
  for (const [dir, bucket] of byDir) {
    const top = dir.split('/')[0] ?? ''
    const key = top.length === 0 ? '.' : top
    const acc = byTop.get(key) ?? { total: 0, source: 0 }
    acc.total += bucket.total
    acc.source += bucket.source
    byTop.set(key, acc)
  }

  const WORKSPACE_DIR_RE = /^(crates?|packages?|modules?|libs?|workspaces?)$/i
  // A directory that wraps the real code rather than being it: `app/` in cairn
  // holds a Svelte frontend and a Tauri shell, while everything of substance is
  // in `app/crates/`. Used only to decide whether a nested workspace candidate
  // is worth scoring.
  const SHELL_DIR_RE = /^(app|apps|desktop|client|frontend|ui)$/i
  const coreCandidates = [
    ...[...byTop.entries()].map(([dir, bucket]) => ({ dir, bucket, sub: false })),
    // Sub-directories, but only where they name a workspace *and* sit under a
    // shell. Scoring every nested directory let `kernel/model/` compete with
    // `kernel/`; scoring every nested workspace name was too loose in the other
    // direction and broke Tauri repos.
    //
    // Measured: with `lib` counted, Easy-MD's coreSet became `src/lib, src` —
    // `src/lib` scores 1.485 (density 1.000 x the conventional-name bonus) and
    // takes a slot from `src`, evicting `src-tauri` (0.852) entirely. Slot 3
    // then has no core-directory native entry to pick, so a Tauri project looks
    // like a pure frontend one. note-gen failed identically (`src/lib, src`).
    // Requiring a shell parent keeps cairn's `app/crates` while dropping
    // `src/lib`, `src/packages` and the rest of the in-tree layout noise.
    ...[...byDir.entries()]
      .filter(([dir]) => {
        const segments = dir.split('/')
        return segments.length === 2
          && WORKSPACE_DIR_RE.test(segments[1] ?? '')
          && SHELL_DIR_RE.test(segments[0] ?? '')
      })
      .map(([dir, bucket]) => ({ dir, bucket, sub: true })),
  ]

  const coreDirs = coreCandidates
    .map(({ dir, bucket, sub }) => {
      const density = bucket.source / Math.max(1, bucket.total)
      const leaf = dir.split('/').pop() ?? dir
      // Density is a RATIO, not a ratio times a size bonus. An earlier version
      // multiplied by `log2(1 + source)`, which rewarded file count — and that
      // is precisely what let logseq's `android/` (many Kotlin files) outrank
      // its ClojureScript `src/`, and cairn's Tauri shell `app/` outrank
      // `crates/`. File count breaks ties only.
      //
      // A conventional source-directory name gets a small bonus so that a
      // near-tie (logseq: deps 0.910 vs src 0.897) resolves toward `src`
      // rather than toward whichever side tool happens to be denser.
      let score = density
      if (CONVENTIONAL_SRC_DIR_RE.test(leaf)) score *= 1.1
      // Workspace members hold the logic in a monorepo, and they are routinely
      // outnumbered by the shell that wraps them: cairn's `crates/` (17 source
      // files, the whole engine) sits under `app/` (126 files, a Tauri shell).
      // The bonus has to exceed the shell's raw density lead (0.940 vs 0.739).
      if (WORKSPACE_DIR_RE.test(leaf)) score *= 1.35
      // The soft exclusions, as a factor on the density score rather than as a
      // deletion from `blobs`. Tested against the candidate DIRECTORY, which is
      // what `PLATFORM_SHELL_RE`/`JUNK_DIR_RE` are about — both match at any
      // depth, so `android/app/src/main/java` is charged for its `android`
      // segment exactly like `android/` is.
      //
      // Order matters only in that both can apply (`scripts/` in a
      // `node_modules/` tree): they multiply, so the charges compose instead of
      // one silently winning.
      if (PLATFORM_SHELL_RE.test(dir)) score *= PLATFORM_SHELL_DIR_FACTOR
      if (JUNK_DIR_RE.test(dir)) score *= JUNK_DIR_DIR_FACTOR
      return { dir, score, density, source: bucket.source, sub }
    })
    .filter(item => item.source >= 2)
    .sort((a, b) => (b.score - a.score) || b.source - a.source || a.dir.localeCompare(b.dir))

  // Keep the two densest directories. One is too few for a Tauri-shaped repo
  // where frontend `src/` and Rust `src-tauri/` are co-equal; three let
  // logseq's `android/` through, which is now excluded by PLATFORM_SHELL_RE
  // instead — the correct place to solve it.
  const coreSet = new Set(coreDirs.slice(0, 2).map(item => item.dir))

  // Whether a path sits in a core directory. Checked at both levels so a
  // workspace core scored as `app/crates` still matches `app/crates/...`.
  const inCore = (path: string): boolean => {
    const segments = path.split('/')
    if (coreSet.has(segments[0] ?? '')) return true
    if (segments.length >= 2 && coreSet.has(`${segments[0]}/${segments[1]}`)) return true
    return false
  }

  // -- Step 2: rank files, preferring code inside the core directory -------
  const scored = blobs.map((entry) => {
    const lower = entry.path.toLowerCase()
    const isRoot = !entry.path.includes('/')
    let score = 0

    if (inCore(entry.path)) score += 60
    // Root-level manifests state the whole project's stack, and are cheap and
    // dense with signal: logseq's `deps.edn` names DataScript and the
    // ClojureScript version in twenty lines. Raised above the core-directory
    // bonus so a root manifest is always read.
    if (MANIFEST_RE.test(entry.path)) score += isRoot ? 65 : 5
    if (SOURCE_EXT_RE.test(entry.path)) score += 20
    // Entry points: the file the program starts from.
    //
    // `program` is here because C# names its entry point `Program.cs`, not
    // `Main.cs` — the language puts the `Main` method INSIDE a file called
    // `Program`, so a name list built from `main` alone never matches the one
    // file a C# reader opens first. `Program.cs` did reach the pick before this
    // was added, but only through the flat remaining-slots ranking, which is to
    // say by not being eliminated: it earned no entry-point score, so it lost
    // to any deeper file that did, and a repository with two such files showed
    // neither.
    if (/(^|\/)(main|program|index|app|mod|lib|entry|handler|server|start)\.(ts|tsx|js|jsx|mjs|rs|go|py|java|cs|clj|cljs|cljc|vue|svelte)$/i.test(lower)) score += 15
    // Docs that record design decisions are genuinely architectural.
    const isDesignRecord = /(^|\/)(plan|design|architecture|codebase_overview|overview)\.md$/i.test(lower)
    if (isDesignRecord) score += 25
    // A README earns one slot: it is the fastest way to know what this is.
    if (/^readme\.md$/i.test(lower)) score += 40
    // Nested manifests describe sub-packages, not the product.
    if (MANIFEST_RE.test(entry.path) && !isRoot) score -= 10
    // `TOOLING_SEGMENT_RE` lists `docs?` among the tooling directories, which is
    // right for docs-site scaffolding and wrong for a design record — and the
    // `DOCSITE_FILE_RE` comment above already states that `docs/` must not be
    // excluded wholesale *because* cairn keeps its stack decisions in
    // `docs/PLAN.md`. Charging the penalty there scored PLAN.md at 8 against
    // the root Cargo.toml's 64, so the file the ranking exists to reward never
    // won its slot. A design record is exempt from the tooling penalty; every
    // other file under `docs/` still pays it.
    if (TOOLING_SEGMENT_RE.test(entry.path) && !isDesignRecord) score -= 15
    // The two soft exclusions, charged against the FILE rather than deleting it.
    // The constants above were declared for exactly this and must be applied
    // here: `PLATFORM_SHELL_RE`/`JUNK_DIR_RE` are claims about rank, so their
    // files stay in the candidate list and pay points. Deleting them here would
    // re-introduce the defect the constants exist to prevent — an Android app or
    // a Python CLI under `scripts/` would again be invisible, with no trace.
    //
    // Charged AFTER the bonuses so a soft-excluded file that is genuinely the
    // best evidence (the only entry point, the only manifest) can still win the
    // slot defined by being one; the penalty is deliberately smaller than a
    // category's bonus. See the constants for the calibration.
    if (PLATFORM_SHELL_RE.test(entry.path)) score -= PLATFORM_SHELL_FILE_PENALTY
    if (JUNK_DIR_RE.test(entry.path)) score -= JUNK_DIR_FILE_PENALTY
    // Shallower files sit closer to the entry point.
    score -= entry.path.split('/').length
    return { path: entry.path, score }
  })

  const ranked = scored.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path))

  // Slots are allocated BY CATEGORY, not by one flat score ranking.
  //
  // A single ranking was tried and it kept producing lopsided picks: whichever
  // category happened to have the most shallow files took all the slots
  // (logseq got three `.cljs` files and no `deps.edn`; Easy-MD got three
  // frontend files and nothing from `src-tauri`). Raising a category's score
  // does not fix that — it just moves which category sweeps the slots.
  //
  // Reading a codebase to judge borrow-worthiness needs to answer four
  // questions, so each gets a slot:
  //   1. what is this?          -> the ROOT README
  //   2. where does it start?   -> a frontend entry point in a core dir
  //   3. what backs it?         -> a backend/native entry point
  //   4. what is it built on?   -> a manifest or a design doc
  //
  // Slot 3 exists because Tauri-shaped projects are the common case here:
  // Easy-MD is `src/` (Vue) + `src-tauri/` (Rust), note-gen the same, and cairn
  // is `app/src` (Svelte) + `crates/` (Rust). With only three slots the backend
  // was always the one dropped — the single fact most needed to judge a stack.
  // `shallow.maxFiles` is 4 to match.
  //
  // Slot 1 is the ROOT README specifically. A nested `README.md` is not the same
  // artifact: logseq has one in `src/main/frontend/persist_db/`, and siyuan has
  // one inside a vendored HEIF decoder (`kernel/heif/internal/h265heic/`).
  // Matching on basename alone picked those over the project's own README,
  // because a core-directory path outscores a root-level one.
  const isRootReadme = (p: string): boolean => /^readme\.md$/i.test(p)
  const isDesignDoc = (p: string): boolean => /(^|\/)(plan|design|architecture|codebase_overview|overview)\.md$/i.test(p)
  const isManifestPath = (p: string): boolean => MANIFEST_RE.test(p)
  // `java` and `cs` were missing from the extension alternation while
  // `NATIVE_EXT_RE` below has always contained them, so a Java or C# project's
  // `Main.java` / `Program.cs` was source the native branch could never reach:
  // slot 3 asks for "a backend/native entry point" and answered "none" on a
  // repository made of nothing else. Measured on the Android design tree
  // (`android/app/src/main/java/{App,Service}.java`), which had no file the
  // function would name an entry point at all.
  //
  // `program` is here for the same reason it is in the scoring pass: C# puts its
  // `Main` method inside `Program.cs`, so without the name a C# project has no
  // file this function will call an entry point at all, and slot 3 answers
  // "none" for a repository that is nothing but one.
  //
  // Keep this alternation and the identical one in the scoring pass above in
  // step: the score decides WHICH entry point wins, this decides WHETHER one
  // exists, and a language present in one but not the other makes the pair
  // disagree about the same file.
  const isEntryPoint = (p: string): boolean =>
    /(^|\/)(main|program|index|app|mod|lib|entry|handler|server|start)\.(ts|tsx|js|jsx|mjs|rs|go|py|java|cs|clj|cljs|cljc|vue|svelte)$/i.test(p)

  // Frontend vs backend is decided by file extension, the only reliable signal
  // available without reading the file. Rust/Go/etc. are the native side.
  const NATIVE_EXT_RE = /\.(rs|go|c|cc|cpp|h|hpp|cs|java|kt|swift|py|rb|php|ex|exs|erl|hs|ml|scala|dart|lua)$/i
  const isNativeEntry = (p: string): boolean => isEntryPoint(p) && NATIVE_EXT_RE.test(p) && inCore(p)
  const isWebEntry = (p: string): boolean => isEntryPoint(p) && !NATIVE_EXT_RE.test(p) && inCore(p)

  const picked: string[] = []
  // Returns true when the predicate claimed a slot, so callers can express a
  // fallback. The earlier `void` version could not: slot 3 called `take` twice
  // in a row and BOTH fired, so Easy-MD and note-gen spent slot 4 on
  // `src-tauri/src/main.rs` and never read `package.json` at all.
  const take = (predicate: (p: string) => boolean): boolean => {
    for (const item of ranked) {
      if (picked.length >= cap) return false
      if (picked.includes(item.path)) continue
      if (!predicate(item.path)) continue
      picked.push(item.path)
      return true
    }
    return false
  }

  // Which core directory a path belongs to, for coverage checks below.
  const coreDirOf = (path: string): string => {
    const segments = path.split('/')
    if (segments.length >= 2 && coreSet.has(`${segments[0]}/${segments[1]}`)) return `${segments[0]}/${segments[1]}`
    return segments[0] ?? ''
  }

  if (cap >= 1) take(isRootReadme)
  if (cap >= 2) take(isWebEntry)
  // Slot 3 prefers a core directory slot 2 did not already cover.
  //
  // Without that, slots 2 and 3 can both land in the same directory, starved by
  // nothing but the alphabetical tie-break: cairn's seven core native entries
  // all score exactly 91, so `app/src-tauri/src/lib.rs` beat
  // `crates/cairn-core/src/lib.rs` on `localeCompare` alone. `crates/` holds 17
  // source files — the entire engine — and got no slot at all, while the card
  // showed two files from `app/`.
  //
  // The preference is soft: when no other core directory has a native entry
  // (note-gen's core dirs are `src` and `src-tauri`, and slot 2 already took
  // `src`), the preference claims nothing and the plain flat ranking decides.
  const coveredBySlot2 = picked.length >= 2 ? coreDirOf(picked[1] ?? '') : ''
  if (cap >= 3) {
    const claimed = coveredBySlot2 !== '' && take(p => isNativeEntry(p) && coreDirOf(p) !== coveredBySlot2)
    if (!claimed) take(isNativeEntry)
  }
  if (cap >= 4) take(p => isManifestPath(p) || isDesignDoc(p))
  // Remaining slots (deep mode) and any category that came up empty.
  for (const item of ranked) {
    if (picked.length >= cap) break
    if (picked.includes(item.path)) continue
    picked.push(item.path)
  }

  // -- Zero-source fallback ------------------------------------------------
  //
  // Slots 1 and 4 are prose by construction — the root README, and a manifest or
  // a design doc — so a repository whose code sits under a soft-excluded path,
  // or merely below everything else in the ranking, can spend all four slots on
  // README plus manifests and answer "what is this built on?" while never showing
  // a line of the product. That is the failure the three design trees were
  // measured on: an Android app and a Python CLI each read as a README and a
  // manifest, and the agent called that the architecture.
  //
  // The budget is frozen, so the fallback cannot add a fifth file: it spends a
  // slot that is already taken, evicting the WEAKEST claim in the pick. The root
  // README is never evicted — slot 1 answers "what is this?", which no source
  // file answers, and at `cap` 1 the README is the whole answer by design
  // (`shallow.maxFiles` is 4, so that is an edge only a direct caller can ask
  // for). Every other non-source pick can be re-derived once code is in hand,
  // which is exactly why those are the ones at risk.
  //
  // The replacement is the top of `ranked` that is not already picked, so the
  // same priorities the slots use choose it: core directory, entry point,
  // shallowness. Extensions need no separate ordering — `SOURCE_EXT_RE` already
  // gates membership, and a language nobody has written yet is still source.
  //
  // What this does NOT do is invent a source file. When every candidate really
  // is prose, `ranked` holds no source path, nothing is evicted, and the pick
  // stands: a manifest-only repository is a real repository. It also cannot
  // resurrect a deleted file, because the candidate list is `blobs` after the
  // filter — a tree of nothing but `logo.png` and `LICENSE` still picks nothing.
  // Keeping the soft-excluded paths as candidates is what makes the pick
  // non-empty on a tree whose only code is under `android/` or `scripts/`; this
  // block is what makes the pick contain source when the ranking alone would not.
  if (!picked.some(path => SOURCE_EXT_RE.test(path))) {
    const replacement = ranked.find(item => !picked.includes(item.path) && SOURCE_EXT_RE.test(item.path))
    if (replacement !== undefined) {
      // `ranked` is sorted best-first, so the LAST pick in it is the weakest.
      const rankOf = new Map(ranked.map((item, index) => [item.path, index]))
      let weakest = -1
      for (let i = 0; i < picked.length; i++) {
        const path = picked[i]
        if (path === undefined || isRootReadme(path)) continue
        if (weakest === -1 || (rankOf.get(path) ?? 0) > (rankOf.get(picked[weakest] ?? '') ?? 0)) weakest = i
      }
      if (weakest !== -1) picked[weakest] = replacement.path
    }
  }

  return picked
}

/** What a repository tree proves about a repository, counted rather than judged. */
export interface TreeEvidence {
  /** Total entries seen in the tree, truncated or not. */
  entries: number
  /** True when GitHub cut the listing short, so absence proves nothing. */
  truncated: boolean
  /** Every top-level directory, alphabetically. Not capped — see `treeEvidence`. */
  topDirs: string[]
  /** Files whose extension looks like source. */
  sourceFiles: number
  /** Files whose path or name looks like a test. */
  testFiles: number
  /** Manifests present, by path. */
  manifests: string[]
  /**
   * Manifests sitting at the repository root, by path.
   *
   * Separate from `manifests` because the two answer different questions, and
   * the first version of this block only had `manifests` — which on logseq
   * listed 29 paths (`deps/x/package.json` ten times over) in 669 characters,
   * 11% of the whole payload, saying nothing. The count is evidence that a repo
   * is real; the root manifest is evidence of what it is built with. Both are
   * kept, and the renderer shows the count plus the root set rather than
   * dumping every nested manifest.
   */
  rootManifests: string[]
}

/**
 * Extensions that indicate source, for the evidence count only.
 *
 * Deliberately NOT the `SOURCE_EXT_RE` declared above. That one drives the
 * selector's density score, where a wrong extension moves a file into or out of
 * the four slots, so it stays narrow to what live repos were measured on. This
 * one answers a different question — "is there code in here at all" — and is
 * wider on purpose: a Kotlin, R or Zig repository is still a repository, and
 * undercounting its files would understate it.
 */
const EVIDENCE_SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|go|rs|py|rb|java|kt|kts|swift|cs|c|cc|cpp|h|hpp|m|mm|scala|clj|cljs|cljc|edn|ex|exs|erl|hs|ml|fs|dart|php|lua|pl|r|jl|zig|nim|v|sql|sh|ps1|bat)$/i

/**
 * Files that indicate tests, matched at any depth.
 *
 * Deliberately whole-tree rather than top-level: probing live repos showed a
 * top-level-only check reporting "no tests" for logseq (which keeps them in
 * `cli-e2e/`) and for siyuan (which keeps `*.test.ts` beside its sources). A
 * check that answers "no tests" for repos that have thousands of them is worse
 * than no check, because the agent would report it as evidence.
 *
 * The rule is a name test, so it is stated as one: a file counts as a test when
 * its basename contains `test` or `spec` as a word, or when it sits in a
 * `test`/`tests`/`spec`/`__tests__`/`e2e` directory. It does not claim to find
 * every test in every language — only that a positive count is real evidence.
 */
export function isTestPath(path: string): boolean {
  const segments = path.split('/')
  const base = segments[segments.length - 1] ?? ''
  if (segments.slice(0, -1).some(seg => /^(tests?|specs?|__tests__|e2e)$/i.test(seg))) return true
  return /(^|[._-])(tests?|specs?)([._-]|$)/i.test(base)
}

/**
 * Count what a repository tree proves, using entries that were already fetched.
 *
 * This exists because of a gap stated in docs/DELIVERY.md: the agent judges a
 * repo from its description and topics, which are the two most gameable fields
 * on GitHub, and after the tail search admitted low-star repos those
 * descriptions are often empty. The intended remedy was "check the claims
 * against the source", and four probe rounds narrowed what that can honestly
 * mean:

 *   - Scanning README prose for claim words does not work. Probed live, every
 *     hit was boilerplate: "support" matched a table-of-contents link titled
 *     `#-support-logseq-development`, "api" matched a badge URL, "sync" matched
 *     an FAQ heading. A tool that reported those as claims would be lying in a
 *     confident voice.
 *   - A top-level test-directory check does not work (see `isTestPath`).
 *   - Checking "the tree" was impossible because the agent did not receive it:
 *     the summary was `[...dirs].slice(0, 20)`, truncated, unsorted, and with no
 *     marker — logseq's list stopped alphabetically at `ios` and looked
 *     complete.
 *
 * What does work is counting. Every field here is a counted fact over the same
 * entry list the caller already paid for, so it costs no extra request, and
 * every number is reproducible by anyone who fetches the same tree. Nothing is
 * inferred, weighted, or scored: the agent still has to decide what the numbers
 * mean for its idea, which is the part only a model can do.
 *
 * @param entries - tree entries, as returned by `getTree`.
 * @param truncated - whether GitHub cut the listing short.
 * @returns counted evidence. Absence of a signal is not evidence of absence
 *   when `truncated` is true, and the renderer says so.
 */
export function treeEvidence(entries: Array<{ path: string }>, truncated: boolean): TreeEvidence {
  const topDirs = new Set<string>()
  let sourceFiles = 0
  let testFiles = 0
  const manifests: string[] = []
  const rootManifests: string[] = []

  for (const entry of entries) {
    const path = entry.path
    const segments = path.split('/')
    // A top-level directory is any path with a separator; the root file case
    // (`README.md`) has one segment and contributes no directory.
    if (segments.length > 1 && segments[0] !== undefined && segments[0].length > 0) topDirs.add(segments[0])
    if (EVIDENCE_SOURCE_EXT_RE.test(path)) sourceFiles++
    if (isTestPath(path)) testFiles++
    if (MANIFEST_RE.test(path)) {
      manifests.push(path)
      if (segments.length === 1) rootManifests.push(path)
    }
  }

  return {
    entries: entries.length,
    truncated,
    // Not capped. The cap was the bug: the caller could not tell "this repo has
    // 20 top-level directories" from "this repo has 20 of them and more".
    topDirs: [...topDirs].sort(),
    sourceFiles,
    testFiles,
    manifests,
    rootManifests,
  }
}

