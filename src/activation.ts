/**
 * dsh-find-ideas — the activation surface: when the model should think of this
 * plugin at all.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Until 0.4.1 the only thing that told a model this plugin existed was the
 * `scout_projects` tool description, and that description opened with "Search
 * GitHub for open-source projects". Measured on the author's own session logs
 * (57 sessions, every `scout_projects` call): 11 sessions had called the tool,
 * and in 11 of 11 the last user message before the first call contained the
 * literal word "GitHub". Four user messages carried a buildable idea without
 * that word; none of them triggered a search. The trigger was not "the user has
 * an idea" — it was "the user said GitHub".
 *
 * A tool description is one line item in a list of a hundred-odd tools. A
 * plugin that wants to be considered for "我想做个番茄钟，有什么建议" needs a
 * second, wider surface: a system-prompt section that states the *situation*
 * (an idea exists) rather than the *action* (search GitHub). This module owns
 * that section and the one mechanically-enforced rule that goes with it.
 *
 * TWO SURFACES, TWO JOBS
 * ----------------------
 *   1. The section says WHEN to search and WHEN NOT to. It is guidance: broad,
 *      scenario-shaped, and cheap to change.
 *   2. The guard enforces the one rule the user asked to be mechanical — say a
 *      sentence before searching, so the user sees why a search is starting.
 *      Guidance alone was not enough for this one: a model that decides to call
 *      a tool rarely spends a token explaining itself first.
 *
 * Both registrations are optional. The plugin's tool registration must keep
 * working on a host that has neither service, because a plugin module that
 * throws while loading takes the whole host down with it (see the note at
 * `src/index.ts:164` about looking services up with `ctx.get` rather than
 * declaring them in `inject`).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolGuard } from '@deepseek-ai/dsh-tools'

/** The tool this module's guidance is about. */
export const SCOUT_TOOL_NAME = 'scout_projects'

/**
 * Every tool this plugin registers, in the order a session meets them.
 *
 * The section renders only while at least one of them is visible to the
 * rendering scope, so a profile that restricts the plugin away does not keep
 * advertising it in the prompt.
 */
export const FIND_IDEAS_TOOL_NAMES: readonly string[] = [
  'scout_projects',
  'rank_candidates',
  'inspect_projects',
  'read_repo_files',
]

/**
 * Order of this plugin's guidance section.
 *
 * Third-party plugins share a band between the deployment persona (0) and the
 * harness policy sections (PLAN_POLICY = 500): dsh-ssh takes 150, this plugin
 * 160, task-board 200, agents 220. Adjacent slots matter because the band is
 * read top to bottom; a plugin that wants to be considered early takes a low
 * number without colliding with a neighbour.
 */
export const SECTION_ORDER = 160

/** Section identity. Duplicate names in one layer throw, so it must be unique. */
export const SECTION_NAME = 'plugin:dsh-find-ideas'

/**
 * Model-facing guidance: the situation in which this plugin is worth using.
 *
 * Written as English rules with Chinese examples on purpose. The rules are
 * English because the rest of the harness prompt is; the examples are the
 * actual sentences Chinese-speaking users type, and an example in the user's
 * own language is what makes "an idea exists" recognisable as a situation
 * rather than as a keyword.
 */
