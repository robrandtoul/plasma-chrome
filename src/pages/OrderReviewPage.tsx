import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DesignerChrome, PanelShell, ButtonCoral, ButtonGhost } from '../design'
import { ImageCard, type GridImage } from '../components/ImageGrid'
import Modal from '../components/Modal'
import { logAudit } from '../lib/audit'
import ArtworkCheckReportView, { InlineSpinner, artworkCheckAuditFields, type ArtworkCheckReport, type ArtworkFlagRef } from '../components/ArtworkCheckReportView'
import HoldOrderDialog from '../components/HoldOrderDialog'
import { mergeInvestigation, requestInvestigation } from '../lib/useProofCheck'
import { scopeToOrderedFinish, finishScopeIsUncertain, type FinishScopeOutcome } from '../lib/approvedArtworkFinish'
import {
  HOLD_COPY,
  HOLD_REASON_MAX,
  holdBlockReason,
  holdState,
  repliedLine,
  type HoldReplyContext,
  type OrderHoldRow,
} from '../lib/orderHolds'

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
// "Base cards supplied under another order's batch" (combined supplier
// batches, migrations 000382/000383): the resolved source as place-order
// echoes it — everything the summary card renders comes from the server, so
// what's shown is what the hand-off used.
interface BlanksSourceInfo {
  order_id: string
  reference: string | null
  stock_order_number: string | null
  label: string | null
  supplier_name: string | null
  batch_quantity: number
  source_quantity: number
  spare_after_both: number
}
// A pickable sibling order (same material, already placed) for the disclosure
// on the supplier route. Fetched directly — designers can read orders — and
// tolerantly: on a pre-migration database the select 42703s and the whole
// feature simply stays hidden.
interface BlanksCandidate {
  id: string
  reference: string | null
  stock_order_number: string | null
  label: string | null
  supplier_name: string | null
  quantity: number
  supplier_overs: number
  fulfilled_at: string | null
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
  // The hold, as place-order read it server-side (migration 000377). null =
  // not on hold; ABSENT = an older deployed function that doesn't know about
  // holds yet, which is not the same thing — see loadPreview.
  hold?: OrderHoldRow | null
  // Blanks from another order (000382/000383). ABSENT = feature unavailable
  // (older function or pre-migration DB); null = available, none chosen;
  // an object = this order's blanks ride that order's batch, and the preview
  // above is the IN-HOUSE hand-off (route flips server-side).
  blanks_source?: BlanksSourceInfo | null
  // Preview-only: the stored/requested source can't be used (gone stale, not
  // placed, wrong material…). The preview falls back to the supplier route
  // and this says why; confirm fails closed on it server-side.
  blanks_source_invalid?: string
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

// What the hold dialog is being opened for. A 'put' carries the reason it
// starts with and the flag it came from; a 'take_off' needs neither.
type HoldDialogState =
  | { mode: 'put'; reason: string; flag: Record<string, unknown> | null }
  | { mode: 'take_off' }

// The pre-written reason for a hold raised off an artwork-check flag.
//
// Written as the sentence a colleague needs to read on the Orders card, not as
// the report's own field names: they are deciding whether to wait or to go
// ahead, and "mobile_number mismatch" does not tell them that. Editable in the
// dialog — this is a starting point, not the question actually asked.
function reasonFromFlag(flag: ArtworkFlagRef): string {
  const field = flag.field.replace(/_/g, ' ').trim() || 'detail'
  const printed = flag.printed?.trim()
  const supplied = flag.supplied?.trim()
  // Two sentences rather than one dashed clause: the report's own card labels
  // often carry a dash of their own ("Derrick Smith — front/back"), and a
  // second one in the same line reads as a stutter.
  // Present tense, not "Asked …": the hold usually goes on BEFORE the message
  // is written, so the past tense would assert something that has not happened
  // and then sit there as the record of it.
  const head = `Checking the ${field} on ${flag.card} with the customer.`
  const detail =
    printed && supplied
      ? ` Artwork says ${printed}, the brief says ${supplied}.`
      : printed
        ? ` Artwork says ${printed}.`
        : ''
  const out = `${head}${detail}`
  // The DB CHECK caps the reason at 500 characters, and the dialog's maxLength
  // only limits TYPING — a long pre-fill would sail past it and bounce on save.
  return out.length > HOLD_REASON_MAX ? `${out.slice(0, HOLD_REASON_MAX - 1)}…` : out
}

function holdDateLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
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
  // The finish the gallery was narrowed to ("Natural"), and — when it couldn't
  // be narrowed — how many finishes are therefore shown instead of one.
  const [artworkFinish, setArtworkFinish] = useState<string | null>(null)
  const [artworkFinishWarning, setArtworkFinishWarning] = useState<
    { tabs: number; reason: FinishScopeOutcome } | null
  >(null)
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
  // "On hold, waiting on the customer" (migration 000377). Read off the order
  // row with everything else, so there is never a moment where the page has
  // rendered and Confirm is live but the hold hasn't loaded yet. The rules all
  // live in src/lib/orderHolds.ts — this page only fetches and renders.
  const [hold, setHold] = useState<OrderHoldRow | null>(null)
  // The proof's Help Scout stamps, for "the customer has replied since you
  // asked". Thread-wide, so it only ever surfaces the card — nothing acts on it.
  const [replyCtx, setReplyCtx] = useState<HoldReplyContext | null>(null)
  // The customer's Help Scout thread, so the "they've replied" prompt has
  // somewhere to send you.
  const [helpscoutUrl, setHelpscoutUrl] = useState<string | null>(null)
  const [holdDialog, setHoldDialog] = useState<HoldDialogState | null>(null)
  const [holdWorking, setHoldWorking] = useState(false)
  const [holdError, setHoldError] = useState<string | null>(null)
  // Bumped on every hold write. A preview requested BEFORE that write can land
  // after it, carrying the pre-write answer — which on a take-off would put the
  // band back and block Confirm over a hold that no longer exists.
  const holdWriteSeq = useRef(0)
  // Blanks from another order (combined supplier batches). Until the reviewer
  // makes a choice this visit (`touched`), the field is OMITTED from every
  // place-order call so a value stamped by a previous visit keeps working; a
  // touch always sends the explicit id-or-null. Kept in a ref too, so
  // loadPreview reads the value at call time without threading a 4th argument
  // through every call site.
  const [blanksChoice, setBlanksChoice] = useState<{ touched: boolean; id: string | null }>({ touched: false, id: null })
  const blanksChoiceRef = useRef(blanksChoice)
  blanksChoiceRef.current = blanksChoice
  // null = not loaded / unavailable (pre-migration DB) → the disclosure hides.
  const [blanksCandidates, setBlanksCandidates] = useState<BlanksCandidate[] | null>(null)
  const [blanksOpen, setBlanksOpen] = useState(false)
  // The order's own material id — the candidates query needs it (blanks must
  // be the same material). Read in the mount effect alongside proof_id.
  const [orderMaterialIdState, setOrderMaterialIdState] = useState<string | null>(null)

