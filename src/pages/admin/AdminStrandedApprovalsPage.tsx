import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { findStrandedMaterialApprovals, type StrandedCard } from '../../lib/strandedApprovals'

// Admin: stranded-approval report (bundle-orders spec §12.3).
//
// Finds proofs where a card was approved on a superseded (non-current) version
// in a DIFFERENT material than the current version — the Novion failure mode,
// where a designer used a version bump to replace one product with another, so
// the earlier approved card can no longer be ordered or seen by the customer.
//
// Read-only: it reads proof_versions + proof_name_approvals (data the app
// already loads elsewhere) and runs the exact same check the order builder
// uses, so this list and the order-time warning agree by construction. No
// schema changes. Slice 1 stops NEW ones happening; this surfaces any that
// already exist so the team can untangle them by hand.

interface VersionRow {
  id: string
  proof_id: string
  version_number: number
  material_id: string | null
  material_display: string | null
  is_current: boolean
}

interface ApprovalRow {
  proof_version_id: string
  name: string
  state: string
}

interface StrandedProof {
  proofId: string
  company: string | null
  contact: string | null
  status: string
  currentMaterial: string | null
  cards: StrandedCard[]
}

// Page through a table 1000 rows at a time. supabase-js caps a single query at
// 1000 rows and silently truncates past that (the footgun behind migration
// 000148) — a report that must not miss a stranded card can't rely on one page.
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export default function AdminStrandedApprovalsPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<StrandedProof[] | null>(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [versionRows, approvalRows] = await Promise.all([
        fetchAll<VersionRow>((from, to) =>
          supabase
            .from('proof_versions')
            .select('id, proof_id, version_number, material_id, material_display, is_current')
            .order('id')
            .range(from, to),
        ),
        fetchAll<ApprovalRow>((from, to) =>
          supabase
            .from('proof_name_approvals')
            .select('proof_version_id, name, state')
            .eq('state', 'approved')
            .order('id')
            .range(from, to),
        ),
      ])

      // Group versions + approvals by proof.
      const versionsByProof = new Map<string, VersionRow[]>()
      const proofByVersionId = new Map<string, string>()
      for (const v of versionRows) {
        proofByVersionId.set(v.id, v.proof_id)
        const arr = versionsByProof.get(v.proof_id) ?? []
        arr.push(v)
        versionsByProof.set(v.proof_id, arr)
      }
      const approvalsByProof = new Map<string, ApprovalRow[]>()
      for (const a of approvalRows) {
        const proofId = proofByVersionId.get(a.proof_version_id)
        if (!proofId) continue
        const arr = approvalsByProof.get(proofId) ?? []
        arr.push(a)
        approvalsByProof.set(proofId, arr)
      }

      // Run the shared check per proof; keep only proofs with stranded cards.
      const stranded: { proofId: string; cards: StrandedCard[] }[] = []
      for (const [proofId, proofApprovals] of approvalsByProof) {
        const proofVersions = versionsByProof.get(proofId) ?? []
        const cards = findStrandedMaterialApprovals(proofVersions, proofApprovals)
        if (cards.length > 0) stranded.push({ proofId, cards })
      }

      // Labels for the affected proofs (usually a handful — this is a rare
      // mess). One query keyed by the small id list.
      const labels = new Map<string, { company: string | null; contact: string | null; status: string }>()
      if (stranded.length > 0) {
        const { data, error: labelErr } = await supabase
          .from('proofs')
          .select('id, status, contacts(full_name, companies(name))')
          .in('id', stranded.map((s) => s.proofId))
        if (labelErr) throw new Error(labelErr.message)
        for (const row of (data ?? []) as any[]) {
          labels.set(row.id, {
            company: row.contacts?.companies?.name ?? null,
            contact: row.contacts?.full_name ?? null,
            status: row.status,
          })
        }
      }

      const out: StrandedProof[] = stranded.map((s) => {
        const label = labels.get(s.proofId)
        const current = (versionsByProof.get(s.proofId) ?? []).find((v) => v.is_current)
        return {
          proofId: s.proofId,
          company: label?.company ?? null,
          contact: label?.contact ?? null,
          status: label?.status ?? '—',
          currentMaterial: current?.material_display ?? null,
          cards: s.cards,
        }
      })
      // Most versions first isn't meaningful across proofs; sort by customer
      // so the same customer's messes sit together.
      out.sort((a, b) =>
        (a.company ?? a.contact ?? '').localeCompare(b.company ?? b.contact ?? ''),
      )
      setResults(out)
    } catch (err) {
      setError((err as Error).message)
      setResults(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Auto-run on mount — it's a read-only report, no confirmation needed.
  useEffect(() => {
    void run()
  }, [run])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-ink">Stranded approvals</h2>
        <p className="mt-1 text-sm text-ink-mute">
          Proofs where a card was approved on an <strong>earlier</strong> version in a <strong>different material</strong> than the current one. That earlier card can’t be ordered or seen by the customer — it’s stranded. Usually it means two different products were built as versions of each other instead of separate projects.
        </p>
        <p className="mt-2 text-xs text-ink-dim">
          Read-only. Open each proof to decide what to do — typically rebuild the stranded card as its own project. Going forward, the new-version and order screens now warn before this can happen.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run()}
          disabled={loading}
          className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? 'Checking…' : 'Re-check'}
        </button>
        {loading && <span className="text-xs text-ink-dim">Reading every proof’s versions and approvals…</span>}
      </div>

      {error && (
        <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out ring-1 ring-out">{error}</div>
      )}

      {results !== null && !loading && results.length === 0 && !error && (
        <div className="rounded-lg bg-in-stock-soft px-3 py-2 text-sm text-in-stock ring-1 ring-in-stock">
          No stranded approvals — every approved card is on its proof’s current material.
        </div>
      )}

      {results && results.length > 0 && (
        <>
          <div className="text-sm text-ink-soft">
            {results.length} proof{results.length === 1 ? '' : 's'} with stranded approvals.
          </div>
          <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
            <table className="min-w-full divide-y divide-line-soft">
              <thead>
                <tr className="bg-canvas text-left text-xs font-semibold uppercase tracking-widest text-ink-mute">
                  <th className="px-5 py-3">Customer</th>
                  <th className="px-5 py-3">Current version</th>
                  <th className="px-5 py-3">Stranded cards</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft text-sm">
                {results.map((r) => (
                  <tr key={r.proofId}>
                    <td className="px-5 py-3 align-top">
                      <div className="font-medium text-ink">{r.company ?? r.contact ?? 'Unknown customer'}</div>
                      {r.company && r.contact && <div className="text-xs text-ink-dim">{r.contact}</div>}
                      <div className="mt-0.5 text-xs text-ink-dim capitalize">{r.status.replace(/_/g, ' ')}</div>
                    </td>
                    <td className="px-5 py-3 align-top text-ink-soft">{r.currentMaterial ?? '—'}</td>
                    <td className="px-5 py-3 align-top text-ink-soft">
                      <ul className="space-y-1">
                        {r.cards.map((c) => (
                          <li key={c.versionId}>
                            {c.names.join(', ')} — <span className="text-ink-dim">v{c.versionNumber}</span>
                            {c.material ? ` (${c.material})` : ''}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-5 py-3 align-top">
                      <Link
                        to={`/proofs/${r.proofId}`}
                        className="whitespace-nowrap font-medium text-brand hover:underline"
                      >
                        Open proof →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
