/**
 * CJK → English search-term lexicon.
 *
 * ## Why this exists
 *
 * A Chinese idea cannot reach the repositories it is looking for. Measured:
 *
 *   本地优先的笔记应用，支持双向链接   -> pool = 1 repo, 0 stars
 *   personal knowledge management     -> 1,435 matches, 9 on-topic anchors
 *   个人知识管理工具，双向链接，本地存储 -> pool = 18 repos, best 4 stars
 *
 * The cause is a language-domain mismatch, not a query bug: logseq, siyuan,
 * Trilium, memos and foam all describe themselves in **English**, so no CJK
 * query can reach them at any precision. `本地优先的` matches Chinese-language
 * repos that merely contain those characters (measured: 15 matches, of which the
 * top six are a book list, three political-document mirrors and an anime repo — * zero note-taking projects).
 *
 * ## The recipe, and why it is shaped this way
 *
 * Measured on three failing ideas (`scripts/probes/recipe.mjs`), 15 candidate queries:
 *
 *   本地优先的笔记应用，支持双向链接
 *     local-first notes               2 words   3,092 matches   5 anchors (Trilium 38k)
 *     local-first note-taking         2 words     758 matches   5 anchors (siyuan 47k, logseq 45k, Trilium 38k)
 *     local-first note app            3 words     865 matches   2 anchors
 *     note app bidirectional links    4 words       8 matches   0 anchors   <- collapsed
 *
 *   个人知识管理工具，双向链接，本地存储
 *     personal knowledge management   3 words   1,435 matches   9 anchors
 *     personal knowledge management app 4 words    128 matches   3 anchors
 *     knowledge base bidirectional    3 words      48 matches   6 anchors (all <=15 stars)
 *
 * Three rules fall out, and none of them is about translation quality:
 *
 *  1. **Two or three terms.** A four-term AND collapses whenever one of the four
 *     is a rare token. `bidirectional` is rare on GitHub; ANDing it with anything
 *     takes the population to single digits.
 *  2. **Prefer the compound the projects actually use.** `note-taking` beat
 *     `notes` — same term count, but it is the string siyuan and logseq put in
 *     their own descriptions. `todo` beat `task manager` for the same reason.
 *  3. **A rare term is only rare inside an AND.** `双向链接` is a real constraint
 *     on the answer, but it cannot stand alone and it cannot join a phrase that
 *     is already three words — see the correction below, which is the one part
 *     of the first draft that measurement overturned.
 *
 * So this module returns a *seed phrase* of at most {@link MAX_SEED_WORDS} words
 * plus a {@link EnglishSeeds.narrow} channel for the constraints. It does not try
 * to translate the whole idea — that is what failed.
 *
 * ## Rule 3, corrected by measurement
 *
 * "Rare terms get their own channel" sounds right and measured wrong. Live
 * (`scripts/probes/slots.mjs`):
 *
 *   bidirectional              total 15,852   head socketio/socket.io (63,214),
 *                                              showdownjs/showdown (14,873),
 *                                              1technophile/OpenMQTTGateway (4,099),
 *                                              deepseek-ai/DualPipe (3,017)
 *   note-taking bidirectional  total 26       head Lumina-Note (917), liandi (329),
 *                                              Binder (40), baram (7), Memoria (4)
 *
 * `bidirectional` is a *common* computer-science word — sockets, Markdown
 * converters, pipeline parallelism and a Python dict library all call themselves
 * bidirectional. It is only rare **inside the AND**: `note-taking bidirectional`
 * is 26 rows and 23 of them are under 100 stars. Rareness is a property of the
 * combination, not of the token, so a rare term can never stand alone.
 *
 * Hence {@link EnglishSeeds.narrow}: the core (modifier dropped, since the
 * modifier is the least discriminating half) ANDed with the rare terms, issued
 * only when the result still fits in {@link MAX_SEED_WORDS}. When it does not
 * fit — `personal knowledge management` + `bidirectional` is four words and
 * measured **3** matches — the caller must fall back to re-issuing the seed with
 * `sort=updated`, which measured 30/30 rows under 100 stars on the same idea.
 * A four-word AND is not a narrow channel, it is an empty one.
 *
 * ## Scope
 *
 * The lexicon is deliberately a phrase table, not a word translator: Chinese
 * compounds do not decompose (`笔记应用` is not `笔记` + `应用` for search
 * purposes). Entries are added when a measurement shows they are needed, which
 * is why each role is documented rather than inferred.
 *
 * ## A one-word seed is fine, and that was checked rather than assumed
 *
 * When an idea has no modifier (`一个本地的待办事项管理工具`), the seed is the bare
 * core — one word. `query.ts` warns that "a one-word query is the wrong
 * instrument here: it matches a huge, mostly-unrelated population", so this
 * looked like a defect. Measured (`scripts/probes/oneword.mjs`, `sort=stars`):
 *
 *   todo         1,782,916 matches   head todomvc (28,953), super-productivity (22,694),
 *                                    taskbook (9,350), markor (6,246), todo.txt-cli (6,188)
 *   kanban          80,360 matches   head plane (60,622), vibe-kanban (28,312), wekan (21,112)
 *   pomodoro        83,065 matches   head pomotroid (5,535), pomatez (4,913), Catime (4,902)
 *   note-taking     52,430 matches   head AppFlowy (77,216), memos (63,658), joplin (56,655),
 *                                    siyuan (46,705), logseq (45,193)
 *
 * A large `total_count` is not the same as a bad head, and the warning is about
 * the `sort=updated` tail, where a huge population's newest slice really is
 * noise. At `sort=stars` a one-word core returns the field's biggest projects,
 * which is what an anchor channel is for. So no minimum length is imposed, and
 * no special case exists for it.
 *
 * The corollary is that a one-word seed contributes NO tail — every measured head
 * above had 0 of 30 rows under 100 stars — which is why the caller always pairs
 * the seed with a second channel rather than issuing it alone.
 */

