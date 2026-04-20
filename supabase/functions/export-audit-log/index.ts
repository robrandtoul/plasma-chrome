// Admin-only edge function: export the audit log as CSV, honouring the
// same filter params as the activity page (actor, action, target_type,
// date range, search). No pagination cap on the export — we stream every
// matching row through in a single response.
//
// Columns follow the order specified in the prompt: timestamp,
// actor_email, actor_label, action, target_type, target_label,
// target_id, before_value (JSON), after_value (JSON), metadata (JSON).

import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { toCsv } from '../_shared/csv.ts'

const HEADER = [
  'timestamp',
  'actor_email',
  'actor_label',
  'action',
  'target_type',
  'target_label',
  'target_id',
  'before_value',
  'after_value',
  'metadata',
]

function todayStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check
  const { admin } = check

  const url = new URL(req.url)
  const actorId   = url.searchParams.get('actor') ?? ''     // 'null' = customer-only, '' = any
  const action    = url.searchParams.get('action') ?? ''
  const targetT   = url.searchParams.get('target_type') ?? ''
  const fromIso   = url.searchParams.get('from') ?? ''
  const toIso     = url.searchParams.get('to') ?? ''
  const q         = url.searchParams.get('q') ?? ''

  try {
    let query = admin
      .from('audit_log')
      .select('created_at, actor_email, actor_label, action, target_type, target_label, target_id, before_value, after_value, metadata')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })

    if (actorId === 'null') query = query.is('actor_id', null)
    else if (actorId) query = query.eq('actor_id', actorId)
    if (action) query = query.eq('action', action)
    if (targetT) query = query.eq('target_type', targetT)
    if (fromIso) query = query.gte('created_at', fromIso)
    if (toIso) query = query.lte('created_at', toIso)
    if (q) {
      const pattern = `%${q.replace(/[,()]/g, '')}%`
      query = query.or(
        `actor_email.ilike.${pattern},actor_label.ilike.${pattern},target_label.ilike.${pattern}`,
      )
    }

    // Pull everything — no page cap on export. PostgREST defaults to 1000
    // rows; using .range allows arbitrary sizes.
    query = query.range(0, 999_999)

    const { data, error } = await query
    if (error) throw error

    const rows: (string | number | null)[][] = [HEADER]
    for (const r of (data ?? [])) {
      rows.push([
        r.created_at,
        r.actor_email,
        r.actor_label,
        r.action,
        r.target_type,
        r.target_label,
        r.target_id,
        r.before_value == null ? '' : JSON.stringify(r.before_value),
        r.after_value == null ? '' : JSON.stringify(r.after_value),
        r.metadata == null ? '' : JSON.stringify(r.metadata),
      ])
    }

    return new Response(toCsv(rows), {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit_log_${todayStamp()}.csv"`,
      },
    })
  } catch (err) {
    console.error('export-audit-log error:', err)
    return json({ error: (err as Error).message ?? 'Export failed' }, 500)
  }
})
