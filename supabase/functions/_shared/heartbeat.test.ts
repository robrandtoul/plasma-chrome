// Unit tests for the Better Stack cron heartbeat helper.
// Run with: npx tsx supabase/functions/_shared/heartbeat.test.ts
//
// This is how the helper gets verified. The three cron jobs it hooks into
// (send-nudges, send-order-reminders, reconcile-helpscout-tags) all send real
// customer email, so they are NEVER invoked by hand to test a heartbeat —
// these tests plus the next scheduled run are the whole verification story.
//
// Env and fetch are injected throughout, so nothing here touches `Deno` or
// the network.

import {
  HEARTBEAT_TIMEOUT_MS,
  pingHeartbeat,
  resolveHeartbeatUrl,
  type HeartbeatDeps,
} from './heartbeat.ts'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${(err as Error).message}`)
    failed++
  }
}

function assertEqual(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}, got ${a}`)
}

function assertTrue(value: boolean, message: string) {
  if (!value) throw new Error(message)
}

const URL_OK = 'https://uptime.betterstack.com/api/v1/heartbeat/abc123'

/** A fetch stand-in that records its calls and returns whatever it's told. */
function recorder(
  outcome: { status?: number; throws?: Error } = {},
): { fetchFn: typeof fetch; calls: { url: string; method?: string }[] } {
  const calls: { url: string; method?: string }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method })
    if (outcome.throws) throw outcome.throws
    return new Response('ok', { status: outcome.status ?? 200 })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

/** Deps with a fixed env and a silenced logger. */
function deps(env: Record<string, string | undefined>, fetchFn?: typeof fetch): HeartbeatDeps & {
  logs: string[]
} {
  const logs: string[] = []
  return {
    getEnv: (name: string) => env[name],
    fetchFn,
    log: (m: string) => logs.push(m),
    logs,
  }
}

const run = async () => {
  console.log('resolveHeartbeatUrl')
  await test('an unset or blank variable resolves to null, silently', () => {
    const logs: string[] = []
    const log = (m: string) => logs.push(m)
    assertEqual(resolveHeartbeatUrl('MISSING', () => undefined, log), null)
    assertEqual(resolveHeartbeatUrl('BLANK', () => '', log), null)
    assertEqual(resolveHeartbeatUrl('SPACES', () => '   ', log), null)
    // Not configured is a normal state (local dev, fresh clone) — not a warning.
    assertEqual(logs, [])
  })
  await test('a valid https url is returned, trimmed', () => {
    assertEqual(resolveHeartbeatUrl('HB', () => `  ${URL_OK}  `), URL_OK)
  })
  await test('a malformed url is refused AND logged', () => {
    // Distinct from "unset": a typo must be visible in the function logs,
    // not fail open into something indistinguishable from not-configured.
    const logs: string[] = []
    assertEqual(resolveHeartbeatUrl('HB', () => 'not a url', (m) => logs.push(m)), null)
    assertEqual(logs.length, 1)
    assertTrue(logs[0].includes('valid URL'), `unexpected log: ${logs[0]}`)
  })
  await test('a plain-http url is refused — the token travels in the path', () => {
    const logs: string[] = []
    assertEqual(
      resolveHeartbeatUrl('HB', () => 'http://uptime.betterstack.com/api/v1/heartbeat/abc', (m) => logs.push(m)),
      null,
    )
    assertTrue(logs[0].includes('https'), `unexpected log: ${logs[0]}`)
  })
  await test('an env reader that throws is treated as not configured', () => {
    assertEqual(
      resolveHeartbeatUrl('HB', () => {
        throw new Error('no env access')
      }),
      null,
    )
  })

  console.log('pingHeartbeat')
  await test('does nothing at all when the variable is unset', async () => {
    const { fetchFn, calls } = recorder()
    const d = deps({}, fetchFn)
    assertEqual(await pingHeartbeat('BETTERSTACK_HEARTBEAT_SEND_NUDGES', d), false)
    assertEqual(calls.length, 0) // rule 2: a no-op, not a failed request
  })
  await test('POSTs to the configured url and reports success', async () => {
    const { fetchFn, calls } = recorder({ status: 200 })
    const d = deps({ HB: URL_OK }, fetchFn)
    assertEqual(await pingHeartbeat('HB', d), true)
    assertEqual(calls.length, 1)
    assertEqual(calls[0].url, URL_OK)
    assertEqual(calls[0].method, 'POST')
  })
  await test('a non-2xx response is reported false and logged, never thrown', async () => {
    const { fetchFn } = recorder({ status: 500 })
    const d = deps({ HB: URL_OK }, fetchFn)
    assertEqual(await pingHeartbeat('HB', d), false)
    assertEqual(d.logs.length, 1)
  })
  await test('a network failure is swallowed — the job must not care', async () => {
    // Rule 1: a missed heartbeat costs a false alert; a thrown heartbeat costs
    // a whole run of customer reminders.
    const { fetchFn } = recorder({ throws: new Error('dns failure') })
    const d = deps({ HB: URL_OK }, fetchFn)
    assertEqual(await pingHeartbeat('HB', d), false)
  })
  await test('a timeout is swallowed the same way', async () => {
    const err = new Error('The signal has been aborted')
    err.name = 'TimeoutError'
    const { fetchFn } = recorder({ throws: err })
    const d = deps({ HB: URL_OK }, fetchFn)
    assertEqual(await pingHeartbeat('HB', d), false)
  })
  await test('never rejects, under any of the failure shapes', async () => {
    const shapes: HeartbeatDeps[] = [
      deps({ HB: URL_OK }, recorder({ throws: new Error('boom') }).fetchFn),
      deps({ HB: 'not a url' }, recorder().fetchFn),
      deps({ HB: URL_OK }, (() => {
        throw new Error('fetch itself exploded')
      }) as unknown as typeof fetch),
      deps({}),
    ]
    for (const d of shapes) {
      const result = await pingHeartbeat('HB', d).then(
        (v) => ({ resolved: v }),
        (e) => ({ rejected: (e as Error).message }),
      )
      assertTrue('resolved' in result, `pingHeartbeat rejected: ${JSON.stringify(result)}`)
    }
  })
  await test('the timeout is short enough to be noise next to a run', () => {
    // Live send-nudges runs take 8–27s; the ping is awaited inline, so this
    // cap is what keeps "Better Stack is down" from lengthening a cron run.
    assertTrue(HEARTBEAT_TIMEOUT_MS <= 5_000, 'heartbeat timeout should stay well under pg_net\'s 5s')
  })

  console.log('')
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