/** How many words a seed phrase may contain. Measured ceiling: 4 collapses. */
export const MAX_SEED_WORDS = 3

/**
 * What a term is for.
 *
 * - `modifier` — a domain or property word (`local-first`, `self-hosted`). At
 *   most one survives into the seed.
 * - `core` — the noun phrase naming the thing (`note-taking`, `todo`). The seed
 *   is built around this.
 * - `rare` — a real constraint that is nonetheless too rare to AND with. Issued
 *   as its own query by the caller.
 */
export type LexRole = 'modifier' | 'core' | 'rare'

/** One lexicon entry. */
export interface LexEntry {
  /** The English search term, as it appears in GitHub descriptions. */
  readonly en: string
  /** What the term is for; see {@link LexRole}. */
  readonly role: LexRole
}

/**
 * CJK surface form → English search term.
 *
 * Keys are matched after quote-stripping and whitespace collapse. Longer keys
 * are tried first, so `笔记应用` wins over `笔记` and `个人知识管理工具` wins over
 * `知识管理`.
 */
export const LEXICON: Readonly<Record<string, LexEntry>> = {
  // --- modifiers -----------------------------------------------------------
  '本地优先的': { en: 'local-first', role: 'modifier' },
  '本地优先': { en: 'local-first', role: 'modifier' },
  '本地化': { en: 'local-first', role: 'modifier' },
  '本地存储': { en: 'local-first', role: 'modifier' },
  '自托管': { en: 'self-hosted', role: 'modifier' },
  '自部署': { en: 'self-hosted', role: 'modifier' },
  '自建': { en: 'self-hosted', role: 'modifier' },
  '离线可用': { en: 'offline', role: 'modifier' },
  '离线运行': { en: 'offline', role: 'modifier' },
  '离线': { en: 'offline', role: 'modifier' },
  '开源': { en: 'open-source', role: 'modifier' },
  '个人': { en: 'personal', role: 'modifier' },
  '轻量级': { en: 'lightweight', role: 'modifier' },
  '轻量': { en: 'lightweight', role: 'modifier' },
  '跨平台': { en: 'cross-platform', role: 'modifier' },
  '隐私优先': { en: 'privacy-first', role: 'modifier' },
  '命令行': { en: 'cli', role: 'modifier' },
  '桌面': { en: 'desktop', role: 'modifier' },
  '移动端': { en: 'mobile', role: 'modifier' },
  '实时': { en: 'realtime', role: 'modifier' },
  '分布式': { en: 'distributed', role: 'modifier' },
  '协作': { en: 'collaboration', role: 'modifier' },
  '协同': { en: 'collaboration', role: 'modifier' },

  // --- cores ---------------------------------------------------------------
  '笔记应用': { en: 'note-taking', role: 'core' },
  '笔记软件': { en: 'note-taking', role: 'core' },
  '记事本': { en: 'note-taking', role: 'core' },
  '笔记': { en: 'note-taking', role: 'core' },
  '知识管理工具': { en: 'personal knowledge management', role: 'core' },
  '个人知识管理工具': { en: 'personal knowledge management', role: 'core' },
  '个人知识管理': { en: 'personal knowledge management', role: 'core' },
  '知识管理': { en: 'personal knowledge management', role: 'core' },
  '知识库': { en: 'personal knowledge management', role: 'core' },
  '第二大脑': { en: 'personal knowledge management', role: 'core' },
  '待办事项管理工具': { en: 'todo', role: 'core' },
  '待办事项': { en: 'todo', role: 'core' },
  '待办': { en: 'todo', role: 'core' },
  '任务管理': { en: 'task manager', role: 'core' },
  '任务清单': { en: 'todo', role: 'core' },
  '日程': { en: 'calendar', role: 'core' },
  '日历': { en: 'calendar', role: 'core' },
  '时间管理': { en: 'time tracking', role: 'core' },
  '番茄钟': { en: 'pomodoro', role: 'core' },
  '习惯追踪': { en: 'habit tracker', role: 'core' },
  '日记': { en: 'journal', role: 'core' },
  '密码管理': { en: 'password manager', role: 'core' },
  '订阅管理': { en: 'subscription tracker', role: 'core' },
  '记账': { en: 'personal finance', role: 'core' },
  '财务管理': { en: 'personal finance', role: 'core' },
  '阅读器': { en: 'reader', role: 'core' },
  '阅读': { en: 'reader', role: 'core' },
  '播客': { en: 'podcast', role: 'core' },
  '书签管理': { en: 'bookmark manager', role: 'core' },
  '网盘': { en: 'file sync', role: 'core' },
  '文件同步': { en: 'file sync', role: 'core' },
  '图床': { en: 'image hosting', role: 'core' },
  '剪贴板': { en: 'clipboard manager', role: 'core' },
  '项目管理': { en: 'project management', role: 'core' },
  '看板': { en: 'kanban', role: 'core' },
  '电子表格': { en: 'spreadsheet', role: 'core' },
  '文档编辑': { en: 'document editor', role: 'core' },
  '代码编辑器': { en: 'code editor', role: 'core' },
  '静态站点': { en: 'static site', role: 'core' },
  '爬虫': { en: 'scraper', role: 'core' },
  '监控': { en: 'monitoring', role: 'core' },
  '通知': { en: 'notification', role: 'core' },
  '翻译': { en: 'translation', role: 'core' },
  '语音识别': { en: 'speech recognition', role: 'core' },
  '图像编辑': { en: 'image editor', role: 'core' },
  // Image processing. Added because `eval/cases.json` case `image-batch-zh`
  // (`一个离线运行的图片批量压缩和格式转换桌面工具`) scanned to two modifiers and no
  // core at all, so the lexicon emitted nothing and the plan stayed a single
  // junk-headed CJK run. Measured `sort=stars` heads: `image compression` ->
  // Luban (13,771), qoi (7,538), Compressor (7,226), caesium-image-compressor
  // (6,377); `image converter` -> repkg (3,783), ascii-image-converter (3,551),
  // webp2jpg-online (2,032), transmute (1,423), HRConvert2 (1,379).
  //
  // Only the 图片-qualified forms are mapped. Bare `压缩` and `格式转换` are left
  // out on purpose: they apply equally to video, PDF and archives, and a lexicon
  // that guesses the domain is how `一个压缩工具` becomes an image tool.
  '图片批量压缩': { en: 'image compression', role: 'core' },
  '图片压缩工具': { en: 'image compression', role: 'core' },
  '图片压缩': { en: 'image compression', role: 'core' },
  '图片批量转换': { en: 'image converter', role: 'core' },
  '图片格式转换': { en: 'image converter', role: 'core' },
  '图片处理': { en: 'image processing', role: 'core' },
  '图片优化': { en: 'image optimizer', role: 'core' },
  '视频编辑': { en: 'video editor', role: 'core' },
  '音乐播放器': { en: 'music player', role: 'core' },
  '聊天': { en: 'chat', role: 'core' },
  '博客': { en: 'blog', role: 'core' },
  '论坛': { en: 'forum', role: 'core' },
  '游戏': { en: 'game', role: 'core' },
  '天气': { en: 'weather', role: 'core' },
  '地图': { en: 'map', role: 'core' },

  // --- rare (own channel, never ANDed) -------------------------------------
  // Measured: `note app bidirectional links` -> 8 matches. `knowledge base
  // bidirectional` -> 48 matches, best anchor 15 stars.
  '双向链接': { en: 'bidirectional', role: 'rare' },
  '双链': { en: 'bidirectional', role: 'rare' },
  // Agent-ecosystem plugins. Measured (`scripts/probes/badcase-trace.mjs`, 2026-10-12):
  // the idea `一个 dsh 上使用的技能市场插件，用来发现和安装 skills` planned only TWO
  // queries and neither could reach the answer:
  //
  //   [0] sort=stars  "一个" dsh skills   total_count 54      NO MATCH for the target
  //   [1] sort=stars  dsh skills          total_count 1,728   matches, top 30 fetched
  //
  // The target `weibaohui/skills-management` (31 stars, the only real answer) sits
  // beyond row 30 of 1,728, and slot 0 was consumed by `"一个"` — a Chinese
  // quantifier meaning "a/one", which `STOPWORDS` cannot catch because it lists
  // only Latin words. Two separate lexicon gaps are visible in that plan:
  // `技能市场`/`技能管理` had no core (so the function half of the idea was never
  // expressed in English), and the ecosystem word `dsh` had no entry at all.
  //
  // These are `core` and `modifier` rather than `rare` on purpose. `rare` means
  // "a real constraint too rare to AND with, give it its own channel" — the
  // measured population for the skill-market vocabulary is small enough to be
  // useful but not so rare that ANDing it collapses the query.
  '技能市场': { en: 'skill marketplace', role: 'core' },
  '技能管理': { en: 'skill management', role: 'core' },
  '技能商店': { en: 'skill marketplace', role: 'core' },
  '插件市场': { en: 'plugin marketplace', role: 'core' },
  '插件管理': { en: 'plugin manager', role: 'core' },
  // The ecosystem words are modifiers: they name WHICH ecosystem, not what the
  // thing does, so `englishSeeds` may use one of them to qualify the core but the
  // core still has to carry the subject. `deepseek harness` is the long form and
  // is listed first because longest-match wins.
  'deepseek harness': { en: 'deepseek harness', role: 'modifier' },
  'dsh': { en: 'dsh', role: 'modifier' },
  '知识图谱': { en: 'knowledge graph', role: 'rare' },
  '全文搜索': { en: 'full-text search', role: 'rare' },
  '端到端加密': { en: 'end-to-end encryption', role: 'rare' },
  '插件系统': { en: 'plugin system', role: 'rare' },
  '版本控制': { en: 'version control', role: 'rare' },
}