export const SCOUT_GUIDANCE =
  'dsh-find-ideas is installed in this session: it searches GitHub for open-source projects similar to an ' +
  'idea, ranks them, and can read their code. When the user asks what you can do, list "research whether a ' +
  'similar open-source project already exists" among your capabilities in one line.\n\n' +
  'SEARCH WHEN the user has an idea for something to build, even before it is precise, and even if they ' +
  'never say "GitHub": "我想做个番茄钟，有什么建议？", "我想弄个能自动整理小红书收藏的工具", "这个该怎么做？", ' +
  '"有没有现成的？", "要是有个……就好了". A request for advice, a question about how to start, or a wish for ' +
  'a tool all count.\n\n' +
  'DO NOT SEARCH when: the user is already building it (writing code, debugging, asking about implementation ' +
  'details of code they have); you already searched this same idea earlier in this session; the question is ' +
  'pure technical Q&A or a concept explanation ("什么是 CRDT？"); or the user said not to search. At most two ' +
  'unprompted searches per session — after that, ask before searching again.\n\n' +
  'HOW TO SEARCH: first say one short sentence to the user about what you are about to look for, then call ' +
  'scout_projects with limit 5-8 for an unprompted search. The tool refuses a call that arrives without that ' +
  'sentence, so announce first. If the search finds nothing, say so and treat it as a blank space worth ' +
  'designing from — never as "this cannot be done".'

/**
 * The refusal a call gets when it arrives without a preceding announcement.
 *
 * A guard's return value is the tool result the model reads, so this string is
 * the whole recovery instruction: what went wrong, the exact sentence to write,
 * and the retry. It is not an error the user should ever see — the model gets
 * one turn to comply, and it is told so.
 */
export const ANNOUNCEMENT_DENIAL =
  'Refused: announce before searching. Say one short sentence to the user about what you are about to look ' +
  'for (for example "我先去 GitHub 小搜一下有没有现成的项目，稍等"), then call scout_projects again. The ' +
  'user must see why a search is starting before it starts.'

/**
 * How many unprompted searches one session may run before the model must ask.
 *
 * The number is a promise made to the user in `SCOUT_GUIDANCE` ("At most two
 * unprompted searches per session"). It is enforced mechanically because a
 * prompt-only cap decays: after the second search the model has already decided
 * a third is worth it, which is exactly the moment a sentence in a prompt loses
 * to the model's own judgement.
 */
export const MAX_UNPROMPTED_SEARCHES = 2

/**
 * The refusal a call gets once the unprompted-search budget is spent.
 *
 * Unlike the announcement refusal this one is not a "do it again properly"
 * nudge: the recovery is to stop and ask the user, so the wording has to make
 * asking the cheapest next move and retrying obviously pointless.
 */
export const BUDGET_DENIAL =
  'Refused: this session has already run ' +
  String(MAX_UNPROMPTED_SEARCHES) +
  ' unprompted searches. Stop and ask the user before searching again: say what you would look for and ' +
  'why, and wait for their answer. If they say yes, call scout_projects again — a search the user asked ' +
  'for is not charged to this budget.'

/**
 * The three positions of the `autoScout` setting.
 *
 * - `always` (default): search on the model's own judgement, announcing first
 *   and stopping at `MAX_UNPROMPTED_SEARCHES`.
 * - `ask`: never search without the user agreeing; the guidance states the
 *   asking rule, the announcement guard still applies to the eventual call.
 * - `off`: no guidance section and no guard. The four tools stay registered and
 *   callable — "off" means "do not advertise", not "uninstall".
 */
export type AutoScoutMode = 'always' | 'ask' | 'off'

/** The valid `autoScout` values, in the order they are documented. */
export const AUTO_SCOUT_MODES: readonly AutoScoutMode[] = ['always', 'ask', 'off']

/** What `autoScout` means when the host supplies no configuration. */
export const DEFAULT_AUTO_SCOUT: AutoScoutMode = 'always'

/**
 * Read an `autoScout` value, or undefined when it is not one of the three.
 *
 * Both the Config schema and `apply` call this, so a value that reached `apply`
 * by a path that skipped validation (a test calling `apply(ctx, …)` directly, a
 * host that ignores `Config`) is normalised the same way it is validated.
 *
 * @param value - the raw configured value.
 * @returns the mode, or undefined when the value is not a mode.
 */
export function normalizeAutoScout(value: unknown): AutoScoutMode | undefined {
  if (typeof value !== 'string') return undefined
  return AUTO_SCOUT_MODES.find((mode) => mode === value)
}

