import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DesignerChrome, PanelShell, ButtonCoral, ButtonGhost } from '../design'
import { ImageCard, type GridImage } from '../components/ImageGrid'
import Modal from '../components/Modal'
import { checkEditedMessage } from '../lib/handoffMessageCheck'
import ArtworkCheckReportView, { InlineSpinner, type ArtworkCheckReport } from '../components/ArtworkCheckReportView'

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
  // Supplier route: quantity the supplier is told to make = quantity + spoilage
  // overs. Equals quantity when there are no overs (and on the in-house route).
  supplierQuantity?: number
  supplierOvers?: number
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
  // The machine-read spec lines (Qty/Material/…) that a fully-edited message
  // must still contain — used to warn before sending and re-checked server-side.
  critical_lines?: string[]
  supplier?: SupplierOpt
  suppliers?: SupplierOpt[]
  ship_by?: string
  summary?: PreviewSummary
  helpscout_linked?: boolean
  // Both routes: which Dropbox folder files will be attached (to the in-house
  // note, or to the supplier email) vs skipped (too big / not artwork).
  artwork_plan?: { attach: string[]; skipped: { name: string; reason: string }[] }
  // Optional Stock Control direct hand-off validation (order-handoff spec
  // §3.3 / §6 Phase 1). Absent or null while the feature is off — the common
  // case — in which case nothing renders. When present with any problems or
  // warnings, they show as a NON-BLOCKING amber card: shadow mode surfaces
  // mapping/setup gaps early without gating Confirm.
  handoff_validation?: {
    ok: boolean
    problems: { code: string; message: string }[]
    warnings: { code: string; message: string }[]
  } | null
}

// The artwork-check edge function's response envelope; the report shape +
// renderer live in ArtworkCheckReportView (shared with the Orders page).
interface ArtworkCheckResponse {
  ok: boolean
  mode?: 'off' | 'shadow' | 'live'
  required?: boolean
  cached?: boolean
  report?: ArtworkCheckReport
  error?: string
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
  // True while a preview round-trip is in flight (incl. a note re-preview on
  // blur). The message box is locked during it so a keystroke can't seed the
  // edit from text that doesn't yet reflect the just-typed note.
  const [previewBusy, setPreviewBusy] = useState(false)
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
  // Optional project-specific note appended to the supplier email (supplier
  // route). Re-previewed on blur so the reviewer sees exactly what's sent.
  const [note, setNote] = useState('')
  // Spoilage overs (supplier route, hybrid foiling orders): extra cards added to
  // the SUPPLIER order to cover foiling done in-house. Manual, starts at 0, no
  // default. Padded onto the supplier Qty line only — the customer's quantity is
  // unchanged. Re-previewed on blur so the message reflects the padded Qty.
  const [overs, setOvers] = useState(0)
  // The reviewer can edit the whole hand-off message before sending. null = not
  // edited (the box mirrors the generated preview, incl. supplier/note changes);
  // a string = the reviewer owns the text and it's sent verbatim. Reset on
  // supplier change so a stale ship-by date can't slip through.
  const [editedMessage, setEditedMessage] = useState<string | null>(null)
  // A revision order that was ALREADY placed (fulfilled_at set) is being
  // re-placed — place-order requires confirmation the old Stock Control job was
  // cancelled first (docs/order-cancel-and-revision-spec.md §3b). Resolved from
  // the order row on load.
  const [revisionReplace, setRevisionReplace] = useState(false)
  const [oldJobCancelled, setOldJobCancelled] = useState(false)
  // A revision order (scenario 3 or 4) whose proof has been reopened but not yet
  // re-approved can't be placed (place-order 409s server-side); gate the button
  // client-side too so the reviewer sees why, rather than a post-click error.
  const [revisionNeedsApproval, setRevisionNeedsApproval] = useState(false)
  // The artwork sanity check — auto-run on load so the happy path needs no
  // extra click. `live` only turns true when the function says the mode is
  // live, so in off/shadow (or with the function not deployed yet) nothing
  // ever renders. A failed RE-run keeps the previous report on screen rather
  // than emptying good state.
  const [artworkCheck, setArtworkCheck] = useState<{
    status: 'hidden' | 'running' | 'done'
    live: boolean
    required: boolean
    report: ArtworkCheckReport | null
  }>({ status: 'hidden', live: false, required: false, report: null })