/** A seed phrase plus the narrow channel that carries the idea's constraints. */
export interface EnglishSeeds {
  /** At most {@link MAX_SEED_WORDS} words, or `''` when nothing was recognised. */
  readonly seed: string
  /**
   * The first core WITHOUT its modifier — the broader anchor phrase.
   *
   * Exposed because a modifier costs recall. Measured: the idea
   * `一个本地优先的待办事项管理工具` seeds `local-first todo`, and `go-vikunja/vikunja`
   * — the reference implementation for that idea — is absent from its 449-row
   * result set but present at position 10 of the 1,782,914-row `todo`. A project
   * can be local-first without saying so in its description, so the caller needs
   * the unmodified core as a second, wider population.
   *
   * `''` when no core was recognised.
   */
  readonly core: string
  /**
   * The core ANDed with the rare terms — the constraint-carrying channel.
   *
   * `''` when there is no core, no rare term, or the AND would exceed
   * {@link MAX_SEED_WORDS} words (measured: a four-word AND returned 3 rows).
   * An empty `narrow` is a signal, not a failure: the caller should fall back to
   * {@link EnglishSeeds.core} or re-issue the seed with `sort=updated`.
   */
  readonly narrow: string
  /** CJK terms the lexicon did not recognise, for diagnostics. */
  readonly unknown: string[]
}