/**
 * The guidance for `autoScout: 'ask'`.
 *
 * Same situations and same boundaries as `SCOUT_GUIDANCE` — the difference is
 * the one sentence that decides who makes the call. Kept as a separate constant
 * rather than a flag so neither text has to be read with a conditional in mind.
 */
export const SCOUT_GUIDANCE_ASK =
  'dsh-find-ideas is installed in this session: it searches GitHub for open-source projects similar to an ' +
  'idea, ranks them, and can read their code. When the user asks what you can do, list "research whether a ' +
  'similar open-source project already exists" among your capabilities in one line.\n\n' +
  'SEARCH WHEN the user has an idea for something to build, even before it is precise, and even if they ' +
  'never say "GitHub": "我想做个番茄钟，有什么建议？", "我想弄个能自动整理小红书收藏的工具", "这个该怎么做？", ' +
  '"有没有现成的？", "要是有个……就好了". A request for advice, a question about how to start, or a wish for ' +
  'a tool all count.\n\n' +
  'DO NOT SEARCH when: the user is already building it (writing code, debugging, asking about implementation ' +
  'details of code they have); you already searched this same idea earlier in this session; the question is ' +
  'pure technical Q&A or a concept explanation ("什么是 CRDT？"); or the user said not to search.\n\n' +
  'ASK FIRST: this session is set to ask before searching. Say in one short sentence what you would search ' +
  'for and why, then wait for the user to agree. Only after they agree, call scout_projects with limit 5-8. ' +
  'The tool refuses a call that arrives without a sentence the user can see, so announce even then. If the ' +
  'search finds nothing, say so and treat it as a blank space worth designing from — never as "this cannot ' +
  'be done".'

/** Minimal shapes this module reads out of the session log. */
export interface ActivationContentBlock {
  readonly type?: unknown
  readonly text?: unknown
}

/** One derived conversation message, as much of it as this module inspects. */
export interface ActivationMessage {
  readonly role?: unknown
  readonly content?: unknown
}

/** One committed session event, as much of it as this module inspects. */
export interface ActivationEvent {
  readonly type?: unknown
  readonly data?: unknown
}

/**
 * Look a service up without requiring it.
 *
 * `ctx.get` is the documented way to read a service the plugin does not declare
 * in `inject` (see `src/index.ts:164`); a host without the service, or a fake
 * context in a test, simply yields undefined.
 *
 * @param ctx - plugin context.
 * @param name - service name.
 * @returns the service, or undefined when absent.
 */
function lookupService(ctx: Context, name: string): unknown {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Build a section text provider that renders only while one of the tools is
 * visible to the rendering scope.
 *
 * The same shape the first-party-adjacent plugins use (`dsh-ssh`): with no tool
 * runtime to ask, render unconditionally; otherwise ask per assembly and fall
 * back to rendering on any lookup failure, because a missing guidance paragraph
 * is a worse failure than a stale one.
 *
 * @param tools - the plugin's tool runtime, or undefined.
 * @param toolNames - names that keep the text alive.
 * @param text - the guidance text.
 * @returns a provider for `SystemPrompt.section`.
 */
export function visibleToolText(
  tools: unknown,
  toolNames: readonly string[],
  text: string,
): (context: { readonly scope?: unknown }) => string {
  const runtime = tools as { get?: (name: string, scope?: unknown) => unknown } | undefined
  if (runtime === undefined || typeof runtime.get !== 'function') return () => text
  const get = runtime.get.bind(runtime)
  return (context) => {
    for (const name of toolNames) {
      try {
        if (get(name, context?.scope) !== undefined) return text
      } catch {
        return text
      }
    }
    return ''
  }
}

/**
 * Whether an assistant message carries text the user can actually see.
 *
 * Only `text` blocks count. A reasoning block is not shown to the user, so a
 * model that thought about searching has not announced anything.
 *
 * @param message - one derived message.
 * @returns true when at least one non-blank text block is present.
 */
function messageHasVisibleText(message: ActivationMessage | undefined): boolean {
  if (message === undefined || message.role !== 'assistant') return false
  const content = message.content
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as ActivationContentBlock
    if (typed.type !== 'text') continue
    if (typeof typed.text === 'string' && typed.text.trim().length > 0) return true
  }
  return false
}

