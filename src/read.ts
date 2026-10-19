/**
 * Which slice of a file a point read should return, and why that slice.
 *
 * WHY THIS IS A MODULE AND NOT A FEW LINES INSIDE THE TOOL
 * The window decision has four branches (whole file, head, focus hit, focus miss)
 * and two arithmetic hazards that are easy to get wrong: the line numbers it
 * reports are 1-based line numbers in the ORIGINAL file while the text it returns
 * is a slice, and the budget it honours is in BYTES while the text is sliced by
 * lines. `inspect_projects` already paid for the first lesson once — a window
 * whose `#L` numbers do not point at the lines shown is worse than no citation at
 * all, because a wrong line number still looks like evidence. A pure function can
 * be tested against both directly; a branch buried in a tool `execute` can only be
 * reached by calling the tool.
 *
 * WHY BYTES AND NOT CHARACTERS
 * This whole change is byte accounting: the thing being reduced is the token cost
 * of a returned card, and one CJK character costs three bytes where an ASCII one
 * costs one. A character budget would let a file of Chinese comments return three
 * times the bytes of a file of English code while claiming the same size, which is
 * exactly the discrepancy the budget exists to remove.
 *
 * WHAT IT IS NOT
 * It does not read files, does not know GitHub, and does not decide how many files
 * to read. It takes text and terms and returns a window.
 */

/**
 * A slice of a file, with everything a reader needs to know what it is.
 *
 * `startLine`/`endLine` are 1-based and inclusive, and they describe the text
 * THIS object carries — not the file. `truncated` says whether the file has more
 * lines outside the window; a window that happens to end at the last line is not
 * truncated, and the caller must not infer that from the numbers alone (a
 * one-line file and a file whose single line was all that fit both read
 * `startLine: 1, endLine: 1`).
 */
export interface ReadWindow {
  /** 1-based first line of `text`, in the original file. */
  startLine: number
  /** 1-based last line of `text`, in the original file. */
  endLine: number
  /**
   * Why this slice:
   * `whole`  — every line of the file is here;
   * `head`   — no focus was asked for, so the window starts at line 1;
   * `focus`  — a focus term was found and the window is centred on it;
   * `focus-miss` — a focus was asked for and NO line matched it, so this is the
   *   head. It is reported as its own kind rather than silently as `head`
   *   because the caller asked a different question and is entitled to know it
   *   was not answered.
   */
  kind: 'whole' | 'head' | 'focus' | 'focus-miss'
  /** 1-based line number of the strongest focus hit; 0 when none was found. */
  hitLine: number
  /** The lines of the window, joined by `\n` (no trailing newline added). */
  text: string
  /**
   * UTF-8 byte length of `text`.
   *
   * Usually at or below the budget, but NOT always: when a single line is longer
   * than the whole budget that line is returned whole (see `pickWindow`), so this
   * can exceed `maxBytes`. A caller that must stay under a byte ceiling has to
   * check this field — the window arithmetic cannot both honour the ceiling and
   * return the only line that answers the question, and returning half a line of
   * source would be a broken citation rather than a smaller one.
   */
  bytes: number
  /**
   * True when the file has lines outside the window.
   *
   * This is about LINES, not about the budget: a one-line file that overflows the
   * byte budget still has every line of the file in its window, so it is not
   * truncated — `bytes` is the field that reports the overflow.
   */
  truncated: boolean
}

/** How many lines of context a focus window keeps on each side of the hit. */
export const READ_CONTEXT_LINES = 40

/**
 * Whether a decoded payload looks like binary rather than text.
 *
 * The contents API base64-encodes whatever the file contains, so asking it for a
 * PNG returns a string of mojibake that would otherwise be fenced and handed
 * back as if it were source. Three signals catch essentially all of it:
 *
 *   - U+FFFD means the bytes were not valid UTF-8 at all;
 *   - a NUL byte means the content is not text in any encoding worth showing;
 *   - control characters other than tab / newline / CR are the same signal.
 *
 * The check is deliberately about *decodability*, not about file extensions: a
 * `.ts` file that is really a compiled blob should be refused too, and a text
 * file with an unusual extension should not be.
 *
 * @param text - the decoded file text.
 * @returns true when the content should not be presented as source.
 */
export function looksBinary(text: string): boolean {
  if (text.includes('\uFFFD')) return true
  if (text.includes('\u0000')) return true
  return /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(text)
}

/** Floor on the budget, so a caller asking for 10 bytes gets a usable line. */
const MIN_BUDGET_BYTES = 200

