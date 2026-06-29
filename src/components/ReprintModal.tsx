// ReprintModal — the "Start reprint" flow launched from a Flagged board card.
//
// A reprint is a FREE remake after a complaint/damage (lost in transit, arrived
// faulty, a design we must correct). It is a NEW order (order_kind='reprint') on
// the SAME proof, linked back to the original it replaces — the original stays a
// complete, untouched record. See migration 000295 + create-order's reprint
// branch.
//
// The modal asks one question and branches:
//   • Artwork is correct (damaged / lost / wrong stock) → raise the free reprint
//     order now (needs the proof currently approved). It lands in the To-order
//     queue; the designer then links a fresh Dropbox folder (next order number)
//     and places it like any job.
//   • Design needs correcting → reopen the proof so it can be fixed, LEAVING the
//     original order untouched. We call reopen_proof directly (not the proof
//     page's reopen, which would flip the shipped order to 'revision'); the
//     reprint order is raised later via the artwork-correct path once re-approved.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Printer, Wrench, Package, X, Check, ArrowRight, AlertTriangle } from 'lucide-react'
import { ButtonCoral, ButtonGhost, Pill } from '../design'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import { type WatchItem } from '../lib/watchList'

type OrderRow = {
  id: string
  stock_order_number: string | null
  order_kind: string
  status: string
  reprint_of_order_id: string | null
  currency: string
  created_at: string
  fulfilled_at: string | null
}

function projectLabel(item: WatchItem): string {
  return item.company_name?.trim() || item.contact_name?.trim() || 'this project'
}

