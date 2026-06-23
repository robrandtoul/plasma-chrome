import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DesignerChrome, PanelShell, ButtonCoral, ButtonGhost } from '../design'
import { ImageCard, type GridImage } from '../components/ImageGrid'
import Modal from '../components/Modal'

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
  // In-house only: which Dropbox folder files will be attached to the note (so
  // Stock Control mirrors them onto the job card) vs skipped (too big / not art).
  artwork_plan?: { attach: string[]; skipped: { name: string; reason: string }[] }
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-ink-mute">{label}</span>
      <span className="text-right font-medium text-ink">{value}</span>
    </div>
  )
}

// supabase-js surfaces a non-2xx edge response as { data: null, error }, with
// the JSON body on error.context (a Response) — NOT on `data`. place-order
// returns its failures (incl. the sent_not_recorded signal) with non-2xx codes,
// so we must read { ok, error, code } off the error or every failure looks
// opaque and the re-send guard never fires.
async function readFnErrorBody(err: unknown): Promise<{ error?: string; code?: string } | null> {
  const ctx = (err as { context?: { json?: () => Promise<unknown> } } | null)?.context
  if (ctx && typeof ctx.json === 'function') {
    try {
      return (await ctx.json()) as { error?: string; code?: string }
    } catch {
      /* body wasn't JSON — fall back to the error message */
    }
  }
  return null
}

