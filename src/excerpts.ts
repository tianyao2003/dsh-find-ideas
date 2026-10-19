// What one file's excerpt is worth putting on the card, and how much of it.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// `inspect_projects` returned 49.4KB per call and 71.8% of every tool-result byte
// in the A/B eval. Measured on the 12 real dumps, the file-excerpt section alone
// was 47.5% of the payload, and most of it was not source code:
//
//   * `.md` 48 blocks / 66.7KB -- documentation prose, not implementation
//   * `.json` 11 / 11.6KB, `.toml` 10 / 11.5KB, `.mod` 7 / 8.7KB -- manifests
//   * 19 source files in languages the scanner does not read (lua 10, swift 3,
//     rb 2, sh 1, cpp 1, h 1, vue 1) / 23.3KB -- the text was dumped but never
//     scanned, so it carried no signature evidence
//
// A 1200-character head of a `go.sum` is not evidence about architecture. The
// rule here is not "show less" -- it is "show the window only when a scanner
// actually reads that window, and say what happened when it does not".
//
// WHY A MODULE RATHER THAN A CONDITION INLINE
// -------------------------------------------
// The decision has to agree with two things that live elsewhere: the selector's
// notion of source (`SOURCE_EXT_RE`) and the scanner's language coverage
// (`SCANNED_EXTENSIONS`). Keeping the rule next to neither, but in one place that
// imports both, is what stops the three from drifting apart -- a drift that had
// already happened: the selector's gate accepts 35 extensions and the scanner
// reads 11, and nothing said so.
//
// The functions are pure: same path and text in, same disposition out. No I/O, no
// globals, so the renderer and the tests can call them freely.

import { EXCERPT_WINDOW_CHARS, SCANNED_EXTENSIONS, scanSignatures } from './skeleton.ts'
import { skipPreamble } from './preamble.ts'
import { isSourcePath } from './select.ts'
import type { SkeletonCardEntry } from './render.ts'

/**
 * The root README's file names, exactly.
 *
 * Deliberately NOT `**\/README.md`: a nested README is a different artifact
 * (logseq keeps one inside a vendored HEIF decoder). Only the repository's own
 * front page is one the `[README 摘录]` section has already shown in full.
 */
const ROOT_README_RE = /^readme\.(md|markdown|rst|txt)$/i

/** Whether this path is the repository's root README. */
export function isRootReadmePath(path: string): boolean {
  return ROOT_README_RE.test(path)
}

/**
 * Source extensions, asked of the one place that defines them.
 *
 * Re-exported rather than restated: `src/select.ts` owns `SOURCE_EXT_RE`, and a
 * second copy of that alternation here is exactly how the selector's gate and
 * the scanner's coverage drifted apart before.
 */
export { isSourcePath } from './select.ts'

/** Extensions the scanner can actually parse, as a set for O(1) lookup. */
const SCANNED = new Set(SCANNED_EXTENSIONS.map((ext) => ext.toLowerCase()))

/** Lowercase extension without the dot, or `''` when there is none. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * How much of one file the card should carry.
 *
 * Four outcomes, and each is a different claim about the same file:
 *
 *   - `window`      the scanner reads this extension, so the 1200-char head IS
 *                   evidence: show it and scan it.
 *   - `title-only`  a documentation file that is not the README. Its heading
 *                   answers "what documents does this project have"; its prose
 *                   does not answer "how is it built".
 *   - `path-only`   either not source at all (manifest, lockfile, data) or
 *                   source in a language the scanner cannot read. The path is
 *                   the whole fact available, so the path is what is shown.
 *   - `readme-lead` the root README, which the card already renders in full
 *                   under its own heading; repeating it is pure duplication.
 */
export type ExcerptDisposition =
  | { kind: 'window' }
  | { kind: 'readme-lead' }
  | { kind: 'title-only' }
  | { kind: 'path-only'; reason: 'not-source' | 'unscanned-language' }

/**
 * Classify one path. Pure, and total: every string gets a disposition.
 *
 * @param path - repository-relative path.
 * @param isSource - predicate from `src/select.ts`; injected so this module does
 *   not have to re-state the selector's extension list.
 */