/**
 * Pull the message out of an `assistant/message` event.
 *
 * @param event - one session event.
 * @returns the message, or undefined when the event carries none.
 */
function eventMessage(event: ActivationEvent): ActivationMessage | undefined {
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  const message = (data as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return undefined
  return message as ActivationMessage
}

/**
 * Whether the current turn already contains a user-visible assistant sentence.
 *
 * The turn boundary is the last `turn/start` event, because "the model said
 * hello in a previous turn" must not license a silent search now. When the log
 * carries no `turn/start` at all — a trimmed or replayed log — the whole
 * snapshot is scanned instead: the guard is a nudge, and failing open is
 * cheaper than blocking a legitimate search on an unusual log shape.
 *
 * @param events - the session's committed events, in order.
 * @returns true when this turn has an assistant message with visible text.
 */
export function turnHasAnnouncement(events: readonly ActivationEvent[]): boolean {
  let start = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      start = index
      break
    }
  }
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'assistant/message') continue
    if (messageHasVisibleText(eventMessage(event))) return true
  }
  return false
}

/**
 * Read the event snapshot of one live session, if it can be read synchronously.
 *
 * `snapshotEvents()` is deprecated in favour of asynchronous reads, but a guard
 * is synchronous by contract — this is the only read available at that point.
 * The deprecation is accepted deliberately, and a failure yields undefined so
 * the caller can fail open.
 *
 * @param session - the session object from the store.
 * @returns the events, or undefined when unavailable.
 */