/**
 * Strip the quote that {@link significantTerms} puts around a CJK run.
 *
 * @param term - a possibly-quoted term.
 * @returns the term without surrounding quotes.
 */
function unquote(term: string): string {
  return term.startsWith('"') && term.endsWith('"') ? term.slice(1, -1) : term
}

/**
 * Every lexicon entry present in one CJK run, in order of appearance.
 *
 * A single run is not one concept. `一个本地优先的笔记应用` is a whole clause
 * holding both a modifier and a core, and the caller needs both — returning only
 * the longest match loses the noun and yields a seed of `local-first` with no
 * subject, which measured 3,092 matches of which 5 were anchors and the top was
 * a book list. Greedy longest-match at each position is what splits it.
 *
 * Longest-first matters: `个人知识管理工具` must resolve as one entry rather than
 * as `个人` + `知识管理`, and only the match order decides which happens.
 *
 * @param run - one unquoted CJK run.
 * @returns matching entries in order; empty when nothing matched.
 */
function scan(run: string): LexEntry[] {
  const keys = Object.keys(LEXICON)
  const out: LexEntry[] = []
  let i = 0
  while (i < run.length) {
    let best = ''
    for (const key of keys) {
      if (key.length > best.length && run.startsWith(key, i)) best = key
    }
    if (best.length === 0) {
      i += 1
      continue
    }
    const entry = LEXICON[best]
    if (entry !== undefined) out.push(entry)
    i += best.length
  }
  return out
}

