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
  quantity: number | null
  created_at: string
  fulfilled_at: string | null
  dropbox_folder_url: string | null
  project_name: string | null
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
  const [created, setCreated] = useState<{ orderId: string; reference: string | null } | null>(null)

  // Folder-clone (after the reprint order is raised): copy the original artwork
  // into a fresh folder named with the next order number, and link it.
  const [cloneNumber, setCloneNumber] = useState('')
  const [cloning, setCloning] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloneLinked, setCloneLinked] = useState<{ number: string; fileCount: number | null } | null>(null)

  // Reprint quantity — defaults to the original order's; lower it for a partial
  // reprint (only some were faulty). Sent to create-order on the artwork path.
  const [qtyInput, setQtyInput] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      const [proofRes, ordersRes] = await Promise.all([
        supabase.from('proofs').select('status').eq('id', item.proof_id).maybeSingle(),
        supabase
          .from('orders')
          .select('id, stock_order_number, order_kind, status, reprint_of_order_id, currency, quantity, created_at, fulfilled_at, dropbox_folder_url, project_name')
          .eq('proof_id', item.proof_id)
          .order('created_at', { ascending: false }),
      ])
      if (cancelled) return
      setProofStatus((proofRes.data?.status as string | null) ?? null)
      const ords = (ordersRes.data ?? []) as OrderRow[]
      setOrders(ords)
      // Default the reprint quantity to the original order's (full reprint).
      const orig = ords.find((o) => o.order_kind !== 'reprint' && (o.status === 'fulfilled' || o.status === 'paid')) ?? null
      setQtyInput(orig?.quantity != null ? String(orig.quantity) : '')
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
    // Reprint quantity: a valid figure that differs from the original is a
    // partial reprint; send it through. Blank/invalid → omit (full reprint).
    const qty = parseInt(qtyInput.trim(), 10)
    const quantityBody = Number.isInteger(qty) && qty > 0 ? qty : undefined
    const isPartial = quantityBody != null && original.quantity != null && quantityBody !== original.quantity
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
          ...(quantityBody != null ? { quantity: quantityBody } : {}),
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
      const qtyLabel = quantityBody != null ? ` — ${quantityBody} card${quantityBody === 1 ? '' : 's'}${isPartial ? ' (partial)' : ''}` : ''
      await supabase.from('watch_updates').insert({
        watch_item_id: item.id,
        kind: 'note',
        body: `Free reprint order raised${qtyLabel} (replacing ${original.stock_order_number ? `#${original.stock_order_number}` : 'the original order'}). Next: link a new Dropbox folder with the next order number and place it from Orders.`,
        created_by: userId,
      })
      void logAudit({
        action: 'watch.reprint_created',
        targetType: 'watch_item',
        targetId: item.id,
        targetLabel: projectLabel(item),
        metadata: { reprint_of_order_id: original.id, order_id: data.id },
      })
      setCreated({ orderId: data.id, reference: data.payment_reference })
      onDone()
    } catch {
      setError('Could not raise the reprint order. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  // Copy the original order's Dropbox artwork into a new folder (named with the
  // designer's next order number) and link it to the reprint order — saving the
  // by-hand file copy. Best-effort: on any failure the designer just sets the
  // folder up manually in Orders.
  async function cloneAndLink() {
    if (!created || !original?.dropbox_folder_url) return
    const number = cloneNumber.trim()
    if (!/^\d{3,}$/.test(number)) {
      setCloneError('Enter the new order number (digits only).')
      return
    }
    const projectName = (original.project_name || projectLabel(item)).trim()
    const newName = `${number} - ${projectName}`
    setCloning(true)
    setCloneError(null)
    try {
      const { data, error: fnError } = await supabase.functions.invoke<
        | { ok: true; shared_url: string; order_number: string; project_name: string; file_count: number | null }
        | { ok: false; error: string }
      >('clone-order-folder', {
        body: { source_url: original.dropbox_folder_url, new_name: newName },
      })
      if (fnError || !data || data.ok !== true) {
        setCloneError((data as { error?: string } | null)?.error ?? 'Could not copy the folder — set it up manually in Orders.')
        return
      }
      // Link the new folder to the reprint order (mirrors the Orders page link flow).
      const { error: updErr } = await supabase
        .from('orders')
        .update({
          dropbox_folder_url: data.shared_url,
          stock_order_number: data.order_number,
          project_name: data.project_name,
        })
        .eq('id', created.orderId)
      if (updErr) {
        setCloneError('Copied the folder, but couldn’t link it — link it in Orders.')
        return
      }
      await supabase.from('watch_updates').insert({
        watch_item_id: item.id,
        kind: 'note',
        body: `Reprint artwork copied into new folder #${data.order_number}${data.file_count != null ? ` (${data.file_count} file${data.file_count === 1 ? '' : 's'})` : ''}. Ready to place from Orders.`,
        created_by: userId,
      })
      setCloneLinked({ number: data.order_number, fileCount: data.file_count })
      onDone()
    } catch {
      setCloneError('Could not copy the folder — set it up manually in Orders.')
    } finally {
      setCloning(false)
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

              {cloneLinked ? (
                <p className="mx-auto mt-1 max-w-[42ch] text-[13px] text-ink-mute">
                  Artwork copied into folder <span className="font-medium text-ink">#{cloneLinked.number}</span>
                  {cloneLinked.fileCount != null ? ` (${cloneLinked.fileCount} file${cloneLinked.fileCount === 1 ? '' : 's'})` : ''} and
                  linked. Go to Orders to place it.
                </p>
              ) : original?.dropbox_folder_url ? (
                <div className="mt-3 rounded-[10px] border border-line bg-canvas p-3 text-left">
                  <p className="text-[13px] font-medium text-ink">Copy the artwork into a new folder</p>
                  <p className="mt-0.5 text-[12px] text-ink-mute">
                    Enter the next order number — I’ll copy the original artwork into a fresh folder
                    {original.project_name ? (
                      <> named <span className="font-medium text-ink">“{cloneNumber.trim() || '…'} - {original.project_name}”</span></>
                    ) : null}{' '}
                    and link it to this reprint.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={cloneNumber}
                      onChange={(e) => setCloneNumber(e.target.value)}
                      inputMode="numeric"
                      placeholder="e.g. 404015"
                      className="h-[34px] w-32 rounded-[8px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand"
                    />
                    <ButtonCoral size="sm" busy={cloning} disabled={!cloneNumber.trim()} onClick={() => void cloneAndLink()}>
                      Copy &amp; link
                    </ButtonCoral>
                  </div>
                  {cloneError && <p className="mt-1.5 text-[12px] text-out">{cloneError}</p>}
                  <p className="mt-1.5 text-[12px] text-ink-dim">Or skip and set the folder up yourself in Orders.</p>
                </div>
              ) : (
                <p className="mx-auto mt-1 max-w-[40ch] text-[13px] text-ink-mute">
                  It’s a £0 order — no payment, no invoice. In Orders, link a fresh Dropbox folder (next order
                  number) and place it like any job.
                </p>
              )}

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
                {/* Artwork correct → raise the reprint now, optionally a partial qty */}
                <div className="rounded-[12px] border border-line bg-canvas px-4 py-3">
                  <div className="flex items-start gap-3">
                    <Printer size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-brand" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold text-ink">The artwork is correct</div>
                      <div className="mt-0.5 text-[12px] text-ink-mute">
                        Damaged, lost, or wrong stock — remake the same approved design.
                      </div>
                    </div>
                  </div>
                  {isApproved ? (
                    <>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <label className="flex items-center gap-1.5 text-[12px] text-ink-soft">
                          Reprint
                          <input
                            type="number"
                            min={1}
                            inputMode="numeric"
                            value={qtyInput}
                            onChange={(e) => setQtyInput(e.target.value)}
                            className="h-[32px] w-20 rounded-[8px] border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-brand"
                          />
                          {original.quantity != null && <span className="text-ink-dim">of {original.quantity}</span>}
                        </label>
                        <ButtonCoral size="sm" busy={busy} onClick={() => void createReprint()}>
                          Raise free reprint
                        </ButtonCoral>
                      </div>
                      <p className="mt-1.5 text-[11px] text-ink-dim">
                        Lower the quantity for a partial reprint (only some were faulty).
                      </p>
                    </>
                  ) : (
                    <p className="mt-2.5 text-[12px] font-medium text-out">
                      This project isn’t approved right now — finish the correction and re-approval first.
                    </p>
                  )}
                </div>

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
