// Better Stack cron heartbeats.
//
// WHAT THIS IS FOR
// ----------------
// `cron.job_run_details` reports `succeeded` for all four of this project's
// pg_cron jobs, but that only means pg_cron QUEUED the pg_net request. pg_net
// has a 5s timeout and this project lost 13 responses in the last 7 days, so
// the database genuinely cannot tell you whether a run completed. A heartbeat
// is the only honest answer: the job itself pings a URL when it finishes, and
// Better Stack alerts when the ping doesn't arrive.
//
// THREE RULES, IN PRIORITY ORDER
// ------------------------------
//   1. It must never break the job. Every failure is swallowed and logged.
//      A missed heartbeat costs a false alert; a thrown heartbeat costs a
//      run of customer reminders.
//   2. It must be a NO-OP when its env var is unset, so local dev, a fresh
//      clone and any not-yet-configured deploy behave exactly as before.
//   3. It must only fire on SUCCESS. A ping from a crashed run is worse than
//      no ping at all — it reports healthy over a job that did nothing.
//
// WHY THIS AWAITS INSTEAD OF DEFERRING
// ------------------------------------
// The obvious shape is fire-and-forget via `EdgeRuntime.waitUntil`. Don't:
// proof-action/index.ts carries an incident note that Supabase "can tear the
// worker down the moment the response is returned, which killed the earlier
// EdgeRuntime.waitUntil + delay approach before it ever ran". A heartbeat that
// silently never fires is the worst possible outcome here — Better Stack would
// page about a job that is running perfectly, and people would learn to ignore
// the alert. So the ping is awaited inline, behind a hard 2s timeout. Live
// runs take 8–27s, so the added latency is noise, and nothing is waiting on a
// cron response anyway (pg_net has already given up at 5s).

/** Hard cap on a single ping. Short enough to be irrelevant next to a run,
 *  long enough to survive an ordinary TLS handshake to Better Stack. */
export const HEARTBEAT_TIMEOUT_MS = 2_000

export interface HeartbeatDeps {
  /** Env reader. Injected so the unit tests never touch `Deno`. */
  getEnv?: (name: string) => string | undefined
  fetchFn?: typeof fetch
  log?: (message: string, meta?: unknown) => void
}

function defaultGetEnv(name: string): string | undefined {
  // Guarded so this module can be imported under plain tsx (the test runner),
  // where `Deno` does not exist.
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno
  return d?.env?.get?.(name)
}

/**
 * Resolve and validate a heartbeat URL from the environment.
 *
 * Returns null — meaning "do nothing, quietly" — when the variable is unset or
 * blank. Returns null and logs when the value is set but unusable, because a
 * typo'd heartbeat URL should be visible in the function logs rather than
 * failing open into a silent no-op that looks identical to "not configured".
 *
 * https only: heartbeat URLs are opaque bearer capabilities (whoever holds one
 * can mark the job healthy), so they must never travel in clear text.
 */
export function resolveHeartbeatUrl(
  envVarName: string,
  getEnv: (name: string) => string | undefined = defaultGetEnv,
  log: (message: string, meta?: unknown) => void = console.warn,
): string | null {
  let raw: string | undefined
  try {
    raw = getEnv(envVarName)
  } catch {
    return null // env access itself unavailable — treat as not configured
  }
  const value = (raw ?? '').trim()
  if (!value) return null // rule 2: unset means no-op, not an error

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    log(`[heartbeat] ${envVarName} is not a valid URL — heartbeat disabled`)
    return null
  }
  if (parsed.protocol !== 'https:') {
    log(`[heartbeat] ${envVarName} must be https — heartbeat disabled`)
    return null
  }
  return parsed.toString()
}

/**
 * Ping the heartbeat named by `envVarName`. Resolves to true when Better Stack
 * accepted the ping, false otherwise (including "not configured").
 *
 * NEVER rejects, whatever happens — see rule 1. Call it only on a job's
 * success path, immediately before returning.
 */
export async function pingHeartbeat(
  envVarName: string,
  deps: HeartbeatDeps = {},
): Promise<boolean> {
  const log = deps.log ?? console.warn
  const url = resolveHeartbeatUrl(envVarName, deps.getEnv ?? defaultGetEnv, log)
  if (!url) return false

  const doFetch = deps.fetchFn ?? fetch
  try {
    const res = await doFetch(url, {
      method: 'POST',
      // Better Stack accepts an empty POST; the timeout is the important part.
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    })
    if (!res.ok) {
      log(`[heartbeat] ${envVarName} ping returned ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    // Timeout, DNS failure, Better Stack outage — all non-events for the job.
    log(`[heartbeat] ${envVarName} ping failed`, (err as Error)?.message ?? err)
    return false
  }
}