/**
 * Whether a term still contains Han characters.
 *
 * Latin terms are the caller's business — they are already searchable and are
 * never reported as `unknown`.
 *
 * @param term - the term to test.
 * @returns true when the term contains at least one Han character.
 */
function isCjk(term: string): boolean {
  return /\p{Script=Han}/u.test(term)
}

/**
 * Build an English seed phrase from a Chinese idea's terms.
 *
 * The output is shaped by measurement, not by translation completeness: one
 * modifier plus one core, capped at {@link MAX_SEED_WORDS} words, plus a
 * {@link EnglishSeeds.narrow} AND of the core and the rare terms. Extra cores
 * are returned separately, because ANDing them is what collapsed the measured
 * queries to single-digit populations.
 *
 * Measured outputs (`scripts/probes/recipe.mjs`, `scripts/probes/seeds.mjs`, `scripts/probes/slots.mjs`):
 *
 *   ['本地优先的','笔记应用']          -> seed `local-first note-taking`  (758 matches, siyuan+logseq+Trilium)
 *                                          narrow `note-taking bidirectional` (26, 23 under 100 stars)
 *   ['个人知识管理工具','双向链接']     -> seed `personal knowledge management`, narrow `` (4 words -> 3 rows)
 *   ['本地优先的','待办事项管理工具']   -> seed `local-first todo`         (449 matches, 16 anchors)
 *   ['本地优先的','本地存储']          -> seed `` (modifiers only, no subject) -> no English channel
 *
 * @param cjkTerms - the idea's CJK terms, quoted or not.
 * @returns the seed phrase and the standalone channels.
 */
