// health — the one endpoint an external uptime monitor can ask
// "is this stack actually working?" and get an honest answer from.
//
// WHY IT EXISTS
// -------------
// public/_redirects ends with `/*  /index.html  200`, so every URL on
// proofs.plasmadesign.co.uk returns 200 with the SPA shell. A monitor pointed
// at the site therefore stays green while Supabase is down, the anon key is
// revoked, every RPC 500s, or a JS bundle failed to deploy — which is exactly
// how the marketing-site pricing tables once went blank unnoticed (see the
// incident note in netlify.toml). The two existing status endpoints
// (payments-status, helpscout-status) are admin-JWT-gated, so no external
// monitor can call them at all.
//
// AUTH
// ----
// verify_jwt = false (recorded in supabase/config.toml — a plain CLI deploy
// would otherwise default it back on and every monitor would 401). The gate is
// an `X-Health-Key` header compared against the HEALTH_CHECK_KEY secret in
// constant time. Missing key, wrong key, or an unconfigured secret all return
// a bare 401 with no detail: the response must never help someone work out
// which of those it was.
//
// STATUS SEMANTICS
// ----------------
// 503 fires ONLY when `db` or `rpc` fail — the two hard dependencies the
// customer-facing pages cannot work without. Everything else reports its state
// in the body at 200 and is graded by Better Stack keyword monitors, so a dead
// Xero connection and a dead database don't produce the same alert. See
// _shared/health.ts for the grading logic (unit-tested via `pnpm test:health`).
//
// PRIVACY
// -------
// The body carries booleans, short status strings and elapsed times only.
// Never secrets, key material, customer names, order counts or revenue — this
// endpoint is protected by a single shared header key, and a shared key is a
// weak enough gate that the body has to be boring on its own merits.
//
// SIDE EFFECTS
// ------------
// None by design. Reads only: one settings row, one anon RPC, one Stripe
// `GET /v1/balance`, one Xero `GET /connections`, one nudge_runs read. It must
// NEVER create a PaymentIntent, post to Help Scout, or send anything.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { getAccessContext } from '../_shared/xero.ts'
import {
  buildHealthBody,
  gradeCrons,
  gradeStripe,
  keyKind,
  serialiseHealthBody,
  type CheckStatus,
  type HealthDetail,
} from '../_shared/health.ts'

/** Per-dependency network budget. Kept well under a monitor's usual 30s
 *  request timeout so one hung dependency can't make the whole endpoint look
 *  down — the point is to identify the sick dependency, not to join it. */
const DEP_TIMEOUT_MS = 6_000

/** How long a Stripe/Xero verdict is reused within one isolate.
 *  Two reasons, and the second is the important one:
 *   - a 30s monitor must not hammer either vendor's API;
 *   - Xero refresh tokens are SINGLE-USE and rotate on refresh, so
 *     unthrottled refreshes could race and invalidate each other, breaking
 *     the very connection this check exists to watch. */
const SOFT_CACHE_MS = 5 * 60 * 1000

interface SoftResult {
  status: CheckStatus
  detail: HealthDetail
}
interface CacheEntry {
  at: number
  value: SoftResult
}

// Module scope: survives between invocations on a warm isolate, and simply
// misses on a cold one (which costs one extra vendor call, not correctness).
let stripeCache: CacheEntry | null = null
let xeroCache: CacheEntry | null = null

function fresh(entry: CacheEntry | null, now: number): SoftResult | null {
  return entry && now - entry.at < SOFT_CACHE_MS ? entry.value : null
}

/** Constant-time compare — same shape as the gate in send-order-reminders.
 *  Length is compared first and leaks only the length, which is not secret. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function unauthorised(): Response {
  // Deliberately bare: no hint about whether the key was absent, wrong, or
  // never configured on this deployment.
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Individual checks ───────────────────────────────────────────────────────

/** Postgres + PostgREST + the service-role key, in one trivial read. */
async function checkDb(admin: SupabaseClient): Promise<SoftResult> {
  try {
    const { error } = await admin
      .from('settings')
      .select('id')
      .eq('id', 1)
      .abortSignal(AbortSignal.timeout(DEP_TIMEOUT_MS))
      .single()
    if (error) return { status: 'fail', detail: { dbError: error.code || 'query_failed' } }
    return { status: 'ok', detail: {} }
  } catch (err) {
    return { status: 'fail', detail: { dbError: errName(err) } }
  }
}

