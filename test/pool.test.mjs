// Bounded-concurrency pool: the properties M3 depends on.
//
// `inspect_projects` now reads repositories through `mapPool` instead of a
// serial `for` loop, so the claims that make that safe have to be pinned
// behaviourally rather than read off the source:
//
//   1. it is actually CONCURRENT (otherwise M3 changed nothing);
//   2. it is actually BOUNDED (otherwise M3 manufactures 429s);
//   3. results come back in CALLER order (the card prints repositories in the
//      order they were asked for, so a shuffled array is a different card);
//   4. `limit: 1` is exactly a serial loop (this is the runtime rollback
//      position: set `INSPECT_CONCURRENCY = 1` and the old behaviour is back);
//   5. a failure surfaces once and leaves no unobserved rejection behind.
//
// Timing is asserted with slack. The point is to separate "3 lanes" from "1
// lane" (a 3x gap), not to measure the event loop: every threshold below is at
// least 1.6x away from both sides of the behaviour it distinguishes, and the
// per-item delay is large enough (40ms) that scheduler jitter cannot cross it.
//
// Run: node test/pool.test.mjs   (NOT `node --test`)

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const { mapPool } = await import(pathToFileURL(join(pkgRoot, 'lib', 'pool.js')).href)
const index = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)

let pass = 0
let fail = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}`)
    if (detail !== '') console.log(`        ${detail}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ===========================================================================
console.log('\n=== P1. the pool is concurrent, and only up to `limit` ===')
{
  const DELAY = 40
  const items = [0, 1, 2, 3, 4, 5]
  let inFlight = 0
  let peak = 0
  const started = []
  const at = Date.now()
  const outcome = await mapPool(items, 3, async (item) => {
    started.push(item)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await sleep(DELAY)
    inFlight -= 1
    return item * 10
  })
  const elapsed = Date.now() - at

  check('every item ran', outcome.results.filter((r) => r !== undefined).length === items.length,
    JSON.stringify(outcome.results))
  check('the run was not stopped early', outcome.stoppedEarly === false)
  check('results keep the caller order', JSON.stringify(outcome.results) === JSON.stringify([0, 10, 20, 30, 40, 50]),
    JSON.stringify(outcome.results))
  // 6 items / 3 lanes = 2 waves of 40ms = ~80ms. Serial would be ~240ms, so the
  // 150ms line sits 1.9x above the concurrent case and 1.6x below the serial one.
  check('three lanes really overlap (wall clock is waves, not the sum)',
    elapsed < DELAY * 4, `elapsed=${elapsed}ms for 6×${DELAY}ms at limit 3`)
  check('concurrency never exceeded the limit', peak <= 3, `peak=${peak}`)
  check('concurrency actually reached the limit', peak === 3, `peak=${peak} (expected 3)`)
  // The anti-vacuity control for the timing check above: if the worker were not
  // really awaited, `started` would be all six at once and `peak` would be 6.
  check('the worker was entered one lane at a time, not all at once', peak < items.length,
    `peak=${peak} of ${items.length}`)
}

// ===========================================================================
console.log('\n=== P2. `limit: 1` is exactly a serial loop (the rollback position) ===')
{
  const DELAY = 30
  const items = ['a', 'b', 'c', 'd']
  let peak = 0
  let inFlight = 0
  const order = []
  const at = Date.now()
  const outcome = await mapPool(items, 1, async (item) => {
    order.push(item)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await sleep(DELAY)
    inFlight -= 1
    return item.toUpperCase()
  })
  const elapsed = Date.now() - at

  check('limit 1 never has two items in flight', peak === 1, `peak=${peak}`)
  check('limit 1 runs the items in order', JSON.stringify(order) === JSON.stringify(items),
    JSON.stringify(order))
  check('limit 1 returns the same shape as any other limit',
    JSON.stringify(outcome.results) === JSON.stringify(['A', 'B', 'C', 'D']),
    JSON.stringify(outcome.results))
  // Serial: 4 × 30ms = ~120ms. Any overlap would land near 60ms.
  check('limit 1 pays the full sum of the per-item cost',
    elapsed >= DELAY * 3, `elapsed=${elapsed}ms for 4×${DELAY}ms (serial floor ~${DELAY * 3}ms)`)
}

// ===========================================================================
console.log('\n=== P3. the index is the item position, not the completion order ===')
{
  // The last item is the fastest, so a pool that filled results by completion
  // would put it first. This is the case the card would print wrong.
  const items = ['slow', 'medium', 'fast']
  const seen = []
  const outcome = await mapPool(items, 3, async (item, index) => {
    seen.push([item, index])
    await sleep(item === 'slow' ? 60 : item === 'medium' ? 30 : 1)
    return `${index}:${item}`
  })
  check('each worker got its own index', JSON.stringify(seen.sort((a, b) => a[1] - b[1])) ===
    JSON.stringify([['slow', 0], ['medium', 1], ['fast', 2]]), JSON.stringify(seen))
  check('results follow the input order even when completion order differs',
    JSON.stringify(outcome.results) === JSON.stringify(['0:slow', '1:medium', '2:fast']),
    JSON.stringify(outcome.results))
}