export function englishSeeds(cjkTerms: readonly string[]): EnglishSeeds {
  const modifiers: string[] = []
  const cores: string[] = []
  const rare: string[] = []
  const unknown: string[] = []

  for (const raw of cjkTerms) {
    const term = unquote(raw)
    if (term.length === 0) continue
    const entries = scan(term)
    if (entries.length === 0) {
      if (isCjk(term)) unknown.push(term)
      continue
    }
    for (const entry of entries) {
      if (entry.role === 'modifier') modifiers.push(entry.en)
      else if (entry.role === 'core') cores.push(entry.en)
      else rare.push(entry.en)
    }
  }

  const unique = (list: readonly string[]): string[] => [...new Set(list)]
  const uniqueCores = unique(cores)

  // A modifier the core already carries is dropped: `个人知识管理工具` resolves to
  // the modifier `personal` plus the core `personal knowledge management`, and
  // keeping both would spend the whole word budget saying `personal` twice.
  const usefulModifiers = unique(modifiers).filter(
    (modifier) => !uniqueCores.some((core) => core.split(' ').includes(modifier)),
  )

  // The core comes FIRST and the modifier only fills leftover budget.
  //
  // The other order has a measured failure: for
  // `个人知识管理工具，双向链接，本地存储` the modifier slot went to `本地存储`
  // (-> `local-first`) and the three-word core `personal knowledge management`
  // then had no room, so the seed collapsed to the bare property word
  // `local-first` — a seed with no subject. Measured, that shape returns the
  // modifier's whole population rather than the idea's, which is the same defect
  // the lexicon exists to remove.
  //
  // A multi-word core is taken whole and may use the entire budget: the phrase
  // is the searchable unit, and `personal knowledge management` measured 1,435
  // matches / 9 anchors against 161 / 3 for the shortened `knowledge management`
  // and 128 / 3 for the padded `personal knowledge management app`.
  //
  // With no core there is no seed. A bare modifier is a filter, not a subject;
  // returning it would issue a query for the modifier's entire population and
  // label it the idea's. The caller is better served by its own CJK channels.
  // Word counts, not array lengths. A core can be a multi-word phrase
  // (`personal knowledge management`), so `parts.length` counts entries and
  // silently under-reports the budget: it let the four-word
  // `personal knowledge management bidirectional` through a three-word cap.
  const words = (phrase: string): number => phrase.split(' ').length

  const parts: string[] = []
  const firstCore = uniqueCores[0]
  if (firstCore !== undefined) {
    let used = 0
    const modifier = usefulModifiers[0]
    if (modifier !== undefined && words(firstCore) + words(modifier) <= MAX_SEED_WORDS) {
      parts.push(modifier)
      used += words(modifier)
    }
    parts.push(firstCore)
    used += words(firstCore)
    for (const core of uniqueCores.slice(1)) {
      if (used + words(core) > MAX_SEED_WORDS) break
      parts.push(core)
      used += words(core)
    }
  }

  // The narrow channel keeps the core and drops the modifier, because the
  // modifier is the least discriminating half of the phrase and something has to
  // give for the rare term to fit. Measured: `note-taking bidirectional` = 26
  // matches with 23 under 100 stars, against 15,852 mostly-unrelated rows for
  // `bidirectional` alone. Nothing is emitted when the AND would run past the
  // cap — `personal knowledge management bidirectional` measured 3 rows.
  let narrow = ''
  if (firstCore !== undefined) {
    const narrowParts = [firstCore]
    let used = words(firstCore)
    for (const term of unique(rare)) {
      if (used + words(term) > MAX_SEED_WORDS) break
      narrowParts.push(term)
      used += words(term)
    }
    if (narrowParts.length > 1) narrow = narrowParts.join(' ')
  }

  return {
    seed: parts.join(' '),
    core: firstCore ?? '',
    narrow,
    unknown,
  }
}