export function classifyExcerpt(
  path: string,
  isSource: (candidate: string) => boolean,
): ExcerptDisposition {
  if (isRootReadmePath(path)) return { kind: 'readme-lead' }
  if (!isSource(path)) {
    // A non-README Markdown file still names itself in its first heading, and
    // "this project documents its architecture in docs/architecture.md" is a
    // fact worth one line. Everything else non-source is a path and nothing
    // more: a 1200-char head of a lockfile is not evidence.
    return extensionOf(path) === 'md' ? { kind: 'title-only' } : { kind: 'path-only', reason: 'not-source' }
  }
  if (!SCANNED.has(extensionOf(path))) return { kind: 'path-only', reason: 'unscanned-language' }
  return { kind: 'window' }
}

/**
 * The line that replaces a duplicated README excerpt.
 *
 * Not an empty string, for the same reason `renderSkeleton` is never empty: a
 * blank entry reads as "this file is empty", and the fact is that its text was
 * already shown above.
 */
export const README_ALREADY_SHOWN = '（正文见上方 [README 摘录]，此处不再重复）'

/**
 * What replaces a window whose entire content is preamble.
 *
 * Not an empty string: blank reads as "this file is empty". Not the preamble
 * itself: it is the one part of the file that provably contains no architecture,
 * and it was 82.1% of the skeleton bytes measured on the 12 dumps. The sentence
 * has to say two things — that nothing was shown, and why that is not a claim
 * about the file.
 *
 * The claim is scoped to "本次读到的开头" on purpose. When the read budget cut
 * the file, everything past the cut is unexamined, and a sentence that read as
 * "this file has no declarations" would be exactly the falsehood this module
 * exists to stop. That case gets `PREAMBLE_ONLY_MORE` appended below.
 */
export const PREAMBLE_ONLY =
  '正文未随本次返回：本次读到的开头全是许可头、import 或模块文档字符串，其中不可能有类/函数声明，所以没有展示'

/**
 * Appended when the read budget cut the file, so the head that was classified is
 * not mistaken for the whole file.
 */
const PREAMBLE_ONLY_MORE = '；文件还有内容没有读到，其后是否有声明本次没有检查'

/** Always last: what to do when the bytes are actually wanted. */
const PREAMBLE_ONLY_HINT = '；需要时用 read_repo_files 点读'

/**
 * Windows smaller than this are never collapsed, even when every byte is preamble.
 *
 * The collapse is not free: the header still costs its line and the note costs
 * ~70 characters, so deferring a window shorter than that PAYS bytes to save
 * fewer. It is also not only about bytes — `src/app/app.routes.ts` is 33 bytes
 * of pure route table, all of it "preamble" by any lexical rule, and it is the
 * architecture. A guard at 60 bytes keeps every small file verbatim and still
 * collapses all 19 measured licence-header windows (the smallest was 200 bytes).
 */
const MIN_COLLAPSE_BYTES = 60

/** First Markdown heading in `text`, or `''` when there is none. */
export function firstHeading(text: string): string {
  for (const line of text.split('\n')) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (match !== null) {
      const heading = match[1]
      if (heading !== undefined && heading.trim().length > 0) return heading.trim()
    }
  }
  return ''
}

/** Lines that carry no prose: titles, badges, comments, links, licences, rules. */
const NOISE_LINE_RES: readonly RegExp[] = [
  /^\s{0,3}#{1,6}\s/, // heading
  /^\s*<!--/, // HTML comment open
  /^\s*-->/, // HTML comment close
  /^\s*([-*_]\s*){3,}$/, // horizontal rule
  /^\s*\|/, // table row
  /^\s*>/, // block quote
]

/** A line that is only a badge, image, or link. */
function isLinkOrBadgeLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  if (/^\[!\[/.test(trimmed)) return true // [![alt](img)](href)
  if (/^!\[/.test(trimmed)) return true // ![alt](img)
  if (/^<img\b/i.test(trimmed)) return true // <img …>
  if (/^<p\s+align=/i.test(trimmed)) return true // centered logo block
  if (/^<a\s+href=/i.test(trimmed)) return true // raw anchor
  if (/shields\.io|badge\.svg|badgen\.net/i.test(trimmed)) return true
  // A line whose entire content is one or more Markdown links.
  const withoutLinks = trimmed.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/<https?:\/\/[^>]*>/g, '')
  if (withoutLinks.trim().length === 0 && /\[[^\]]*\]\([^)]*\)|<https?:/.test(trimmed)) return true
  return false
}