  const loadPreview = useCallback(async (chosenSupplierId?: string | null, noteArg?: string, oversArg?: number) => {
    if (!id) return
    setError(null)
    setPreviewBusy(true)
    const seq = holdWriteSeq.current
    try {
      // The blanks choice rides every preview once touched (explicit id or
      // null); untouched sends nothing so the server's stored value applies.
      const blanks = blanksChoiceRef.current
      const { data, error: fnErr } = await supabase.functions.invoke<PreviewResponse>('place-order', {
        body: { order_id: id, mode: 'preview', ...(chosenSupplierId ? { supplier_id: chosenSupplierId } : {}), ...(noteArg ? { note: noteArg } : {}), ...(oversArg ? { supplier_overs: oversArg } : {}), ...(blanks.touched ? { blanks_source_order_id: blanks.id } : {}) },
      })
      if (fnErr || !data?.ok) {
        const body = data ?? await readFnErrorBody(fnErr)
        setError(body?.error ?? fnErr?.message ?? 'Could not load this order for review.')
        setPreview(null)
        return
      }
      setPreview(data)
      // Every preview is a fresh server read of the hold, so a colleague's hold
      // shows up here without a page reload. Two guards: skip it entirely if
      // the field is ABSENT (an older deployed place-order — `?? null` would
      // then wipe a real hold), and skip it if a hold write happened while this
      // request was in the air (its answer is older than what we know).
      if (data.hold !== undefined && holdWriteSeq.current === seq) {
        setHold(data.hold ?? { held_at: null })
      }
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
        const { data: order } = await supabase
          .from('orders')
          // Deliberately does NOT name the 000377 hold columns. PostgREST
          // sends one select= list, so an unknown column fails the WHOLE query
          // — and this query is what resolves proof_id, so a frontend deployed
          // before the migration would silently lose the approved-artwork
          // gallery and the revision-replace banner, not just the hold. The
          // hold arrives on the preview payload instead (place-order reads it
          // in its own tolerant query), which keeps the deploy order free in
          // both directions.
          .select(
            'proof_id, status, fulfilled_at, material_id, material_option_id, ' +
              'proofs(helpscout_last_reply_at, helpscout_last_customer_reply_at, helpscout_conversation_url)',
          )
          .eq('id', id)
          .maybeSingle()
        const proofId = (order as { proof_id?: string } | null)?.proof_id
        const orderStatus = (order as { status?: string } | null)?.status ?? null
        // The order's own material — the artwork gallery must show the version this
        // order was placed against, which for a two-material proof is NOT
        // necessarily the current version (mirrors place-order + OrdersPage).
        const orderMaterialId = (order as { material_id?: string | null } | null)?.material_id ?? null
        // The finish the customer bought (open-spec pick at checkout, or the
        // designer's in the builder) — narrows the gallery below.
        const orderMaterialOptionId = (order as { material_option_id?: string | null } | null)?.material_option_id ?? null
        if (!cancelled) {
          const o = order as { status?: string; fulfilled_at?: string | null } | null
          setRevisionReplace(o?.status === 'revision' && !!o?.fulfilled_at)
          setOrderMaterialIdState(orderMaterialId)
          // Hold state comes from the preview payload only (see the select
          // above) — setting it from this row would overwrite the server's
          // answer with an undefined.
          const p = (order as { proofs?: { helpscout_last_reply_at?: string | null; helpscout_last_customer_reply_at?: string | null; helpscout_conversation_url?: string | null } | null } | null)?.proofs
          setReplyCtx(
            p
              ? {
                  lastStaffReplyAt: p.helpscout_last_reply_at ?? null,
                  lastCustomerReplyAt: p.helpscout_last_customer_reply_at ?? null,
                }
              : null,
          )
          // "The customer has replied — worth a read" is an errand, and this
          // page otherwise has no way out to the thread (its only links are
          // three "Back to orders"). Without this the prompt is a dead end.
          setHelpscoutUrl(p?.helpscout_conversation_url ?? null)
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
              .select('id, material_id, is_current, version_number, material_options')
              .eq('proof_id', proofId)
              .order('version_number', { ascending: false })
            const vers = (vRows ?? []) as { id: string; material_id: string | null; is_current: boolean; material_options: string[] | null }[]
            const matches = orderMaterialId ? vers.filter((v) => v.material_id === orderMaterialId) : []
            const scopedVersion =
              matches.find((v) => v.is_current) ?? matches[0] ?? vers.find((v) => v.is_current) ?? null
            const scopedVersionId = scopedVersion?.id ?? null
            const nonQr = ((await supabase.functions.invoke<{ images: GridImage[] }>('customer-proof-images', { body: { proofId } })).data?.images ?? [])
              .filter((img) => img.is_qr_code !== true)
            const scoped = scopedVersionId
              ? nonQr.filter((img) => (img as unknown as { proof_version_id?: string }).proof_version_id === scopedVersionId)
              : []
            const versionImages = scoped.length > 0 ? scoped : nonQr
            // …and then to the FINISH this order was bought against. A version
            // proofed in three metal finishes carries a set per finish; only
            // one is this order's artwork, and this gallery is the last look
            // before the files go to production. Same rule as the Orders-page
            // hand-off panel (src/lib/approvedArtworkFinish.ts): an
            // unresolvable finish falls back to the whole set rather than an
            // empty one, and the caption below says which finish is shown.
            let orderFinishCode: string | null = null
            let orderFinishLabel: string | null = null
            const versionOptionCodes = Array.isArray(scopedVersion?.material_options) ? scopedVersion.material_options : []
            if (versionOptionCodes.length > 0 && orderMaterialOptionId) {
              const { data: optRow } = await supabase
                .from('material_options')
                .select('code, display_name')
                .eq('id', orderMaterialOptionId)
                .maybeSingle()
              const opt = optRow as { code: string | null; display_name: string | null } | null
              orderFinishCode = opt?.code ?? null
              orderFinishLabel = opt?.display_name ?? opt?.code ?? null
            }
            const finishScope = scopeToOrderedFinish(versionImages, versionOptionCodes, orderFinishCode)
            if (!cancelled) {
              // Name the finish only when it actually narrowed the gallery —
              // a chip beside a full-matrix grid would contradict the warning.
              setArtworkFinish(finishScope.outcome === 'scoped' ? orderFinishLabel : null)
              setArtworkFinishWarning(
                finishScopeIsUncertain(finishScope.outcome) && versionOptionCodes.length > 1
                  ? { tabs: versionOptionCodes.length, reason: finishScope.outcome }
                  : null,
              )
            }
            const gallery = finishScope.images
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
  // `trigger: 'auto'` marks the on-open run so the 000357 ledger can tell a
  // page visit apart from a designer deliberately clicking Re-check. Without
  // it both arrive on the same designer JWT and Admin → Analytics would credit
  // every review-page open to whoever happened to open it.
  const runArtworkCheck = useCallback(async (force: boolean, trigger: 'auto' | 'designer' = 'designer') => {
    if (!id) return
    setArtworkCheck((prev) => ({ ...prev, status: 'running' }))
    try {
      const { data } = await supabase.functions.invoke<ArtworkCheckResponse>('artwork-check', {
        body: { order_id: id, trigger, ...(force ? { force: true } : {}) },
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
    void runArtworkCheck(false, 'auto')
  }, [runArtworkCheck])

  // Leaving the review without placing the order — the order-side counterpart
  // of the preview gate's "Go back and edit", and the only honest signal this
  // page has that a reviewer looked and decided not to proceed. Stamped with
  // the check's state so "flagged → walked away" can be measured against
  // "clear → walked away"; placements themselves are already audited server
  // side as `order.placed`, and their verdict is joinable from the run ledger.
  //
  // A lower bound by construction: a reviewer who leaves via the browser back
  // button or the nav bar isn't counted. Deliberately not chased with a
  // beforeunload handler, which fires on refreshes and tab closes too and
  // would make the figure dirtier, not better.
  const exitReview = useCallback(async () => {
    await logAudit({
      action: 'order.review_exited',
      targetType: 'order',
      targetId: id,
      // Same label shape place-order uses for `order.placed`, so the two sides
      // of the decision read alike in Admin → Activity.
      targetLabel: id ? `Order ${id}` : undefined,
      metadata: artworkCheckAuditFields(artworkCheck.report ?? null),
    })
    navigate('/orders')
  }, [id, artworkCheck.report, navigate])

  // Per-flag history walk (designer-triggered — see ArtworkCheckReportView).
  // On success the investigation is cached server-side AND merged into the
  // local report so the timeline appears without a refetch.
  const [investigatingKey, setInvestigatingKey] = useState<string | null>(null)
  const [investigationError, setInvestigationError] = useState<{ key: string; message: string } | null>(null)
  const [staleNotice, setStaleNotice] = useState<string | null>(null)

  async function investigateFlag(flag: { card: string; field: string }) {
    if (!id) return
    const key = `${flag.card}::${flag.field}`
    setInvestigatingKey(key)
    setInvestigationError(null)
    setStaleNotice(null)
    try {
      // requestInvestigation surfaces the server's real message and, when the
      // check has been re-run underneath this page, the report the database
      // actually holds — see useProofCheck.ts.
      const out = await requestInvestigation({ order_id: id }, flag)
      if (out.investigation) {
        const inv = out.investigation
        setArtworkCheck((prev) => prev.report
          ? { ...prev, report: mergeInvestigation(prev.report, [out.key, key], inv) }
          : prev)
      } else if (out.staleReport) {
        const fresh = out.staleReport
        setArtworkCheck((prev) => ({ ...prev, status: 'done', report: fresh }))
        setStaleNotice(out.message ?? 'This check has been re-run — the flags below are the current ones.')
      } else {
        setInvestigationError({ key, message: out.message ?? 'The investigation couldn’t run — try again.' })
      }
    } finally {
      setInvestigatingKey(null)
    }
  }

  // Load the pickable blanks sources: sibling orders in the SAME material,
  // already placed (the batch must exist), recent, not themselves riding
  // another order's batch, not prototypes. Direct read (designers can read
  // orders); the select names the 000382 column, so on a pre-migration
  // database it fails and the feature stays hidden — by design, this page must
  // keep working either side of the migration.
  const blanksActive = !!preview?.blanks_source
  useEffect(() => {
    if (!id || !orderMaterialIdState) return
    if (!(preview?.route === 'supplier' || blanksActive)) return
    if (blanksCandidates !== null) return // one fetch per visit is enough
    let cancelled = false
    void (async () => {
      try {
        const cutoff = new Date(Date.now() - 90 * 86400000).toISOString()
        const { data, error: err } = await supabase
          .from('orders')
          .select('id, payment_reference, stock_order_number, project_name, supplier_name, quantity, supplier_overs, fulfilled_at, order_kind, blanks_source_order_id')
          .eq('material_id', orderMaterialIdState)
          .eq('status', 'fulfilled')
          .neq('id', id)
          .gte('fulfilled_at', cutoff)
          .order('fulfilled_at', { ascending: false })
          .limit(8)
        if (err || cancelled) return
        type Row = { id: string; payment_reference: string | null; stock_order_number: string | null; project_name: string | null; supplier_name: string | null; quantity: number | null; supplier_overs: number | null; fulfilled_at: string | null; order_kind: string | null; blanks_source_order_id: string | null }
        setBlanksCandidates(
          ((data ?? []) as Row[])
            .filter((r) => r.blanks_source_order_id == null && (r.order_kind ?? 'production') !== 'prototype')
            .map((r) => ({
              id: r.id,
              reference: r.payment_reference,
              stock_order_number: r.stock_order_number,
              label: r.project_name,
              supplier_name: r.supplier_name,
              quantity: Math.max(0, Number(r.quantity) || 0),
              supplier_overs: Math.max(0, Number(r.supplier_overs) || 0),
              fulfilled_at: r.fulfilled_at,
            })),
        )
      } catch {
        /* pre-migration DB or transient failure — the disclosure stays hidden */
      }
    })()
    return () => { cancelled = true }
  }, [id, orderMaterialIdState, preview?.route, blanksActive, blanksCandidates])

  // Pick a blanks source (or null to clear back to a normal supplier order).
  // Any switch disarms + reseeds the message: the whole hand-off changes shape
  // (supplier email ↔ production note), so nothing typed against the old shape
  // may survive into the new one.
  function chooseBlanks(sourceId: string | null) {
    const next = { touched: true, id: sourceId }
    setBlanksChoice(next)
    blanksChoiceRef.current = next // sync — loadPreview reads the ref right now
    setArmed(false)
    setConfirmError(null)
    setEditedMessage(null)
    void loadPreview(supplierId, note, overs)
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

  // Put this order on hold, or take it off. One write either way.
  //
  // held_by / held_by_name are deliberately NOT sent: the trigger stamps them
  // from auth.uid() server-side, because proofs.profiles SELECT is
  // self-or-admin (the page cannot read a colleague's name) and a
  // client-supplied name on a shared row would be spoofable. Taking a hold off
  // is exactly `held_at: null` — the trigger clears the reason, the
  // attribution and the flag snapshot for us (migration 000377).
  async function submitHold(reason: string) {
    if (!id || !holdDialog) return
    setHoldWorking(true)
    setHoldError(null)
    holdWriteSeq.current += 1
    try {
      const patch =
        holdDialog.mode === 'take_off'
          ? { held_at: null }
          : {
              held_at: new Date().toISOString(),
              hold_reason: reason,
              hold_artwork_flag: holdDialog.flag,
            }
      const { data, error: err } = await supabase
        .from('orders')
        .update(patch)
        .eq('id', id)
        // Read the row back so the band shows the name the TRIGGER stamped,
        // rather than an optimistic guess this page isn't allowed to make.
        .select('held_at, hold_reason, held_by_name')
        .maybeSingle()
      if (err) {
        // The raw PostgREST message is never empty, so putting it first meant
        // the friendly sentence below could never actually appear — what Rob
        // saw on a failure was database jargon. Keep the detail in the console.
        console.error('[order-review] hold write failed:', err)
        setHoldError('That couldn’t be saved. Check your connection, and if it keeps happening sign out and back in.')
        return
      }
      // No error means the write landed, so the new state is what we wrote —
      // the read-back only supplies the one field we couldn't know, the name
      // the trigger stamped. Deriving it this way rather than trusting the
      // returned row means an empty or odd read can never rub out a hold that
      // exists, which would show a clear page over a blocked order.
      setHold({
        held_at: patch.held_at,
        hold_reason: patch.held_at ? reason : null,
        held_by_name: (data as OrderHoldRow | null)?.held_by_name ?? null,
      })
      setHoldDialog(null)
    } finally {
      setHoldWorking(false)
    }
  }

  async function confirm() {
    if (!id) return
    setConfirming(true)
    setConfirmError(null)
    try {
      const blanks = blanksChoiceRef.current
      const { data, error: fnErr } = await supabase.functions.invoke<{ ok: boolean; error?: string; code?: string; placed?: boolean }>('place-order', {
        // When the message has been edited it's sent verbatim (custom_message) and
        // the separate note is folded in there, so don't send both.
        body: { order_id: id, mode: 'confirm', ...(supplierId ? { supplier_id: supplierId } : {}), ...(overs > 0 ? { supplier_overs: overs } : {}), ...(editedMessage !== null ? { custom_message: editedMessage } : (note ? { note } : {})), ...(blanks.touched ? { blanks_source_order_id: blanks.id } : {}), ...(revisionReplace ? { old_job_cancelled: oldJobCancelled } : {}) },
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
  // The order itself goes into Stock Control the moment you confirm — this
  // message is read by people, not machines, so the wording is yours. The only
  // thing worth saying is when it's been emptied altogether.
  const messageEmpty = messageValue.trim() === ''
  const machineHint = isSupplier
    ? 'The supplier reads this — the order details are already in Stock Control, so the wording is yours.'
    : 'The workshop reads this — the job is already in Stock Control, so the wording is yours.'
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
  const holdInfo = holdState(hold, replyCtx)
  // The hold clause goes FIRST. Every other reason here is something the
  // reviewer can fix on this page in the next minute; a hold is a colleague
  // waiting on an answer from the customer, and it outranks all of them.
  // Second in the chain and a held order missing a supplier email would be
  // told to go and set up a supplier — sending them off to solve the wrong
  // problem and, worse, implying the order is placeable once they have.
  const blockReason = holdInfo.held
    ? holdBlockReason(holdInfo)
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

  // Blanks-from-another-order derivations (combined supplier batches).
  const blanksInfo = preview?.blanks_source ?? null
  const blanksInvalidMsg = preview?.blanks_source_invalid ?? null
  const fmtNum = (n: number) => n.toLocaleString('en-GB')
  const candidateDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null

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
      {messageEmpty && (
        <div className="mt-2 rounded-lg bg-low-soft px-3 py-2 text-[12px] text-low ring-1 ring-low">
          This message is empty — type something or reset it.
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

            {/* On hold — the one thing on this page that means "don't place
                this", so it sits above everything, before the artwork the
                reviewer came here to look at. The reason is quoted rather than
                summarised: it is the only thing that tells a colleague whether
                to wait or to go ahead.

                The wording stops at "from here" on purpose. A hand-written
                Help Scout note carrying Qty:/Card: lines still creates a Stock
                Control job through the inhouse-order parser, so no control on
                an order can honestly promise nobody can place it. */}
            {holdInfo.held && (
              <div className="mt-4 rounded-lg bg-low-soft px-3.5 py-3 text-[13px] text-ink ring-1 ring-low">
                <p className="font-medium">
                  {holdInfo.byName ? `${holdInfo.byName} put this order on hold` : 'This order is on hold'}
                  {' · '}
                  {holdDateLabel(holdInfo.heldAt)}
                </p>
                <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-ink-mute">Waiting on</p>
                <blockquote className="mt-0.5 break-words border-l-[3px] border-low pl-3">
                  {holdInfo.reason}
                </blockquote>
                <p className="mt-2 text-ink-soft">
                  It can’t be pushed into production from here until someone takes it off hold.
                </p>
                {repliedLine(holdInfo) && (
                  <p className="mt-1.5 font-medium">
                    {repliedLine(holdInfo)}
                    {helpscoutUrl && (
                      <>
                        {' '}
                        <a
                          href={helpscoutUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
                        >
                          Open in Help Scout ↗
                        </a>
                      </>
                    )}
                  </p>
                )}
                <div className="mt-2.5">
                  <ButtonGhost
                    size="sm"
                    onClick={() => {
                      setHoldError(null)
                      setHoldDialog({ mode: 'take_off' })
                    }}
                  >
                    {HOLD_COPY.take_off}
                  </ButtonGhost>
                </div>
              </div>
            )}

            {/* Approved artwork — the whole point of the review: see exactly
                what's being produced. Every name + side of the version this
                order was placed against, narrowed to the ordered finish, each
                opening full size in a lightbox. */}
            {artwork.length > 0 && (
              <PanelShell className="mt-6">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Approved artwork</h2>
                  {artworkFinish && (
                    <span className="rounded-[4px] bg-in-stock-soft px-1.5 py-0.5 text-[11px] font-semibold text-in-stock">
                      {artworkFinish}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-mute">
                  This is exactly what will be produced. Click any image to view it full size.
                </p>
                {/* Couldn't narrow to the ordered finish — this is every
                    proofed finish, most of which the customer didn't buy. */}
                {artworkFinishWarning !== null && (
                  <p className="mt-2 rounded-lg border border-low bg-low-soft px-3 py-2 text-xs text-ink-soft">
                    {artworkFinishWarning.reason === 'finish-missing'
                      ? `This order’s finish isn’t one of the ${artworkFinishWarning.tabs} proofed here, so all of them are shown.`
                      : `All ${artworkFinishWarning.tabs} proofed finishes are shown — this order doesn’t record which one was bought.`}{' '}
                    Confirm the finish before producing these.
                  </p>
                )}
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
                    {/* The stored / requested blanks source can't be used — the
                        preview has fallen back to a normal supplier order and
                        this says why. Confirm fails closed on it server-side,
                        so this can never slip through silently. */}
                    {blanksInvalidMsg && (
                      <p className="mt-3 rounded-lg bg-low-soft px-3 py-2 text-[12px] text-ink ring-1 ring-low">
                        <span className="font-medium">Blanks from another order: </span>{blanksInvalidMsg}
                      </p>
                    )}
                    {/* Blanks already covered by a sibling order's batch
                        (combined supplier batches). Only offered when there is
                        a placed same-material order to point at; picking one
                        re-previews as an IN-HOUSE hand-off — no supplier
                        email — with a provenance line for the workshop. */}
                    {(blanksCandidates?.length ?? 0) > 0 && (
                      <div className="mt-3 rounded-lg border border-line-soft bg-canvas/60 p-3">
                        <button
                          type="button"
                          onClick={() => setBlanksOpen((o) => !o)}
                          className="flex w-full items-center justify-between gap-2 text-left text-[13px] font-medium text-ink"
                        >
                          <span>Base cards already covered by another order?</span>
                          <span aria-hidden className="text-ink-mute">{blanksOpen ? '▾' : '▸'}</span>
                        </button>
                        {blanksOpen && (
                          <>
                            <p className="mt-1.5 text-[12px] text-ink-mute">
                              If this job’s blanks are being made as part of another order’s supplier batch
                              (one combined batch via its Spoilage overs), pick that order — no supplier
                              email is sent for this one, and the workshop job says where its blanks come from.
                            </p>
                            <div className="mt-2 space-y-1.5">
                              {(blanksCandidates ?? []).map((c) => (
                                <button
                                  key={c.id}
                                  type="button"
                                  disabled={previewBusy}
                                  onClick={() => chooseBlanks(c.id)}
                                  className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-left text-[13px] text-ink hover:border-[var(--c-brand)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)] disabled:opacity-50"
                                >
                                  <span className="font-medium">
                                    {c.stock_order_number ? `Order ${c.stock_order_number}` : (c.reference ?? 'Order')}
                                  </span>
                                  {c.label ? <span className="text-ink-soft"> · {c.label}</span> : null}
                                  <span className="mt-0.5 block text-[12px] text-ink-mute">
                                    {fmtNum(c.quantity)}{c.supplier_overs > 0 ? ` + ${fmtNum(c.supplier_overs)} overs = ${fmtNum(c.quantity + c.supplier_overs)} blanks` : ' blanks'}
                                    {c.supplier_name ? ` from ${c.supplier_name}` : ''}
                                    {candidateDate(c.fulfilled_at) ? ` · placed ${candidateDate(c.fulfilled_at)}` : ''}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
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
                    <p className="mt-2 text-[12px] text-ink-mute">Sent to the supplier on a new Help Scout conversation. The order goes into Stock Control on its own when you confirm — this email is the supplier’s copy, so the wording is yours. The artwork files are attached, with the Dropbox link in the email as a backup.</p>
                  </>
                ) : (
                  <>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Production note</h2>
                    {/* This order's blanks ride a sibling order's supplier
                        batch: say so up top, with the arithmetic, and give the
                        way back. The provenance line is already IN the note
                        below — this card is the summary a reviewer scans. */}
                    {blanksInfo && (
                      <div className="mt-3 rounded-lg bg-[var(--c-in-stock-soft)]/50 px-3.5 py-3 text-[13px] text-ink ring-1 ring-[var(--c-in-stock)]/40">
                        <p className="font-medium">
                          Blanks from order {blanksInfo.stock_order_number ?? blanksInfo.reference ?? '—'}
                          {blanksInfo.label ? ` (${blanksInfo.label})` : ''}
                        </p>
                        <p className="mt-1 text-ink-soft">
                          {fmtNum(blanksInfo.batch_quantity)} blanks were ordered
                          {blanksInfo.supplier_name ? ` from ${blanksInfo.supplier_name}` : ''} with that order —
                          this job’s {fmtNum(s.quantity)} come out of the same batch, so <span className="font-medium text-ink">no supplier email is sent</span> for
                          this order. The workshop note below says where the blanks come from.
                        </p>
                        {blanksInfo.spare_after_both >= 0 ? (
                          <p className="mt-1 text-ink-soft">
                            After both orders’ cards ({fmtNum(blanksInfo.source_quantity)} + {fmtNum(s.quantity)}), {fmtNum(blanksInfo.spare_after_both)} spare for finishing spoilage.
                          </p>
                        ) : (
                          <p className="mt-1.5 rounded-lg bg-low-soft px-2.5 py-1.5 text-[12px] text-ink ring-1 ring-low">
                            <span className="font-medium">That batch is {fmtNum(-blanksInfo.spare_after_both)} short</span> of
                            the two orders’ quantities ({fmtNum(blanksInfo.source_quantity)} + {fmtNum(s.quantity)} &gt; {fmtNum(blanksInfo.batch_quantity)}) — check with the
                            supplier before placing.
                          </p>
                        )}
                        <button
                          type="button"
                          disabled={previewBusy}
                          onClick={() => chooseBlanks(null)}
                          className="mt-2 text-[12px] font-medium text-brand hover:underline disabled:opacity-50"
                        >
                          Order its own blanks from the supplier instead
                        </button>
                      </div>
                    )}
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
                    <p className="mt-2 text-[12px] text-ink-mute">The job goes into Stock Control on its own when you confirm — this note is what the workshop reads, and the record on the customer’s thread.</p>
                  </>
                )}

                {/* Per-order note — project-specific instructions for whoever
                    makes this order. Appended at the end of the message on both
                    routes, so it reads as a postscript to the spec. */}
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
                      : 'Added at the end, after the order details. Click out to see it in the message above.'}
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
            {/* Card tint mirrors the proof-page panel: green wash for
                all-clear, NEUTRAL surface + slim verdict outline for
                flagged/defect (a solid wash behind the field table made
                every row look flagged), amber wash for error only. */}
            {showArtworkCard && (
              <div
                className={`mt-4 rounded-lg px-3.5 py-3 ring-1 ${
                  artworkCheck.status === 'running' || !artworkReport
                    ? 'bg-canvas/60 ring-line'
                    : artworkReport.verdict === 'clear'
                      ? 'bg-[var(--c-in-stock-soft)]/50 ring-[var(--c-in-stock)]/40'
                      : artworkReport.verdict === 'defect'
                        ? 'bg-surface ring-[var(--c-out)]/50'
                        : artworkReport.verdict === 'flagged'
                          ? 'bg-surface ring-[var(--c-low)]/60'
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
                    notice={staleNotice}
                    onInvestigate={(flag) => void investigateFlag(flag)}
                    investigatingKey={investigatingKey}
                    investigationError={investigationError}
                    // Not offered while the order is already held: a second
                    // hold would overwrite a colleague's reason with this
                    // flag's, and the band above already says what to do next.
                    onHoldFromFlag={
                      holdInfo.held
                        ? undefined
                        : (flag) => {
                            setHoldError(null)
                            setHoldDialog({
                              mode: 'put',
                              reason: reasonFromFlag(flag),
                              // Snapshot the finding onto the hold. The stored
                              // report is replaced wholesale by every re-run —
                              // including the automatic one that fires when a
                              // Dropbox folder is linked — so without this the
                              // reason would outlive the finding behind it.
                              flag: {
                                card: flag.card,
                                field: flag.field,
                                supplied: flag.supplied,
                                printed: flag.printed,
                                note: flag.note,
                                severity: flag.severity ?? null,
                                checked_at: artworkReport?.checked_at ?? null,
                              },
                            })
                          }
                    }
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
                      <ButtonGhost onClick={() => void exitReview()} disabled={confirming}>Cancel</ButtonGhost>
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

            {holdDialog && (
              <HoldOrderDialog
                mode={holdDialog.mode}
                customerLabel={s.customer}
                state={holdInfo.held ? holdInfo : null}
                initialReason={holdDialog.mode === 'put' ? holdDialog.reason : undefined}
                working={holdWorking}
                errorMsg={holdError}
                onConfirm={(reason) => void submitHold(reason)}
                onCancel={() => {
                  if (holdWorking) return
                  setHoldDialog(null)
                  setHoldError(null)
                }}
              />
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