/**
 * The customer path, end to end: the ANON key, the `proofs` schema, and the
 * SECURITY DEFINER RPC every /p/:id page load calls. This is what catches a
 * revoked anon key or a dropped EXECUTE grant — neither of which the
 * service-role check above would notice.
 */
async function checkRpc(anon: SupabaseClient): Promise<SoftResult> {
  try {
    const { data, error } = await anon
      .rpc('public_settings')
      .abortSignal(AbortSignal.timeout(DEP_TIMEOUT_MS))
    if (error) return { status: 'fail', detail: { rpcError: error.code || 'rpc_failed' } }
    // A null payload means the RPC answered but the singleton row is missing —
    // technically reachable, functionally broken for the customer page.
    if (data === null || data === undefined) return { status: 'fail', detail: { rpcError: 'empty' } }
    return { status: 'ok', detail: {} }
  } catch (err) {
    return { status: 'fail', detail: { rpcError: errName(err) } }
  }
}

/**
 * Stripe: does the selected mode have a matching key behind it, and does that
 * key still work? `GET /v1/balance` is the cheapest authenticated read Stripe
 * offers and mutates nothing.
 */
async function checkStripe(admin: SupabaseClient): Promise<SoftResult> {
  const { data: modeRow } = await admin.from('settings').select('payment_mode').eq('id', 1).single()
  const mode: 'test' | 'live' = modeRow?.payment_mode === 'live' ? 'live' : 'test'

  const legacy = Deno.env.get('STRIPE_SECRET_KEY')
  const selected =
    mode === 'live'
      ? (Deno.env.get('STRIPE_SECRET_KEY_LIVE') ?? legacy)
      : (Deno.env.get('STRIPE_SECRET_KEY_TEST') ?? legacy)
  const kind = keyKind(selected)

  let reachable: boolean | null = null
  let httpStatus: number | null = null
  if (kind !== 'absent') {
    try {
      const res = await fetch('https://api.stripe.com/v1/balance', {
        headers: { Authorization: `Bearer ${selected}` },
        signal: AbortSignal.timeout(DEP_TIMEOUT_MS),
      })
      reachable = res.ok
      httpStatus = res.status // 401 here is the revoked-key signal
    } catch {
      reachable = false
    }
  }

  return {
    status: gradeStripe(mode, kind, reachable),
    detail: {
      stripeMode: mode,
      stripeKeyKind: kind, // 'test' | 'live' | 'unknown' | 'absent' — never the key
      stripeApiStatus: httpStatus,
    },
  }
}

/**
 * Xero: the sleeper failure. A dead connection means every paid order fails to
 * invoice AFTER the customer has been charged, and nothing external notices
 * today. `getAccessContext` refreshes the stored token when it's near expiry,
 * so this genuinely asserts the connection still works rather than that a
 * cached token hasn't expired yet; `GET /connections` then confirms the stored
 * tenant is still one the token can act on (catching a drifted connection).
 */
async function checkXero(admin: SupabaseClient): Promise<SoftResult> {
  try {
    const acc = await getAccessContext(admin)
    if (!acc) return { status: 'disconnected', detail: { xeroConnected: false } }

    const res = await fetch('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${acc.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(DEP_TIMEOUT_MS),
    })
    if (!res.ok) {
      return { status: 'fail', detail: { xeroConnected: true, xeroApiStatus: res.status } }
    }
    const conns = await res.json().catch(() => null)
    const match = Array.isArray(conns) ? conns.find((c) => c?.tenantId === acc.tenantId) : null
    if (!match) {
      // Token valid, but the stored org is no longer among its connections.
      return { status: 'fail', detail: { xeroConnected: true, xeroTenantMatches: false } }
    }
    const name = (match.tenantName as string | undefined) ?? ''
    return {
      status: 'ok',
      detail: {
        xeroConnected: true,
        xeroTenantMatches: true,
        // A boolean, not the org name: sandbox orgs are always "Demo Company (…)",
        // and real money landing in a demo org is worth surfacing.
        xeroDemoCompany: /^demo company\b/i.test(name),
      },
    }
  } catch (err) {
    // A refresh failure lands here — the revoked/expired-connection case.
    return { status: 'fail', detail: { xeroConnected: false, xeroError: errName(err) } }
  }
}

