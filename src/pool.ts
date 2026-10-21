// Bounded-concurrency mapping, order-preserving.
//
// Why this exists instead of `Promise.all`
// ----------------------------------------
// `inspect_projects` fans out over repositories, and an unbounded fan-out
// against a shared API quota is how a plugin turns its own parallelism into a
// 429 storm. `Promise.all` cannot express "at most three at a time". Every call
// site here also needs results in the CALLER's order rather than in the order
// the network happened to answer: the card prints repositories in the order they
// were asked for, and the failure list is read as a sequence, so a shuffled
// result array would be a different card.
//
// The shape is a fixed set of lanes pulling from a shared cursor. That keeps the
// in-flight count at exactly `limit` while work remains, with no batching: a
// batch barrier would idle a lane every time one item is slow, which against a
// remote API is the common case, not the exception.
//
// Failure semantics
// -----------------
// The first rejection stops the pool from STARTING new items, and is rethrown
// once the in-flight ones have settled. Items already running are not cancelled
// — cancellation belongs to the caller's `AbortSignal`, and this helper must not
// pretend to provide it. What it does guarantee is that no rejection is left
// unobserved (an unhandled rejection in a long-lived host process is a crash,
// not a log line).

/**
 * Outcome of a pool run.
 *
 * `results` has one slot per item, and a slot is `undefined` when the item was
 * never started. Holes are the honest representation: "this item did not run"
 * and "this item ran and produced nothing" are different facts, and a sentinel
 * value would conflate them.
 */
export interface PoolOutcome<R> {
  results: (R | undefined)[]
  /** True when `stopAfter` ended the run before every item was started. */
  stoppedEarly: boolean
}

/** Optional behaviour a caller can layer on top of a plain pool run. */
export interface PoolOptions<R> {
  /**
   * Consulted after each completed item; returning true starts no further items.
   *
   * This is for a batch-level condition the caller can only observe by running
   * work — a rate limit, for example, means the shared quota is gone, so
   * starting another item would spend a request already known to fail. Items
   * already in flight are allowed to settle: their results are real, and
   * discarding them would throw away evidence that was already paid for.
   */
  stopAfter?: (result: R, index: number) => boolean
}

/**
 * Run `worker` over `items` with at most `limit` calls in flight.
 *
 * @param items - work items, started in order.
 * @param limit - maximum concurrent calls; clamped to at least 1, and to
 *   `items.length` so a limit larger than the work does not spawn idle lanes.
 *   A limit of 1 is exactly a serial loop, which is what makes it a usable
 *   rollback position for every caller that adopts this helper.
 * @param worker - called once per item that starts, with its index in `items`.
 * @param options - optional early stop, see {@link PoolOptions}.
 * @returns the per-item results in the same order as `items` (holes for items
 *   that never started) and whether the run was stopped early.
 * @throws the first error any worker threw, once the pool has drained.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: PoolOptions<R> = {},
): Promise<PoolOutcome<R>> {
  const total = items.length
  const results = new Array<R | undefined>(total)
  if (total === 0) return { results, stoppedEarly: false }

  // A non-finite limit would make `Math.min` below NaN, and a NaN lane count
  // starts zero lanes — a pool that silently does no work. The call sites pass a
  // module constant, so this guards a bad edit rather than a bad argument.
  const requested = Number.isFinite(limit) ? Math.floor(limit) : 1
  const width = Math.max(1, Math.min(requested, total))

  let cursor = 0
  let stopped = false
  let failure: { error: unknown } | undefined
  const stopAfter = options.stopAfter

  const lane = async (): Promise<void> => {
    for (;;) {
      if (stopped) return
      // Read and advance the cursor with no `await` in between, so two lanes can
      // never claim the same index.
      const index = cursor
      cursor += 1
      if (index >= total) return
      let result: R
      try {
        result = await worker(items[index] as T, index)
      } catch (error) {
        // Only the FIRST failure is reported: the rest are consequences of it,
        // and a caller reading a rate-limit error does not want four copies.
        if (failure === undefined) failure = { error }
        stopped = true
        return
      }
      results[index] = result
      if (stopAfter !== undefined && stopAfter(result, index)) {
        stopped = true
        return
      }
    }
  }

  const lanes = new Array<Promise<void>>(width)
  for (let index = 0; index < width; index += 1) lanes[index] = lane()
  await Promise.all(lanes)

  if (failure !== undefined) throw failure.error
  return { results, stoppedEarly: stopped }
}
