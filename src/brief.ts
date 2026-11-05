/**
 * dsh-find-ideas — what a search result tells the model to do next.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Until 0.5.0 the `scout_projects` description said, in capitals, that the model
 * MUST call `rank_candidates` afterwards. Measured cost of that MUST: the
 * arguments of a single `rank_candidates` call run 8.2 KB–18 KB, because it
 * demands the whole candidate array plus four dimension scores per row. For a
 * first look at a vague idea that is a large amount of work spent before the
 * user has even seen the names.
 *
 * The user's decision was not to delete the MUST but to split it: a small first
 * search returns a first look, and ranking is what you do when the user asks to
 * go deeper. That split cannot live in the tool description alone, because the
 * description is read once at planning time and cannot know whether THIS result
 * is a first look or a deliberate deep dive. So the tool takes a `mode`
 * parameter, and the returned text carries the reminder for the mode that ran —
 * the one place the model reads after seeing the rows.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not touch the result VALUE. `mode` changes one paragraph of text, never
 * the candidate list, so every caller that ignores the parameter keeps exactly
 * the value it got before. The honesty machinery in `render.ts` (degraded notes,
 * probe notes, per-term coverage, archived markers, the small-project note) is
 * included in both modes: a brief view that dropped those would be shorter and
 * wrong, because those notes are what stop a thin or partial result from reading
 * as a fact about GitHub.
 */

/** The two positions of the `mode` parameter. */
export type ScoutMode = 'brief' | 'full'

/** What `mode` means when the caller omits it. */
export const DEFAULT_SCOUT_MODE: ScoutMode = 'brief'

/** The valid `mode` values, in documentation order. */
export const SCOUT_MODES: readonly ScoutMode[] = ['brief', 'full']

/**
 * Read a `mode` value, or undefined when it is not one of the two.
 *
 * @param value - the raw argument.
 * @returns the mode, or undefined.
 */
export function normalizeScoutMode(value: unknown): ScoutMode | undefined {
  if (typeof value !== 'string') return undefined
  return SCOUT_MODES.find((mode) => mode === value)
}

/**
 * The line a brief result ends with.
 *
 * Written as a permission rather than a prohibition: the model reading a first
 * look should not feel it owes the user a ranking, but it must also know the
 * ranking path still exists — the alternative (saying nothing about
 * `rank_candidates`) would make a deep dive unreachable from a brief result.
 */
export const BRIEF_NEXT_STEP =
  '本次为速览、未打分。把上面这些名字和一句话简介直接给用户看就够了；' +
  '只有用户想深入对比、或从中挑了几个项目时，再调 rank_candidates 打分并生成卡片。' +
  '不要为了一次随口一问就先跑打分。'

/**
 * The line a full result ends with.
 *
 * This is the old MUST, moved from the tool description to the place where the
 * model has actually seen the rows and can be asked to score them.
 */
export const FULL_NEXT_STEP =
  '本次为完整模式：接下来调用 rank_candidates，为你认为相关的每个候选打上 problem_fit / workflow_fit / ' +
  'technical_fit（0-5，未测就填 null），排名和 star 权重由代码计算。不要自己给这些原始结果排序。'

/**
 * Frame a rendered card with the next-step paragraph for the mode that ran.
 *
 * @param card - the rendered candidate card, or the empty-result card.
 * @param mode - the mode the call ran in.
 * @param prior - the prior-context block, appended after the card when present.
 * @returns the text block the model reads.
 */
export function frameScoutResult(card: string, mode: ScoutMode, prior: string = ''): string {
  const note = mode === 'full' ? FULL_NEXT_STEP : BRIEF_NEXT_STEP
  const head = prior.length > 0 ? `${card}\n\n${prior}` : card
  return `${head}\n\n${note}`
}

/**
 * Read the mode out of validated tool arguments.
 *
 * `render` receives the raw argument object, whose `mode` is optional at the
 * schema level; the default therefore has to be applied here as well as in
 * `execute`, or an omitted parameter would render as if it were `full`.
 *
 * @param args - the tool's validated arguments.
 * @returns the mode to render for.
 */
export function scoutModeOf(args: unknown): ScoutMode {
  if (args === null || typeof args !== 'object') return DEFAULT_SCOUT_MODE
  return normalizeScoutMode((args as { mode?: unknown }).mode) ?? DEFAULT_SCOUT_MODE
}