  const loadPreview = useCallback(async (chosenSupplierId?: string | null, noteArg?: string, oversArg?: number) => {
    if (!id) return
    setError(null)
    setPreviewBusy(true)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<PreviewResponse>('place-order', {
        body: { order_id: id, mode: 'preview', ...(chosenSupplierId ? { supplier_id: chosenSupplierId } : {}), ...(noteArg ? { note: noteArg } : {}), ...(oversArg ? { supplier_overs: oversArg } : {}) },
      })
      if (fnErr || !data?.ok) {
        const body = data ?? await readFnErrorBody(fnErr)
        setError(body?.error ?? fnErr?.message ?? 'Could not load this order for review.')
        setPreview(null)
        return
      }
      setPreview(data)
      if (data.supplier && !chosenSupplierId) setSupplierId(data.supplier.id)
    } finally {
      setPreviewBusy(false)
    }
  }, [id])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      await loadPreview()
      // Approved artwork for review. Resolve the proof id off the order; ignore
      // failures (the page still works without artwork).
      if (id) {
        const { data: order } = await supabase.from('orders').select('proof_id, status, fulfilled_at, material_id').eq('id', id).maybeSingle()
        const proofId = (order as { proof_id?: string } | null)?.proof_id
        const orderStatus = (order as { status?: string } | null)?.status ?? null
        // The order's own material — the artwork gallery must show the version this
        // order was placed against, which for a two-material proof is NOT
        // necessarily the current version (mirrors place-order + OrdersPage).
        const orderMaterialId = (order as { material_id?: string | null } | null)?.material_id ?? null
        if (!cancelled) {
          const o = order as { status?: string; fulfilled_at?: string | null } | null
          setRevisionReplace(o?.status === 'revision' && !!o?.fulfilled_at)
        }
        // For a revision order, gate Confirm on the proof being re-approved.
        if (proofId && orderStatus === 'revision' && !cancelled) {
          const { data: pr } = await supabase.from('proofs').select('status').eq('id', proofId).maybeSingle()
          if (!cancelled) setRevisionNeedsApproval(((pr as { status?: string } | null)?.status ?? null) !== 'approved')
        }
        if (proofId && !cancelled) {
          try {
            // customer-proof-images returns EVERY version's images (the customer
            // page has a version switcher), so scope to the version this ORDER was
            // placed against — the version whose material matches the order's, NOT
            // necessarily the current version. A proof can carry orders in two
            // materials (e.g. a metal order on a proof whose current version is now
            // letterpress); the current version's art would be the wrong product.
            // Prefer the current version when it matches (the common case); fall
            // back to it, then to all non-QR images, if nothing matches.
            const { data: vRows } = await supabase
              .from('proof_versions')
              .select('id, material_id, is_current, version_number')
              .eq('proof_id', proofId)
              .order('version_number', { ascending: false })
            const vers = (vRows ?? []) as { id: string; material_id: string | null; is_current: boolean }[]
            const matches = orderMaterialId ? vers.filter((v) => v.material_id === orderMaterialId) : []
            const scopedVersionId =
              (matches.find((v) => v.is_current) ?? matches[0] ?? vers.find((v) => v.is_current))?.id ?? null
            const nonQr = ((await supabase.functions.invoke<{ images: GridImage[] }>('customer-proof-images', { body: { proofId } })).data?.images ?? [])
              .filter((img) => img.is_qr_code !== true)
            const scoped = scopedVersionId
              ? nonQr.filter((img) => (img as unknown as { proof_version_id?: string }).proof_version_id === scopedVersionId)
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

  // Run (or force re-run) the artwork check. The function is the mode gate:
  // off/shadow → no report in live shape, so the card stays hidden; the run
  // itself still happens server-side in shadow (that's the rollout's data
  // collection). Any invoke failure degrades to hidden/previous state — this
  // card must never break the review page.
  const runArtworkCheck = useCallback(async (force: boolean) => {
    if (!id) return
    setArtworkCheck((prev) => ({ ...prev, status: 'running' }))
    try {
      const { data } = await supabase.functions.invoke<ArtworkCheckResponse>('artwork-check', {
        body: { order_id: id, ...(force ? { force: true } : {}) },
      })
      if (!data?.ok || data.mode !== 'live') {
        // Correct a wrong optimistic pre-read (below): if the mode isn't live,
        // the card must not linger.
        setArtworkCheck((prev) => ({ ...prev, live: false, status: prev.report ? 'done' : 'hidden' }))
        return
      }
      setArtworkCheck((prev) => ({
        status: 'done',
        live: true,
        required: data.required === true,
        report: data.report ?? prev.report,
      }))
    } catch {
      setArtworkCheck((prev) => ({ ...prev, status: prev.report ? 'done' : 'hidden' }))
    }
  }, [id])

  useEffect(() => {
    // The check auto-runs on load, but `live` (which gates the card) isn't
    // known until that ~30–50s call returns — leaving the reviewer with no
    // sign anything is happening on the first, uncached run. Pre-read the mode
    // so the "Checking…" card + spinner appear immediately; the run's own
    // response stays authoritative and corrects this if it disagrees.
    void supabase
      .from('settings')
      .select('artwork_check_mode')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data }) => {
        if ((data as { artwork_check_mode?: string | null } | null)?.artwork_check_mode === 'live') {
          setArtworkCheck((prev) => (prev.status === 'done' ? prev : { ...prev, live: true }))
        }
      })
    void runArtworkCheck(false)
  }, [runArtworkCheck])

  // Per-flag history walk (designer-triggered — see ArtworkCheckReportView).
  // On success the investigation is cached server-side AND merged into the
  // local report so the timeline appears without a refetch.
  const [investigatingKey, setInvestigatingKey] = useState<string | null>(null)
  const [investigationError, setInvestigationError] = useState<{ key: string; message: string } | null>(null)

  async function investigateFlag(flag: { card: string; field: string }) {
    if (!id) return
    const key = `${flag.card}::${flag.field}`
    setInvestigatingKey(key)
    setInvestigationError(null)
    try {
      const { data } = await supabase.functions.invoke<{
        ok: boolean
        investigation?: NonNullable<ArtworkCheckReport['investigations']>[string]
        error?: string
      }>('artwork-check', { body: { order_id: id, investigate: flag } })
      if (data?.ok && data.investigation) {
        const inv = data.investigation
        setArtworkCheck((prev) => prev.report
          ? { ...prev, report: { ...prev.report, investigations: { ...(prev.report.investigations ?? {}), [key]: inv } } }
          : prev)
      } else {
        setInvestigationError({ key, message: data?.error ?? 'The investigation couldn’t run — try again.' })
      }
    } catch {
      setInvestigationError({ key, message: 'The investigation couldn’t run — try again.' })
    } finally {
      setInvestigatingKey(null)
    }
  }

  async function onSupplierChange(newId: string) {
    setSupplierId(newId)
    setArmed(false) // changing supplier disarms — re-confirm the new recipient
    setConfirmError(null) // a prior failure was about the previous supplier
    setEditedMessage(null) // ship-by + template change — re-seed from the new preview
    setSupplierLoading(true)
    try {
      await loadPreview(newId, note, overs)
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
        // When the message has been edited it's sent verbatim (custom_message) and
        // the separate note is folded in there, so don't send both.
        body: { order_id: id, mode: 'confirm', ...(supplierId ? { supplier_id: supplierId } : {}), ...(overs > 0 ? { supplier_overs: overs } : {}), ...(editedMessage !== null ? { custom_message: editedMessage } : (note ? { note } : {})), ...(revisionReplace ? { old_job_cancelled: oldJobCancelled } : {}) },
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
  // The generated hand-off text; the box shows this until the reviewer edits it,
  // then their text wins. `messageDirty` = they've taken ownership of the message.
  const generatedMessage = (isSupplier ? preview?.email_lines : preview?.note_lines)?.join('\n') ?? ''
  const messageValue = editedMessage ?? generatedMessage
  const messageDirty = editedMessage !== null
  // Problems an edit introduced (dropped a machine-read line, or added one the
  // parser could misread) — block the send and show them, so a broken hand-off
  // never reaches production. Authoritatively re-checked server-side too.
  const messageProblems = messageDirty ? checkEditedMessage(messageValue, preview?.critical_lines ?? []) : []
  const machineHint = isSupplier
    ? 'Stock Control reads the Qty / Material / Type / Thickness / Finish / Must-ship-by lines — keep them.'
    : 'Stock Control reads the Qty / Card / Date-required lines — keep them.'
  // Hand-off preconditions the page already knows about — disable Confirm when
  // it provably can't succeed, rather than letting the doomed round-trip run.
  const noSuppliers = isSupplier && (preview?.suppliers ?? []).length === 0
  // Several allowed suppliers + none picked yet → the placer must choose (no
  // default, by design). A single allowed supplier is auto-selected upstream.
  const mustChoose = isSupplier && !noSuppliers && (preview?.suppliers ?? []).length > 1 && !supplierId
  // Only meaningful once a supplier is resolved (picked or the lone one).
  const supplierEmailMissing = isSupplier && !!preview?.supplier && !preview.supplier.email
  const hsMissing = !isSupplier && preview?.helpscout_linked === false
  // Mandatory-RUN gate (docs/artwork-check-spec.md): when the check is live +
  // required and no run exists for this order, Confirm waits. Only RUNNING is
  // mandatory — any verdict (clear, flagged, even an errored run) satisfies
  // it; the auto-run on load normally clears this before anyone notices.
  // `required` is only ever true from a live-mode response, so this is inert
  // while the feature is off/shadow. place-order re-checks it server-side.
  const artworkRunNeeded = artworkCheck.required && artworkCheck.report == null
  // An edit that would break the Stock Control import takes precedence over the
  // other reasons — it's the thing the reviewer can fix right here, right now.
  const messageBroken = messageProblems.length > 0
    ? 'Your edit may break the Stock Control import — fix the flagged lines, or reset the message.'
    : null
  const blockReason = messageBroken
    ? messageBroken
    : revisionNeedsApproval
    ? 'Re-approve the new proof before placing this revision.'
    : (revisionReplace && !oldJobCancelled)
    ? 'Confirm you’ve cancelled the old Stock Control job to place this revision.'
    : noSuppliers
    ? 'No suppliers are configured for this material — set them on Admin → Outsourcing.'
    : mustChoose
      ? 'Choose a supplier to order from.'
      : supplierEmailMissing
        ? 'The selected supplier has no email address in Stock Control, so this order can’t be emailed.'
        : hsMissing
          ? 'This proof has no linked Help Scout conversation, so the production note can’t be posted.'
          : artworkRunNeeded
            ? 'Run the artwork check before placing this order.'
            : null
  const canConfirm = !blockReason

  // Stock Control hand-off checks (shadow mode) — informational only.
  // Deliberately NOT part of blockReason: a failed check never gates Confirm.
  const handoffProblems = preview?.handoff_validation?.problems ?? []
  const handoffWarnings = preview?.handoff_validation?.warnings ?? []
  const showHandoffChecks = handoffProblems.length > 0 || handoffWarnings.length > 0

  // Artwork check card derivations; the headline + body rendering both live in
  // the shared ArtworkCheckReportView (also used by the Orders-page report modal).
  const artworkReport = artworkCheck.report
  const showArtworkCard = artworkCheck.live && (artworkCheck.status === 'running' || artworkReport != null)

  // The editable hand-off message — identical control for both routes (only the
  // heading above it differs). Mirrors the generated preview until edited, then
  // the reviewer's text is sent verbatim (with the spec-line safety check above).
  const messageEditor = (
    <>
      <textarea
        value={messageValue}
        onChange={(e) => setEditedMessage(e.target.value)}
        spellCheck={false}
        rows={isSupplier ? 14 : 12}
        disabled={previewBusy && !messageDirty}
        className="mt-1 w-full rounded-lg border border-line bg-canvas p-3 font-mono text-[12.5px] leading-relaxed text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] disabled:opacity-50"
      />
      <div className="mt-1 flex items-start justify-between gap-3">
        <span className="text-[12px] text-ink-mute">You can edit this before sending. {machineHint}</span>
        {messageDirty && (
          <button type="button" onClick={() => setEditedMessage(null)} className="shrink-0 text-[12px] font-medium text-brand hover:underline">Reset</button>
        )}
      </div>
      {messageProblems.length > 0 && (
        <div className="mt-2 rounded-lg bg-out-soft px-3 py-2 text-[12px] text-out ring-1 ring-out">
          <p className="font-medium">This edit may break the Stock Control import:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {messageProblems.map((p, i) => <li key={i} className="break-words">{p}</li>)}
          </ul>
          <p className="mt-1">Fix the line{messageProblems.length === 1 ? '' : 's'} above, or use Reset.</p>
        </div>
      )}
    </>
  )

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
                    {/* Spoilage overs — hybrid foiling orders only. Extra blank
                        cards the supplier makes so in-house foiling has spares.
                        Pads the supplier Qty line ONLY; the customer's quantity
                        (invoice + in-house finishing) is unchanged. Manual, no
                        default. Re-previews on blur so the Qty above reflects it. */}
                    <label className="mt-3 block">
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Spoilage overs (extra cards for the supplier)</span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={overs === 0 ? '' : overs}
                        onChange={(e) => { setOvers(Math.max(0, Math.floor(Number(e.target.value) || 0))); setEditedMessage(null) }}
                        onBlur={() => { void loadPreview(supplierId, note, overs) }}
                        placeholder="0"
                        className="mt-1 h-[38px] w-full max-w-[160px] rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                      />
                      <span className="mt-1 block text-[12px] text-ink-mute">
                        {overs > 0
                          ? `Supplier makes ${(s.quantity + overs).toLocaleString()} cards (${s.quantity.toLocaleString()} + ${overs} overs). The customer is still invoiced for ${s.quantity.toLocaleString()}, and the in-house finishing job stays at ${s.quantity.toLocaleString()}.`
                          : 'For hybrid foiling orders — extra blank cards so in-house foiling has spares. Leave at 0 when nothing is foiled in-house.'}
                      </span>
                    </label>
                    <p className="mt-3 text-[12px] text-ink-mute">Subject</p>
                    <p className="text-sm font-medium text-ink">{preview.subject}</p>
                    <p className="mt-3 text-[12px] text-ink-mute">Message</p>
                    {messageEditor}
                    {preview.artwork_plan && (
                      <div className="mt-3 rounded-lg border border-line-soft bg-canvas/60 p-3 text-[12px]">
                        {preview.artwork_plan.attach.length > 0 ? (
                          <>
                            <p className="font-medium text-ink">
                              {preview.artwork_plan.attach.length} artwork file{preview.artwork_plan.attach.length === 1 ? '' : 's'} will be attached to the email
                            </p>
                            <ul className="mt-1 list-disc pl-4 text-ink-soft">
                              {preview.artwork_plan.attach.map((n) => <li key={n} className="break-all">{n}</li>)}
                            </ul>
                          </>
                        ) : (
                          <p className="text-ink-mute">No files will be attached — the supplier opens the Dropbox folder from the link in the email.</p>
                        )}
                        {preview.artwork_plan.skipped.length > 0 && (
                          <p className="mt-1.5 text-ink-mute">
                            Skipped (use the Dropbox link): {preview.artwork_plan.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}
                          </p>
                        )}
                      </div>
                    )}
                    <p className="mt-2 text-[12px] text-ink-mute">Sent to the supplier on a new Help Scout conversation, which hands the order to Stock Control. The artwork files are attached, with the Dropbox link in the email as a backup.</p>
                  </>
                ) : (
                  <>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Production note</h2>
                    <p className="mt-3 text-[12px] text-ink-mute">Help Scout subject will be set to</p>
                    <p className="text-sm font-medium text-ink">{preview.subject}</p>
                    <p className="mt-3 text-[12px] text-ink-mute">Note posted to the customer’s thread</p>
                    {messageEditor}
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

                {/* Per-order note — project-specific instructions for whoever
                    makes this order. Appended after the order details (which the
                    parser reads), so it's safe for both routes. */}
                <label className="mt-4 block border-t border-line-soft pt-3">
                  <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">
                    {isSupplier ? 'Note to supplier (optional)' : 'Note to production (optional)'}
                  </span>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    onBlur={() => { void loadPreview(supplierId, note, overs) }}
                    rows={3}
                    disabled={messageDirty}
                    placeholder="Project-specific instructions for this order."
                    className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="mt-1 block text-[12px] text-ink-mute">
                    {messageDirty
                      ? 'You’re editing the message directly — type any notes straight into it, or Reset to use this field.'
                      : 'Added after the order details (which Stock Control reads). Click out to see it in the message above.'}
                  </span>
                </label>
              </PanelShell>
            </div>

            {/* Stock Control hand-off checks — the direct-import validation run
                alongside the preview (shadow mode). Amber and NON-blocking:
                problems (stronger) and warnings are surfaced so mapping/setup
                gaps get fixed, but Confirm is never gated on them. Absent from
                the response entirely while the feature is off. */}
            {showHandoffChecks && (
              <div className="mt-4 rounded-lg bg-low-soft px-3 py-3 text-[13px] text-ink ring-1 ring-low">
                <p className="font-medium">Stock Control hand-off checks</p>
                {handoffProblems.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {handoffProblems.map((p, i) => (
                      <li key={`${p.code}-${i}`} className="break-words font-medium">{p.message}</li>
                    ))}
                  </ul>
                )}
                {handoffWarnings.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-soft">
                    {handoffWarnings.map((w, i) => (
                      <li key={`${w.code}-${i}`} className="break-words">{w.message}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-1.5 text-[12px] text-ink-soft">These checks don’t block placing the order.</p>
              </div>
            )}

            {/* Artwork sanity check (docs/artwork-check-spec.md) — the
                supplied-vs-printed comparison against the Help Scout thread,
                the QR contents and the Dropbox PRINT files. Advisory: a
                flagged verdict never disables Confirm — the reviewer
                adjudicates each flag right here. Renders only when the
                feature mode is live. */}
            {showArtworkCard && (
              <div
                className={`mt-4 rounded-lg px-3.5 py-3 ring-1 ${
                  artworkCheck.status === 'running' || !artworkReport
                    ? 'bg-canvas/60 ring-line'
                    : artworkReport.verdict === 'clear'
                      ? 'bg-[var(--c-in-stock-soft)]/50 ring-[var(--c-in-stock)]/40'
                      : artworkReport.verdict === 'defect'
                        ? 'bg-out-soft ring-out'
                        : 'bg-low-soft ring-low'
                }`}
              >
                {artworkCheck.status === 'running' ? (
                  <p className="flex items-center gap-2 font-medium text-ink">
                    <InlineSpinner />Checking the artwork against the customer’s details…
                  </p>
                ) : artworkReport ? (
                  <ArtworkCheckReportView
                    report={artworkReport}
                    action={
                      <button
                        type="button"
                        onClick={() => void runArtworkCheck(true)}
                        disabled={confirming}
                        className="text-[13px] font-medium text-brand hover:underline"
                      >
                        Re-run
                      </button>
                    }
                    onInvestigate={(flag) => void investigateFlag(flag)}
                    investigatingKey={investigatingKey}
                    investigationError={investigationError}
                  />
                ) : null}
              </div>
            )}

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

                {revisionReplace && (
                  <div className="mt-4 rounded-lg bg-out-soft px-3 py-3 text-[13px] text-out ring-1 ring-out">
                    <p className="font-medium">This order was already placed, then revised.</p>
                    <p className="mt-1">Cancel the old job in Stock Control and confirm with production it hasn’t printed before re-placing — the previously-approved artwork must not be produced.</p>
                    <label className="mt-2 flex items-start gap-2">
                      <input type="checkbox" checked={oldJobCancelled} onChange={(e) => setOldJobCancelled(e.target.checked)} className="mt-0.5" />
                      <span>I’ve cancelled the old Stock Control job.</span>
                    </label>
                  </div>
                )}

                {/* An edit broke the spec lines after the button was armed/enabled
                    — say so beside the button, not just in the disabled tooltip. */}
                {messageBroken && (
                  <p className="mt-4 rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out ring-1 ring-out">
                    <span className="font-medium">Can’t send this edit.</span> {messageBroken}
                  </p>
                )}

                {/* Supplier sends a real, immediate email — arm it with an explicit
                    second click so a misclick can't fire an external order.
                    Suppressed when the edit is broken (the button is disabled). */}
                {isSupplier && armed && !messageBroken && (
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
              mobileSheet={false}
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
