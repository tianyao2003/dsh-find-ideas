// PROPERTY test: the query planner never throws, and the tool never answers with
// a stack trace, for ANY idea.
//
// WHY THIS FILE EXISTS
// --------------------
// The 637-assertion suite did not catch a defect that reached users five times
// out of twelve. Every test it had asked about plans the authors had already
// thought of; nothing asked the planner to survive input nobody had chosen.
//
// The specific miss is worth naming, because it is a property of how the suite
// grew rather than an oversight: the frozen eval cases are the ideas the lexicon
// was extended to cover (`图片批量压缩` was added to LEXICON *because* a case
// needed it — see the note in `lexicon.ts`). So the frozen suite measures the
// vocabulary and the vocabulary was grown to satisfy the suite. No case in it can
// land outside the lexicon, which is precisely where the crash lived.
//
// WHAT IS ASSERTED
// ----------------
// Three properties, over every input this file can build:
//
//   1. NO THROW.        `planQueries` returns a plan for every input, including
//                       the ones that used to throw (measured: 5 of 12 natural
//                       Chinese ideas) and the ones built by sampling LEXICON.
//   2. A LEGAL PLAN.    At most MAX_QUERIES slots, each with a known role, each
//                       with a non-empty query, and no duplicate (query, sort).
//                       A plan that is returned must be one the fetch layer can
//                       actually run.
//   3. A REACHABLE TAIL. When a tail slot exists, it must not AND several CJK
//                       runs — that shape is a sentence fragment and matches
//                       nothing (measured: total_count 0).
//
// It runs on a FRESH CHECKOUT: no `eval/runs/`, no network, no token. That is a
// requirement, not a convenience — the frozen-run replays SKIP when their
// fixtures are absent, so on a clean clone (which is what CI is) they verify
// nothing, and this file is the coverage that survives that.
//
// Run with:  npm test
// Or directly: node test/planner-properties.test.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { MAX_QUERIES, planQueries, isTailReachable } = await load('query.js')
const { LEXICON } = await load('lexicon.js')

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ''}`)
  }
}

/** Assert properties 1-3 for one idea. Returns true when it held. */
function assertPlanIsLegal(idea, keywords, label) {
  let queries
  try {
    queries = planQueries(idea, keywords).queries
  } catch (error) {
    check(`${label}: planning does not throw`, false, `threw ${String(error).slice(0, 120)}`)
    return false
  }

  check(`${label}: plans at most MAX_QUERIES slots`, queries.length <= MAX_QUERIES, String(queries.length))
  check(`${label}: every slot has a known role`,
    queries.every((q) => q.role === 'anchor' || q.role === 'precise' || q.role === 'tail'),
    JSON.stringify(queries.map((q) => q.role)))
  check(`${label}: every slot has a non-empty query`,
    queries.every((q) => typeof q.query === 'string' && q.query.trim().length > 0),
    JSON.stringify(queries.map((q) => q.query)))
  check(`${label}: every slot has a sort`,
    queries.every((q) => q.sort === 'stars' || q.sort === 'updated'),
    JSON.stringify(queries.map((q) => q.sort)))

  const pairs = queries.map((q) => `${q.sort}|${q.query}`)
  check(`${label}: no duplicate (sort, query) pair`, new Set(pairs).size === pairs.length, JSON.stringify(pairs))
  check(`${label}: every tail is reachable`, queries.every(isTailReachable),
    JSON.stringify(queries.filter((q) => !isTailReachable(q)).map((q) => q.query)))

  return true
}

// ---------------------------------------------------------------------------
console.log('\n=== F1. the five ideas that used to throw now plan legally ===')
{
  // The exact inputs measured to throw on 2026-10-12, before T2. Both forms are
  // covered because the keyword form takes a different branch through
  // `buildQuery` — the crash was invisible to a caller who followed the tool
  // description and supplied English keywords, which is most callers.
  const CRASHERS = [
    '一个区块链浏览器，支持多链查询和交易追踪',
    '一个自托管的照片管理应用，支持人脸识别',
    '一个本地的视频剪辑工具，支持字幕和转场',
    '一个智能家居控制面板，支持语音助手',
    '一个开源的邮件客户端，支持多账户和加密',
  ]

  for (const idea of CRASHERS) {
    assertPlanIsLegal(idea, undefined, `no keywords: ${idea}`)
  }

  // The keyword forms, with hints a caller would plausibly supply.
  const HINTS = [
    'blockchain explorer multi-chain transaction tracking',
    'self-hosted photo management face recognition',
    'local video editor subtitles transitions',
    'smart home dashboard voice assistant',
    'open source email client multi-account encryption',
  ]
  CRASHERS.forEach((idea, i) => assertPlanIsLegal(idea, HINTS[i], `with keywords: ${idea}`))
}

// ---------------------------------------------------------------------------
console.log('\n=== F2. natural Chinese ideas outside the frozen suite ===')
{
  // The frozen eval suite cannot contain these: it is the vocabulary's own
  // exercise sheet. These are ordinary ideas whose terms are absent from
  // LEXICON — the population the crash actually lived in.
  const OUTSIDE = [
    '一个区块链浏览器，支持多链查询和交易追踪',
    '一个自托管的照片管理应用，支持人脸识别',
    '一个本地的视频剪辑工具，支持字幕和转场',
    '一个智能家居控制面板，支持语音助手',
    '一个开源的邮件客户端，支持多账户和加密',
    '一个分布式任务队列，支持失败重试和延迟执行',
    '一个家庭菜谱管理应用，支持购物清单同步',
    '一个城市骑行路线规划工具，支持海拔剖面',
    '一个播客订阅与离线收听应用，支持倍速播放',
    '一个自建的家庭影音库，支持自动刮削元数据',
    '一个本地运行的 OCR 工具，支持批量识别 PDF',
    '一个开源的家庭记账本，支持多币种和预算提醒',
  ]
  for (const idea of OUTSIDE) assertPlanIsLegal(idea, undefined, idea)

  // Every one of these is a sentence, not a keyword list: the shape that broke
  // the old tail rule (several CJK runs ANDed together match nothing).
  check('the uncovered set still contains multi-clause sentences',
    OUTSIDE.every((idea) => (idea.match(/[，,]/g) ?? []).length >= 1))
}

// ---------------------------------------------------------------------------
console.log('\n=== F3. structural fuzz over the real vocabulary ===')
{
  // Sample LEXICON itself, so the fuzz speaks the plugin's own language rather
  // than a synthetic one. Modifier + core + rare is the shape the lexicon is
  // designed around, and the crash lived in the shapes it does NOT cover.
  const byRole = { modifier: [], core: [], rare: [] }
  for (const [term, entry] of Object.entries(LEXICON)) byRole[entry.role].push(term)

  check('the lexicon has all three roles populated',
    byRole.modifier.length > 0 && byRole.core.length > 0 && byRole.rare.length > 0,
    JSON.stringify({ m: byRole.modifier.length, c: byRole.core.length, r: byRole.rare.length }))

  // Words the lexicon does NOT know — the population that used to crash. Real
  // Chinese project vocabulary, deliberately NOT added to LEXICON.
  const UNCOVERED = ['摄影后期', '骑行导航', '菜谱管理', '播客订阅', '影音刮削', '票据识别', '宠物健康', '乐器练习']

  // A deterministic sweep: every modifier against a fixed core, then every core
  // against a fixed modifier. Deterministic so a failure is reproducible from the
  // label alone — a fuzz that fails once and cannot be re-run is a rumour.
  for (const mod of byRole.modifier) {
    assertPlanIsLegal(`${mod}笔记应用`, undefined, `modifier sweep: ${mod}`)
    assertPlanIsLegal(`一个${mod}的笔记应用`, undefined, `modifier sweep (一个…的): ${mod}`)
  }
  for (const core of byRole.core) {
    assertPlanIsLegal(`本地优先的${core}`, undefined, `core sweep: ${core}`)
    assertPlanIsLegal(`一个${core}`, undefined, `core sweep (一个): ${core}`)
  }

  // The cross product that matters: a FULLY covered idea ANDed with an uncovered
  // clause. This is the shape of every natural Chinese idea, and the shape that
  // used to produce a tail with several CJK runs.
  let combos = 0
  for (const mod of byRole.modifier.slice(0, 8)) {
    for (const core of byRole.core.slice(0, 8)) {
      for (const unknown of UNCOVERED) {
        assertPlanIsLegal(`一个${mod}的${core}，支持${unknown}`, undefined, `combo: ${mod}/${core}/${unknown}`)
        combos++
      }
    }
  }
  check('the cross product actually ran', combos === 8 * 8 * UNCOVERED.length, String(combos))

  // Rare terms are the constraint half and the fourth role in the lexicon. They
  // are ANDed into the narrow channel, which is where a dead tail came from.
  for (const rare of byRole.rare) {
    assertPlanIsLegal(`本地优先的笔记应用，支持${rare}`, undefined, `rare sweep: ${rare}`)
    assertPlanIsLegal(`一个${rare}工具`, undefined, `rare-only: ${rare}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== F4. degenerate and adversarial input ===')
{
  // A planner that survives real ideas but dies on an empty string is still a
  // crash. These are the inputs no user means to send and every user can produce
  // (a paste that went wrong, a tool call with an empty field, a truncated idea).
  const DEGENERATE = [
    '', ' ', '   ', '\n', '\t', '。', '、、、', '!!!', '???', '...', '---',
    '一个', '的', '支持', '本地优先',
    'a', 'ab', '12345678901234567890',
    '🎯', '🎯🎯🎯', '你好👋世界',
    '\u0000', '\u200b', '\uFEFF',
    '，'.repeat(50), 'a'.repeat(500), '中'.repeat(200),
    '本地优先的笔记应用，支持双向链接，支持标签，支持筛选，支持全文搜索，支持导出',
    ' english ', 'LOCAL-FIRST MARKDOWN NOTE APP',
  ]
  for (const idea of DEGENERATE) {
    assertPlanIsLegal(idea, undefined, `degenerate: ${JSON.stringify(idea).slice(0, 40)}`)
  }

  // A hint that is empty, whitespace, punctuation or another language must not
  // change the contract either — `keywords` takes a different path through the
  // planner, and an empty hint is what a sloppy tool call sends.
  for (const keywords of ['', ' ', '、、、', '🎯', '本地优先的笔记应用', 'a']) {
    assertPlanIsLegal('一个区块链浏览器，支持多链查询和交易追踪', keywords,
      `degenerate keywords: ${JSON.stringify(keywords)}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== F5. the plan is deterministic ===')
{
  // The eval harness pins this for the frozen cases ("plan determinism: each case
  // is planned 20 times and must agree"), because a plan that varies run to run
  // makes every downstream measurement unreproducible. The property is asserted
  // here for inputs the harness cannot reach.
  const IDEAS = [
    '一个区块链浏览器，支持多链查询和交易追踪',
    '本地优先的笔记应用，支持双向链接',
    '一个轻量级的看板工具',
    'a local-first markdown note-taking app with bidirectional links',
    '',
  ]
  for (const idea of IDEAS) {
    const first = JSON.stringify(planQueries(idea).queries)
    let stable = true
    for (let i = 0; i < 20; i++) {
      if (JSON.stringify(planQueries(idea).queries) !== first) stable = false
    }
    check(`the plan is stable across 20 runs (${JSON.stringify(idea).slice(0, 30)})`, stable, first.slice(0, 120))
  }
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
