import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DesignerChrome, PanelShell, ButtonCoral, ButtonGhost } from '../design'
import type { GridImage } from '../components/ImageGrid'

// OrderReviewPage (/orders/:id/place) — the review-and-confirm screen for placing
// a PAID order into production. Shows the artwork, spec, quantities, destination
// and the EXACT hand-off that will be sent — the in-house production note (posted
// to the customer's Help Scout thread) or the supplier email (with a supplier
// picker) — then a Confirm button that executes it via the place-order edge
// function. Preview + confirm both come from place-order, so what's shown is what
// goes out.

interface PreviewSummary {
  customer: string
  material: string | null
  variant: string | null
  finish: string | null
  inkFront: string | null
  inkBack: string | null
  quantity: number
  split: string[]
  packaging: string | null
  dateRequired: string
  dropboxFolderUrl: string | null
  route: 'in_house' | 'supplier'
}
interface SupplierOpt {
  id: string
  name: string
  email: string | null
  is_international: boolean
  default_shipping_days: number | null
}
interface PreviewResponse {
  ok: boolean
  error?: string
  route?: 'in_house' | 'supplier'
  subject?: string
  note_lines?: string[]
  email_lines?: string[]
  supplier?: SupplierOpt
  suppliers?: SupplierOpt[]
  ship_by?: string
  summary?: PreviewSummary
  helpscout_linked?: boolean
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-ink-mute">{label}</span>
      <span className="text-right font-medium text-ink">{value}</span>
    </div>
  )
}

