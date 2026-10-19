/**
 * Where a file's body starts, after its licence header, imports and docstrings.
 *
 * WHY THIS EXISTS
 * `inspect_projects` shows a fixed window of each file as evidence. On the
 * measured sample of 107 scanned files that window held no declaration for 59 of
 * them, and the largest single cause was not a missing scanner: it was a
 * preamble. 21 files had a window that was *entirely* licence header, import
 * block or module docstring — six `.py` files of `ha_xiaomi_home` spend all 1200
 * characters on an SPDX header, `query_builder/server.py` spends all 1200 on a
 * module docstring, and `src/App.tsx` spends all 1200 on imports. The window was
 * pointed at text that cannot contain a class or function, and the card then
 * reported "零声明" about a file it had never really looked at.
 *
 * WHAT IT IS NOT
 * This is not a parser and does not know Python from TypeScript. It recognises
 * the four shapes that fill a file header in every language the scanner covers —
 * line comments, block comments, triple-quoted docstrings, and import/package
 * statements — and stops at the first line that is none of them. 84 of the 107
 * measured files start with code and get `offset: 0`, so the common case is
 * untouched.
 *
 * WHY THE OFFSETS ARE LINE-BASED
 * The caller re-reads the file from `offset` and re-scans it, but every `#L<n>`
 * it reports must be a line number in the ORIGINAL file. `lineOffset` is how the
 * scanner converts its window-relative line numbers back. Measured on the same
 * sample, the shift is p50=4, p90=20, max=35 lines — so skipping this arithmetic
 * would put every citation tens of lines too high, which is worse than no
 * citation at all because a wrong line number still looks like evidence.
 */

/**
 * The result of skipping a file's preamble.
 *
 * `offset` and `lineOffset` describe the same position two ways, and both are
 * needed: `offset` slices the text, `lineOffset` fixes line numbers. When the
 * whole text is preamble there is no body to point at, so `offset` falls back to
 * 0 and `allPreamble` is the flag the caller must act on — silently returning an
 * offset past the end would make the caller render an empty excerpt and report
 * it as "zero declarations", which is the exact falsehood this module exists to
 * stop.
 */
export interface PreambleSkip {
  /** Character offset of the first body line; 0 when the whole text is preamble. */
  offset: number
  /** Lines skipped before `offset`, for converting window-relative line numbers. */
  lineOffset: number
  /** True when every line was preamble. `offset` is then 0 and the caller decides. */
  allPreamble: boolean
}

/**
 * A line that imports something, in any of the languages the scanner covers.
 *
 * `export type` is deliberately NOT here. The first version of this pattern had
 * `export\s+type\s` in it and treated `export type StepType = …` as an import
 * statement — which silently dropped three real type declarations from the
 * measured sample (`quarrydb` `StepType`, `deepdive` `ErrorCode`, `tabularis`
 * `Dialect`). An exported type IS a declaration the card is supposed to cite, so
 * matching it as preamble both hid it and moved the window past it.
 */
const IMPORT_LINE_RE = /^\s*(?:import\s|from\s+\S+\s+import\s|export\s+\*\s+from\s|export\s*\{|package\s|namespace\s|using\s|#include\s|require\s*\(|const\s+\w+\s*=\s*require\(|"use strict"|'use strict')/

/**
 * A line comment, or a shebang.
 *
 * `#(?!include)` is what keeps `#include <stdio.h>` out of this branch: it is
 * matched as an import above, and matching it here too would be harmless only by
 * accident. The lookahead makes the two rules disjoint on purpose.
 */
const LINE_COMMENT_RE = /^\s*(?:\/\/|#(?!include)|--|-->)/

/** Opening of a C-style block comment, at the start of a line. */
const BLOCK_COMMENT_OPEN_RE = /^\s*\/\*/

/**
 * Opening of a triple-quoted string used as a module docstring, at line start.
 *
 * The `[rRuUbB]?` prefix is for `r"""…"""`, which is how a Python docstring
 * carrying backslashes is written. Missing it would leave the whole docstring
 * unskipped and put the window inside prose.
 */
const DOCSTRING_OPEN_RE = /^\s*[rRuUbB]?("""|''')/

/**
 * Offsets of the first character of each line.
 *
 * Built by scanning for `\n` rather than by accumulating `line.length + 1`,
 * because the latter is off by one per line on CRLF input and the error lands
 * directly in `#L` numbers. The offset after a `\n` is the first character of the
 * next line either way.
 */
function lineStartOffsets(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/**
 * The line after a block comment that opens on `from`, or `undefined` when no
 * block comment opens there.
 *
 * An unterminated comment consumes to EOF: the rest of such a file really is
 * comment, so treating it as preamble is correct, and the caller's `allPreamble`
 * branch is what keeps that from being reported as an empty body.
 */
function blockCommentEnd(lines: readonly string[], from: number): number | undefined {
  const first = lines[from] ?? ''
  if (!BLOCK_COMMENT_OPEN_RE.test(first)) return undefined
  const openAt = first.indexOf('/*')
  if (first.indexOf('*/', openAt + 2) !== -1) return from + 1
  let i = from + 1
  while (i < lines.length) {
    if ((lines[i] ?? '').indexOf('*/') !== -1) return i + 1
    i += 1
  }
  return lines.length
}

/**
 * The line after a triple-quoted docstring that opens on `from`, or `undefined`
 * when no docstring opens there.
 *
 * The whole construct is consumed, not just its first line. That is the fix for
 * a real defect: treating `"""` as a one-line comment left the rest of a module
 * docstring unskipped, so the window started in the middle of prose and the card
 * described the file as having zero declarations.
 */
function docstringEnd(lines: readonly string[], from: number): number | undefined {
  const first = lines[from] ?? ''
  const match = DOCSTRING_OPEN_RE.exec(first)
  if (match === null) return undefined
  const delimiter = match[1] ?? ''
  if (delimiter.length === 0) return undefined
  // The opening delimiter may close on the same line: `"""The Tuya integration."""`
  const openAt = match[0].length - delimiter.length
  if (first.indexOf(delimiter, openAt + delimiter.length) !== -1) return from + 1
  let i = from + 1
  while (i < lines.length) {
    if ((lines[i] ?? '').indexOf(delimiter) !== -1) return i + 1
    i += 1
  }
  return lines.length
}

/**
 * Find the first line of a file that is not licence, comment, docstring or
 * import.
 *
 * @param text - the file's text, already truncated to whatever the caller read.
 * @returns the body offset, the line count skipped, and whether a body exists.
 */
export function skipPreamble(text: string): PreambleSkip {
  if (text.length === 0) return { offset: 0, lineOffset: 0, allPreamble: false }
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim().length === 0) { i += 1; continue }
    if (IMPORT_LINE_RE.test(line)) { i += 1; continue }
    if (LINE_COMMENT_RE.test(line)) { i += 1; continue }
    const afterBlock = blockCommentEnd(lines, i)
    if (afterBlock !== undefined) { i = afterBlock; continue }
    const afterDoc = docstringEnd(lines, i)
    if (afterDoc !== undefined) { i = afterDoc; continue }
    break
  }
  if (i >= lines.length) return { offset: 0, lineOffset: 0, allPreamble: true }
  const starts = lineStartOffsets(text)
  return { offset: starts[i] ?? 0, lineOffset: i, allPreamble: false }
}