/**
 * Strip the quoting `significantTerms` puts around a CJK run.
 *
 * `significantTerms` quotes Han runs so GitHub matches them as a phrase
 * (`"本地优先的"`). That quoting is a SEARCH syntax, and a line of source code
 * does not contain the quote characters, so matching against the quoted form
 * would report every CJK focus as a miss.
 */
function bareTerm(term: string): string {
  return term.replace(/^"|"$/g, '')
}

/**
 * The 0-based index of the line that best matches `terms`, or -1 for no match.
 *
 * Score is the number of distinct terms the line contains, case-insensitively;
 * ties go to the earliest line. Distinct terms rather than occurrences, because
 * one line repeating a word five times is not more relevant than a line that
 * carries three of the caller's words. Earliest rather than longest, because a
 * file usually declares a thing once and refers to it afterwards, and the
 * declaration is what a reader wants.
 */
function bestFocusLine(lines: readonly string[], terms: readonly string[]): number {
  const needles = terms.map(bareTerm).filter(term => term.length > 0).map(term => term.toLowerCase())
  if (needles.length === 0) return -1
  let bestLine = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').toLowerCase()
    if (line.length === 0) continue
    let score = 0
    for (const needle of needles) {
      if (line.includes(needle)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      bestLine = i
    }
  }
  return bestLine
}

/**
 * Choose the window to return for one file.
 *
 * @param text - the file's text, already truncated to whatever the caller read.
 * @param terms - focus terms, from `significantTerms`; empty means "no focus".
 * @param maxBytes - ceiling on the UTF-8 byte length of the returned text. A
 *   single line longer than the ceiling is still returned whole (and marked
 *   `truncated`) only when it is the window's only line, because half a line of
 *   source is not a smaller window, it is a broken one; otherwise such a line is
 *   not included and the window stops before it.
 * @param contextLines - lines of context each side of a focus hit.
 * @returns the window plus the facts needed to describe it truthfully.
 */
export function pickWindow(
  text: string,
  terms: readonly string[],
  maxBytes: number,
  contextLines: number = READ_CONTEXT_LINES,
): ReadWindow {
  const lines = text.split('\n')
  const budget = Math.max(MIN_BUDGET_BYTES, Math.floor(maxBytes))
  const totalBytes = Buffer.byteLength(text, 'utf8')

  // The whole file fits: no window arithmetic is needed, and reporting `whole`
  // rather than `head` matters because "this is the entire file" is a stronger
  // claim than "this is its beginning".
  if (totalBytes <= budget) {
    return {
      startLine: 1,
      endLine: lines.length,
      kind: 'whole',
      hitLine: 0,
      text,
      bytes: totalBytes,
      truncated: false,
    }
  }

  const hit = terms.length === 0 ? -1 : bestFocusLine(lines, terms)
  const kind: ReadWindow['kind'] = terms.length === 0 ? 'head' : hit >= 0 ? 'focus' : 'focus-miss'
  const centre = hit >= 0 ? hit : 0
  const upLimit = hit >= 0 ? Math.max(0, contextLines) : 0
  const downLimit = hit >= 0 ? Math.max(0, contextLines) : lines.length

  const centreLine = lines[centre] ?? ''
  const centreBytes = Buffer.byteLength(centreLine, 'utf8')
  // A single line bigger than the whole budget still gets returned: it is the
  // only line that can answer the caller's question, and a window that excludes
  // it would report a focus hit with nothing around it.
  let start = centre
  let end = centre
  let used = centreBytes
  let up = centre - 1
  let down = centre + 1
  let above = 0
  let below = 0

  if (centreBytes <= budget) {
    // Grow outward from the centre, one line at a time, alternating sides so a
    // focus window stays centred on its hit instead of drifting to one side as
    // the budget is spent. Stops when both directions are exhausted or the next
    // line would exceed the ceiling; it does not skip an oversized line to reach
    // a smaller one, because a window with a hole in it cannot be cited as a range.
    for (;;) {
      let progressed = false
      if (up >= 0 && above < upLimit) {
        const cost = Buffer.byteLength(lines[up] ?? '', 'utf8') + 1
        if (used + cost > budget) break
        start = up
        used += cost
        up -= 1
        above += 1
        progressed = true
      }
      if (down < lines.length && below < downLimit) {
        const cost = Buffer.byteLength(lines[down] ?? '', 'utf8') + 1
        if (used + cost > budget) break
        end = down
        used += cost
        down += 1
        below += 1
        progressed = true
      }
      if (!progressed) break
    }
  }

  const windowText = lines.slice(start, end + 1).join('\n')
  return {
    startLine: start + 1,
    endLine: end + 1,
    kind,
    hitLine: hit + 1,
    text: windowText,
    bytes: Buffer.byteLength(windowText, 'utf8'),
    truncated: !(start === 0 && end === lines.length - 1),
  }
}