/** A line that is a licence statement rather than project prose. */
function isLicenceLine(line: string): boolean {
  return /^\s*(licen[cs]e|licenced|licensed under|copyright|©|\(c\)\s*\d{4})/i.test(line)
}

/** A line that is a section header for installation / usage / build. */
function isMetaSectionLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+(install|installation|usage|quick ?start|getting started|build|building|setup|配置|安装|使用|快速开始|构建)/i.test(line)
}

/**
 * Paragraphs that talk about the README's AUDIENCE rather than the project.
 *
 * WHY THIS EXISTS
 * ---------------
 * Truncating to one paragraph introduces a failure the old card could not have:
 * the old card printed 1200 verbatim characters, so a description that came
 * after a contribution note was still on screen. A one-paragraph lead that picks
 * the contribution note instead has thrown the description away.
 *
 * Measured on the 48 cards in the A/B fixture: 47 READMEs yield a description as
 * their first prose paragraph, and exactly one (`make-all/tuya-local`) yields
 * "Please report any issues and feel free to raise pull requests". One in 48 is
 * a small regression, but it is a SILENT one — the card still looks like it
 * answered the question — and it costs a few lines to close.
 *
 * Deliberately anchored at the START of the paragraph and short. A real
 * description can legitimately mention issues or contributions ("a CLI that
 * files issues to your tracker"), so the test is on how the paragraph OPENS, not
 * on which words it happens to contain. And a wrong skip is recoverable: when
 * every paragraph looks like boilerplate the first one is used anyway, because
 * "this README has no description" would be a false claim about a README that
 * merely has an unusual one.
 */
const BOILERPLATE_PARAGRAPH_RES: readonly RegExp[] = [
  // "Please report any issues…", "File a bug…", "Open a PR…"
  /^(please\s+)?(report|file|open|submit|raise|create)\s+(any\s+|a\s+|an\s+)?(issues?|bugs?|pull\s+requests?|prs?|tickets?)/i,
  // "Issues and pull requests are welcome."
  /^(issues?|bugs?|pull\s+requests?|prs?|feedback|questions?|contributions?)\b/i,
  // "Feel free to…", "Contributions are welcome."
  /^(feel\s+free|contributions?\s+(are|is)\s+welcome|all\s+contributions)/i,
  // "Acknowledgements", "Credits", "Thanks to…"
  /^(acknowledge?ments?|credits|thanks|thank\s+you|contributors)\b/i,
  // A licence paragraph is not a description.
  /^(licen[cs]e|licen[cs]ing|版权|许可)/i,
  // A table of contents is not a description.
  /^(table\s+of\s+contents|contents|toc)\b/i,
]

/**
 * A paragraph with Markdown link syntax reduced to its visible text.
 *
 * The boilerplate test has to see what a READER sees. "Please report any
 * [issues](https://…)" opens with the words "Please report any issues"; matching
 * the raw string instead fails on the `[` and lets exactly the paragraph this
 * filter exists for through. Images keep their alt text, bare URLs keep their
 * text, and anything that is not a link is untouched.
 */
function readableText(paragraph: string): string {
  return paragraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) / ![alt](url) -> text
    .replace(/<https?:\/\/[^>]*>/g, '') // <https://…> -> nothing
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether a paragraph is about the project or about its contributors. */
function isBoilerplateParagraph(paragraph: string): boolean {
  const readable = readableText(paragraph)
  return BOILERPLATE_PARAGRAPH_RES.some((re) => re.test(readable))
}