export default function OrderReviewPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [supplierId, setSupplierId] = useState<string | null>(null)
  // The full set of approved artwork for the order's CURRENT version (every
  // name + side), shown as a gallery the reviewer can open full size.
  const [artwork, setArtwork] = useState<GridImage[]>([])
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  // Supplier sends a REAL email — require an explicit second click to arm it.
  const [armed, setArmed] = useState(false)
  // True while a supplier change re-fetches the preview — disables the picker +
  // confirm so the armed banner, the button label, and the id actually sent
  // can't describe different suppliers mid-fetch.
  const [supplierLoading, setSupplierLoading] = useState(false)
  // Set when the hand-off WAS sent but the status flip failed (place-order
  // returns code 'sent_not_recorded') — block any retry, which would re-send.
  const [sentNotRecorded, setSentNotRecorded] = useState<string | null>(null)

  const loadPreview = useCallback(async (chosenSupplierId?: string | null) => {
    if (!id) return
    setError(null)
    const { data, error: fnErr } = await supabase.functions.invoke<PreviewResponse>('place-order', {
      body: { order_id: id, mode: 'preview', ...(chosenSupplierId ? { supplier_id: chosenSupplierId } : {}) },
    })
    if (fnErr || !data?.ok) {
      const body = data ?? await readFnErrorBody(fnErr)
      setError(body?.error ?? fnErr?.message ?? 'Could not load this order for review.')
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
      // Approved artwork for review. Resolve the proof id off the order; ignore
      // failures (the page still works without artwork).
      if (id) {
        const { data: order } = await supabase.from('orders').select('proof_id').eq('id', id).maybeSingle()
        const proofId = (order as { proof_id?: string } | null)?.proof_id
        if (proofId && !cancelled) {
          try {
            // customer-proof-images returns EVERY version's images (the customer
            // page has a version switcher), so scope to the CURRENT version —
            // otherwise earlier-version artwork would leak in. Show ALL of the
            // current version's non-QR images (every name + side) so the
            // reviewer sees exactly what's being produced. Falls back to all
            // non-QR images only if the current version can't be resolved.
            const { data: curV } = await supabase
              .from('proof_versions')
              .select('id')
              .eq('proof_id', proofId)
              .eq('is_current', true)
              .maybeSingle()
            const currentVersionId = (curV as { id?: string } | null)?.id ?? null
            const nonQr = ((await supabase.functions.invoke<{ images: GridImage[] }>('customer-proof-images', { body: { proofId } })).data?.images ?? [])
              .filter((img) => img.is_qr_code !== true)
            const scoped = currentVersionId
              ? nonQr.filter((img) => (img as unknown as { proof_version_id?: string }).proof_version_id === currentVersionId)
              : []
            const gallery = scoped.length > 0 ? scoped : nonQr
            // Caption each image with name + side, but only show a dimension when
            // it actually varies (mirrors the proof page's approved-artwork
            // table): hide the name when everything is shared, hide the side when
            // it's one-sided.
            const hasNames = gallery.some((g) => g.associated_name)
            const hasBack = gallery.some((g) => g.side === 'back')
            const labelled = gallery.map((g) => ({
              ...g,
              label: [
                hasNames ? (g.associated_name ?? 'Shared') : '',
                hasBack ? (g.side === 'back' ? 'Back' : 'Front') : '',
              ].filter(Boolean).join(' · '),
            }))
            labelled.sort((a, b) => {
              const an = a.associated_name == null ? 0 : 1
              const bn = b.associated_name == null ? 0 : 1
              if (an !== bn) return an - bn
              const nameCmp = (a.associated_name ?? '').localeCompare(b.associated_name ?? '')
              if (nameCmp !== 0) return nameCmp
              const as = (a.side ?? 'front') === 'front' ? 0 : 1
              const bs = (b.side ?? 'front') === 'front' ? 0 : 1
              return as - bs
            })
            if (!cancelled) setArtwork(labelled)
          } catch { /* no artwork */ }
        }
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id, loadPreview])

  async function onSupplierChange(newId: string) {
    setSupplierId(newId)
    setArmed(false) // changing supplier disarms — re-confirm the new recipient
    setConfirmError(null) // a prior failure was about the previous supplier
    setSupplierLoading(true)
    try {
      await loadPreview(newId)
    } finally {
      setSupplierLoading(false)
    }
  }

  async function confirm() {
    if (!id) return
    setConfirming(true)
    setConfirmError(null)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<{ ok: boolean; error?: string; code?: string; placed?: boolean }>('place-order', {
        body: { order_id: id, mode: 'confirm', ...(supplierId ? { supplier_id: supplierId } : {}) },
      })
      // On a non-2xx (which is how place-order returns sent_not_recorded AND its
      // other failures) supabase-js gives data:null + the body on error.context.
      // Read whichever is populated so the code + message are never lost.
      const body = data ?? await readFnErrorBody(fnErr)
      if (body?.code === 'sent_not_recorded') {
        // The hand-off WAS sent; only the status flip failed. Do NOT let the user
        // retry (that re-sends) — show the manual-fix instruction instead.
        setSentNotRecorded(body.error ?? 'The hand-off was sent but the order status could not be updated. Mark it placed manually in Stock Control.')
        return
      }
      if (fnErr || !data?.ok) {
        setConfirmError(body?.error ?? fnErr?.message ?? 'Could not place the order. Please try again.')
        return
      }
      navigate('/orders')
    } finally {
      setConfirming(false)
    }
  }

  const s = preview?.summary
  const isSupplier = preview?.route === 'supplier'
  // Hand-off preconditions the page already knows about — disable Confirm when
  // it provably can't succeed, rather than letting the doomed round-trip run.
  const noSuppliers = isSupplier && (preview?.suppliers ?? []).length === 0
  // Several allowed suppliers + none picked yet → the placer must choose (no
  // default, by design). A single allowed supplier is auto-selected upstream.
  const mustChoose = isSupplier && !noSuppliers && (preview?.suppliers ?? []).length > 1 && !supplierId
  // Only meaningful once a supplier is resolved (picked or the lone one).
  const supplierEmailMissing = isSupplier && !!preview?.supplier && !preview.supplier.email
  const hsMissing = !isSupplier && preview?.helpscout_linked === false
  const blockReason = noSuppliers
    ? 'No suppliers are configured for this material — set them on Admin → Outsourcing.'
    : mustChoose
      ? 'Choose a supplier to order from.'
      : supplierEmailMissing
        ? 'The selected supplier has no email address in Stock Control, so this order can’t be emailed.'
        : hsMissing
          ? 'This proof has no linked Help Scout conversation, so the production note can’t be posted.'
          : null
  const canConfirm = !blockReason

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

            {/* Approved artwork — the whole point of the review: see exactly
                what's being produced. Every name + side of the current version,
                each opening full size in a lightbox. */}
            {artwork.length > 0 && (
              <PanelShell className="mt-6">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Approved artwork</h2>
                <p className="mt-1 text-xs text-ink-mute">
                  This is exactly what will be produced. Click any image to view it full size.
                </p>
                <div className={`mt-3 grid gap-4 ${artwork.length === 1 ? 'max-w-md' : 'sm:grid-cols-2'}`}>
                  {artwork.map((img) => (
                    <ImageCard key={img.id} image={img} alt={img.label || 'Approved artwork'} onClick={setLightboxSrc} />
                  ))}
                </div>
              </PanelShell>
            )}

            <div className="mt-6 grid gap-5 lg:grid-cols-2">
              {/* Left: the order at a glance */}
              <PanelShell>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Order</h2>
                  <p className="mt-1 text-base font-semibold text-ink">{s.material ?? 'Cards'}{s.variant && s.variant !== s.material ? ` · ${s.variant}` : ''}</p>
                  {s.finish && <p className="text-sm text-ink-soft">{s.finish}</p>}
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
                        disabled={supplierLoading}
                        className="mt-1 h-[38px] w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] disabled:opacity-60"
                      >
                        {/* No default when several are allowed — make the placer pick. */}
                        {!supplierId && <option value="">Choose a supplier…</option>}
                        {(preview.suppliers ?? []).map((sup) => (
                          <option key={sup.id} value={sup.id}>
                            {sup.name}{sup.email ? ` (${sup.email})` : ''}{sup.is_international ? ' · intl' : ''}
                          </option>
                        ))}
                      </select>
                      {supplierLoading && (
                        <span className="mt-1 block text-[12px] text-ink-mute">Updating preview…</span>
                      )}
                      {!supplierLoading && mustChoose && (
                        <span className="mt-1 block text-[12px] text-ink-mute">Choose which supplier to order from.</span>
                      )}
                      {!supplierLoading && noSuppliers && (
                        <span className="mt-1 block text-[12px] text-out">No suppliers are configured for this material — set them on Admin → Outsourcing.</span>
                      )}
                      {!supplierLoading && supplierEmailMissing && (
                        <span className="mt-1 block text-[12px] text-out">This supplier has no email configured in Stock Control.</span>
                      )}
                    </label>
                    <p className="mt-3 text-[12px] text-ink-mute">Subject</p>
                    <p className="text-sm font-medium text-ink">{preview.subject}</p>
                    <p className="mt-3 text-[12px] text-ink-mute">Message</p>
                    <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-3 text-[13px] text-ink">{(preview.email_lines ?? []).join('\n')}</pre>
                    <p className="mt-2 text-[12px] text-ink-mute">Sent to the supplier on a new Help Scout conversation, which hands the order to Stock Control. Artwork goes via the Dropbox link above.</p>
                  </>
                ) : (
                  <>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Production note</h2>
                    <p className="mt-3 text-[12px] text-ink-mute">Help Scout subject will be set to</p>
                    <p className="text-sm font-medium text-ink">{preview.subject}</p>
                    <p className="mt-3 text-[12px] text-ink-mute">Note posted to the customer’s thread</p>
                    <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-3 text-[13px] text-ink">{(preview.note_lines ?? []).join('\n')}</pre>
                    {preview.helpscout_linked === false && (
                      <p className="mt-2 text-[12px] text-out">This proof has no linked Help Scout conversation — the note can’t be posted until one is linked.</p>
                    )}
                    {preview.artwork_plan && (
                      <div className="mt-3 rounded-lg border border-line-soft bg-canvas/60 p-3 text-[12px]">
                        {preview.artwork_plan.attach.length > 0 ? (
                          <>
                            <p className="font-medium text-ink">
                              {preview.artwork_plan.attach.length} artwork file{preview.artwork_plan.attach.length === 1 ? '' : 's'} will be attached to the note
                            </p>
                            <ul className="mt-1 list-disc pl-4 text-ink-soft">
                              {preview.artwork_plan.attach.map((n) => <li key={n} className="break-all">{n}</li>)}
                            </ul>
                          </>
                        ) : (
                          <p className="text-ink-mute">No files will be attached — production will open the Dropbox folder from the link in the note.</p>
                        )}
                        {preview.artwork_plan.skipped.length > 0 && (
                          <p className="mt-1.5 text-ink-mute">
                            Skipped (use the Dropbox link): {preview.artwork_plan.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}
                          </p>
                        )}
                      </div>
                    )}
                    <p className="mt-2 text-[12px] text-ink-mute">Stock Control reads this note and schedules the job.</p>
                  </>
                )}
              </PanelShell>
            </div>

            {sentNotRecorded ? (
              <>
                <p className="mt-4 rounded-lg bg-low-soft px-3 py-3 text-[13px] text-ink ring-1 ring-low">
                  <span className="font-medium">Sent, but not recorded.</span> {sentNotRecorded}
                </p>
                <div className="mt-6 flex items-center justify-end gap-3">
                  <Link to="/orders"><ButtonGhost>Back to orders</ButtonGhost></Link>
                </div>
              </>
            ) : (
              <>
                {confirmError && (
                  <p className="mt-4 rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out ring-1 ring-out">
                    <span className="font-medium">Couldn’t place the order.</span> {confirmError}
                  </p>
                )}

                {/* Supplier sends a real, immediate email — arm it with an explicit
                    second click so a misclick can't fire an external order. */}
                {isSupplier && armed && (
                  <p className="mt-4 rounded-lg bg-low-soft px-3 py-2 text-[13px] text-ink ring-1 ring-low">
                    This emails <span className="font-medium">{preview.supplier?.name}</span>
                    {preview.supplier?.email ? ` (${preview.supplier.email})` : ''} right now — they’ll receive the order immediately. Send it?
                  </p>
                )}

                <div className="mt-6 flex items-center justify-end gap-3">
                  {isSupplier && armed ? (
                    <>
                      <ButtonGhost onClick={() => { setArmed(false); setConfirmError(null) }} disabled={confirming}>Back</ButtonGhost>
                      <ButtonCoral onClick={() => void confirm()} disabled={confirming || supplierLoading || !canConfirm} title={blockReason ?? undefined}>
                        {confirming ? 'Sending…' : `Yes — email ${preview.supplier?.name ?? 'supplier'} now`}
                      </ButtonCoral>
                    </>
                  ) : (
                    <>
                      <Link to="/orders"><ButtonGhost disabled={confirming}>Cancel</ButtonGhost></Link>
                      <ButtonCoral
                        onClick={() => { if (isSupplier) { setArmed(true) } else { void confirm() } }}
                        disabled={confirming || supplierLoading || !canConfirm}
                        title={blockReason ?? undefined}
                      >
                        {confirming ? 'Placing…' : isSupplier ? 'Confirm & email supplier' : 'Confirm & post note'}
                      </ButtonCoral>
                    </>
                  )}
                </div>
              </>
            )}

            {/* Full-size artwork viewer. Portal-based Modal with its own Esc +
                backdrop close; bg-black/80 backdrop, transparent panel. */}
            <Modal
              open={!!lightboxSrc}
              onClose={() => setLightboxSrc(null)}
              ariaLabel="Approved artwork preview"
              backdropClassName="bg-black/80"
              panelClassName="bg-transparent"
            >
              {lightboxSrc && (
                <img
                  src={lightboxSrc}
                  alt="Approved artwork"
                  className="max-h-[calc(100dvh-2rem)] max-w-full rounded-lg object-contain"
                />
              )}
            </Modal>
          </>
        ) : null}
      </main>
    </DesignerChrome>
  )
}