export default function OrderReviewPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [supplierId, setSupplierId] = useState<string | null>(null)
  const [thumb, setThumb] = useState<GridImage | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  const loadPreview = useCallback(async (chosenSupplierId?: string | null) => {
    if (!id) return
    setError(null)
    const { data, error: fnErr } = await supabase.functions.invoke<PreviewResponse>('place-order', {
      body: { order_id: id, mode: 'preview', ...(chosenSupplierId ? { supplier_id: chosenSupplierId } : {}) },
    })
    if (fnErr || !data?.ok) {
      setError(data?.error ?? fnErr?.message ?? 'Could not load this order for review.')
      setPreview(null)
      return
    }
    setPreview(data)
    if (data.supplier && !chosenSupplierId) setSupplierId(data.supplier.id)
  }, [id])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      await loadPreview()
      // Representative artwork thumbnail (recognition aid). Resolve the proof id
      // off the order; ignore failures (the page works without a thumbnail).
      if (id) {
        const { data: order } = await supabase.from('orders').select('proof_id').eq('id', id).maybeSingle()
        const proofId = (order as { proof_id?: string } | null)?.proof_id
        if (proofId && !cancelled) {
          try {
            const { data: imgData } = await supabase.functions.invoke<{ images: GridImage[] }>('customer-proof-images', { body: { proofId } })
            const first = (imgData?.images ?? []).find((img) => img.is_qr_code !== true) ?? null
            if (!cancelled) setThumb(first)
          } catch { /* no thumbnail */ }
        }
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id, loadPreview])

  async function onSupplierChange(newId: string) {
    setSupplierId(newId)
    await loadPreview(newId)
  }

  async function confirm() {
    if (!id) return
    setConfirming(true)
    setConfirmError(null)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<{ ok: boolean; error?: string; placed?: boolean }>('place-order', {
        body: { order_id: id, mode: 'confirm', ...(supplierId ? { supplier_id: supplierId } : {}) },
      })
      if (fnErr || !data?.ok) {
        setConfirmError(data?.error ?? fnErr?.message ?? 'Could not place the order. Please try again.')
        return
      }
      navigate('/orders')
    } finally {
      setConfirming(false)
    }
  }

  const s = preview?.summary
  const isSupplier = preview?.route === 'supplier'

  return (
    <DesignerChrome active="orders">
      <main className="mx-auto max-w-[920px] px-4 py-8 sm:px-7">
        <Link to="/orders" className="text-[13px] text-ink-mute hover:underline">← Back to orders</Link>
        <h1 className="mt-2 text-xl font-semibold text-ink">Place order</h1>

        {loading ? (
          <p className="mt-8 text-sm text-ink-mute">Loading…</p>
        ) : error ? (
          <PanelShell className="mt-6">
            <p className="text-sm text-out">{error}</p>
            <div className="mt-4"><Link to="/orders"><ButtonGhost size="sm">Back to orders</ButtonGhost></Link></div>
          </PanelShell>
        ) : preview && s ? (
          <>
            <p className="mt-1 text-sm text-ink-soft">
              {s.customer}
              {' · '}
              <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-soft">
                {isSupplier ? 'Supplier order' : 'In-house order'}
              </span>
            </p>

            <div className="mt-6 grid gap-5 lg:grid-cols-2">
              {/* Left: the order at a glance */}
              <PanelShell>
                <div className="flex gap-4">
                  {thumb && (
                    <img src={thumb.signed_url} alt="Proof artwork" className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-line" />
                  )}
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Order</h2>
                    <p className="mt-1 text-base font-semibold text-ink">{s.material ?? 'Cards'}{s.variant && s.variant !== s.material ? ` · ${s.variant}` : ''}</p>
                    {s.finish && <p className="text-sm text-ink-soft">{s.finish}</p>}
                  </div>
                </div>
                <div className="mt-4 divide-y divide-line-soft border-t border-line-soft">
                  <Row label="Quantity" value={`${s.quantity.toLocaleString()} cards`} />
                  {s.split.length > 0 && (
                    <div className="py-1.5 text-sm">
                      <span className="text-ink-mute">Per person</span>
                      <div className="mt-1 space-y-0.5">
                        {s.split.map((line, i) => <p key={i} className="text-right font-medium text-ink">{line}</p>)}
                      </div>
                    </div>
                  )}
                  {s.inkFront && <Row label="Ink on front" value={s.inkFront} />}
                  {s.inkBack && <Row label="Ink on back" value={s.inkBack} />}
                  {s.packaging && <Row label="Packaging" value={s.packaging} />}
                  <Row label="Date required" value={s.dateRequired || '—'} />
                  {isSupplier && preview.ship_by && <Row label="Must ship by" value={preview.ship_by} />}
                  <Row
                    label="Artwork"
                    value={s.dropboxFolderUrl
                      ? <a href={s.dropboxFolderUrl} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Dropbox folder ↗</a>
                      : <span className="text-low">No folder linked</span>}
                  />
                </div>
              </PanelShell>

              {/* Right: the exact hand-off */}
              <PanelShell>
                {isSupplier ? (
                  <>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Email to supplier</h2>
                    <label className="mt-3 block">
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Supplier</span>
                      <select
                        value={supplierId ?? ''}
                        onChange={(e) => void onSupplierChange(e.target.value)}
                        className="mt-1 h-[38px] w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                      >
                        {(preview.suppliers ?? []).map((sup) => (
                          <option key={sup.id} value={sup.id}>
                            {sup.name}{sup.email ? ` (${sup.email})` : ''}{sup.is_international ? ' · intl' : ''}
                          </option>
                        ))}
                      </select>
                      {preview.supplier && !preview.supplier.email && (
                        <span className="mt-1 block text-[12px] text-out">This supplier has no email configured in Stock Control.</span>
                      )}
                    </label>
                    <p className="mt-3 text-[12px] text-ink-mute">Subject</p>
                    <p className="text-sm font-medium text-ink">{preview.subject}</p>
                    <p className="mt-3 text-[12px] text-ink-mute">Message</p>
                    <pre className="mt-1 whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 text-[13px] text-ink">{(preview.email_lines ?? []).join('\n')}</pre>
                    <p className="mt-2 text-[12px] text-ink-mute">Sent to the supplier on a new Help Scout conversation, which hands the order to Stock Control. Artwork goes via the Dropbox link above.</p>
                  </>
                ) : (
                  <>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Production note</h2>
                    <p className="mt-3 text-[12px] text-ink-mute">Help Scout subject will be set to</p>
                    <p className="text-sm font-medium text-ink">{preview.subject}</p>
                    <p className="mt-3 text-[12px] text-ink-mute">Note posted to the customer’s thread</p>
                    <pre className="mt-1 whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 text-[13px] text-ink">{(preview.note_lines ?? []).join('\n')}</pre>
                    {preview.helpscout_linked === false && (
                      <p className="mt-2 text-[12px] text-out">This proof has no linked Help Scout conversation — the note can’t be posted until one is linked.</p>
                    )}
                    <p className="mt-2 text-[12px] text-ink-mute">Stock Control reads this note and schedules the job.</p>
                  </>
                )}
              </PanelShell>
            </div>

            {confirmError && (
              <p className="mt-4 rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out ring-1 ring-out">
                <span className="font-medium">Couldn’t place the order.</span> {confirmError}
              </p>
            )}

            <div className="mt-6 flex items-center justify-end gap-3">
              <Link to="/orders"><ButtonGhost disabled={confirming}>Cancel</ButtonGhost></Link>
              <ButtonCoral onClick={() => void confirm()} disabled={confirming}>
                {confirming ? 'Placing…' : isSupplier ? 'Confirm & email supplier' : 'Confirm & post note'}
              </ButtonCoral>
            </div>
          </>
        ) : null}
      </main>
    </DesignerChrome>
  )
}
