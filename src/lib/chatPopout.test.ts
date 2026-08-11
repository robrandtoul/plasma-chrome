// Unit tests for chatPopout.ts
// Run with: npx tsx src/lib/chatPopout.test.ts
//
// The popout's window handling is DOM work that only a browser can exercise,
// but three rules underneath it decide whether the feature behaves, and all
// three are pure:
//
//   1. "Is this window the popout?" — read wrong, the popped-out window mutes
//      itself and the main window dings, which is exactly backwards.
//   2. "Is the popout still there?" — a force-quit sends no farewell, so the
//      main window has to notice the silence. Too eager and chat vanishes from
//      the header while it is still open in front of you; too slow and the
//      header claims a window that has gone.
//   3. The saved size must never come back as zero — a window reports 0×0 in
//      some browsers while it is closing, and that is the moment we read it.

import {
  clampPopoutSize,
  isPopoutSearch,
  popoutIsAlive,
  windowFeatures,
  DEFAULT_POPOUT_SIZE,
  MIN_POPOUT_W,
  MIN_POPOUT_H,
  POPOUT_ALIVE_MS,
  POPOUT_HEARTBEAT_MS,
} from './chatPopout.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${(err as Error).message}`)
    failed++
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEquals<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
    )
  }
}

// ── isPopoutSearch ──────────────────────────────────────────────────────────

console.log('\nisPopoutSearch')

test('recognises the popout query string', () => {
  assert(isPopoutSearch('?popout=1'), '?popout=1 should mark a popout window')
})

test('recognises it alongside other params, in any order', () => {
  assert(isPopoutSearch('?thread=team&popout=1'), 'trailing popout param missed')
  assert(isPopoutSearch('?popout=1&thread=team'), 'leading popout param missed')
})

test('an ordinary /chat window is not a popout', () => {
  assert(!isPopoutSearch(''), 'no query string should not be a popout')
  assert(!isPopoutSearch('?thread=team'), 'unrelated params should not be a popout')
})

test('only the exact opt-in counts', () => {
  // Guards against a half-written link ("?popout=") flipping a normal window
  // into popout mode, where it would silence the main window's notifications.
  assert(!isPopoutSearch('?popout='), 'empty value should not count')
  assert(!isPopoutSearch('?popout=0'), 'popout=0 should not count')
  assert(!isPopoutSearch('?popouts=1'), 'a different param should not count')
})

// ── popoutIsAlive ───────────────────────────────────────────────────────────

console.log('\npopoutIsAlive')

const NOW = 1_000_000

test('a window that has never been heard from is not alive', () => {
  assert(!popoutIsAlive(0, NOW), 'a zero timestamp means no popout has announced itself')
})

test('a beat just received counts as alive', () => {
  assert(popoutIsAlive(NOW, NOW), 'a beat at this instant should count')
})

test('survives a missed beat', () => {
  // The whole point of the grace window: one dropped beat (a busy main thread,
  // a backgrounded window) must not make chat disappear from the header.
  assert(
    popoutIsAlive(NOW - POPOUT_HEARTBEAT_MS * 2, NOW),
    'two beats of silence should still count as alive',
  )
})

test('a long silence means it has gone', () => {
  assert(!popoutIsAlive(NOW - POPOUT_ALIVE_MS - 1, NOW), 'past the grace window it should be gone')
})

test('the grace window leaves room for at least two missed beats', () => {
  // If the window were tighter than the beat, a popout would flicker in and
  // out of existence between heartbeats.
  assert(
    POPOUT_ALIVE_MS >= POPOUT_HEARTBEAT_MS * 2,
    'POPOUT_ALIVE_MS must span more than one heartbeat or the popout flickers',
  )
})

// ── clampPopoutSize ─────────────────────────────────────────────────────────

console.log('\nclampPopoutSize')

test('keeps a sensible size as-is', () => {
  assertEquals(clampPopoutSize({ w: 500, h: 700 }), { w: 500, h: 700 }, 'a valid size should pass through')
})

test('a closing window reporting 0×0 cannot shrink the next one below usable', () => {
  assertEquals(
    clampPopoutSize({ w: 0, h: 0 }),
    { w: MIN_POPOUT_W, h: MIN_POPOUT_H },
    'zero should clamp to the minimum, not persist as zero',
  )
})

test('rounds fractional sizes', () => {
  assertEquals(clampPopoutSize({ w: 500.6, h: 700.4 }), { w: 501, h: 700 }, 'sizes should be whole pixels')
})

test('the default is itself valid', () => {
  assertEquals(clampPopoutSize(DEFAULT_POPOUT_SIZE), DEFAULT_POPOUT_SIZE, 'the default must not be clamped')
})

// ── windowFeatures ──────────────────────────────────────────────────────────

console.log('\nwindowFeatures')

test('parks the window inside the right-hand edge of the app window', () => {
  // App at x=0, 1440 wide, a 420-wide popout → 1440 - 420 - 40 = 980.
  const f = windowFeatures({ w: 420, h: 620 }, { x: 0, y: 0, width: 1440 })
  assert(f.includes('width=420'), `width missing: ${f}`)
  assert(f.includes('height=620'), `height missing: ${f}`)
  assert(f.includes('left=980'), `left should sit inside the right edge: ${f}`)
  assert(f.includes('top=80'), `top should be below the window's title bar: ${f}`)
})

test('follows the app onto a second monitor', () => {
  // The app window offset by 1440px: the popout must open beside it on THAT
  // screen, not sail back to the primary one.
  const f = windowFeatures({ w: 420, h: 620 }, { x: 1440, y: 0, width: 1920 })
  assert(f.includes('left=2900'), `left should be relative to the app window: ${f}`)
})

test('never positions a window off the left edge', () => {
  // An unknown or very narrow anchor must not produce a negative coordinate,
  // which browsers treat inconsistently.
  const f = windowFeatures({ w: 420, h: 620 }, { x: 0, y: 0, width: 0 })
  assert(!f.includes('left=-'), `left should never be negative: ${f}`)
  assert(f.includes('left=0'), `left should floor at 0: ${f}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