export default function ReprintModal({
  item,
  onClose,
  onDone,
}: {
  item: WatchItem
  onClose: () => void
  onDone: () => void
}) {
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [proofStatus, setProofStatus] = useState<string | null>(null)
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ reference: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      const [proofRes, ordersRes] = await Promise.all([
        supabase.from('proofs').select('status').eq('id', item.proof_id).maybeSingle(),
        supabase
          .from('orders')
          .select('id, stock_order_number, order_kind, status, reprint_of_order_id, currency, created_at, fulfilled_at')
          .eq('proof_id', item.proof_id)
          .order('created_at', { ascending: false }),
      ])
      if (cancelled) return
      setProofStatus((proofRes.data?.status as string | null) ?? null)
      setOrders((ordersRes.data ?? []) as OrderRow[])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [item.proof_id])

  // The order being remade: the most recent real (paid or placed) non-reprint
  // order. Orders load newest-first, so the first match is the latest.
  const original = orders.find((o) => o.order_kind !== 'reprint' && (o.status === 'fulfilled' || o.status === 'paid')) ?? null
  const existingReprints = orders.filter((o) => o.order_kind === 'reprint')
  const isApproved = proofStatus === 'approved'

  async function createReprint() {
    if (!original) {
      setError('There’s no produced order on this project to reprint.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { data, error: fnError } = await supabase.functions.invoke<
        { id: string; token: string; status: string; payment_reference: string } | { error: string }
      >('create-order', {
        body: {
          proof_id: item.proof_id,
          order_kind: 'reprint',
          reprint_of_order_id: original.id,
          currency: original.currency,
        },
      })
      if (fnError) {
        setError('Could not raise the reprint order. Please try again.')
        return
      }
      if (!data || 'error' in data) {
        setError((data as { error?: string } | null)?.error ?? 'Could not raise the reprint order.')
        return
      }
      // Keep the story on the card: log a note so the thread records the remake.
      await supabase.from('watch_updates').insert({
        watch_item_id: item.id,
        kind: 'note',
        body: `Free reprint order raised (replacing ${original.stock_order_number ? `#${original.stock_order_number}` : 'the original order'}). Next: link a new Dropbox folder with the next order number and place it from Orders.`,
        created_by: userId,
      })
      void logAudit({
        action: 'watch.reprint_created',
        targetType: 'watch_item',
        targetId: item.id,
        targetLabel: projectLabel(item),
        metadata: { reprint_of_order_id: original.id, order_id: data.id },
      })
      setCreated({ reference: data.payment_reference })
      onDone()
    } catch {
      setError('Could not raise the reprint order. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function reopenForReprint() {
    setBusy(true)
    setError(null)
    try {
      // Call reopen_proof directly — it flips the proof to in_progress and clears
      // approvals WITHOUT touching the original order (deliberately not the proof
      // page's reopen, which would flip the shipped order to 'revision').
      const { error: rpcError } = await supabase.rpc('reopen_proof', { p_proof_id: item.proof_id })
      if (rpcError) {
        setError(`Could not reopen the project: ${rpcError.message}`)
        return
      }
      await supabase.from('watch_updates').insert({
        watch_item_id: item.id,
        kind: 'note',
        body: 'Reopened the project to correct the design for a reprint. The original order is unchanged — raise the free reprint once the corrected proof is re-approved.',
        created_by: userId,
      })
      void logAudit({
        action: 'watch.reprint_reopen',
        targetType: 'watch_item',
        targetId: item.proof_id,
        targetLabel: projectLabel(item),
      })
      onDone()
      navigate(`/proofs/${item.proof_id}/versions/new`)
    } catch {
      setError('Could not reopen the project. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Start a reprint"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-[16px] border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Printer size={18} aria-hidden="true" className="text-brand" />
            <h2 className="text-[15px] font-semibold text-ink">Start a reprint</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-ink-mute hover:text-ink">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4">
          {loading ? (
            <div className="space-y-2">
              <div className="h-4 w-2/3 animate-pulse rounded bg-line-soft" />
              <div className="h-20 animate-pulse rounded-[10px] bg-line-soft" />
            </div>
          ) : created ? (
            // ── Done: reprint order raised ──────────────────────────────
            <div className="text-center">
              <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-in-stock-soft text-in-stock">
                <Check size={20} aria-hidden="true" />
              </div>
              <p className="text-[15px] font-semibold text-ink">Free reprint order raised</p>
              <p className="mx-auto mt-1 max-w-[40ch] text-[13px] text-ink-mute">
                It’s a £0 order — no payment, no invoice. In Orders, link a fresh Dropbox folder (named with the
                next order number) and place it to production like any job.
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <Link to="/orders">
                  <ButtonCoral icon={Package}>Go to Orders</ButtonCoral>
                </Link>
                <ButtonGhost onClick={onClose}>Close</ButtonGhost>
              </div>
            </div>
          ) : !original ? (
            // ── Nothing to reprint ──────────────────────────────────────
            <div className="text-center">
              <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-line-soft text-ink-mute">
                <AlertTriangle size={20} aria-hidden="true" />
              </div>
              <p className="text-[14px] font-medium text-ink">No produced order to reprint</p>
              <p className="mx-auto mt-1 max-w-[40ch] text-[13px] text-ink-mute">
                A reprint remakes an order that was paid or placed. {projectLabel(item)} doesn’t have one yet —
                raise a normal order first.
              </p>
              <div className="mt-4 flex justify-center">
                <ButtonGhost onClick={onClose}>Close</ButtonGhost>
              </div>
            </div>
          ) : (
            // ── Choice ──────────────────────────────────────────────────
            <>
              <p className="text-[13px] text-ink-soft">
                Remaking <span className="font-medium text-ink">{projectLabel(item)}</span>
                {original.stock_order_number && (
                  <>
                    {' '}— original order <span className="font-medium text-ink">#{original.stock_order_number}</span>
                  </>
                )}
                . The reprint is <span className="font-medium text-ink">free</span> and the original stays untouched.
              </p>

              {existingReprints.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-[8px] bg-canvas px-3 py-2 text-[12px] text-ink-soft">
                  <span>Already raised:</span>
                  {existingReprints.map((r) => (
                    <span key={r.id} className="inline-flex items-center gap-1">
                      {r.stock_order_number ? `#${r.stock_order_number}` : 'reprint'}
                      <Pill colour={r.status === 'fulfilled' ? 'in-stock' : 'allocated'}>{r.status}</Pill>
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-4 space-y-2.5">
                {/* Artwork correct → raise the reprint now */}
                <button
                  type="button"
                  disabled={busy || !isApproved}
                  onClick={() => void createReprint()}
                  className="group flex w-full items-start gap-3 rounded-[12px] border border-line bg-canvas px-4 py-3 text-left transition-colors hover:border-brand hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line disabled:hover:bg-canvas"
                >
                  <Printer size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-brand" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
                      The artwork is correct
                      <ArrowRight size={14} aria-hidden="true" className="text-ink-dim transition-transform group-hover:translate-x-0.5" />
                    </span>
                    <span className="mt-0.5 block text-[12px] text-ink-mute">
                      Damaged, lost, or wrong stock — remake the same approved design.
                    </span>
                    {!isApproved && (
                      <span className="mt-1 block text-[12px] font-medium text-out">
                        This project isn’t approved right now — finish the correction and re-approval first.
                      </span>
                    )}
                  </span>
                </button>

                {/* Design needs fixing → reopen */}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reopenForReprint()}
                  className="group flex w-full items-start gap-3 rounded-[12px] border border-line bg-canvas px-4 py-3 text-left transition-colors hover:border-brand hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Wrench size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-brand" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
                      The design needs correcting
                      <ArrowRight size={14} aria-hidden="true" className="text-ink-dim transition-transform group-hover:translate-x-0.5" />
                    </span>
                    <span className="mt-0.5 block text-[12px] text-ink-mute">
                      Reopen the project to fix the artwork. The original order stays as it is; raise the reprint
                      once the customer re-approves.
                    </span>
                  </span>
                </button>
              </div>
            </>
          )}

          {error && (
            <p className="mt-3 rounded-[8px] bg-out-soft px-3 py-2 text-[13px] text-out">{error}</p>
          )}
        </div>
      </div>
    </div>
  )
}