/** Cut at the last sentence end at or before `maxChars`, else at `maxChars`. */
function cutAtSentence(text: string, maxChars: number): { text: string; elided: boolean } {
  if (text.length <= maxChars) return { text, elided: false }
  const window = text.slice(0, maxChars)
  let cut = -1
  for (const match of window.matchAll(/[。！？.!?]["'）)]?(?=\s|$)/g)) {
    const end = (match.index ?? 0) + match[0].length
    if (end <= maxChars) cut = end
  }
  if (cut < maxChars * 0.5) cut = maxChars
  return { text: `${window.slice(0, cut).trimEnd()}…`, elided: true }
}

/**
 * The first real paragraph of a README, capped.
 *
 * The old excerpt was the first 4000-12000 characters verbatim, which on a
 * typical repository is: title, four badge lines, a table of contents, and the
 * installation section -- 19.3% of the whole payload, and the part that tells a
 * reader least about the architecture. The question the card is answering is
 * "what is this project and how is it built", and the first prose paragraph is
 * where a README answers that.
 *
 * When there IS no prose (a title-only README, or one that opens with a badge
 * wall), the result says so explicitly. Returning `''` would be read as "the
 * README is empty", which is a different and false claim.
 *
 * @param markdown - raw README text.
 * @param maxChars - character budget for the returned lead.
 * @returns the lead paragraph plus a note when something was skipped or elided.
 */
export function extractReadmeLead(
  markdown: string,
  maxChars: number,
): { text: string; note: string } {
  const source = typeof markdown === 'string' ? markdown : ''
  if (source.trim().length === 0) return { text: '', note: '' }

  const lines = source.split('\n')
  const paragraphs: string[] = []
  let current: string[] = []
  let sawNoise = false
  let inComment = false
  let inCodeFence = false

  const flush = (): void => {
    if (current.length > 0) {
      paragraphs.push(current.join(' ').replace(/\s+/g, ' ').trim())
      current = []
    }
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    // A fenced code block is not prose; skipping it also stops an install
    // snippet from being mistaken for the project description.
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      inCodeFence = !inCodeFence
      flush()
      continue
    }
    if (inCodeFence) continue
    // HTML comments can span lines and routinely wrap a whole logo block.
    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    if (/^\s*<!--/.test(line)) {
      if (!line.includes('-->')) inComment = true
      continue
    }
    if (line.trim().length === 0) {
      flush()
      continue
    }
    if (isLinkOrBadgeLine(line) || isLicenceLine(line)) {
      sawNoise = true
      flush()
      continue
    }
    if (NOISE_LINE_RES.some((re) => re.test(line))) {
      // A heading that announces an install/usage section is the start of
      // procedural documentation; the description paragraph, if there is one,
      // came before it. Stop rather than reading the install steps as prose.
      if (isMetaSectionLine(line)) {
        flush()
        break
      }
      sawNoise = true
      flush()
      continue
    }
    current.push(line.trim())
  }
  flush()

  // The first prose paragraph that is about the PROJECT. A contribution note or
  // a table of contents is prose by every structural test above, so it survives
  // the noise filters and would otherwise become the whole README section.
  //
  // Fallback, not rejection: if every paragraph looks like boilerplate, the
  // first one is used anyway. Returning "no description" for a README that has
  // an unusual description would be a false claim, and a false claim is worse
  // than a mediocre paragraph.
  const prose = paragraphs.filter((paragraph) => paragraph.length > 0)
  const skippedBoilerplate = prose.length > 1 ? prose.filter(isBoilerplateParagraph).length : 0
  const lead = prose.find((paragraph) => !isBoilerplateParagraph(paragraph)) ?? prose[0]
  if (lead === undefined) {
    return {
      text: '',
      note: `README 前 ${lines.length} 行只有标题、徽章与章节标题，没有正文段落：这里没有可摘录的项目描述。`,
    }
  }

  const cut = cutAtSentence(lead, maxChars)
  const notes: string[] = []
  if (sawNoise) notes.push('已跳过标题、徽章与许可声明')
  if (skippedBoilerplate > 0) notes.push(`已跳过 ${skippedBoilerplate} 段贡献/许可说明`)
  if (cut.elided) notes.push(`首段超过 ${maxChars} 字，已按句末截断`)
  return { text: cut.text, note: notes.length > 0 ? `（${notes.join('；')}）` : '' }
}

/**
 * The README section's final text: the lead paragraph, plus what was skipped,
 * plus how much of the README was available at all.
 *
 * WHY THE COVERAGE NOTE IS SEPARATE FROM THE LEAD NOTE
 * ---------------------------------------------------
 * `extractReadmeLead` describes the PARAGRAPH it picked; the read budget
 * describes the FILE. Folding the second into the first would report the budget
 * as a property of the paragraph, and the case that needs both is exactly the
 * one where there is no paragraph: a README cut by the read budget whose visible
 * part is nothing but a title and a badge wall. Saying only "前 N 行只有标题…没有
 * 正文段落" there would be a claim about the FILE drawn from a fragment of it.
 *
 * @param lead - result of `extractReadmeLead`.
 * @param readmeTruncated - whether the read budget cut the README.
 * @param readBudgetChars - that budget, quoted in the coverage note.
 * @returns the section body; `''` only when the README is empty and whole.
 */
export function renderReadmeExcerpt(
  lead: { text: string; note: string },
  readmeTruncated: boolean,
  readBudgetChars: number,
): string {
  const parts: string[] = []
  if (lead.text.length > 0) parts.push(lead.text)
  if (lead.note.length > 0) parts.push(lead.note)
  if (readmeTruncated) {
    parts.push(`（README 长于 ${readBudgetChars} 字符的读取预算，以上取自其开头部分）`)
  }
  return parts.join('\n')
}

/**
 * One file as it was read: the head in hand, and how much of the file that is.
 *
 * `fullLength` exists because the head and the file are not the same length once
 * the read budget has cut the file. The coverage note in the header is a claim
 * about the FILE ("this is only the first 1200 characters"), so it cannot be
 * derived from the length of the head — a head that was itself truncated is
 * short for a different reason. When the caller does not know the true length,
 * omitting `fullLength` says "the head is all there is".
 */
export interface ExcerptSource {
  /** Text as read, possibly already cut by the read budget. */
  text: string
  /** Whether the read budget cut this file. */
  truncated: boolean
  /** Characters in the whole file, when known to exceed `text.length`. */
  fullLength?: number
}

/** What one file contributes to the card: its excerpt block and its skeleton entry. */
export interface ExcerptPlan {
  /** The whole `--- path ---` block for the file-excerpt section. */
  block: string
  /** The same file's entry in the card-level skeleton block. */
  entry: SkeletonCardEntry
}

/**
 * Decide what one file is worth showing, and render both halves of that decision.
 *
 * WHY THIS IS A FUNCTION AND NOT A BRANCH IN `inspectOne`
 * -----------------------------------------------------
 * The byte budget this module exists to enforce can only be verified by
 * re-rendering real payloads, and a re-render that reimplements the rule measures
 * the reimplementation, not the product. Keeping the decision here — pure, no
 * I/O, no globals — lets the production path and the measurement harness call
 * the same code, so a measured saving is a saving the plugin actually makes.
 *
 * @param path - repository-relative path.
 * @param source - the file's head and how much of the file it is.
 * @param readBudgetChars - the read budget, quoted in the truncation note.
 */
export function describeExcerpt(
  path: string,
  source: ExcerptSource,
  readBudgetChars: number,
): ExcerptPlan {
  const totalChars = source.fullLength ?? source.text.length
  const windowed = totalChars > EXCERPT_WINDOW_CHARS
  // Two truncations happen to every excerpt and BOTH used to be silent, so a
  // 1200-character head of a 200KB file was indistinguishable from a whole file.
  // Level 3 is the read budget, level 4 is the window below; the header states
  // whichever applies, in characters, so the reader can tell how much of the file
  // is actually in front of them.
  const coverage: string[] = []
  if (source.truncated) coverage.push(`文件长于 ${readBudgetChars} 字符的读取预算，已截断`)

  const disposition = classifyExcerpt(path, isSourcePath)

  // Where the file's body starts, past the licence header, the import block and
  // any module docstring. Measured on 107 real files: 21 of them spent the ENTIRE
  // 1200-character window on that preamble, and the card then reported "零声明"
  // about text that cannot contain a declaration. The window was pointed at the
  // one part of the file that provably has no architecture in it.
  const skip =
    disposition.kind === 'window'
      ? skipPreamble(source.text)
      : { offset: 0, lineOffset: 0, allPreamble: false }
  const collapse = disposition.kind === 'window' && skip.allPreamble && source.text.length >= MIN_COLLAPSE_BYTES
  // Once the window starts after the preamble, "文件开头" is not where it starts.
  // The header is a claim about which bytes the reader has, so it has to change
  // with the window instead of describing the old one.
  const shifted = disposition.kind === 'window' && !skip.allPreamble && skip.lineOffset > 0

  const headerWith = (notes: string[]): string =>
    `--- ${path} ---${notes.length > 0 ? `（${notes.join('；')}）` : ''}`
  // Every non-window branch shows no file body, so for those the only coverage
  // fact is how much of the file the read budget returned.
  const plainHeader = headerWith(
    windowed ? [...coverage, `本摘录只含开头 ${EXCERPT_WINDOW_CHARS} 字符，其后内容未展示`] : coverage,
  )

  switch (disposition.kind) {
    case 'readme-lead':
      // The README's prose is rendered once, under its own heading. Repeating the
      // body here is the 68.9KB of duplication the dumps measured. The coverage
      // notes stay: they are the only statement of how much of the README the
      // reader actually has.
      return { block: `${plainHeader}\n${README_ALREADY_SHOWN}`, entry: { path, skipped: 'readme-shown' } }
    case 'title-only': {
      // A documentation file that is not the README: its heading answers "what
      // documents does this project have", which is a real fact; its prose does
      // not answer "how is it built".
      const title = firstHeading(source.text)
      const body = title.length > 0 ? title : '（未展开：文档正文，只列标题）'
      return { block: `${plainHeader}\n${body}`, entry: { path, skipped: 'not-source' } }
    }
    case 'path-only': {
      const why =
        disposition.reason === 'unscanned-language'
          ? '只列路径：该扩展名不在扫描器的语言覆盖内，本文件没有被扫描过'
          : '只列路径：非源码文件'
      return { block: `${plainHeader}\n（${why}）`, entry: { path, skipped: disposition.reason } }
    }
    case 'window': {
      if (collapse) {
        // Nothing but preamble: there is no body to show. A blank block would read
        // as "this file is empty", and dumping the preamble spends bytes on text
        // that cannot answer what the card is for. Say what happened and how to
        // get the bytes if they are really wanted.
        //
        // The middle clause is conditional because the classification only covers
        // the bytes that were READ. When the read budget cut the file, the part
        // past the cut was never examined, and the note must not let "开头全是
        // 许可头" harden into "这个文件没有声明".
        const more = source.truncated ? PREAMBLE_ONLY_MORE : ''
        return {
          block: `${headerWith(coverage)}\n${PREAMBLE_ONLY}${more}${PREAMBLE_ONLY_HINT}`,
          entry: { path, skipped: 'preamble-only' },
        }
      }
      // `allPreamble` under the guard is a SHORT file that happens to be all
      // preamble (`src/app/app.routes.ts`, 33 bytes, the whole route table). It is
      // shown verbatim: the guard exists because deferring costs more bytes than
      // the window it saves, and because a small architecture file must not be
      // hidden by a rule aimed at licence headers.
      const body = skip.allPreamble ? source.text : source.text.slice(skip.offset)
      const excerpt = body.slice(0, EXCERPT_WINDOW_CHARS)
      const windowCut = excerpt.length >= EXCERPT_WINDOW_CHARS
      // The header has to describe THIS window. After a shift the shown text is
      // not the file's opening, and saying it is would be the same class of
      // falsehood the window cut itself used to commit (a silent second cut).
      const notes = [...coverage]
      if (shifted) {
        notes.push(
          `已跳过开头的许可头、import 或模块文档字符串，本摘录从第 ${skip.lineOffset + 1} 行开始` +
            (windowCut ? `，只含其后 ${EXCERPT_WINDOW_CHARS} 字符` : ''),
        )
      } else if (windowed) {
        notes.push(`本摘录只含开头 ${EXCERPT_WINDOW_CHARS} 字符，其后内容未展示`)
      }
      // The scanner reads the SAME window the excerpt shows. Scanning more than
      // is displayed would let the card cite a declaration the reader cannot see,
      // and scanning less would leave a line number pointing at nothing.
      //
      // `lineOffset` is what keeps the citations honest once the window no longer
      // starts at line 1: the excerpt is a slice, but every `#L<n>` must be a line
      // number in the ORIGINAL file. Measured shift on the same sample: p50=4,
      // p90=20, max=35 lines — so skipping this arithmetic would put every
      // citation tens of lines too high, which is worse than no citation at all
      // because a wrong line number still looks like evidence.
      const lineOffset = skip.allPreamble ? 0 : skip.lineOffset
      return { block: `${headerWith(notes)}\n${excerpt}`, entry: { path, hits: scanSignatures(path, excerpt, lineOffset) } }
    }
  }
}
