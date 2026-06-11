// Maps a Help Scout conversation (with embedded threads) onto the pipeline's
// ThreadMessage shape. Pure functions — unit-tested in guardrails.test.ts.

import type { ThreadMessage } from './types.ts'

// Structural subset of _shared/helpscout.ts's HsThread — kept local so the
// shared core has no import edge into the Deno-side helper module.
export interface HsThreadLike {
  id: number
  type?: string
  body?: string
  createdAt?: string
  createdBy?: { type?: string; first?: string }
}

function roleFor(thread: HsThreadLike): ThreadMessage['role'] | null {
  const type = (thread.type ?? '').toLowerCase()
  const author = (thread.createdBy?.type ?? '').toLowerCase()
  if (type === 'customer') return 'customer'
  if (type === 'note') return 'note'
  // Live chat / beacon messages carry the author on createdBy.
  if ((type === 'chat' || type === 'beaconchat') && author === 'customer') return 'customer'
  if ((type === 'chat' || type === 'beaconchat') && author === 'user') return 'staff'
  if (type === 'message' || type === 'reply') return 'staff'
  // lineitems, status changes, forwards… carry no conversational content.
  return null
}

export function mapThreads(threads: HsThreadLike[]): ThreadMessage[] {
  return threads
    .map((t) => {
      const role = roleFor(t)
      const body = (t.body ?? '').trim()
      if (!role || !body) return null
      return {
        role,
        createdAt: t.createdAt ?? '',
        author: t.createdBy?.first || (role === 'customer' ? 'Customer' : 'Staff'),
        body,
      } satisfies ThreadMessage
    })
    .filter((m): m is ThreadMessage => m !== null)
    .sort((a, b) => Date.parse(a.createdAt || '0') - Date.parse(b.createdAt || '0'))
}

// The dedupe anchor: a draft attempt is keyed to the newest customer thread,
// so a webhook retry for the same customer message is a no-op while a NEW
// customer message legitimately re-triggers (stale-draft regeneration).
export function latestCustomerThreadId(threads: HsThreadLike[]): number | null {
  let latest: HsThreadLike | null = null
  for (const t of threads) {
    if (roleFor(t) !== 'customer') continue
    if (!latest || Date.parse(t.createdAt ?? '0') >= Date.parse(latest.createdAt ?? '0')) {
      latest = t
    }
  }
  return latest?.id ?? null
}