// ===========================================================================
console.log('\n=== P4. a bad limit cannot silently stop the pool from working ===')
{
  const items = [1, 2, 3]
  const cases = [
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['fractional', 1.9],
    ['larger than the work', 99],
  ]
  for (const [label, limit] of cases) {
    let peak = 0
    let inFlight = 0
    const outcome = await mapPool(items, limit, async (item) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(10)
      inFlight -= 1
      return item
    })
    check(`${label}: every item still runs`,
      JSON.stringify(outcome.results) === JSON.stringify(items), JSON.stringify(outcome.results))
    check(`${label}: at least one lane exists`, peak >= 1, `peak=${peak}`)
    check(`${label}: never more lanes than items`, peak <= items.length, `peak=${peak}`)
  }
}

// ===========================================================================
console.log('\n=== P5. an empty list is not an error and starts no work ===')
{
  let called = 0
  const outcome = await mapPool([], 3, async () => { called += 1; return 1 })
  check('an empty list returns no results', outcome.results.length === 0)
  check('an empty list never calls the worker', called === 0, `calls=${called}`)
  check('an empty list is not "stopped early"', outcome.stoppedEarly === false)
}

// ===========================================================================
console.log('\n=== P6. a failure is reported once, and nothing is left unobserved ===')
{
  const items = [0, 1, 2, 3, 4, 5]
  const started = []
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  let thrown
  try {
    await mapPool(items, 2, async (item) => {
      started.push(item)
      await sleep(5)
      if (item === 1) throw new Error('boom at 1')
      return item
    })
  } catch (error) {
    thrown = error
  } finally {
    // Give the microtask/macrotask queues a chance to surface a stray rejection.
    await sleep(30)
    process.off('unhandledRejection', onUnhandled)
  }

  check('the pool rejects with the worker error', thrown instanceof Error && thrown.message === 'boom at 1',
    String(thrown?.message ?? thrown))
  check('no unhandled rejection is left behind', unhandled.length === 0,
    JSON.stringify(unhandled.map((reason) => String(reason?.message ?? reason))))
  // The failure must stop NEW work: with 2 lanes and item 1 failing, item 0 is
  // already running and at most one more lane can have picked up item 2. Items
  // 3-5 must never start.
  check('a failure stops the pool from starting the rest',
    !started.includes(4) && !started.includes(5), `started=${JSON.stringify(started)}`)
}

// ===========================================================================
console.log('\n=== P7. `stopAfter` ends the run without inventing results ===')
{
  const items = [0, 1, 2, 3, 4, 5]
  const started = []
  const outcome = await mapPool(items, 2, async (item) => {
    started.push(item)
    await sleep(5)
    return item
  }, { stopAfter: (result) => result === 1 })

  check('stopAfter ends the run early', outcome.stoppedEarly === true)
  check('items that never started are holes, not fabricated values',
    outcome.results.slice(3).every((r) => r === undefined),
    JSON.stringify(outcome.results))
  check('the items that did run are reported with their real values',
    outcome.results[0] === 0 && outcome.results[1] === 1, JSON.stringify(outcome.results))
  check('stopAfter prevents later items from starting',
    !started.includes(4) && !started.includes(5), `started=${JSON.stringify(started)}`)
  // The stopping item itself must be recorded: it is evidence that was paid for.
  check('the item that triggered the stop is kept', outcome.results.includes(1),
    JSON.stringify(outcome.results))
}

// ===========================================================================
console.log('\n=== P8. the constant M3 introduced is usable as a rollback switch ===')
{
  check('INSPECT_CONCURRENCY is exported', typeof index.INSPECT_CONCURRENCY === 'number',
    `typeof=${typeof index.INSPECT_CONCURRENCY}`)
  check('INSPECT_CONCURRENCY is a positive integer',
    Number.isInteger(index.INSPECT_CONCURRENCY) && index.INSPECT_CONCURRENCY >= 1,
    `value=${index.INSPECT_CONCURRENCY}`)
  // Not a style rule: the quota argument in the constant's own comment is about
  // a single-digit in-flight count, and the whole point of the bound is that a
  // batch of five cannot become a twenty-request burst.
  check('INSPECT_CONCURRENCY stays inside the documented single-digit bound',
    index.INSPECT_CONCURRENCY <= 9, `value=${index.INSPECT_CONCURRENCY}`)
  check('INSPECT_CONCURRENCY is below the repository cap, so it can bind',
    index.INSPECT_CONCURRENCY <= 5, `value=${index.INSPECT_CONCURRENCY}`)
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
