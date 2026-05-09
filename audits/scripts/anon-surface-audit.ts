#!/usr/bin/env tsx
/**
 * Anon REST surface audit — recon-only.
 *
 * Hits every public-facing PostgREST surface on the live Supabase project
 * with the anon publishable key (no Authorization header) and reports what
 * the role can SELECT. No mutations, no migrations, no policy changes.
 *
 * Usage:
 *   pnpm tsx audits/scripts/anon-surface-audit.ts
 *
 * Output:
 *   audits/test-runs/<YYYY-MM-DD>-rls-recon[-<HHMMSS>].md
 *
 * Re-runnable: subsequent runs of the same day get a timestamped suffix so
 * earlier reports aren't clobbered. The fixed-input fixture probe references
 * the [QA] row 1 proof from the 2026-05-09 first-pass run; if that proof is
 * removed the filtered probes will return empty arrays but the script will
 * still complete successfully (an empty filtered probe is itself a useful
 * signal — see report rendering).
 *
 * Inputs (from .env at repo root):
 *   VITE_SUPABASE_URL or SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY
 *
 * Designed to double as a regression test for the eventual P1 RLS fix:
 * once policies tighten, every surface should land in the "clean" priority
 * group. Any P1/P2 line item after the fix is a regression.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
loadDotenv({ path: resolve(REPO_ROOT, '.env') })

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL
const ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !ANON_KEY) {
  console.error(
    'Missing required env. Need VITE_SUPABASE_URL and one of ' +
      'VITE_SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEY / SUPABASE_ANON_KEY.',
  )
  process.exit(1)
}

// QA row 1 fixture from the 2026-05-09 first-pass run. Used for filtered
// probes to confirm the legitimate customer-page single-row read still works.
const QA_PROOF_ID = 'f47c88c1-98a9-4719-94c6-f4e3cea8a175'
const QA_VERSION_ID = 'f88a97dd-f5d8-4251-bd09-7a41392d2cb0'

type Filter = { column: string; value: string }

interface SurfaceSpec {
  name: string
  type: 'table' | 'view'
  filter?: Filter
}

const SURFACES: SurfaceSpec[] = [
  // Proof-graph tables
  { name: 'proofs', type: 'table', filter: { column: 'id', value: QA_PROOF_ID } },
  { name: 'proof_versions', type: 'table', filter: { column: 'proof_id', value: QA_PROOF_ID } },
  { name: 'proof_version_images', type: 'table', filter: { column: 'proof_version_id', value: QA_VERSION_ID } },
  { name: 'proof_round_variants', type: 'table' },
  { name: 'proof_name_approvals', type: 'table', filter: { column: 'proof_version_id', value: QA_VERSION_ID } },
  { name: 'proof_pins', type: 'table', filter: { column: 'proof_id', value: QA_PROOF_ID } },
  { name: 'proof_events', type: 'table', filter: { column: 'proof_id', value: QA_PROOF_ID } },
  { name: 'proof_version_views', type: 'table', filter: { column: 'proof_version_id', value: QA_VERSION_ID } },

  // Customer / company tables
  { name: 'contacts', type: 'table' },
  { name: 'companies', type: 'table' },

  // Catalogue tables (intentionally public-ish — surface anyway, label as P2)
  { name: 'materials', type: 'table' },
  { name: 'material_variants', type: 'table' },
  { name: 'material_options', type: 'table' },
  { name: 'material_option_surcharges', type: 'table' },
  { name: 'price_tiers', type: 'table' },
  { name: 'add_ons', type: 'table' },
  { name: 'add_on_prices', type: 'table' },
  { name: 'letterpress_core_colours', type: 'table' },

  // Settings / admin
  { name: 'site_settings', type: 'table' },
  { name: 'reply_templates', type: 'table' },
  { name: 'audit_log', type: 'table' },
  { name: 'profiles', type: 'table' },

  // Public views
  { name: 'public_proofs', type: 'view', filter: { column: 'id', value: QA_PROOF_ID } },
  { name: 'public_proof_versions', type: 'view', filter: { column: 'proof_id', value: QA_PROOF_ID } },
  { name: 'public_proof_version_images', type: 'view', filter: { column: 'proof_version_id', value: QA_VERSION_ID } },
  { name: 'public_dashboard_projects', type: 'view', filter: { column: 'proof_id', value: QA_PROOF_ID } },
  { name: 'public_site_settings', type: 'view' },
  { name: 'public_material_options', type: 'view' },
  { name: 'public_material_option_surcharges', type: 'view' },
  { name: 'dashboard_latest_events', type: 'view', filter: { column: 'proof_id', value: QA_PROOF_ID } },
  { name: 'material_price_tier_counts', type: 'view' },
]

interface ProbeResult {
  status: number
  bodyText: string
  bodyJson: unknown
  rowCount: number | null
  columns: string[] | null
}

interface SurfaceResult {
  name: string
  type: 'table' | 'view'
  unfiltered: ProbeResult
  filtered: { result: ProbeResult; filterDescription: string } | null
  priority: 'P1' | 'P2' | 'clean'
  reason: string
}

// Columns we treat as PII / customer-identifying when classifying priority.
// Conservative — anything that names a real person, links to one externally,
// or commonly carries customer-supplied free text.
const PII_KEYS = new Set([
  'customer_name',
  'names',
  'full_name',
  'email',
  'customer_email',
  'actor_email',
  'actor_name',
  'helpscout_conversation_id',
  'helpscout_conversation_url',
  'helpscout_thread_url',
  'internal_notes',
  'change_request',
  'ink_names',
  'change_notes',
  'recipient_name',
  'contact_name',
  'company',
  'company_name',
  'associated_name', // proof_version_images: per-recipient image tag
  'original_filename', // proof_version_images: customer-uploaded filenames often carry names
])

async function fetchAsAnon(restPath: string): Promise<ProbeResult> {
  const url = `${SUPABASE_URL}/rest/v1/${restPath}`
  let status = 0
  let bodyText = ''
  let bodyJson: unknown = null
  try {
    const r = await fetch(url, {
      headers: { apikey: ANON_KEY!, accept: 'application/json' },
    })
    status = r.status
    bodyText = await r.text()
    try {
      bodyJson = JSON.parse(bodyText)
    } catch {
      bodyJson = null
    }
  } catch (e) {
    status = 0
    bodyText = `fetch error: ${(e as Error).message}`
  }
  let rowCount: number | null = null
  let columns: string[] | null = null
  if (Array.isArray(bodyJson)) {
    rowCount = bodyJson.length
    if (bodyJson.length > 0 && typeof bodyJson[0] === 'object' && bodyJson[0] !== null) {
      columns = Object.keys(bodyJson[0] as object)
    }
  }
  return { status, bodyText, bodyJson, rowCount, columns }
}

function abbreviateRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (
      (k === 'customer_name' ||
        k === 'full_name' ||
        k === 'actor_name' ||
        k === 'recipient_name' ||
        k === 'contact_name') &&
      typeof v === 'string' &&
      v.length > 0
    ) {
      out[k] = v[0] + '…'
    } else if (k === 'names' && Array.isArray(v)) {
      out[k] = v.map((n) =>
        typeof n === 'string' && n.length > 0 ? n[0] + '…' : n,
      )
    } else if (
      (k === 'email' || k === 'customer_email' || k === 'actor_email') &&
      typeof v === 'string' &&
      v.includes('@')
    ) {
      const [local, domain] = v.split('@')
      out[k] = (local[0] ?? '') + '…@' + domain
    } else if ((k === 'company' || k === 'company_name') && typeof v === 'string' && v.length > 0) {
      out[k] = v[0] + '…'
    } else if (
      (k === 'change_request' || k === 'change_notes' || k === 'internal_notes') &&
      typeof v === 'string' &&
      v.length > 40
    ) {
      out[k] = v.substring(0, 40) + '…'
    } else if (k === 'associated_name' && typeof v === 'string' && v.length > 0) {
      out[k] = v[0] + '…'
    } else if (k === 'original_filename' && typeof v === 'string' && v.length > 0) {
      // Filenames often embed names — keep extension for shape, hide stem
      const dot = v.lastIndexOf('.')
      out[k] = dot > 0 ? v[0] + '…' + v.substring(dot) : v[0] + '…'
    } else {
      // helpscout_conversation_id and ink_names left verbatim per recon spec
      out[k] = v
    }
  }
  return out
}

function classify(r: ProbeResult): { priority: 'P1' | 'P2' | 'clean'; reason: string } {
  if (r.status === 401 || r.status === 403) {
    return { priority: 'clean', reason: `HTTP ${r.status} — permission denied` }
  }
  if (r.status === 404) {
    return { priority: 'clean', reason: 'HTTP 404 — surface not exposed by PostgREST' }
  }
  if (r.status >= 200 && r.status < 300) {
    if (Array.isArray(r.bodyJson)) {
      if (r.bodyJson.length === 0) {
        return { priority: 'clean', reason: '200 OK, 0 rows — RLS filtered all rows' }
      }
      const cols = r.columns ?? []
      const piiHits = cols.filter((k) => PII_KEYS.has(k))
      if (piiHits.length > 0) {
        return {
          priority: 'P1',
          reason: `200 OK, ${r.bodyJson.length} row(s) — PII columns exposed: ${piiHits.join(', ')}`,
        }
      }
      return {
        priority: 'P2',
        reason: `200 OK, ${r.bodyJson.length} row(s) — no flagged PII columns but unrestricted listing`,
      }
    }
    return { priority: 'P2', reason: `HTTP ${r.status} but body is not a JSON array` }
  }
  return { priority: 'P2', reason: `HTTP ${r.status} (unexpected)` }
}

async function discoverExtraSurfaces(known: Set<string>): Promise<string[]> {
  // PostgREST exposes an OpenAPI spec at /rest/v1/. Anon can usually fetch
  // it. The "definitions" section keys are the table/view names exposed.
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: ANON_KEY!, accept: 'application/openapi+json' },
    })
    if (!r.ok) return []
    const spec = (await r.json()) as { definitions?: Record<string, unknown> }
    const all = Object.keys(spec.definitions ?? {})
    return all.filter((n) => !known.has(n) && !n.startsWith('_'))
  } catch {
    return []
  }
}

function priorityLabel(label: 'P1' | 'P2' | 'clean'): string {
  if (label === 'P1') return 'P1 — leaks PII or proof-graph data'
  if (label === 'P2') return 'P2 — exposed but lower-stakes (catalogue / settings)'
  return 'clean — locked down'
}

function renderReport(results: SurfaceResult[], extra: string[]): string {
  const ts = new Date().toISOString()
  const groups: Record<'P1' | 'P2' | 'clean', SurfaceResult[]> = {
    P1: results.filter((r) => r.priority === 'P1'),
    P2: results.filter((r) => r.priority === 'P2'),
    clean: results.filter((r) => r.priority === 'clean'),
  }

  const lines: string[] = []
  lines.push('# Anon REST surface audit — recon')
  lines.push('')
  lines.push(`**Generated:** ${ts}`)
  lines.push(`**Source script:** \`audits/scripts/anon-surface-audit.ts\` (re-runnable)`)
  lines.push(`**Auth:** publishable apikey only — no \`Authorization\` header`)
  lines.push(`**Endpoint pattern:** \`${SUPABASE_URL}/rest/v1/<surface>?select=*&limit=5\``)
  lines.push(`**Filtered-probe fixture:** QA row 1 proof \`${QA_PROOF_ID}\` (version \`${QA_VERSION_ID}\`)`)
  lines.push('')
  lines.push('Recon-only. No fixes proposed.')
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push('| Surface | Type | Anon SELECT * status | Rows leaked | Priority |')
  lines.push('|---|---|---|---|---|')
  for (const r of results) {
    const u = r.unfiltered
    const rows =
      r.priority === 'clean' && u.rowCount === 0
        ? '0 (filtered)'
        : u.rowCount === null
        ? '—'
        : String(u.rowCount)
    lines.push(`| \`${r.name}\` | ${r.type} | ${u.status} | ${rows} | ${r.priority} |`)
  }
  lines.push('')
  lines.push(
    `**Counts:** P1 = ${groups.P1.length}, P2 = ${groups.P2.length}, clean = ${groups.clean.length}.`,
  )
  lines.push('')

  if (extra.length > 0) {
    lines.push('### Surfaces discovered via PostgREST OpenAPI but not in the predefined list')
    lines.push('')
    for (const s of extra) lines.push(`- \`${s}\``)
    lines.push('')
    lines.push(
      '> The script probes only the predefined list above. Add any of these to the `SURFACES` array if they look interesting.',
    )
    lines.push('')
  }

  for (const key of ['P1', 'P2', 'clean'] as const) {
    lines.push(`## ${priorityLabel(key)}`)
    lines.push('')
    if (groups[key].length === 0) {
      lines.push('_(none)_')
      lines.push('')
      continue
    }
    for (const r of groups[key]) renderSurface(lines, r)
  }

  lines.push('## Observed patterns')
  lines.push('')
  patternNotes(lines, results)

  return lines.join('\n')
}

function renderSurface(lines: string[], r: SurfaceResult): void {
  lines.push(`### \`${r.name}\` (${r.type})`)
  lines.push('')
  lines.push(`**Verdict:** ${r.priority} — ${r.reason}`)
  lines.push('')
  const u = r.unfiltered
  lines.push(`**Unfiltered SELECT \\*:** HTTP ${u.status}, ${u.rowCount ?? '—'} row(s) returned`)
  if (u.columns && u.columns.length > 0) {
    lines.push('')
    lines.push(`Columns: \`${u.columns.join('`, `')}\``)
  }
  if (u.rowCount !== null && u.rowCount > 0 && Array.isArray(u.bodyJson) && u.bodyJson[0]) {
    const sample = abbreviateRow(u.bodyJson[0] as Record<string, unknown>)
    lines.push('')
    lines.push(
      'Sample row (PII abbreviated; `helpscout_conversation_id` and `ink_names` left verbatim per recon spec):',
    )
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(sample, null, 2))
    lines.push('```')
  } else if (u.rowCount === 0) {
    lines.push('')
    lines.push('Body: `[]`')
  } else if (u.bodyJson && typeof u.bodyJson === 'object' && !Array.isArray(u.bodyJson)) {
    lines.push('')
    lines.push('Error body:')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(u.bodyJson, null, 2))
    lines.push('```')
  } else if (u.status === 0) {
    lines.push('')
    lines.push(`Network/fetch error: \`${u.bodyText.substring(0, 200)}\``)
  }

  if (r.filtered) {
    const f = r.filtered.result
    lines.push('')
    lines.push(`**Filtered probe (\`${r.filtered.filterDescription}\`):** HTTP ${f.status}, ${f.rowCount ?? '—'} row(s)`)
    if (f.rowCount === 0) {
      lines.push('')
      lines.push(
        '> Empty body — either the QA fixture row is missing, or the filtered customer-page read also returns nothing. Compare with the unfiltered result above to disambiguate.',
      )
    } else if (f.rowCount !== null && f.rowCount > 0) {
      lines.push('')
      lines.push(`> Filter resolves to ${f.rowCount} row(s) — legitimate customer-page single-row read works.`)
    }
  }
  lines.push('')
}

function patternNotes(lines: string[], results: SurfaceResult[]): void {
  const publicViews = results.filter((r) => r.type === 'view' && r.name.startsWith('public_'))
  const publicViewLeaks = publicViews.filter((r) => r.priority !== 'clean')
  const publicViewClean = publicViews.length - publicViewLeaks.length
  const tables = results.filter((r) => r.type === 'table')
  const tableLeaks = tables.filter((r) => r.priority !== 'clean')
  const tableClean = tables.length - tableLeaks.length

  lines.push(
    `- ${publicViews.length} \`public_*\` view(s) probed → ${publicViewLeaks.length} leak, ${publicViewClean} clean.`,
  )
  lines.push(
    `- ${tables.length} raw table(s) probed → ${tableLeaks.length} leak, ${tableClean} clean.`,
  )

  // Status-code distribution
  const byStatus = new Map<number, string[]>()
  for (const r of results) {
    const arr = byStatus.get(r.unfiltered.status) ?? []
    arr.push(r.name)
    byStatus.set(r.unfiltered.status, arr)
  }
  const sortedStatuses = Array.from(byStatus.entries()).sort(([a], [b]) => a - b)
  lines.push('- Status-code distribution across all probed surfaces:')
  for (const [code, names] of sortedStatuses) {
    lines.push(
      `  - HTTP ${code}: ${names.length} surface(s) — ${names.map((n) => '`' + n + '`').join(', ')}`,
    )
  }
  // Filtered-probe coverage
  const withFilter = results.filter((r) => r.filtered !== null)
  const filterEmpty = withFilter.filter((r) => r.filtered?.result.rowCount === 0)
  lines.push(
    `- Filtered probes attempted on ${withFilter.length} surface(s); ${filterEmpty.length} returned empty (fixture missing, RLS filter, or table genuinely has no matching rows).`,
  )

  lines.push('')
  lines.push('Recon only — no remediation in this report.')
  lines.push('')
}

async function main(): Promise<void> {
  console.error('Anon REST surface audit against', SUPABASE_URL)
  console.error('  fixture proof:  ', QA_PROOF_ID)
  console.error('  fixture version:', QA_VERSION_ID)
  console.error('')

  const results: SurfaceResult[] = []
  for (const s of SURFACES) {
    process.stderr.write(`  ${s.name.padEnd(38)} `)
    const unfiltered = await fetchAsAnon(`${s.name}?select=*&limit=5`)
    let filtered: SurfaceResult['filtered'] = null
    if (s.filter) {
      const f = await fetchAsAnon(
        `${s.name}?${s.filter.column}=eq.${s.filter.value}&select=*&limit=5`,
      )
      filtered = { result: f, filterDescription: `${s.filter.column}=eq.${s.filter.value}` }
    }
    const c = classify(unfiltered)
    results.push({
      name: s.name,
      type: s.type,
      unfiltered,
      filtered,
      priority: c.priority,
      reason: c.reason,
    })
    process.stderr.write(`${unfiltered.status} → ${c.priority}\n`)
  }

  const known = new Set(SURFACES.map((s) => s.name))
  const extra = await discoverExtraSurfaces(known)
  if (extra.length > 0) {
    console.error('')
    console.error(`Discovered ${extra.length} extra surface(s) via OpenAPI not in the predefined list:`)
    for (const e of extra) console.error('  -', e)
  }

  const md = renderReport(results, extra)

  const today = new Date().toISOString().slice(0, 10)
  const reportsDir = resolve(REPO_ROOT, 'audits', 'test-runs')
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true })
  let outPath = resolve(reportsDir, `${today}-rls-recon.md`)
  if (existsSync(outPath)) {
    const time = new Date().toISOString().slice(11, 19).replace(/:/g, '')
    outPath = resolve(reportsDir, `${today}-rls-recon-${time}.md`)
  }
  writeFileSync(outPath, md, 'utf8')
  console.error('')
  console.error(`Report written: ${outPath}`)

  // Final stdout summary so a CI invocation can grep counts.
  const counts = {
    P1: results.filter((r) => r.priority === 'P1').length,
    P2: results.filter((r) => r.priority === 'P2').length,
    clean: results.filter((r) => r.priority === 'clean').length,
  }
  console.log(JSON.stringify({ outPath, counts }))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
