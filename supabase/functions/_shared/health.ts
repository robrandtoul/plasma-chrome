// Pure logic behind the `health` edge function.
//
// Everything here is deliberately free of Deno APIs, network calls and clocks
// (`now` is always a parameter) so it can be unit-tested under plain tsx —
// same convention as _shared/nudgeDecision.ts. The endpoint itself
// (supabase/functions/health/index.ts) does the I/O and hands the results here
// to be graded and shaped.
//
// WHY A HEALTH ENDPOINT AT ALL
// ----------------------------
// public/_redirects ends with `/*  /index.html  200`, so EVERY url on
// proofs.plasmadesign.co.uk answers 200 with the SPA shell. A plain uptime
// monitor pointed at the site therefore stays green while Supabase is down,
// the anon key is revoked, or every RPC 500s. This endpoint is the thing an
// external monitor can ask "is the stack actually working?" and get an honest
// answer from.

/** One check's verdict. `ok` is the only healthy value — a Better Stack
 *  keyword monitor asserting `"xero":"ok"` trips on every other token. */
export type CheckStatus =
  | 'ok'
  | 'fail' // the dependency answered, and the answer was bad (or it didn't answer)
  | 'stale' // the dependency is up but hasn't done its job recently enough
  | 'disconnected' // no connection configured (Xero has never been linked / was revoked)
  | 'misconfigured' // configuration is internally inconsistent (e.g. live mode, test key)

export interface HealthChecks {
  db: CheckStatus
  rpc: CheckStatus
  stripe: CheckStatus
  xero: CheckStatus
  crons: CheckStatus
}

/** Free-form diagnosis. Booleans, short status strings and elapsed times only:
 *  this endpoint is guarded by a single shared header key, so it must never
 *  carry secrets, key material, customer names, order counts or revenue. */
export type HealthDetail = Record<string, string | number | boolean | null>

export interface HealthBody {
  /** The 503 gate. True iff both HARD dependencies (db, rpc) are ok — those
   *  are what the customer-facing pages cannot work without. */
  ok: boolean
  /** True when a SOFT dependency (stripe, xero, crons) is unhealthy. The
   *  endpoint still answers 200 in that state so Better Stack grades it via
   *  keyword monitors rather than a blunt page-is-down alert. */
  degraded: boolean
  checks: HealthChecks
  detail: HealthDetail
  checkedAt: string
}

// ── Stripe ──────────────────────────────────────────────────────────────────

/** Classify a Stripe key by prefix without revealing it. Keys are
 *  sk_test_… / sk_live_… (restricted rk_… keys carry the same infix).
 *  Lifted from payments-status/index.ts — same logic, minus the admin gate. */
export function keyKind(key: string | undefined | null): 'test' | 'live' | 'unknown' | 'absent' {
  if (!key) return 'absent'
  if (key.includes('_test_')) return 'test'
  if (key.includes('_live_')) return 'live'
  return 'unknown'
}

/** Does the key behind the selected mode actually match that mode?
 *  The dangerous state this exists to catch is `payment_mode = 'live'` with a
 *  test key (or no key) in the live slot — real orders would fail to charge. */
export function stripeKeyConsistent(
  mode: 'test' | 'live',
  kind: ReturnType<typeof keyKind>,
): boolean {
  return mode === 'test' ? kind === 'test' || kind === 'unknown' : kind === 'live'
}

/**
 * Grade Stripe. Configuration is judged before the network call, because a
 * mode/key mismatch is a misconfiguration whether or not the API answers.
 *
 * @param apiReachable null when the live API call was skipped (no key to try).
 */
export function gradeStripe(
  mode: 'test' | 'live',
  kind: ReturnType<typeof keyKind>,
  apiReachable: boolean | null,
): CheckStatus {
  if (kind === 'absent') return 'misconfigured'
  if (!stripeKeyConsistent(mode, kind)) return 'misconfigured'
  if (apiReachable === false) return 'fail'
  return 'ok'
}

// ── Cron freshness ──────────────────────────────────────────────────────────

/** The UTC hours `proofs-send-nudges` fires at (pg_cron `0 9,15 * * 1-5`). */
export const NUDGE_RUN_SLOT_HOURS_UTC = [9, 15]

/** How long after a slot we still consider a missing run "not late yet".
 *  Live runs complete in 8–27s, so this is generous on purpose — the
 *  heartbeats are the fast alarm; this is the belt-and-braces cross-check. */
export const CRON_GRACE_MS = 30 * 60 * 1000

/**
 * The most recent moment a send-nudges run should ALREADY have happened,
 * or null if none is expected yet.
 *
 * This is weekday-aware, and that is the whole point: the job is
 * `0 9,15 * * 1-5`, so the longest legitimate gap between runs is Friday
 * 15:00 → Monday 09:00 — 66 hours. A naive "stale after 24h" rule would be
 * red every single weekend, which is precisely how a monitor teaches people
 * to ignore it.
 *
 * Bank holidays are deliberately NOT excluded: pg_cron still fires on them,
 * and send-nudges still opens a `nudge_runs` row (the London send-window
 * check only demotes the run to dry_run — it doesn't skip the run).
 */