/**
 * Automation freshness from the `proofs.nudge_runs` ledger. pg_cron reporting
 * `succeeded` only means it queued the pg_net request, so the ledger is the
 * only database-side evidence a run actually started — and the heartbeats
 * (see _shared/heartbeat.ts) are the evidence one finished.
 */
async function checkCrons(admin: SupabaseClient): Promise<SoftResult> {
  try {
    const [latest, open] = await Promise.all([
      admin
        .from('nudge_runs')
        .select('started_at')
        .order('started_at', { ascending: false })
        .limit(1)
        .abortSignal(AbortSignal.timeout(DEP_TIMEOUT_MS))
        .maybeSingle(),
      admin
        .from('nudge_runs')
        .select('id', { count: 'exact', head: true })
        .is('finished_at', null)
        .abortSignal(AbortSignal.timeout(DEP_TIMEOUT_MS)),
    ])
    if (latest.error) return { status: 'fail', detail: { cronsError: latest.error.code || 'query_failed' } }

    const lastStartedAt = latest.data?.started_at ? new Date(latest.data.started_at as string) : null
    const verdict = gradeCrons(lastStartedAt, open.count ?? 0, new Date())
    return {
      status: verdict.status,
      detail: {
        lastNudgeRunAgeMinutes: verdict.lastRunAgeMinutes,
        openNudgeRuns: verdict.openRuns,
      },
    }
  } catch (err) {
    return { status: 'fail', detail: { cronsError: errName(err) } }
  }
}

/** An error's shape without its message — messages can quote row data. */
function errName(err: unknown): string {
  const e = err as { name?: string } | null
  return e?.name || 'error'
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // GET only. No side effects means no reason to accept anything else, and a
  // narrow surface is worth more here than convenience.
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Fail closed: an unset secret must reject everything, not accept everything
  // by matching the empty string.
  const expected = (Deno.env.get('HEALTH_CHECK_KEY') ?? '').trim()
  const presented = (req.headers.get('X-Health-Key') ?? '').trim()
  if (!expected || !presented || !timingSafeEqual(presented, expected)) return unauthorised()

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  // Separate client on the ANON key, mirroring the customer page exactly.
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const now = Date.now()
  const cachedStripe = fresh(stripeCache, now)
  const cachedXero = fresh(xeroCache, now)

  // Hard checks always run fresh — they decide the 503, so a cached "ok" would
  // be a lie about the present. Soft checks reuse a recent verdict.
  const [db, rpc, crons, stripe, xero] = await Promise.all([
    checkDb(admin),
    checkRpc(anon),
    checkCrons(admin),
    cachedStripe ? Promise.resolve(cachedStripe) : checkStripe(admin).then((v) => {
      stripeCache = { at: now, value: v }
      return v
    }),
    cachedXero ? Promise.resolve(cachedXero) : checkXero(admin).then((v) => {
      xeroCache = { at: now, value: v }
      return v
    }),
  ])

  const { body, status } = buildHealthBody(
    {
      db: db.status,
      rpc: rpc.status,
      stripe: stripe.status,
      xero: xero.status,
      crons: crons.status,
    },
    {
      ...db.detail,
      ...rpc.detail,
      ...stripe.detail,
      ...xero.detail,
      ...crons.detail,
      // Which soft verdicts came from cache, so a stale reading is never
      // mistaken for a live one while debugging.
      stripeCached: !!cachedStripe,
      xeroCached: !!cachedXero,
    },
    new Date(),
  )

  return new Response(serialiseHealthBody(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Never let a CDN or the monitor itself serve a remembered verdict.
      'Cache-Control': 'no-store',
    },
  })
})