function readSessionEvents(session: unknown): readonly ActivationEvent[] | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const candidate = session as {
    snapshotEvents?: () => readonly ActivationEvent[]
    ownEvents?: () => readonly ActivationEvent[]
  }
  try {
    if (typeof candidate.snapshotEvents === 'function') return candidate.snapshotEvents()
    if (typeof candidate.ownEvents === 'function') return candidate.ownEvents()
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Read the tool name out of a `tool/call` event.
 *
 * @param event - one session event.
 * @returns the name, or undefined when the event is not a tool call.
 */
function eventToolCallName(event: ActivationEvent): string | undefined {
  if (event.type !== 'tool/call') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  const name = (data as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

/**
 * Read the call id out of a `tool/result` event.
 *
 * Two shapes exist in the log: the tool message carries `toolCallId`, and its
 * `source` carries the same id as `callId`. Both are read because a trimmed or
 * replayed log may carry only one of them.
 *
 * @param event - one session event.
 * @returns the call id, or undefined when the event is not a tool result.
 */
function eventToolResultCallId(event: ActivationEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  const message = (data as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return undefined
  const direct = (message as { toolCallId?: unknown }).toolCallId
  if (typeof direct === 'string') return direct
  const source = (message as { source?: unknown }).source
  if (source === null || typeof source !== 'object') return undefined
  const nested = (source as { callId?: unknown }).callId
  return typeof nested === 'string' ? nested : undefined
}

/**
 * Whether a `tool/result` reports a refusal or a failure rather than a result.
 *
 * This is what keeps the budget honest: a call the guard refused, or a search
 * that failed at the transport, never returned candidates and must not be
 * charged as one of the session's searches.
 *
 * @param event - one session event.
 * @returns true when the event is an error result.
 */
function eventIsErrorResult(event: ActivationEvent): boolean {
  if (event.type !== 'tool/result') return false
  const data = event.data
  if (data === null || typeof data !== 'object') return false
  if ((data as { error?: unknown }).error !== undefined) return true
  const message = (data as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return false
  return (message as { isError?: unknown }).isError === true
}

/**
 * Count the searches this session has actually run.
 *
 * A search counts when its `scout_projects` call has a SUCCESSFUL result. Both
 * halves matter:
 *
 *   - Counting `tool/call` alone would charge refusals to the budget, so the
 *     model would spend its two searches on two rejected attempts.
 *   - Counting `tool/result` alone cannot tell which tool produced it.
 *
 * The current call is excluded by id, because whether the host commits
 * `tool/call` before or after the guard runs is not part of the guard contract.
 *
 * @param events - the session's committed events, in order.
 * @param currentCallId - id of the call being guarded, if the host supplies it.
 * @returns the number of completed searches.
 */
export function countCompletedScoutCalls(
  events: readonly ActivationEvent[],
  currentCallId?: string,
): number {
  const completed = new Set<string>()
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (eventIsErrorResult(event)) continue
    const callId = eventToolResultCallId(event)
    if (callId !== undefined) completed.add(callId)
  }
  let count = 0
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (eventToolCallName(event) !== SCOUT_TOOL_NAME) continue
    const data = event.data as { callId?: unknown }
    const callId = typeof data.callId === 'string' ? data.callId : undefined
    if (callId === undefined) continue
    if (currentCallId !== undefined && callId === currentCallId) continue
    if (completed.has(callId)) count += 1
  }
  return count
}

/**
 * Whether a `user/message` event carries something the human actually typed.
 *
 * Most `user/message` events in a real log are NOT the user talking: they are
 * the runtime injecting `time-context`, `runtime-context`, the skill catalog,
 * compaction checkpoints, approval results, background-job notices. Measured on
 * 58 local logs, real user speech (`source.kind === 'user'`) is 140 of 831
 * `user/message` events — the rest arrive on almost every step. A budget whose
 * release valve read all of them would find "the user just spoke" on every
 * single step and release itself forever.
 *
 * A missing `source` counts as real: an older or trimmed log that dropped the
 * field must not silently disable the valve.
 *
 * @param event - one session event.
 * @returns true when the event is a message the user typed.
 */
function eventIsUserSpeech(event: ActivationEvent): boolean {
  if (event.type !== 'user/message') return false
  const data = event.data
  if (data === null || typeof data !== 'object') return false
  const source = (data as { source?: unknown }).source
  if (source === null || typeof source !== 'object') return true
  const kind = (source as { kind?: unknown }).kind
  if (typeof kind !== 'string') return true
  return kind === 'user'
}

/**
 * Index of the last message the user actually typed, or -1 when there is none.
 *
 * @param events - the session's committed events, in order.
 * @returns the index, or -1.
 */
export function lastUserMessageIndex(events: readonly ActivationEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object') continue
    if (eventIsUserSpeech(event)) return index
  }
  return -1
}

/**
 * Index of the last `scout_projects` call in the log, or -1 when there is none.
 *
 * @param events - the session's committed events, in order.
 * @returns the index, or -1.
 */
export function lastScoutCallIndex(events: readonly ActivationEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object') continue
    if (eventToolCallName(event) === SCOUT_TOOL_NAME) return index
  }
  return -1
}

/**
 * Whether this session has spent its unprompted-search budget AND has not been
 * given a fresh go-ahead since.
 *
 * The release valve is the user speaking after the last search. Without it the
 * budget would be a permanent block: the denial tells the model to ask the user,
 * the user says yes, and the retry would be refused by the same rule. With it,
 * the rule after the cap becomes "one search per user reply", which is exactly
 * what "ask first" means in mechanical terms — and it needs no reading of the
 * user's intent, only the position of their last message in the log.
 *
 * @param events - the session's committed events, in order.
 * @param currentCallId - id of the call being guarded, if the host supplies it.
 * @returns true when the call must be refused on budget grounds.
 */
export function scoutBudgetSpent(
  events: readonly ActivationEvent[],
  currentCallId?: string,
): boolean {
  if (countCompletedScoutCalls(events, currentCallId) < MAX_UNPROMPTED_SEARCHES) return false
  return lastUserMessageIndex(events) < lastScoutCallIndex(events)
}

/**
 * Read the session's committed events for one tool execution, if possible.
 *
 * Fails open in every situation it cannot judge: no agent on the execution, no
 * session store, no session for that id, an unreadable log.
 *
 * @param ctx - plugin context.
 * @param execution - the tool execution being guarded.
 * @returns the events, or undefined when they cannot be read.
 */
function sessionEventsFor(ctx: Context, execution: { agent?: { id: unknown } }): readonly ActivationEvent[] | undefined {
  const agent = execution.agent
  if (agent === undefined) return undefined
  const store = lookupService(ctx, 'sessions') as { get?: (id: unknown) => unknown } | undefined
  if (store === undefined || typeof store.get !== 'function') return undefined
  const session = store.get(agent.id)
  if (session === undefined) return undefined
  return readSessionEvents(session)
}

/**
 * Build the guard for `scout_projects`: the announcement rule, then the budget.
 *
 * Two refusals in one guard, in a deliberate order. The budget is checked first
 * because it is the harder stop — when both apply, the useful next action is
 * "ask the user", not "say a sentence and retry", and the model reads one
 * refusal per attempt.
 *
 * Fails open wherever it cannot judge: a guard that blocked work because the
 * host changed shape would be worse than the silence it prevents.
 *
 * @param ctx - plugin context.
 * @param mode - the configured auto-scout mode.
 * @returns a tool guard.
 */
export function createScoutGuard(ctx: Context, mode: AutoScoutMode = DEFAULT_AUTO_SCOUT): ToolGuard {
  return (execution) => {
    if (execution.name !== SCOUT_TOOL_NAME) return undefined
    if (mode === 'off') return undefined
    const events = sessionEventsFor(ctx, execution)
    if (events === undefined) return undefined
    const callId = typeof execution.callId === 'string' ? execution.callId : undefined
    if (scoutBudgetSpent(events, callId)) return BUDGET_DENIAL
    return turnHasAnnouncement(events) ? undefined : ANNOUNCEMENT_DENIAL
  }
}

/**
 * Build the announcement-only guard.
 *
 * Kept as a named export because it is the rule on its own, without the budget:
 * a host or a test that wants to reason about "did the model speak first" should
 * not have to simulate two searches to get past the other check.
 *
 * @param ctx - plugin context.
 * @returns a tool guard.
 */
export function createAnnouncementGuard(ctx: Context): ToolGuard {
  return (execution) => {
    if (execution.name !== SCOUT_TOOL_NAME) return undefined
    const events = sessionEventsFor(ctx, execution)
    if (events === undefined) return undefined
    return turnHasAnnouncement(events) ? undefined : ANNOUNCEMENT_DENIAL
  }
}

/**
 * The plugin configuration schema, in the `~standard` shape cordis validates.
 *
 * Hand-written rather than built from `@deepseek-ai/schemastery`, because this
 * package ships zero runtime dependencies and a config schema is not a reason
 * to acquire one: cordis only ever calls `Config['~standard'].validate(config)`
 * and reads `{ value }` or `{ issues }` back (see `resolveConfig` in
 * `node_modules/@deepseek-ai/cordis/lib/index.js:956-963`). A missing or
 * non-object config resolves to the default; an unknown mode is reported as an
 * issue rather than silently falling back, so a typo in `cordis.patch.yml`
 * fails the load with the offending value named.
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-find-ideas',
    validate(value: unknown): { value: { autoScout: AutoScoutMode } } | { issues: { message: string; path: string[] }[] } {
      const source = value === null || typeof value !== 'object' ? {} : (value as Record<string, unknown>)
      const raw = source.autoScout
      if (raw === undefined || raw === null) return { value: { autoScout: DEFAULT_AUTO_SCOUT } }
      const mode = normalizeAutoScout(raw)
      if (mode === undefined) {
        return {
          issues: [{
            message:
              `$.autoScout expected ${AUTO_SCOUT_MODES.map((entry) => JSON.stringify(entry)).join(' | ')} ` +
              `but got ${JSON.stringify(raw)}`,
            path: ['autoScout'],
          }],
        }
      }
      return { value: { autoScout: mode } }
    },
  },
}

/** The validated shape `Config` produces. */
export interface FindIdeasConfig {
  readonly autoScout: AutoScoutMode
}

/**
 * Turn whatever the host passed as `config` into a usable mode.
 *
 * The second `apply` argument is absent in every pre-0.5.0 host and in the 21
 * tests that call `apply(ctx)` with one argument, so this cannot assume an
 * object. An unreadable config falls back to the default instead of throwing:
 * a bad config file must not take four tools down with it.
 *
 * @param config - the raw second argument to `apply`.
 * @returns the mode to use.
 */
export function resolveAutoScout(config: unknown): AutoScoutMode {
  if (config === null || typeof config !== 'object') return DEFAULT_AUTO_SCOUT
  const mode = normalizeAutoScout((config as { autoScout?: unknown }).autoScout)
  return mode ?? DEFAULT_AUTO_SCOUT
}

/**
 * Register both activation surfaces on a host that offers them.
 *
 * Called from `apply`. Every step is feature-detected and wrapped, because the
 * tool registrations that follow (and the 21 tests that drive `apply` with a
 * two-property fake context) must not depend on either service existing.
 *
 * @param ctx - plugin context.
 */
export function registerActivation(
  ctx: Context,
  mode: AutoScoutMode = DEFAULT_AUTO_SCOUT,
): void {
  // `off` is the "do not advertise" position: the tools stay registered and
  // callable, but nothing in the prompt points at them and no call is refused.
  // A user who turned auto-scouting off is still allowed to ask for a search.
  if (mode === 'off') return

  registerSection(ctx, mode)

  if (typeof ctx.tools.guard === 'function') {
    try {
      ctx.tools.guard(createScoutGuard(ctx, mode))
    } catch {
      // Same rule: a guard is a nudge, never a reason for the plugin to fail.
    }
  }
}

/**
 * Register the guidance section on whichever service handle is available.
 *
 * `ctx.get` is STRICT by default in cordis — it answers `undefined` for a
 * service that exists but is not active yet. A bundle's `apply` can run before
 * the system-prompt service has settled, so looking it up once here would
 * silently register no section at all on exactly the hosts that need it.
 * `ctx.inject` is the deferred form: the body runs when the service appears and
 * re-runs if it is replaced.
 *
 * The `get` path stays for hosts (and the fake contexts in this repo's tests)
 * that expose a service table but not `inject`.
 *
 * @param ctx - plugin context.
 */
function registerSection(ctx: Context, mode: AutoScoutMode = DEFAULT_AUTO_SCOUT): void {
  const text = mode === 'ask' ? SCOUT_GUIDANCE_ASK : SCOUT_GUIDANCE
  const mount = (prompted: Context): void => {
    const systemPrompt = lookupService(prompted, 'systemPrompt') as
      | { section?: (section: { name: string; order: number; text: unknown }) => unknown }
      | undefined
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
    try {
      systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: visibleToolText(prompted.tools, FIND_IDEAS_TOOL_NAMES, text),
      })
    } catch {
      // A duplicate section name must not take the four tools down with it: the
      // description still carries the activation rules on its own.
    }
  }

  const inject = (ctx as unknown as {
    inject?: (deps: string[], callback: (scope: Context) => void) => unknown
  }).inject
  if (typeof inject === 'function') {
    try {
      inject.call(ctx, ['systemPrompt'], mount)
      return
    } catch {
      // Fall through to the eager lookup: a host whose `inject` rejects this
      // dependency may still have the service mounted already.
    }
  }
  mount(ctx)
}