export function mostRecentExpectedRun(now: Date, graceMs: number = CRON_GRACE_MS): Date | null {
  const cutoff = now.getTime() - graceMs
  const slotsLatestFirst = [...NUDGE_RUN_SLOT_HOURS_UTC].sort((a, b) => b - a)
  // Ten days back is far more than any legitimate gap; past that the answer
  // is "very stale" either way and the exact slot stops mattering.
  for (let dayOffset = 0; dayOffset <= 10; dayOffset++) {
    const day = new Date(now.getTime() - dayOffset * 86_400_000)
    const dow = day.getUTCDay()
    if (dow === 0 || dow === 6) continue // pg_cron fires Mon–Fri only
    for (const hour of slotsLatestFirst) {
      const slot = Date.UTC(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate(),
        hour,
        0,
        0,
      )
      if (slot <= cutoff) return new Date(slot)
    }
  }
  return null
}

export interface CronVerdict {
  status: CheckStatus
  /** Minutes since the newest run started, or null when there has never been one. */
  lastRunAgeMinutes: number | null
  /** Runs still open (finished_at IS NULL). Any open row means a batch died
   *  mid-flight — and send-nudges itself then demotes every later run to
   *  dry_run, so customer reminders have silently stopped going out. */
  openRuns: number
}

/**
 * Grade the automation from the `proofs.nudge_runs` ledger.
 *
 * Note this reads FRESHNESS, not success: pg_cron reporting `succeeded` only
 * means it queued the pg_net request (which has a 5s timeout and does lose
 * responses), so the ledger is the only database-side evidence a run actually
 * started. Evidence it *finished* is the heartbeat.
 */
export function gradeCrons(
  lastStartedAt: Date | null,
  openRuns: number,
  now: Date,
  graceMs: number = CRON_GRACE_MS,
): CronVerdict {
  const lastRunAgeMinutes =
    lastStartedAt === null
      ? null
      : Math.max(0, Math.round((now.getTime() - lastStartedAt.getTime()) / 60_000))

  if (openRuns > 0) return { status: 'fail', lastRunAgeMinutes, openRuns }
  if (lastStartedAt === null) return { status: 'fail', lastRunAgeMinutes, openRuns }

  const expected = mostRecentExpectedRun(now, graceMs)
  // No slot has come due yet (a brand-new project, or the clock is before the
  // first ever weekday slot) — nothing to be late for.
  if (expected === null) return { status: 'ok', lastRunAgeMinutes, openRuns }

  return {
    status: lastStartedAt.getTime() >= expected.getTime() ? 'ok' : 'stale',
    lastRunAgeMinutes,
    openRuns,
  }
}

// ── Body ────────────────────────────────────────────────────────────────────

const HARD_CHECKS = ['db', 'rpc'] as const
const SOFT_CHECKS = ['stripe', 'xero', 'crons'] as const

/**
 * Assemble the response body and decide the HTTP status.
 *
 * 503 fires ONLY on a hard-dependency failure. A dead Xero connection is
 * serious — every paid order will fail to invoice AFTER the customer has been
 * charged — but it is not "the site is down", and conflating the two would
 * mean the same alert for two very different responses.
 */
export function buildHealthBody(
  checks: HealthChecks,
  detail: HealthDetail,
  now: Date,
): { body: HealthBody; status: 200 | 503 } {
  const ok = HARD_CHECKS.every((k) => checks[k] === 'ok')
  const degraded = SOFT_CHECKS.some((k) => checks[k] !== 'ok')
  return {
    body: { ok, degraded, checks, detail, checkedAt: now.toISOString() },
    status: ok ? 200 : 503,
  }
}

/**
 * Serialise the body for the wire.
 *
 * LOAD-BEARING: this must stay compact (no `JSON.stringify(x, null, 2)`).
 * The Better Stack keyword monitors assert the literal substrings
 * `"xero":"ok"` and `"stripe":"ok"`; pretty-printing inserts a space after
 * the colon and every one of those monitors would go red against a perfectly
 * healthy stack. health.test.ts pins this.
 */
export function serialiseHealthBody(body: HealthBody): string {
  return JSON.stringify(body)
}

/** The exact substrings the Better Stack keyword monitors look for. Exported
 *  so the test suite asserts against the same constants the runbook quotes. */
export const KEYWORD_ASSERTIONS = {
  stripe: '"stripe":"ok"',
  xero: '"xero":"ok"',
  crons: '"crons":"ok"',
  db: '"db":"ok"',
  rpc: '"rpc":"ok"',
} as const
