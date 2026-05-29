import { Fragment, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Send, Check, Layers, PoundSterling, DollarSign, Euro, BookOpen, Info, Eye, type LucideIcon } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { PlasmaWordmark, Pill, ButtonInk, ButtonCoral, ButtonGhost, PanelShell, StatusRule, tokens, type PillColour } from '../design'
import type { PublicProof, PublicProofVersion, PublicMaterialOption, PublicMaterialOptionSurcharge, PublicPriceTier, PublicMaterialVariant, RoundVariant, CustomerProofGraph, PersonalisationPricing } from '../lib/types'
import { compilePersonalisationSurcharges, personalisationBreakeven } from '../lib/personalisation'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import type { ProofEventState } from '../lib/types'
import { deriveSharedApprovalState } from '../lib/sharedApproval'
import { formatPrice } from '../lib/currency'
import { type GridImage } from '../components/ImageGrid'
import { MaterialOptionTabs } from '../components/MaterialOptionTabs'
import { CoreColourSwatch } from '../components/CoreColourSwatch'
import { LayeredConstructionPanel } from '../components/LayeredConstructionPanel'
import { MetalThicknessPanel } from '../components/MetalThicknessPanel'
import { DEFAULT_METAL_THICKNESS_NOTES, thicknessSetForMaterial } from '../lib/metalThicknessNotes'
import { QrCodePanel, qrRowsForSlot } from '../components/QrCodePanel'
import { ActionPanel } from '../components/ActionPanel'
import { ProofDetailView } from '../components/ProofDetailView'
import { firstName } from '../lib/firstName'
import { BRAND_ORDER } from '../lib/theme'
import { getPublicSettings, ABOUT_PROOF_COPY_DEFAULT, type PublicSettings } from '../lib/publicSettings'
import type { PricingSnapshot, PricingVariant, Currency } from '../lib/types'

// Pricing-card header glyph, picked from the version's currency so the
// icon matches the prices shown beneath it (£ / $ / €) instead of always
// reading as GBP. Falls back to the pound for null/unknown currencies
// (e.g. per-direction-pricing rounds, which hide the pricing card anyway).
function currencyIcon(currency: Currency | null | undefined): LucideIcon {
  switch (currency) {
    case 'USD':
      return DollarSign
    case 'EUR':
      return Euro
    default:
      return PoundSterling
  }
}

export default function CustomerProofPage() {
  const { id } = useParams<{ id: string }>()

  const [proof, setProof] = useState<PublicProof | null>(null)
  const [versions, setVersions] = useState<PublicProofVersion[]>([])
  const [activeVersion, setActiveVersion] = useState<PublicProofVersion | null>(null)
  // History row: when a proof has many revisions, collapse the older
  // ones behind a "+N earlier" chip so the row doesn't wrap to several
  // lines. Toggled open by the customer; also force-open when they're
  // viewing one of the older (collapsed) versions.
  const [showAllVersions, setShowAllVersions] = useState(false)
  const [versionImages, setVersionImages] = useState<Record<string, GridImage[]>>({})
  // QR-code rows split off from versionImages so the regular image
  // grid never renders them. Same edge-function payload, but
  // is_qr_code=true rows are bucketed here for the dedicated QR
  // panel below the version header. Empty object when no QRs are
  // present on any of the proof's versions (the common case for
  // anything created before the QR feature shipped).
  const [versionQrImages, setVersionQrImages] = useState<Record<string, GridImage[]>>({})
  const [materialOptions, setMaterialOptions] = useState<PublicMaterialOption[]>([])
  const [optionSurcharges, setOptionSurcharges] = useState<PublicMaterialOptionSurcharge[]>([])
  // Per-currency personalisation pricing (migration 000172). Live-
  // read from public_get_customer_proof every load; never snapshotted.
  // Map keyed on currency code ('GBP' / 'USD' / 'EUR'); only currencies
  // referenced by this proof's versions are populated.
  const [personalisationPricing, setPersonalisationPricing] = useState<Record<string, PersonalisationPricing>>({})
  // Live pricing — replaces the proof_versions.pricing_snapshot
  // read since Phase 2 (migration 000117). Both lists cover every
  // material × currency referenced by this proof's versions; the
  // active version's pricing snapshot shape is rebuilt from these
  // rows in livePricingSnapshot below.
  const [tierRows, setTierRows] = useState<PublicPriceTier[]>([])
  const [variantRows, setVariantRows] = useState<PublicMaterialVariant[]>([])
  const [activeOptionCode, setActiveOptionCode] = useState<string | null>(null)
  const [publicSettings, setPublicSettings] = useState<PublicSettings | null>(null)
  // Detail view (Phase 2 — replaces the dark fullscreen lightbox).
  // Non-modal, light-register zoom that coexists with the request-
  // changes panel. `images` is the navigable set (the clicked image's
  // group — front + back of one recipient's card, or both directions
  // of one variant-round card). `index` is the clicked image inside
  // that set; chevrons step within `images` only, never the whole
  // page. `displayLabel` is the caption's primary label
  // (recipient name, "Shared", or a variant display name).
  // `recipientName` / `roundVariant` route the "Request changes"
  // button to the right opener (openActionPanel vs
  // openVariantActionPanel).
  const [detailView, setDetailView] = useState<
    | {
        images: GridImage[]
        index: number
        displayLabel: string | null
        versionId: string
        recipientName: string
        roundVariant: { id: string; displayName: string } | null
      }
    | null
  >(null)
  // Captured on open so we can restore focus to the originating
  // PlateCard button on close (keyboard-user continuity — same
  // pattern the action modal uses).
  const detailViewTriggerRef = useRef<HTMLElement | null>(null)
  // Phase 3 — the side currently visible in the detail view, kept
  // here so submitAction can stamp proof_events.side when the
  // customer sends a change request without the detail view having
  // to thread state into the panel. Reported by ProofDetailView's
  // onCurrentSideChange callback on mount and on every chevron step.
  // Null when no detail view is open OR when the visible image has
  // no side value (shared / single-image groups).
  const [detailViewSide, setDetailViewSide] = useState<'front' | 'back' | null>(null)
  function openDetailView(payload: {
    images: GridImage[]
    index: number
    displayLabel: string | null
    versionId: string
    recipientName: string
    roundVariant?: { id: string; displayName: string } | null
  }) {
    detailViewTriggerRef.current = document.activeElement as HTMLElement | null
    setDetailView({
      images: payload.images,
      index: payload.index,
      displayLabel: payload.displayLabel,
      versionId: payload.versionId,
      recipientName: payload.recipientName,
      roundVariant: payload.roundVariant ?? null,
    })
  }
  function closeDetailView() {
    setDetailView(null)
    // Reset so a subsequent change request opened from the overview
    // (rather than from inside a detail view) records side=null.
    setDetailViewSide(null)
    const trigger = detailViewTriggerRef.current
    detailViewTriggerRef.current = null
    if (trigger && typeof trigger.focus === 'function') {
      requestAnimationFrame(() => trigger.focus())
    }
  }
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  // Guards the per-version-per-page-load proof_version_views
  // insert. Keyed on versionId so that if a customer switches
  // between versions on the same page session, each version
  // gets exactly one recorded view (instead of only the first
  // version visited counting). A ref survives React strict-mode's
  // double-invoke of effects whereas state wouldn't.
  const viewRecordedVersionsRef = useRef<Set<string>>(new Set())
  // Per-recipient Approve buttons are always live — the disclaimer
  // acknowledgement now lives inside the Approve modal as a tick
  // box on the Confirm action. After the first successful Confirm
  // in this page session, subsequent Approve modals collapse the
  // disclaimer to a one-line reminder (the tick still gates
  // Confirm). React-state only — closing the tab resets the
  // session-scoped flag, by design. The bottom-of-page disclaimer
  // card is purely informational reference text.
  const [disclaimerAckedThisSession, setDisclaimerAckedThisSession] =
    useState(false)

  // ── Phase 2.5 per-recipient customer approval flow ─────────────
  // actionPanel is the modal surface; null = closed. Carries both
  // the version and the recipient name (or SHARED_APPROVAL_KEY for
  // the shared section) so the modal copy and the edge-function
  // call can attribute correctly.
  // actionResults / successMessages key on `${versionId}|${name}`
  // so each band's optimistic state is isolated — Alec approving
  // doesn't lock Kyle's band.
  // roundVariant flips the modal into "Choose this direction" mode for
  // variant rounds (steps 4 / build plan). When set, name is forced to
  // SHARED_APPROVAL_KEY and type is forced to 'request_changes' at
  // open time; the modal swaps its header copy, body label, and
  // confirm button text to read as a selection rather than a change
  // request. The Approve disclaimer block is also hidden by virtue of
  // the type already being 'request_changes' on this path.
  const [actionPanel, setActionPanel] = useState<
    | {
        versionId: string
        name: string
        type: 'approve' | 'request_changes'
        roundVariant?: { id: string; displayName: string } | null
      }
    | null
  >(null)
  const [actionName, setActionName] = useState('')
  const [actionComment, setActionComment] = useState('')
  const [actionSubmitting, setActionSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // Modal-scoped disclaimer state. Reset every time the Approve
  // modal opens so each action requires its own per-action ack —
  // the session-scoped flag only collapses how prominently the
  // disclaimer text is rendered. `actionDisclaimerExpanded`
  // overrides the abbreviated view when the customer clicks the
  // "Show disclaimer" affordance on a subsequent action.
  const [actionDisclaimerAcked, setActionDisclaimerAcked] = useState(false)
  const [actionDisclaimerExpanded, setActionDisclaimerExpanded] =
    useState(false)
  // Migration 000169. Tracks the "I've verified my QR code
  // contents" tick on the approve modal. Renders only when the
  // active slot has at least one QR row visible to it; gates the
  // Confirm button alongside the disclaimer tick. The customer
  // can untick and re-check without losing place, mirroring the
  // disclaimer tick's behaviour. Reset to false whenever a new
  // action modal opens.
  const [actionQrConfirmed, setActionQrConfirmed] = useState(false)
  // Earlier-version acknowledgement on the approve panel. Renders an
  // extra warning block + tick at the top of the panel body whenever
  // the version being approved is not the latest, since approving a
  // superseded design is higher-risk than the standard disclaimer
  // covers. Gates Confirm alongside the disclaimer and QR ticks.
  // Reset to false on every action-panel open (same pattern as the
  // other approve-only acks).
  const [actionEarlierVersionAcked, setActionEarlierVersionAcked] =
    useState(false)
  const [actionResults, setActionResults] = useState<
    Record<
      string,
      {
        type: 'approve' | 'request_changes'
        actorName: string
        comment: string | null
        createdAt: string
      }
    >
  >({})
  const [successMessages, setSuccessMessages] = useState<Record<string, string>>({})
  // Confirmation-screen flag for the standard request-changes
  // panel. When true, ActionPanel swaps its form body for a
  // "thanks, we'll be in touch" view that the customer dismisses
  // with Done. Approve and variant-round "Choose this direction"
  // close on success as before — they never set this flag. Cleared
  // in closeActionPanel and reset at every open.
  const [requestChangesSubmitted, setRequestChangesSubmitted] = useState(false)

  useEffect(() => {
    if (!id) { setNotFound(true); return }
    loadProof(id)
  }, [id])

  // Per-proof document.title — same primary string the masthead uses
  // (company when present, otherwise the contact name) so screen-reader
  // users with multiple tabs open can tell proofs apart instead of
  // hearing the generic "Proof Viewer" page title for every tab.
  // Resets to the static title on unmount so navigating away from
  // /p/:id doesn't leave the customer's name in the tab.
  useEffect(() => {
    if (!proof) return
    const trimmedCompany = proof.company?.trim() ?? ''
    const trimmedName = proof.customer_name?.trim() ?? ''
    const primary = trimmedCompany.length > 0 ? trimmedCompany : trimmedName
    const previous = document.title
    document.title = primary ? `${primary} — Proof Viewer` : 'Proof Viewer'
    return () => { document.title = previous }
  }, [proof])

  // Element that had focus when the panel opened — restored on close
  // so keyboard users land back on the per-recipient Approve /
  // Request changes button rather than at <body> with the page's tab
  // order re-set to zero. The previous focus-trap effect tied to the
  // approve modal is gone with the modal; the docked panel owns its
  // own Escape + focus-on-open, and deliberately does NOT trap Tab
  // so the customer can scroll the proof while reading the
  // disclaimer.
  const actionPanelTriggerRef = useRef<HTMLElement | null>(null)

  // When active version changes, reset the option switcher to the first option
  // this version exposes.
  useEffect(() => {
    if (!activeVersion) return
    setActiveOptionCode(activeVersion.material_options[0] ?? null)
  }, [activeVersion?.id])

  // Fire a one-shot proof_version_views insert ~2.5s after the
  // initial version becomes available. The delay filters out
  // transient page loads where the customer clicks through to
  // another tab immediately, and by sitting behind a setTimeout
  // we also stay clear of the bot scanners that don't execute JS
  // at all. Server-side bot classification (known preview UAs)
  // handles the ones that do. Ref guard prevents double-fire in
  // React strict mode.
  useEffect(() => {
    if (!activeVersion) return
    const versionId = activeVersion.id
    if (viewRecordedVersionsRef.current.has(versionId)) return
    const t = window.setTimeout(() => {
      if (viewRecordedVersionsRef.current.has(versionId)) return
      // Designer-preview bypass: the admin "Preview as customer"
      // button opens /p/:id?preview=1 so the RPC doesn't pollute
      // proof_version_views with designer hits. Read the flag at
      // fire time rather than at effect setup — the URL has
      // definitely settled by now (2.5s post-mount) so there's no
      // risk of a stale search string, and keeping the check
      // inside the timer means the effect body is a single
      // uninterrupted schedule→cleanup pair. logCustomerEvent
      // still fires from loadProof — that's a general audit
      // ledger, distinct from the view-tracking table.
      if (new URLSearchParams(window.location.search).get('preview') === '1') return
      // Mark the version as evaluated up front so a re-run of this
      // effect (React strict mode, an auth-state flip mid-view)
      // doesn't race the async session check below and double-fire.
      viewRecordedVersionsRef.current.add(versionId)
      // Designer-as-viewer bypass. Designers loading /p/:id directly
      // (no ?preview=1) used to land here with no gate, polluting the
      // dashboard's customer-activity timeline (000127 attributes
      // every non-bot proof_version_views row to the proof's contact
      // name on the assumption that anon = customer). Skip the RPC
      // when a Supabase session exists. getSession is async because
      // it returns the in-memory session synchronously after the
      // initial bootstrap; the await is a single microtask hop on
      // the warm path. Forward-only — historical designer-as-viewer
      // rows are intentionally not backfilled.
      void (async () => {
        const { data: { session } } = await supabase.auth.getSession()
        if (session) return
        // .then() is load-bearing, not cosmetic. supabase.rpc()
        // returns a PostgrestBuilder, a custom thenable — it only
        // dispatches the fetch when something calls .then(),
        // awaits, or iterates. `void supabase.rpc(…)` drops the
        // reference without triggering execution, so the RPC
        // silently never runs. Attaching .then() is the minimal
        // way to force the request; the body is only there to
        // surface server-side errors to the console.
        supabase.rpc('record_proof_view', {
          p_version_id: versionId,
          p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
          p_ip: null, // server reads from request headers
        }).then(({ error }) => {
          if (error) console.error('[proof-viewer] record_proof_view failed:', error)
        })
      })()
    }, 2500)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVersion?.id])

  // After the initial paint settles, warm the browser cache for
  // every historic version's images so the timeline feels instant
  // when the customer clicks back through earlier revisions. The
  // signed URLs are already resolved in versionImages state; we
  // just need the bytes in the HTTP cache. Best-effort and silent
  // on failure, no UI surface. The active version is already being
  // fetched by the DOM so we skip it to avoid doubling bandwidth
  // on the hot path.
  //
  // Dependency is [versionImages, activeVersion?.id] rather than
  // just [activeVersion?.id]: versionImages is what arms the
  // effect once loadProof settles (it starts as an empty object,
  // then lands populated), and the active-id change is what
  // causes the re-fire when the customer switches versions via
  // the timeline, so the new active is skipped and the rest stay
  // warm.
  useEffect(() => {
    if (!activeVersion) return
    const urls: string[] = []
    for (const [versionId, imgs] of Object.entries(versionImages)) {
      if (versionId === activeVersion.id) continue
      for (const img of imgs) {
        if (img.signed_url) urls.push(img.signed_url)
      }
    }
    if (urls.length === 0) return

    const preloaders: HTMLImageElement[] = []
    const preload = () => {
      for (const url of urls) {
        const img = new Image()
        img.src = url
        preloaders.push(img)
      }
    }

    // requestIdleCallback is missing in Safari, fall back to a
    // short timeout so the preload still runs after first paint
    // without contesting the render-critical path.
    const ric = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number
      cancelIdleCallback?: (handle: number) => void
    }
    let idleHandle: number | null = null
    let timerHandle: number | null = null
    if (ric.requestIdleCallback) {
      idleHandle = ric.requestIdleCallback(preload, { timeout: 2000 })
    } else {
      timerHandle = window.setTimeout(preload, 200)
    }

    return () => {
      if (idleHandle != null && ric.cancelIdleCallback) ric.cancelIdleCallback(idleHandle)
      if (timerHandle != null) window.clearTimeout(timerHandle)
      // Null the src on in-flight preloaders so the browser can
      // abort downloads that have not already completed. Cheap,
      // defensive, no-op if already finished.
      for (const img of preloaders) img.src = ''
    }
  }, [versionImages, activeVersion?.id])

  // ── Phase 2.5 per-recipient action helpers ──────────────────────────────

  // Composite key for actionResults / successMessages so each band
  // (per recipient × version) has isolated optimistic state.
  function bandKey(versionId: string, name: string): string {
    return `${versionId}|${name}`
  }

  // Variant-round optimistic-state key (build-plan step 4). Lives in
  // a separate namespace from bandKey so a per-recipient band on a
  // standard version can never collide with a variant card on a
  // variant-round version. Only the variant-round render path reads
  // this; the standard path never sees these keys.
  function variantBandKey(versionId: string, variantId: string): string {
    return `${versionId}|variant|${variantId}`
  }

  function openActionPanel(
    versionId: string,
    recipientName: string,
    type: 'approve' | 'request_changes',
  ) {
    actionPanelTriggerRef.current = document.activeElement as HTMLElement | null
    setActionPanel({ versionId, name: recipientName, type })
    // Pre-fill actor_name with the recipient's name when it's a
    // named band — the actor is most often the recipient
    // themselves, with the field still editable in case someone's
    // approving on their behalf. Shared bands open empty since
    // there's no recipient to default to.
    setActionName(recipientName === SHARED_APPROVAL_KEY ? '' : recipientName)
    setActionComment('')
    setActionError(null)
    // Per-action ack: every Approve open starts with the tick
    // unset and Confirm disabled, regardless of whether the
    // disclaimer has been acked earlier this session. The
    // session flag only collapses how prominently the text is
    // rendered (full vs one-line reminder + Show disclaimer).
    setActionDisclaimerAcked(false)
    setActionDisclaimerExpanded(false)
    setActionQrConfirmed(false)
    setActionEarlierVersionAcked(false)
    // Defensive reset — closeActionPanel already clears the flag,
    // but a fresh open should never inherit a stale confirmation
    // view if state ever drifts (e.g. component remount).
    setRequestChangesSubmitted(false)
  }

  // Variant-round equivalent of openActionPanel (build-plan step 4).
  // Variant rounds always travel as request_changes server-side, are
  // always shared (name = SHARED_APPROVAL_KEY), and carry the chosen
  // variant via roundVariant. The Approve disclaimer doesn't apply on
  // this path — it's gated by type === 'approve' in the modal which is
  // never true here — so we don't touch the disclaimer state. Otherwise
  // mirrors openActionPanel exactly.
  function openVariantActionPanel(
    versionId: string,
    variant: { id: string; display_name: string },
  ) {
    actionPanelTriggerRef.current = document.activeElement as HTMLElement | null
    setActionPanel({
      versionId,
      name: SHARED_APPROVAL_KEY,
      type: 'request_changes',
      roundVariant: { id: variant.id, displayName: variant.display_name },
    })
    setActionName('')
    setActionComment('')
    setActionError(null)
    setActionDisclaimerAcked(false)
    setActionDisclaimerExpanded(false)
    setActionQrConfirmed(false)
    setActionEarlierVersionAcked(false)
    // Same defensive reset as openActionPanel — variant-round opens
    // close on success anyway, but a state-drifted "submitted" flag
    // would render a confirmation view on top of a fresh form.
    setRequestChangesSubmitted(false)
  }

  function closeActionPanel() {
    setActionPanel(null)
    setActionError(null)
    // Drop the confirmation flag so the next open starts on the
    // form. The next open also resets it, but clearing here keeps
    // state consistent if anything else inspects the flag while
    // actionPanel transitions.
    setRequestChangesSubmitted(false)
    const trigger = actionPanelTriggerRef.current
    actionPanelTriggerRef.current = null
    if (trigger && typeof trigger.focus === 'function') {
      requestAnimationFrame(() => trigger.focus())
    }
  }

  async function submitAction() {
    if (!actionPanel) return
    const name = actionName.trim()
    const comment = actionComment.trim()
    // Client-side validation mirrors the edge function so the error
    // surfaces inside the modal rather than after a round-trip.
    if (!name) {
      setActionError('Please enter your name.')
      return
    }
    if (actionPanel.type === 'request_changes' && !comment) {
      setActionError('Please describe the changes you need.')
      return
    }
    // Approve flow only: the disclaimer tick gates Confirm
    // when a disclaimer is configured. The button is already
    // disabled in that state so this branch is a defensive
    // mirror of the disabled prop, not a primary surface.
    if (
      actionPanel.type === 'approve' &&
      publicSettings?.disclaimer_text &&
      !actionDisclaimerAcked
    ) {
      setActionError('Please confirm you have read the disclaimer.')
      return
    }
    // QR-confirmation tick (migration 000169). Same defensive
    // mirror pattern as the disclaimer block above: the button
    // is already disabled in this state, but a stale-tab or
    // bypassed-JS request needs a clear error message rather
    // than a generic edge-function 400.
    if (actionPanel.type === 'approve') {
      const slotQrs = qrRowsForSlot({
        qrImages: versionQrImages[actionPanel.versionId] ?? [],
        slotName: actionPanel.name,
        versionHasNames: (activeVersion?.names ?? []).length > 0,
      })
      if (slotQrs.length > 0 && !actionQrConfirmed) {
        setActionError('Please confirm the QR code contents before approving.')
        return
      }
    }
    // Earlier-version acknowledgement. Same defensive-mirror pattern
    // as the disclaimer and QR guards above: the Confirm button is
    // already disabled by the panel's gate, but a stale-tab or
    // bypassed-JS submit needs a clear error rather than landing on
    // the edge function and looking like a generic failure.
    if (
      actionPanel.type === 'approve' &&
      activeVersion &&
      !activeVersion.is_current &&
      !actionEarlierVersionAcked
    ) {
      setActionError(
        'Please confirm you understand you are approving an earlier version.',
      )
      return
    }
    setActionSubmitting(true)
    setActionError(null)
    try {
      const { data, error } = await supabase.functions.invoke<
        | { status: 'ok'; event_id: string }
        | {
            status: 'partial'
            event_id: string
            reason: 'helpscout_post_failed' | 'proof_name_approvals_sync_failed'
          }
        | { status: 'failed'; reason: string; detail?: string }
      >('proof-action', {
        body: {
          proof_version_id: actionPanel.versionId,
          event_type: actionPanel.type,
          actor_name: name,
          name: actionPanel.name,
          comment: comment || undefined,
          // Active option-tab code at the moment the customer clicked
          // Confirm — recorded on proof_events + proof_name_approvals
          // per migration 000124 so a "(brushed)" suffix can ride
          // through the dashboard without re-deriving from active
          // tab state. Null when the version has no option dimension
          // (empty material_options array). Sending null explicitly
          // rather than undefined so the edge function's body parser
          // doesn't have to distinguish absent-vs-null. Variant
          // rounds force null here regardless of activeOptionCode —
          // the option-tab strip isn't rendered on a variant round
          // (build-plan step 4) so activeOptionCode is null in
          // practice, but we belt-and-brace it.
          material_option_code: actionPanel.roundVariant
            ? null
            : (activeOptionCode ?? null),
          // Variant-round selection (migrations 000138 + 000139). Only
          // included when the modal was opened via openVariantActionPanel;
          // the edge function rejects round_variant_id on non-variant
          // versions, so we omit the key entirely on the standard path
          // rather than sending null.
          ...(actionPanel.roundVariant
            ? { round_variant_id: actionPanel.roundVariant.id }
            : {}),
          // Migration 000169 — customer's tick on "I've verified my
          // QR code contents". Edge function ignores it on
          // request_changes and on slots with no QRs; only the
          // approve-with-QRs path consumes the flag.
          qr_confirmed: actionPanel.type === 'approve' && actionQrConfirmed,
          // Migration 000196 (Phase 3) — the card side currently
          // visible in the detail view, if any. ProofDetailView
          // reports it through onCurrentSideChange while open;
          // closeDetailView resets it. Null when the panel was
          // opened from the overview action band (no zoom context)
          // or when the visible image has no side value. Edge
          // function pre-Phase-3 ignores the field, so it's safe
          // to send unconditionally.
          side: detailViewSide,
        },
      })
      if (error) {
        // Network / 5xx — generic fallback per spec.
        setActionError(
          'We\'re having trouble processing your request right now. Please reply to the email you received with this proof link — the team will pick it up there.',
        )
        return
      }
      const result = data
      if (!result) {
        setActionError(
          'We\'re having trouble processing your request right now. Please reply to the email you received with this proof link — the team will pick it up there.',
        )
        return
      }
      if (result.status === 'failed') {
        if (result.reason === 'approvals_disabled') {
          setActionError(
            'This action isn\'t available right now. Please reply to the email you received with this proof link.',
          )
        } else if (result.reason === 'validation') {
          // The server already enforces the same rules as the
          // client guard above; if we hit this branch it's an
          // unexpected divergence (e.g. trim semantics). Surface
          // the server detail when available, otherwise a generic
          // validation prompt.
          setActionError(
            (result as { detail?: string }).detail ??
              'Please check your details and try again.',
          )
        } else {
          setActionError(
            'We\'re having trouble processing your request right now. Please reply to the email you received with this proof link — the team will pick it up there.',
          )
        }
        return
      }
      // ok / partial — both lock this band. Optimistically write
      // the post-action state keyed on (versionId, name) for the
      // standard per-recipient path, or on (versionId, variantId)
      // for the variant-round path (build-plan step 4) so the two
      // namespaces never collide. The next page load picks the
      // same shape from approvals[] + latest_events_by_name on the
      // view; the locked-round detection in getVariantRoundState
      // reads round_variant_id from latest_events_by_name to
      // survive a refresh.
      //
      // Verb copy: standard path uses "approval" / "change request"
      // — preserved as-is. Variant rounds always travel as
      // request_changes server-side but the customer is selecting a
      // direction, not requesting changes; the success copy switches
      // to "selection" so the banner reads accurately.
      const verb = actionPanel.roundVariant
        ? 'selection'
        : actionPanel.type === 'approve' ? 'approval' : 'change request'
      const message =
        result.status === 'partial'
          ? `Thanks, ${name}. Your ${verb} has been recorded, but we couldn't notify the team automatically. To make sure they see it, please also reply to the email you received with this proof link.`
          : `Thanks, ${name}. Your ${verb} has been recorded and the team has been notified.`
      const key = actionPanel.roundVariant
        ? variantBandKey(actionPanel.versionId, actionPanel.roundVariant.id)
        : bandKey(actionPanel.versionId, actionPanel.name)
      const type = actionPanel.type
      setActionResults((prev) => ({
        ...prev,
        [key]: {
          type,
          actorName: name,
          comment: comment || null,
          createdAt: new Date().toISOString(),
        },
      }))
      setSuccessMessages((prev) => ({ ...prev, [key]: message }))
      // First successful Approve in this page session flips the
      // session-scoped flag so subsequent Approve modals open
      // with the abbreviated disclaimer reminder. Doesn't apply
      // to Request Changes — that flow has no disclaimer at all.
      if (type === 'approve') {
        setDisclaimerAckedThisSession(true)
      }
      // Standard request_changes leaves the panel open and swaps
      // it to a post-submit confirmation view (the admin-configured
      // confirmation copy used to render before submit, which read
      // wrong). Approve and the variant-round "Choose this
      // direction" path close as before — approve already has its
      // own per-recipient banner downstream, and variant-round's
      // success is signalled by the locked-grid state.
      if (type === 'request_changes' && !actionPanel.roundVariant) {
        setRequestChangesSubmitted(true)
      } else {
        closeActionPanel()
      }
    } catch {
      setActionError(
        'We\'re having trouble processing your request right now. Please reply to the email you received with this proof link — the team will pick it up there.',
      )
    } finally {
      setActionSubmitting(false)
    }
  }

  async function loadProof(proofId: string) {
    setLoading(true)
    // React Router keeps this component mounted across /p/:id →
    // /p/:otherId navigations, so without an explicit reset the
    // conditional setters below leave the previous proof's data in
    // place when the new proof has no versions / no options / no
    // variants. Reset every data slot up-front so a partial re-fetch
    // never bakes the old proof's surcharges into the new proof's
    // pricing grid.
    setProof(null)
    setVersions([])
    setActiveVersion(null)
    setVersionImages({})
    setVersionQrImages({})
    setMaterialOptions([])
    setOptionSurcharges([])
    setVariantRows([])
    setTierRows([])
    setPersonalisationPricing({})
    setActiveOptionCode(null)
    setNotFound(false)

    // One SECURITY DEFINER RPC replaces the previous fan-out across
    // public_proofs / public_proof_versions / public_material_options /
    // public_material_option_surcharges / public_material_variants /
    // public_price_tiers. The function (migration 000162) scopes every
    // catalogue lookup to the material_ids and currencies referenced by
    // this proof's versions, so anon can only ever see the slice
    // relevant to the proof UUID it already knows. The views
    // themselves are no longer anon-readable; this is the only
    // customer-page entry point now.
    const [graphResult, settingsResult] = await Promise.all([
      supabase.rpc('public_get_customer_proof', { p_proof_id: proofId }),
      getPublicSettings(),
    ])

    if (graphResult.error || graphResult.data == null) {
      // SQL NULL from the RPC (proof not found) lands here as
      // data === null, matching the previous .maybeSingle() shape.
      setNotFound(true)
      setLoading(false)
      return
    }

    const graph = graphResult.data as CustomerProofGraph
    setProof(graph.proof)
    setPublicSettings(settingsResult)

    const rawVersions = graph.versions ?? []
    setVersions(rawVersions)
    // Initial version: the one with is_current=true, falling back to
    // the last in the array. Designer-preview overrides via ?v=<id>:
    // VersionPreviewGate opens the customer page in an iframe pinned
    // to the just-saved version so the designer is checking what
    // they're about to send, not whichever version happens to carry
    // is_current right now (relevant when the designer edits an
    // older, non-current version). The param is read once at load
    // time and ignored if it doesn't match any version in the graph.
    const pinnedVersionId = new URLSearchParams(window.location.search).get('v')
    const pinnedVersion = pinnedVersionId ? rawVersions.find((v) => v.id === pinnedVersionId) ?? null : null
    const initialVersion = pinnedVersion ?? rawVersions.find((v) => v.is_current) ?? rawVersions[rawVersions.length - 1] ?? null
    setActiveVersion(initialVersion)

    setMaterialOptions(graph.material_options ?? [])
    setOptionSurcharges(graph.material_option_surcharges ?? [])
    setVariantRows(graph.material_variants ?? [])
    setTierRows(graph.price_tiers ?? [])
    setPersonalisationPricing(graph.personalisation_pricing ?? {})

    // Customer view tracking happens in the proof_version_views
    // table via the record_proof_view RPC fired below (after a
    // 2.5s settle delay). The previous duplicate write to
    // audit_log via logCustomerEvent has been removed alongside
    // the dropped log_customer_event RPC (audit finding H2).

    if (rawVersions.length > 0) {
      // Images stay on a dedicated edge function (service-role,
      // signs storage URLs) rather than folding into the RPC — the
      // RPC keeps to a pure SQL surface and the function handles
      // per-image graceful degradation around the storage signer.
      const { data: imgData, error: imgError } = await supabase.functions.invoke<{ images: GridImage[] }>(
        'customer-proof-images',
        { body: { proofId } },
      )
      if (imgError || !imgData?.images) {
        // Graceful failure: render the page without images rather
        // than blocking the whole load.
        setVersionImages({})
        setVersionQrImages({})
      } else {
        // Two buckets, populated in one pass. Artwork images flow
        // into versionImages (the existing image grid), QR rows
        // into versionQrImages (the dedicated QR panel). is_qr_code
        // is set per-row by migration 000168; legacy rows default
        // to false so the bucketing is safe for pre-QR proofs.
        const byVersion: Record<string, GridImage[]> = {}
        const qrByVersion: Record<string, GridImage[]> = {}
        imgData.images.forEach((img) => {
          // proof_version_id rides on the row but isn't in the
          // GridImage type. Same shape (and same cast pattern) as
          // the pre-shipment direct-fetch path.
          const pvid = (img as unknown as { proof_version_id: string }).proof_version_id
          const target = img.is_qr_code === true ? qrByVersion : byVersion
          if (!target[pvid]) target[pvid] = []
          target[pvid].push(img)
        })
        setVersionImages(byVersion)
        setVersionQrImages(qrByVersion)
      }
    }

    setLoading(false)
  }

  if (loading) return <LoadingScreen />
  if (notFound || !proof) return <NotFoundScreen />
  if (proof.status === 'abandoned') return <AbandonedScreen proof={proof} />

  const isApproved = proof.status === 'approved'
  const viewingApprovedVersion = isApproved && activeVersion?.is_current === true

  // Proof-level approval check used by the version-selector logic
  // below. Reads proof.status directly rather than aliasing
  // through `isApproved`, so the derivation is self-evident here
  // and not coupled to whatever else `isApproved` ends up being
  // used for. True once the parent proof has been approved (000017
  // / 000126); when false, viewing an earlier version is a soft
  // state with an amber warning instead of a lockout.
  //
  // The original intent here was a per-version approved_at on
  // proof_versions (added in 000066 for an "Approve this version"
  // button that never shipped), but those columns were dropped
  // in 000076 when per-name approvals replaced the version-level
  // model. proof.status is now the single proof-wide approval
  // signal: it flips when every required slot on the current
  // version is approved (000126 trigger or designer override).
  const proofIsApproved = proof.status === 'approved'
  const latestVersion =
    versions.find((v) => v.is_current) ?? versions[versions.length - 1] ?? null

  // Per-name approval roll-up for the current version. Drives the
  // muted "partially approved" banner when some slots carry
  // approvals from a prior version but others are still open on
  // the current version. changes_requested is deliberately
  // treated as "not approved" here — we don't surface that state
  // to the customer in this shipment. Null / empty approvals
  // array is the common case (jsonb_agg coalesce in
  // public_proof_versions guarantees an array, never null).
  const currentVersion = activeVersion?.is_current === true ? activeVersion : null
  const approvedNamesOnCurrent = new Set(
    (currentVersion?.approvals ?? [])
      .filter((a) => a.state === 'approved')
      .map((a) => a.name),
  )
  // Slot identities present on the current version. Mirrors the
  // designer-side rule: current version's names[] plus the
  // shared sentinel when the version has any associated_name=null
  // images in its image set. Versions with no slots (shouldn't
  // happen given validation, but defensive) collapse the banner
  // logic to silent.
  const currentVersionHasSharedImages = currentVersion
    ? (versionImages[currentVersion.id] ?? []).some((img) => img.associated_name == null)
    : false
  const currentSlotIdentities: string[] = currentVersion
    ? [
        ...(currentVersionHasSharedImages ? [SHARED_APPROVAL_KEY] : []),
        ...currentVersion.names,
      ]
    : []
  const approvedSlotCount = currentSlotIdentities.filter((id) =>
    approvedNamesOnCurrent.has(id),
  ).length
  // "Some but not all slots approved" — the carry-forward middle
  // state. Only shown on the current version; older versions
  // stay silent regardless. If proof.status is fully approved
  // the emerald banner wins (below) and this branch sits dark.
  const showPartialApprovalBanner =
    activeVersion?.is_current === true &&
    !viewingApprovedVersion &&
    currentSlotIdentities.length > 0 &&
    approvedSlotCount > 0 &&
    approvedSlotCount < currentSlotIdentities.length

  // Version-id → version_number map for "Approved from v{n}" pill
  // provenance resolution. Cheap to build here since `versions`
  // is already loaded for the version selector.
  const versionNumberById = new Map<string, number>()
  for (const v of versions) versionNumberById.set(v.id, v.version_number)

  // Per-band state resolution for the Phase 2.5 customer action
  // surface. Reads from three sources, in priority order:
  //   1. actionResults[bandKey] — local optimistic state from a
  //      just-completed POST (overrides server reads until next
  //      page load).
  //   2. activeVersion.approvals[name] — designer-side mirror of
  //      the canonical state (proof_name_approvals row). Drives
  //      the carried-from-v(N) muted banner, plus the basic
  //      approved / changes_requested banners when no audit
  //      detail is co-located.
  //   3. activeVersion.latest_events_by_name[name] — audit detail
  //      (actor_name, comment, created_at) for banners on customer-
  //      recorded actions. Falls back gracefully when no event
  //      exists (e.g. designer-only approvals).
  type BandState =
    | { kind: 'pending' }
    | {
        kind: 'optimistic'
        type: 'approve' | 'request_changes'
        actorName: string
        comment: string | null
        createdAt: string
      }
    | { kind: 'carried'; carriedFromVersionNumber: number | null }
    | {
        kind: 'approved'
        actorName: string | null
        comment: string | null
        createdAt: string | null
      }
    | {
        kind: 'changes_requested'
        actorName: string | null
        comment: string | null
        createdAt: string | null
      }

  function getBandState(name: string): BandState {
    if (!activeVersion) return { kind: 'pending' }
    const key = bandKey(activeVersion.id, name)
    const optimistic = actionResults[key]
    if (optimistic) {
      return {
        kind: 'optimistic',
        type: optimistic.type,
        actorName: optimistic.actorName,
        comment: optimistic.comment,
        createdAt: optimistic.createdAt,
      }
    }
    const approval = activeVersion.approvals.find((a) => a.name === name)
    if (!approval) return { kind: 'pending' }
    if (approval.state === 'approved' && approval.carried_from_version_id) {
      return {
        kind: 'carried',
        carriedFromVersionNumber:
          versionNumberById.get(approval.carried_from_version_id) ?? null,
      }
    }
    // Audit detail from latest_events_by_name when the customer
    // recorded the action. Shared-section events written by older
    // code paths could carry name=null instead of '__shared__';
    // both are accepted here for safety.
    //
    // State-aware event_type matching (000130 / PR #6 follow-up):
    // the lookup must match the event_type to the row's current
    // state. Without this guard, a partial-failure case where the
    // row's state flipped to 'approved' via an override but the
    // matching designer_override_approve event was never written
    // (e.g. the original PR #6 RLS regression) would fall through
    // to the older request_changes event and leak the customer's
    // change-request metadata onto an approved pill.
    //
    // designer_override_approve events never appear here regardless
    // of state — they're designer-side audit only.
    const expectedEventType = approval.state === 'approved'
      ? 'approve'
      : 'request_changes'
    const event: ProofEventState | undefined =
      activeVersion.latest_events_by_name.find(
        (e) =>
          e.event_type === expectedEventType &&
          (e.name === name ||
            (name === SHARED_APPROVAL_KEY && e.name == null)),
      )
    if (approval.state === 'approved') {
      return {
        kind: 'approved',
        actorName: event?.actor_name ?? null,
        comment: event?.comment ?? null,
        createdAt: event?.created_at ?? null,
      }
    }
    return {
      kind: 'changes_requested',
      actorName: event?.actor_name ?? null,
      comment: event?.comment ?? null,
      createdAt: event?.created_at ?? null,
    }
  }

  // Format an event timestamp for the banner body. Falls back to
  // the empty string on null / parse failure so the rendered line
  // is "by {actor}" rather than "by {actor} on Invalid Date".
  function formatBandDate(iso: string | null): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const datePart = d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
    const timePart = d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    })
    return `${datePart} at ${timePart}`
  }

  // DD MMM YYYY, e.g. "07 May 2026". Used by the approved-state
  // status line in renderActionBand — quieter than the long-form
  // "7 May 2026 at 14:32" banner format.
  function formatApprovedDate(iso: string | null): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  }

  // ── Per-band action surface ──────────────────────────────────
  //
  // Renders directly under each rendered group's image cluster
  // (one band per named recipient + one for the shared section
  // when present). Five visual states keyed off getBandState:
  //
  //   pending           → two buttons (Approve / Request changes)
  //   optimistic        → success banner driven by the just-
  //                       completed local action
  //   carried           → muted "Approved (carried from v{N})"
  //                       banner, no buttons
  //   approved          → APPROVED banner with actor+date+comment
  //   changes_requested → CHANGES REQUESTED banner with comment
  //
  // Both buttons are always live. The disclaimer ack now lives
  // inside the Approve modal as a per-action tick box gating
  // Confirm — see the modal block at the bottom of this file.
  // Request changes stays ungated end-to-end.
  function renderActionBand(name: string): React.ReactNode {
    if (!activeVersion) return null
    if (!activeVersion.approvals_enabled) return null

    const state = getBandState(name)
    const named = name !== SHARED_APPROVAL_KEY
    const recipientLabel = named ? name : 'this proof'
    const forSuffix = named ? ` for ${name}` : ''
    const key = bandKey(activeVersion.id, name)
    const successMessage = successMessages[key] ?? null

    // Older-version hard lockout — viewing v(N) while v(M) is
    // current AND the proof has already been approved somewhere.
    // Informational line + ghost button to jump to the latest.
    // Before any approval, the customer can still approve an
    // earlier version they prefer; that branch falls through to
    // the normal pending render with an amber warning prepended
    // (see below). is_current is the single source of truth for
    // "latest version" (set by the supersession trigger in 000068).
    if (!activeVersion.is_current && proofIsApproved) {
      const currentVersion = versions.find((v) => v.is_current) ?? null
      return (
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-start">
          <span className="text-sm text-ink-soft">
            You're viewing version {activeVersion.version_number}.
            {currentVersion
              ? ` Version ${currentVersion.version_number} is the current proof.`
              : ''}
          </span>
          {currentVersion && (
            <ButtonGhost size="sm" onClick={() => setActiveVersion(currentVersion)}>
              View current version
            </ButtonGhost>
          )}
        </div>
      )
    }

    // Optimistic banner — fires right after a successful action
    // before the server-mirrored state lands on next reload.
    // role="status" is the implicit aria-live=polite + atomic so
    // screen readers announce the result; the non-optimistic
    // states render at page load and don't need announcing.
    if (state.kind === 'optimistic') {
      const approved = state.type === 'approve'
      const pillColour: PillColour = approved ? 'in-stock' : 'brand'
      const label = (approved ? 'Approved' : 'Changes requested') + (named ? ` for ${name}` : '')
      return (
        <div
          role="status"
          className="mt-6 flex flex-col gap-2 rounded-[10px] bg-surface border border-line px-5 py-4"
        >
          <Pill colour={pillColour}>{label}</Pill>
          <span className="text-[15px] text-ink leading-snug">
            by {state.actorName}
            {formatBandDate(state.createdAt) ? ` on ${formatBandDate(state.createdAt)}` : ''}.
          </span>
          {state.comment && (
            <p className="text-[14px] leading-[1.55] text-ink-soft">
              &ldquo;{state.comment}&rdquo;
            </p>
          )}
          {successMessage && (
            <p className="text-[13px] leading-[1.55] text-ink-mute">
              {successMessage}
            </p>
          )}
        </div>
      )
    }

    // Carried — green carry-forward banner. Reads "Approved
    // (carried from v{N})" so the customer understands the slot
    // was approved on an earlier version and pulled through.
    if (state.kind === 'carried') {
      const subtitle =
        state.carriedFromVersionNumber != null
          ? `Carried from v${state.carriedFromVersionNumber}`
          : 'Carried from a previous version'
      return (
        <div className="mt-6 flex flex-col gap-2 rounded-[10px] bg-surface border border-line px-5 py-4">
          <Pill colour="in-stock">{'Approved' + forSuffix}</Pill>
          <span className="text-[14px] text-ink-soft">{subtitle}</span>
        </div>
      )
    }

    // Approved — minimal status line in the same horizontal slot
    // the buttons would occupy. Pill + actor/date/comment.
    // Quieter than the carried banner because the slot reads as
    // "done" rather than as a state to act on.
    if (state.kind === 'approved') {
      const approvedDate = formatApprovedDate(state.createdAt)
      return (
        <div className="mt-6 flex flex-col gap-1.5 sm:items-start">
          <Pill colour="in-stock">{'Approved' + forSuffix}</Pill>
          {(state.actorName || approvedDate) && (
            <span className="text-sm text-ink-soft">
              {state.actorName ? `Approved by ${state.actorName}` : 'Approved'}
              {approvedDate ? ` on ${approvedDate}` : ''}
            </span>
          )}
          {state.comment && (
            <p className="text-[14px] leading-[1.55] text-ink-soft">
              &ldquo;{state.comment}&rdquo;
            </p>
          )}
        </div>
      )
    }

    // Changes requested — coral / brand pill on a quiet card.
    // brand-soft for the changes-requested treatment so it sits
    // on the page as a clear "action needed" state without
    // shouting at the customer who already submitted feedback.
    if (state.kind === 'changes_requested') {
      return (
        <div className="mt-6 flex flex-col gap-2 rounded-[10px] bg-brand-50 border border-brand-200 px-5 py-4">
          <Pill colour="brand">Changes requested</Pill>
          {(state.actorName || state.createdAt) && (
            <span className="text-[15px] text-ink leading-snug">
              {state.actorName ? `by ${state.actorName}` : ''}
              {state.actorName && formatBandDate(state.createdAt) ? ' ' : ''}
              {formatBandDate(state.createdAt)
                ? `${state.actorName ? 'on' : 'On'} ${formatBandDate(state.createdAt)}`
                : ''}
              .
            </span>
          )}
          {state.comment && (
            <p className="text-[14px] leading-[1.55] text-ink-soft">
              &ldquo;{state.comment}&rdquo;
            </p>
          )}
        </div>
      )
    }

    // Pending — render the two buttons. When the customer is viewing
    // an earlier version on a not-yet-approved proof, prepend an
    // amber warning so they know they're not on the most recent
    // proof but can still approve this one if they prefer it.
    //
    // If the action panel is already open for this slot (same
    // version and recipient, and not the variant-round path),
    // suppress the whole pending block — eyebrow, warning, both
    // buttons. The panel IS the form now; rendering a second pair
    // of buttons below it reads as redundant. The block reappears
    // if the customer cancels.
    if (
      actionPanel &&
      !actionPanel.roundVariant &&
      actionPanel.versionId === activeVersion.id &&
      actionPanel.name === name
    ) {
      return null
    }
    const approveLabel = `Approve ${recipientLabel}${named ? "'s design" : ''}`
    const showEarlierVersionWarning =
      !activeVersion.is_current && !proofIsApproved && latestVersion != null
    return (
      <div className="mt-6 flex flex-col gap-3 sm:items-start">
        {showEarlierVersionWarning && latestVersion && (
          // "Heads up" earlier-version warning. Quiet low-soft
          // (amber) card with a pill + body copy. Was Direction-B
          // amber tint + bespoke colour values; now uses the
          // design system's low / low-soft tokens which match
          // the same semantic (warning, not error).
          <div className="flex flex-col gap-2 rounded-[10px] bg-low-soft border border-low px-5 py-4">
            <Pill colour="low">Heads up</Pill>
            <p className="text-sm text-ink leading-relaxed">
              You're viewing version {activeVersion.version_number} of{' '}
              {versions.length}. Version {latestVersion.version_number} is
              the most recent proof. You can still approve this version if
              you prefer it.
            </p>
          </div>
        )}
        {/* "Request changes or approve" eyebrow only makes sense
            when both actions are on offer. On an earlier version
            Request changes is suppressed (capturing feedback
            against a superseded design is illogical — the
            customer should be on the latest version to do that),
            so the eyebrow goes too. */}
        {!showEarlierVersionWarning && (
          <span className="eyebrow">Request changes or approve</span>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {showEarlierVersionWarning && latestVersion ? (
            // Earlier version, no approval yet — secondary
            // navigation, not the primary action. ButtonGhost
            // lets the customer switch to the latest version
            // quietly while the Approve CTA stays available for
            // the deliberate "I want this earlier version" case.
            <ButtonGhost onClick={() => setActiveVersion(latestVersion)}>
              Go to the latest version
            </ButtonGhost>
          ) : (
            // Request changes — coral / brand-tinted CTA, paired
            // with the ink Approve to its right. The two CTAs
            // sit side-by-side at sm+ and stack at <sm.
            <ButtonCoral
              icon={Send}
              onClick={() => openActionPanel(activeVersion.id, name, 'request_changes')}
            >
              Request changes
            </ButtonCoral>
          )}
          <ButtonInk
            icon={Check}
            onClick={() => openActionPanel(activeVersion.id, name, 'approve')}
          >
            {approveLabel}
          </ButtonInk>
        </div>
      </div>
    )
  }

  // ── Shared section info band ─────────────────────────────────
  //
  // Replaces the action band on the standalone shared block when the
  // version has named recipients. The shared back/section never gets
  // its own customer Approve action in that case — it's approved by
  // implication once every named recipient approves their card. This
  // band reflects that derived state and never renders buttons.
  //
  // Timestamp source per surface (per the shared helper's contract):
  // customer page reads latest_events_by_name.created_at for approve
  // events. Carry-forward approvals have no co-located event on this
  // version, so they satisfy the predicate via approvals[] but
  // contribute no timestamp; falls back to "Approved" without a date
  // when no name yields a timestamp.
  function renderSharedInfoBand(): React.ReactNode {
    if (!activeVersion) return null
    if (!activeVersion.approvals_enabled) return null

    const approvedNames = new Set<string>()
    for (const a of activeVersion.approvals) {
      if (a.state !== 'approved') continue
      if (a.name === SHARED_APPROVAL_KEY) continue
      approvedNames.add(a.name)
    }
    const timestampByName = new Map<string, string>()
    for (const e of activeVersion.latest_events_by_name) {
      if (e.event_type !== 'approve') continue
      if (e.name == null) continue
      if (e.name === SHARED_APPROVAL_KEY) continue
      timestampByName.set(e.name, e.created_at)
    }
    const derived = deriveSharedApprovalState({
      names: activeVersion.names,
      approvedNames,
      timestampByName,
    })

    // Two-state info banner for the shared-section block — used
    // when the proof has named recipients (the shared section is
    // approved-by-implication, never the customer's direct action).
    // 'approved' → green register matching the per-recipient
    // approval pill from PR 12c; otherwise → quiet eyebrow.
    if (derived.state === 'approved') {
      const dateStr = derived.latestApprovedAt
        ? new Date(derived.latestApprovedAt).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })
        : null
      return (
        <div className="flex flex-col gap-1.5">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 eyebrow self-start"
            style={{
              background: 'rgba(14,155,78,0.14)',
              color: 'var(--c-in-stock)',
              border: '1px solid rgba(14,155,78,0.3)',
              letterSpacing: '0.14em',
            }}
          >
            <svg
              width="9"
              height="9"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2.5 6.5L5 9L9.5 3.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Approved
          </span>
          <span className="text-[14px] text-ink-soft leading-snug">
            {dateStr ? `Approved on ${dateStr}.` : 'Approved.'}
          </span>
        </div>
      )
    }

    return (
      <div className="flex flex-col gap-1.5">
        <span className="eyebrow text-ink-mute">Pending review</span>
        <span className="text-[14px] text-ink-soft leading-snug">
          Approved automatically once every recipient approves their design.
        </span>
      </div>
    )
  }

  // Per-identity approval lookup for the group-heading pills.
  // Keyed on SHARED_APPROVAL_KEY or a real name. Returns the
  // provenance string for the pill: "Approved from v{n}" when
  // the approval carried forward and the source version is
  // resolvable; plain "Approved" otherwise.
  function approvalPillFor(identity: string): string | null {
    const row = (currentVersion?.approvals ?? []).find(
      (a) => a.name === identity && a.state === 'approved',
    )
    if (!row) return null
    if (row.carried_from_version_id) {
      const n = versionNumberById.get(row.carried_from_version_id)
      if (n != null) return `Approved from v${n}`
    }
    return 'Approved'
  }

  // ─── Variant rounds (build-plan step 4) ─────────────────────────────────
  //
  // Three helpers grouped together so the variant-round render path is
  // contained: getVariantRoundState (locked-state derivation),
  // renderVariantBand (per-variant action band), renderVariantRound
  // (top-level comparison-grid section). None of these touch the
  // standard render path — they're only invoked from the variant-round
  // branch at the top of the proofs IIFE.

  // Derived locked-round state. Reads two sources in priority order:
  //   1. actionResults — optimistic state from a just-completed POST
  //      in this page session. Keyed on variantBandKey, so per-recipient
  //      bands on a standard version can never collide with these.
  //   2. activeVersion.latest_events_by_name — durable state from the
  //      DB (migration 000139 surfaced round_variant_id on each entry).
  //      Variant rounds always carry name='__shared__' so DISTINCT ON
  //      collapses the append-only event stream to a single entry per
  //      version, yielding the most recent direction the customer
  //      selected. Filtered to event_type='request_changes' AND
  //      round_variant_id != null for safety.
  // Returning a 'locked' state on any match locks every variant card in
  // the grid; only the chosen variant gets the green-tinted "Selected"
  // banner, others render in muted state per the build-plan v1
  // simplification (no in-page change-of-mind; reply by email).
  type VariantRoundState =
    | { kind: 'pending' }
    | {
        kind: 'locked'
        chosenVariantId: string
        actorName: string | null
        comment: string | null
        createdAt: string | null
      }
  function getVariantRoundState(): VariantRoundState {
    if (!activeVersion || !activeVersion.is_variant_round) return { kind: 'pending' }
    const variants = activeVersion.round_variants ?? []

    // 1. Optimistic — most recent successful selection in this session.
    let mostRecent:
      | { variantId: string; createdAt: string; actorName: string; comment: string | null }
      | null = null
    for (const variant of variants) {
      const result = actionResults[variantBandKey(activeVersion.id, variant.id)]
      if (!result) continue
      if (!mostRecent || result.createdAt > mostRecent.createdAt) {
        mostRecent = {
          variantId: variant.id,
          createdAt: result.createdAt,
          actorName: result.actorName,
          comment: result.comment,
        }
      }
    }
    if (mostRecent) {
      return {
        kind: 'locked',
        chosenVariantId: mostRecent.variantId,
        actorName: mostRecent.actorName,
        comment: mostRecent.comment,
        createdAt: mostRecent.createdAt,
      }
    }

    // 2. Durable — read latest_events_by_name. Variant rounds always
    //    carry name='__shared__', so any entry with round_variant_id
    //    set is the customer's locked selection. event_type filter
    //    excludes a hypothetical future state where we route something
    //    other than request_changes through this surface.
    const lockedEvent = activeVersion.latest_events_by_name.find(
      (e) => e.event_type === 'request_changes' && e.round_variant_id != null,
    )
    if (lockedEvent && lockedEvent.round_variant_id) {
      return {
        kind: 'locked',
        chosenVariantId: lockedEvent.round_variant_id,
        actorName: lockedEvent.actor_name,
        comment: lockedEvent.comment,
        createdAt: lockedEvent.created_at,
      }
    }

    return { kind: 'pending' }
  }

  // Per-variant action band. Three states:
  //   * pending             → "Choose this direction" CTA
  //   * locked + chosen     → emerald "Selected" banner with actor +
  //                            date + comment (mirrors the existing
  //                            approved-banner pattern)
  //   * locked + not chosen → muted "Not selected" indicator (the card
  //                            also gets reduced opacity from
  //                            renderVariantRound's wrapper styling)
  // Gates on approvals_enabled — same kill switch as renderActionBand,
  // so flipping the global flag dark hides every CTA across both modes.
  function renderVariantBand(variant: RoundVariant): React.ReactNode {
    if (!activeVersion) return null
    if (!activeVersion.approvals_enabled) return null
    const lockState = getVariantRoundState()
    const isLocked = lockState.kind === 'locked'
    const isChosen = isLocked && lockState.chosenVariantId === variant.id

    // Chosen direction — green Selected pill + headline + optional
    // comment. Uses the same in-stock token as the per-recipient
    // approval pill in PR 12c so the two "this has been confirmed"
    // signals read as the same colour register across the page.
    if (isLocked && isChosen) {
      const actor = lockState.actorName ?? ''
      const dateStr = formatBandDate(lockState.createdAt)
      const headlineText = actor && dateStr
        ? `Chosen by ${actor} on ${dateStr}.`
        : actor
          ? `Chosen by ${actor}.`
          : 'This direction was selected.'
      return (
        <div className="flex flex-col gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 eyebrow self-start"
            style={{
              background: 'rgba(14,155,78,0.14)',
              color: 'var(--c-in-stock)',
              border: '1px solid rgba(14,155,78,0.3)',
              letterSpacing: '0.14em',
            }}
          >
            <svg
              width="9"
              height="9"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2.5 6.5L5 9L9.5 3.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Selected
          </span>
          <span className="font-display font-medium text-ink text-[17px] leading-snug">
            {headlineText}
          </span>
          {lockState.comment && (
            <p className="text-[14px] text-ink-soft leading-[1.55]">
              "{lockState.comment}"
            </p>
          )}
        </div>
      )
    }

    if (isLocked && !isChosen) {
      return (
        <span className="eyebrow text-ink-mute">Not selected</span>
      )
    }

    // Pending — render the CTA. Same guard as renderActionBand:
    // if the action panel is already open for this specific variant
    // card (variant-round path, same version + variantId), suppress
    // the "Choose this direction" button. The panel IS the form, so
    // a second copy of the entry-point button would just read as
    // redundant. The button reappears if the customer cancels.
    if (
      actionPanel &&
      actionPanel.roundVariant?.id === variant.id &&
      actionPanel.versionId === activeVersion.id
    ) {
      return null
    }
    return (
      <ButtonGhost
        block
        onClick={() =>
          openVariantActionPanel(activeVersion.id, {
            id: variant.id,
            display_name: variant.display_name,
          })
        }
      >
        Choose this direction
      </ButtonGhost>
    )
  }

  // Top-level variant-round render. Returns a fragment with two
  // <section>s: pricing card on top, then the variant comparison grid.
  // Replaces the proofs IIFE entirely on variant-round versions; the
  // standalone pricing section below is gated off so it doesn't render
  // a second copy of the price grid. The OptionTabStrip is intentionally
  // never entered on this branch — variant rounds are single-material
  // single-option by design.
  function renderVariantRound(): React.ReactNode {
    if (!activeVersion || !activeVersion.is_variant_round) return null
    const variants = [...(activeVersion.round_variants ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code),
    )
    if (variants.length === 0) return null

    const allImages = versionImages[activeVersion.id] ?? []
    const imagesByVariant = new Map<string, GridImage[]>()
    for (const v of variants) imagesByVariant.set(v.id, [])
    for (const img of allImages) {
      if (img.round_variant_id) {
        imagesByVariant.get(img.round_variant_id)?.push(img)
      }
    }
    for (const list of imagesByVariant.values()) {
      list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    }

    // hasAnyTwoSided: any variant in this round carries back images.
    // When true the grid collapses to a single column on all
    // viewports — a 2-sided card needs the full container width
    // for its Front+Back sub-grid to read at a usable size; cramming
    // it into a half- or third-width slot alongside other variants
    // produces awkward size disparity (1-sided dominates) or
    // crushed images (3 × 33% wide front+back). Stacking gives
    // every card the full width so within-card layouts stay
    // legible. Round with all variants 1-sided still uses the
    // 2 / 3 / 4+ comparison grid.
    const hasAnyTwoSided = variants.some(
      (v) =>
        (imagesByVariant.get(v.id) ?? []).some((img) => img.side === 'back'),
    )
    const gridClass = (() => {
      if (hasAnyTwoSided) return 'grid grid-cols-1 gap-6 sm:gap-8'
      const n = variants.length
      if (n === 2) return 'grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8'
      if (n === 3) return 'grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-8'
      return 'grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8'
    })()

    const lockState = getVariantRoundState()
    const isLocked = lockState.kind === 'locked'

    return (
      <div className="space-y-6">
        {/* V2 contact-sheet treatment for the variant comparison.
            Inline section header ("Choose a direction" + count
            eyebrow + gradient hairline) matches the plates section
            from PR 12c. Each variant renders as a V2 numbered card
            panel: header band with chip + display_name + sides
            indicator, image grid below, per-variant action band on
            a top border at the bottom. */}
        <div>
          <div className="mb-6 flex flex-wrap items-baseline gap-3 sm:gap-4">
            <h2
              id="section-variant-grid-heading"
              className="font-display font-medium tracking-[-0.02em] text-ink leading-tight"
              style={{ fontSize: 'clamp(22px, 3vw, 28px)' }}
            >
              Choose a direction
            </h2>
            <span className="eyebrow">
              {variants.length === 1
                ? '01 direction'
                : `${String(variants.length).padStart(2, '0')} directions · pick one`}
            </span>
            <span
              aria-hidden="true"
              className="hidden sm:block flex-1 h-px"
              style={{ background: 'linear-gradient(to right, var(--c-line), transparent)' }}
            />
          </div>
          {/* Per-direction-pricing pointer (000142, renamed 000144).
              Sits between the header and the variant cards so the
              customer reads it as part of the section's framing.
              Per-direction pricing also fires when directions differ
              in thickness/tier within the same material family, so
              the by-material framing was sometimes inaccurate. */}
          {activeVersion.is_per_direction_pricing && (
            <p className="mb-5 text-[14px] text-ink-soft leading-[1.55]">
              Each direction is priced individually. See your email for details.
            </p>
          )}
          <div className={gridClass}>
            {variants.map((variant, variantIdx) => {
              const variantImages = imagesByVariant.get(variant.id) ?? []
              // Per-variant 2-sided support. Front images include
              // any legacy side=null rows so existing variant
              // rounds without a side stamp render unchanged
              // (000143 backfilled production rows to 'front', so
              // the null-tolerant filter is belt-and-braces for
              // any future drift). Back images render as a second
              // cluster below the front, separated by a small
              // eyebrow label — only when the designer actually
              // uploaded a back side for this variant.
              const frontImages = variantImages.filter(
                (img) => img.side === 'front' || img.side == null,
              )
              const backImages = variantImages.filter(
                (img) => img.side === 'back',
              )
              const hasBack = backImages.length > 0
              // Variant-round navigable set — what the detail view
              // (Phase 2) walks through with its chevrons. Front-
              // then-back across this single variant card; the
              // rest of the page (other variants, the shared
              // section) is not part of the same set, so chevron
              // navigation never escapes the variant the customer
              // clicked into.
              const variantNavigableImages: GridImage[] = hasBack
                ? [...frontImages, ...backImages]
                : frontImages
              const isChosen =
                isLocked && lockState.chosenVariantId === variant.id
              const dimmed = isLocked && !isChosen
              const chipLabel = String(variantIdx + 1).padStart(2, '0')
              const sidesLabel = hasBack
                ? '2 sides'
                : `${frontImages.length} ${frontImages.length === 1 ? 'side' : 'sides'}`
              let colorIdx = 0
              return (
                <article
                  key={variant.id}
                  className="bg-surface border rounded-[14px] overflow-hidden flex flex-col"
                  style={{
                    borderColor: isChosen
                      ? 'rgba(14,155,78,0.4)'
                      : 'var(--c-line)',
                    opacity: dimmed ? 0.55 : 1,
                    transition: 'opacity 200ms ease-out',
                  }}
                >
                  {/* Card header band: numbered chip + display_name
                      + sides indicator. Mirrors the per-recipient
                      card pattern from PR 12c. */}
                  <div className="flex items-center gap-3 px-5 py-4 border-b border-line-soft">
                    <span className="grid place-items-center h-9 w-9 rounded-full bg-canvas border border-line eyebrow text-ink">
                      {chipLabel}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-display font-medium text-ink text-[17px] leading-tight truncate">
                        {variant.display_name}
                      </div>
                    </div>
                    {variantImages.length > 0 && (
                      <span className="inline-flex items-center gap-1.5 eyebrow text-ink-mute">
                        <Eye size={12} aria-hidden="true" />
                        {sidesLabel}
                      </span>
                    )}
                  </div>
                  {/* Image area. Empty state, two-sided sub-grid,
                      or single cluster. */}
                  {variantImages.length === 0 ? (
                    <div className="p-5">
                      <p className="text-[14px] text-ink-mute">
                        No images uploaded for this direction yet.
                      </p>
                    </div>
                  ) : hasBack ? (
                    // Two-sided: Front and Back render side-by-side
                    // at sm+ (≥ 640px) so the variant card stays
                    // roughly the same height as a single-sided card
                    // alongside it. Below sm, fall back to vertical
                    // stacking — side-by-side inside a comparison-
                    // grid column at <640px would crush each image
                    // too small to read. Order is fixed Front-Left,
                    // Back-Right regardless of image sort_order.
                    <div className="grid grid-cols-1 gap-px bg-line-soft sm:grid-cols-2">
                      <div className="bg-surface p-5">
                        <p className="eyebrow text-ink-mute mb-2">Front</p>
                        <div className="space-y-5">
                          {frontImages.map((img) => (
                            <PlateCard
                              key={img.id}
                              image={img}
                              brandColor={BRAND_ORDER[(colorIdx++) % BRAND_ORDER.length]}
                              alt={`${variant.display_name} — proof version ${activeVersion.version_number}`}
                              onClick={() => openDetailView({
                                images: variantNavigableImages,
                                index: variantNavigableImages.findIndex((x) => x.id === img.id),
                                displayLabel: variant.display_name,
                                versionId: activeVersion.id,
                                recipientName: SHARED_APPROVAL_KEY,
                                roundVariant: { id: variant.id, displayName: variant.display_name },
                              })}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="bg-surface p-5">
                        <p className="eyebrow text-ink-mute mb-2">Back</p>
                        <div className="space-y-5">
                          {backImages.map((img) => (
                            <PlateCard
                              key={img.id}
                              image={img}
                              brandColor={BRAND_ORDER[(colorIdx++) % BRAND_ORDER.length]}
                              alt={`${variant.display_name} (back) — proof version ${activeVersion.version_number}`}
                              onClick={() => openDetailView({
                                images: variantNavigableImages,
                                index: variantNavigableImages.findIndex((x) => x.id === img.id),
                                displayLabel: variant.display_name,
                                versionId: activeVersion.id,
                                recipientName: SHARED_APPROVAL_KEY,
                                roundVariant: { id: variant.id, displayName: variant.display_name },
                              })}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    // Single-sided: full-width Front cluster, no eyebrow.
                    <div className="p-5 space-y-5">
                      {frontImages.map((img) => (
                        <PlateCard
                          key={img.id}
                          image={img}
                          brandColor={BRAND_ORDER[(colorIdx++) % BRAND_ORDER.length]}
                          alt={`${variant.display_name} — proof version ${activeVersion.version_number}`}
                          onClick={() => openDetailView({
                            images: variantNavigableImages,
                            index: variantNavigableImages.findIndex((x) => x.id === img.id),
                            displayLabel: variant.display_name,
                            versionId: activeVersion.id,
                            recipientName: SHARED_APPROVAL_KEY,
                            roundVariant: { id: variant.id, displayName: variant.display_name },
                          })}
                        />
                      ))}
                    </div>
                  )}
                  {/* Per-variant action band — sits on a top border
                      so the divider reads as "now act on this
                      direction". Matches the per-recipient action
                      band layout from PR 12c. */}
                  <div className="mt-auto border-t border-line-soft px-5 py-4">
                    {renderVariantBand(variant)}
                  </div>
                </article>
              )
            })}
          </div>
        </div>

        {/* Pricing card. Variant rounds are single-material /
            single-currency so the pricing card is shared across
            every variant card. Sits below the variant grid — the
            customer compares directions first, then sees price
            context once they're ready to act.

            Per-direction-pricing variant rounds (000142, renamed
            000144) hide this card entirely — pricing is per-variant
            and handled out-of-band. The pointer line above the
            variant grid signposts that decision to the customer. */}
        {!activeVersion.is_per_direction_pricing && (
          <PanelShell
            title="Pricing"
            icon={currencyIcon(activeVersion.currency)}
            accent={tokens.brand}
            action={
              !activeVersion.custom_quote ? (
                <span className="eyebrow text-ink-mute">
                  {activeVersion.currency}
                  {activeVersion.currency === 'GBP' ? ' · VAT included' : ''}
                </span>
              ) : null
            }
          >
            {activeVersion.custom_quote ? (
              <p className="text-[14px] text-ink-soft leading-[1.55] py-2">
                This proof requires a custom quote. We'll be in touch separately with pricing.
              </p>
            ) : (
              <PaperPricingTable
                snapshot={livePricingSnapshot}
                // Non-null assertion: this block is inside the
                // !is_per_direction_pricing gate at the parent
                // conditional, where activeVersion.currency is
                // guaranteed non-null per migration 000142.
                currency={activeVersion.currency!}
                displayQuantities={activeVersion.display_quantities}
                quoteMinQuantity={activeVersion.quote_min_quantity}
                quoteMaxQuantity={activeVersion.quote_max_quantity}
                quantitySurcharges={{}}
                // Variant rounds are guaranteed non-personalised by
                // the DB CHECK constraint in migration 000173, so a
                // hardcoded null here is the right answer rather than
                // threading the active currency's live pricing.
                personalisationPricing={null}
              />
            )}
            {!activeVersion.custom_quote && activeVersion.shipping_note && (
              <div className="mt-4 pt-4 border-t border-line-soft">
                <p className="eyebrow text-ink-mute mb-1">Shipping</p>
                <p className="text-[14px] text-ink-soft leading-[1.55]">
                  {activeVersion.shipping_note}
                </p>
              </div>
            )}
          </PanelShell>
        )}
      </div>
    )
  }

  // Derived: options for the currently-viewed version.
  const versionOptions = activeVersion?.material_options ?? []
  const showOptionSwitcher = versionOptions.length >= 2
  // Validate activeOptionCode against the current version's option set.
  // The useEffect that resets activeOptionCode on version change runs
  // after render, so during the transition frame it can hold a stale
  // code that doesn't exist on the new version. Without this guard the
  // image filter below would match nothing and the grid would render
  // empty for one frame. Falling through to versionOptions[0] keeps the
  // pricing/option/images consistent until the effect catches up.
  const effectiveOptionCode =
    activeOptionCode && versionOptions.includes(activeOptionCode)
      ? activeOptionCode
      : versionOptions[0] ?? null
  const activeOption = effectiveOptionCode && activeVersion
    ? materialOptions.find(o => o.material_id === activeVersion.material_id && o.code === effectiveOptionCode) ?? null
    : null

  // Filter images for the active option (if this version is in option mode).
  // When the version has option tabs (versionOptions.length > 0) every image
  // is expected to carry a non-null material_option matching one of the
  // selected options — the save paths in NewVersionPage / EditVersionPage
  // stamp the active tab onto every fresh upload. A null material_option in
  // that context is an orphan, typically a variant-round carry-forward that
  // arrived on a non-variant version (variant-round images have
  // material_option = null by design, since variant rounds don't use option
  // tabs). Treating those nulls as "shared across all tabs" would surface
  // them alongside the real per-tab uploads, which is what we used to do
  // and exactly the bug fixed here. The non-option-mode branch keeps
  // returning every image untouched so legacy proofs that never used tabs
  // continue to render their null-option images.
  const allVersionImages = activeVersion ? (versionImages[activeVersion.id] ?? []) : []
  const displayImages = versionOptions.length > 0 && effectiveOptionCode
    ? allVersionImages.filter(img => img.material_option === effectiveOptionCode)
    : allVersionImages

  // Live pricing snapshot for the active version (Phase 2). Replaces
  // the proof_versions.pricing_snapshot read with a derivation from
  // tierRows + variantRows scoped to the active version's material
  // and currency. Same shape as the legacy snapshot, so
  // InkPricingTable / QuantityLookup render code is unchanged.
  // Variants with zero priced tiers in the active currency are
  // dropped from the grid; missing tier cells inside an otherwise-
  // priced variant are handled at render time as "—".
  const livePricingSnapshot: PricingSnapshot = activeVersion
    ? {
        variants: variantRows
          .filter(v => v.material_id === activeVersion.material_id)
          // Restrict to the designer's chosen subset when curated
          // (migration 000118). Null falls through to the post-
          // Phase-2 "show every active variant" default — the safe
          // shape for legacy rows that pre-date the column.
          .filter(v =>
            activeVersion.displayed_variant_ids == null ||
            activeVersion.displayed_variant_ids.includes(v.id)
          )
          .map(v => {
            const prices: Record<string, number> = {}
            for (const t of tierRows) {
              if (t.material_variant_id === v.id && t.currency === activeVersion.currency) {
                prices[String(t.quantity)] = t.total_price
              }
            }
            return {
              variant_id: v.id,
              display: v.variant_type === 'default' ? 'Default' : v.display_name,
              prices,
            }
          })
          .filter(v => Object.keys(v.prices).length > 0),
      }
    : { variants: [] }

  // Locked-variant spec surface. When the version's pricing grid has
  // exactly one variant AND that variant_type is 'finish', the
  // customer has no other surface signalling which finish they're
  // being quoted for — the matrix collapses to a single "Price"
  // column with no variant name in the header (PricingDisplay's th
  // reads "Price" for the single-variant shape). Surface it on the
  // Specification sheet so the customer sees "Finish: With Foiling"
  // alongside Material / Sides / etc.
  //
  // Standard Paper is the only material with variant_type='finish'
  // today (Standard / With UV Spot / With Foiling — three
  // effectively-different products, picked at order time, not
  // customer-switchable).
  //
  // 'thickness' stays matrix-only — the multi-column grid IS the
  // surface. 'ink_count' is conveyed by the Ink colours row's count
  // of listed Pantone codes (adding "Inks: N" would duplicate).
  // 'default' carries no dimension worth surfacing.
  const lockedFinishVariant: PublicMaterialVariant | null = (() => {
    if (!activeVersion) return null
    if (livePricingSnapshot.variants.length !== 1) return null
    const v = variantRows.find(
      (r) => r.id === livePricingSnapshot.variants[0].variant_id,
    )
    if (!v) return null
    return v.variant_type === 'finish' ? v : null
  })()

  // Per-quantity surcharge map for the active option, baked into every
  // pricing cell. Empty for base options or materials with no surcharges
  // (e.g. wood species).
  const quantitySurcharges: Record<number, number> = {}
  if (activeOption && activeVersion) {
    optionSurcharges
      .filter(s => s.material_option_id === activeOption.id && s.currency === activeVersion.currency)
      .forEach(s => { quantitySurcharges[s.quantity] = s.surcharge })
  }

  // Personalisation (migration 000172). Three gates:
  //   * activeVersion.has_personalisation === true
  //   * not a custom-quote version (no grid to layer on)
  //   * not a per-direction-pricing variant round (also no grid)
  // The pricing object is keyed by currency; only currencies referenced
  // by the proof's versions are present. activePricing falls back to
  // null when the gate's tripped or the currency lookup misses (e.g.
  // an admin removed the currency row — defensive).
  const activePersonalisationPricing: PersonalisationPricing | null =
    activeVersion?.has_personalisation
    && !activeVersion.custom_quote
    && !activeVersion.is_per_direction_pricing
    && activeVersion.currency
      ? (personalisationPricing[activeVersion.currency] ?? null)
      : null
  const personalisationBreakevenQty = activePersonalisationPricing
    ? personalisationBreakeven(activePersonalisationPricing)
    : null

  // Smallest surcharge a customer would actually see in the displayed
  // pricing grid for a given option, or null if this option carries no
  // visible surcharge (base/Natural, wood, or surcharge schedule that
  // doesn't intersect display_quantities).
  //
  // Scoped to activeVersion.display_quantities so the "From +£X" tab
  // pill matches the collapsed grid the customer reads. The metal
  // schedule, for example, has a qty 25 row (000145) with the
  // smallest absolute surcharge in the table, but qty 25 isn't in
  // any metal material's display_quantities — the customer would see
  // "+£20" on the tab and "+£30 at qty 50" in the grid, which read as
  // a contradiction. Filtering here makes the two consistent.
  //
  // Falls back to "smallest across all tiers" when display_quantities
  // is null (uncurated material — customer-side falls back to the
  // first 10 ascending snapshot tiers, which we can't precisely
  // reproduce here without re-deriving the snapshot, but those
  // materials are rare enough that the legacy behaviour is fine).
  function optionFromPrice(code: string): number | null {
    if (!activeVersion) return null
    const o = materialOptions.find(x => x.material_id === activeVersion.material_id && x.code === code)
    if (!o) return null
    const displayedQuantities = activeVersion.display_quantities
    const matching = optionSurcharges.filter(s =>
      s.material_option_id === o.id
      && s.currency === activeVersion.currency
      && s.surcharge > 0
      && (displayedQuantities == null || displayedQuantities.includes(s.quantity)),
    )
    if (matching.length === 0) return null
    return Math.min(...matching.map(s => s.surcharge))
  }

  // Does this material carry any surcharges at all? Drives whether we show
  // the "Prices shown for X" subtitle — for wood (no surcharges) the grid
  // is identical across species so the subtitle would be noise.
  const materialHasSurcharges = activeVersion
    ? versionOptions.some(code => optionFromPrice(code) !== null)
    : false

  // Display label for the option dimension — singular form, used in copy
  // like "Prices shown for Brushed finish" and the spec summary. No plural
  // form is needed on the customer page (no section heading for options).
  const optionLabelSingular = activeVersion?.option_label ?? 'Finish'

  // Admin-editable metal Thickness card copy (migration 000199). Falls
  // back to the shipped defaults while publicSettings is still loading
  // or if the column / RPC is unavailable, so the panel never blanks.
  const thicknessNotes = publicSettings?.metal_thickness_notes ?? DEFAULT_METAL_THICKNESS_NOTES

  // Short customer-facing reference — the proof's Help Scout
  // conversation id, prefixed with PL · for the editorial feel.
  // Exposed on public_proofs by migration 000089. Hidden
  // helpscout_conversation_id was dropped from the customer-side
  // payload by migration 000162 (field hygiene — anon shouldn't
  // need it to render the page). The masthead/footer "PL · {id}"
  // badge now always collapses to null; DocketBar and the footer
  // already gate on (proofRef || activeVersion) so nothing else
  // changes. Reserved as a typed null to keep DocketBar's existing
  // string | null prop wiring intact.
  const proofRef: string | null = null

  // Hero approval strip — green when the version is fully
  // approved + the designer has flipped proof.status; blue for
  // the partial-approval middle state; silent otherwise.
  type HeroApprovalStrip =
    | { kind: 'approved'; dateLabel: string | null }
    | { kind: 'partial' }
    | null
  const heroApprovalStrip: HeroApprovalStrip = viewingApprovedVersion
    ? {
        kind: 'approved',
        dateLabel: proof.approved_at
          ? new Date(proof.approved_at).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })
          : null,
      }
    : showPartialApprovalBanner
      ? { kind: 'partial' }
      : null

  // Hero facts row copy. "Revision" line reads v{n} · date; date
  // formatted the same way as the approval strip for consistency.
  const heroRevisionDate = activeVersion
    ? new Date(activeVersion.created_at).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null

  // While either action panel is open (approve or request_changes),
  // push the page content away from it so nothing is hidden:
  // right-side gutter on desktop (panel width = 400px), bottom
  // gutter on mobile (sheet height = 50vh — the bottom-padding lets
  // the page scroll its full content into the visible area above
  // the sheet).
  const actionPanelOpen = actionPanel != null

  // Header meta: anti-enumeration design (public_get_customer_proof
  // doesn't expose the customer's email or proof.sent_at), so the
  // "Sent X to Y" line from the prototype becomes a "Last updated
  // {date}" carrying the active version's created_at — the most
  // recent customer-visible date on the proof.
  const lastUpdated = activeVersion
    ? new Date(activeVersion.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : null

  return (
    <div
      className={[
        'antialiased bg-canvas text-ink font-body',
        actionPanelOpen ? 'pb-[50vh] sm:pb-0 sm:pr-[400px]' : '',
      ].join(' ')}
    >

      {/* Sticky public header. PlasmaWordmark left, "Last updated"
          eyebrow right. Replaces the Direction-B dark-ink DocketBar +
          BrandRule masthead. Cream canvas, hairline bottom border.
          Container width + padding match the dark masthead and <main>
          below (max-w-1280 / px-6 sm:px-7) so the wordmark's left edge
          lines up with the cards rather than sitting inboard. */}
      <header
        className="sticky top-0 z-[5] bg-ink text-on-ink"
      >
        <div className="mx-auto max-w-[1280px] flex items-center gap-4 px-6 sm:px-7 py-3.5">
          {/* Full-colour Plasma logo lockup on the ink banner — the
              only branding the customer sees. White-text variant
              designed for dark backgrounds; steps up a touch at sm+
              where the masthead has more room. */}
          <img
            src="/logo-dark.png"
            alt="PlasmaDesign Proofs"
            className="h-7 sm:h-9 w-auto"
          />
          <div className="ml-auto flex items-center gap-4">
            {lastUpdated && (
              <span
                className="eyebrow hidden sm:inline"
                style={{ color: 'rgba(255,255,255,0.65)' }}
              >
                Last updated {lastUpdated}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* V2 dark masthead strip — newspaper-rule horizontal band
          beneath the cream sticky header. Left cluster: company
          name (when present) + divider + VERSION {nn} · CURRENT /
          HISTORY · status (mapped from proof.status). Right cluster:
          {nn} NAMES · {n} SIDES · {variant} {MATERIAL} stats.
          All mono uppercase tracked. Hides until activeVersion
          resolves so we don't flash placeholder copy. */}
      {activeVersion && (() => {
        const company = proof.company?.trim() ?? ''
        const versionLabel = `Version ${String(activeVersion.version_number).padStart(2, '0')}`
        const currencyLabel = activeVersion.is_current ? 'Current' : 'History'
        // proof.status === 'abandoned' is handled by the AbandonedScreen
        // early-return above, so it's unreachable here.
        const statusLabel = proof.status === 'approved'
          ? 'Approved'
          : proof.status === 'dormant'
            ? 'Dormant'
            : 'In review'
        const namesCount = activeVersion.names.length
        const namesLabel = namesCount > 0
          ? `${String(namesCount).padStart(2, '0')} ${namesCount === 1 ? 'Name' : 'Names'}`
          : null
        const hasBack = (versionImages[activeVersion.id] ?? []).some((img) => img.side === 'back')
        const sidesLabel = `${hasBack ? '02' : '01'} ${hasBack ? 'Sides' : 'Side'}`
        // Variant label — when exactly one variant is priced on this
        // version (the common case for thickness / finish / default
        // materials), pull its display string from the snapshot.
        // Multi-variant materials (e.g. ink-count grids) collapse to
        // null and the stats line reads with just material name.
        const variantLabel =
          livePricingSnapshot.variants.length === 1
            ? livePricingSnapshot.variants[0].display
            : null
        const materialLabel = activeVersion.material_display
        const statsPieces = [namesLabel, sidesLabel,
          [variantLabel, materialLabel].filter(Boolean).join(' '),
        ].filter(Boolean) as string[]
        return (
          <div className="bg-ink text-on-ink">
            <div className="mx-auto max-w-[1280px] flex flex-wrap items-center gap-3 sm:gap-4 px-6 sm:px-7 py-3.5">
              {company && (
                <>
                  <span className="eyebrow" style={{ color: 'rgba(255,255,255,0.55)' }}>
                    {company}
                  </span>
                  <span aria-hidden="true" className="hidden sm:inline-block w-px h-3 bg-white/25" />
                </>
              )}
              <span className="eyebrow" style={{ color: '#ffffff' }}>
                {[versionLabel, currencyLabel, statusLabel].join(' · ')}
              </span>
              {statsPieces.length > 0 && (
                <span className="eyebrow sm:ml-auto" style={{ color: 'rgba(255,255,255,0.55)' }}>
                  {statsPieces.join(' · ')}
                </span>
              )}
            </div>
          </div>
        )
      })()}

      {/* V2 customer-page main — 2-column grid on lg+: a sticky
          left rail carrying the customer card, Specs, and Pricing;
          a right column carrying the version pills, the contact-
          sheet recipient panels, material-explanation panels, and
          the About-this-proof disclaimer. Stacks to one column
          below lg. Gated on activeVersion so the page doesn't
          half-render while data loads. */}
      {activeVersion && (
        /* Layout: single flex column on narrow screens, two-column
           grid on lg+. On mobile both column wrappers below are
           `display: contents` so every card becomes a direct flex
           child of <main> and can be re-sequenced with order-* into
           the customer-preferred reading order (Proof for -> The set ->
           QR -> Spec -> Thickness/Construction -> Pricing -> Material
           notes -> About this proof). Each card resets to lg:order-none
           so the desktop two-column layout is untouched. */
        <main className="mx-auto max-w-[1280px] px-6 sm:px-7 py-8 flex flex-col gap-6 lg:grid lg:grid-cols-[360px_1fr] lg:gap-8 lg:items-start">

          {/* Left rail — sticky on lg+, scrolls with viewport on
              smaller screens. top-[120px] accounts for sticky
              header (~60px) + masthead band (~52px) + small gutter. */}
          <aside className="contents lg:flex lg:flex-col lg:gap-4 lg:sticky lg:top-[120px]">

            {/* Approval banner — shows when the proof has been
                fully signed off or carries forward-approved slots
                from earlier versions. Lifted into the left rail in
                V2 (was a full-width top banner in V1) so it sits
                next to the customer card it qualifies. */}
            {heroApprovalStrip && (() => {
              const total = versionImages[activeVersion.id]?.length ?? 0
              const isApprovedKind = heroApprovalStrip.kind === 'approved'
              const pillColour: PillColour = isApprovedKind ? 'in-stock' : 'allocated'
              const label = isApprovedKind ? 'Approved' : 'Partially approved'
              const detailVisible = isApprovedKind
                ? [
                    heroApprovalStrip.dateLabel ? `Signed off ${heroApprovalStrip.dateLabel}` : 'Signed off',
                    total > 0 ? `${total} / ${total} proof${total === 1 ? '' : 's'}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Some proofs already signed off, others awaiting review'
              const detailAria = isApprovedKind
                ? [
                    heroApprovalStrip.dateLabel ? `Signed off ${heroApprovalStrip.dateLabel}` : 'Signed off',
                    total > 0 ? `${total} of ${total} proof${total === 1 ? '' : 's'}` : null,
                  ]
                    .filter(Boolean)
                    .join(', ')
                : 'Some proofs already signed off, others awaiting review'
              return (
                <div className="order-1 lg:order-none flex flex-wrap items-center gap-3 rounded-[10px] bg-surface border border-line px-4 py-3">
                  <Pill colour={pillColour}>{label}</Pill>
                  <span className="text-[13px] text-ink-soft" aria-label={detailAria}>
                    {detailVisible}
                  </span>
                </div>
              )
            })()}

            {/* Customer card with brand StatusRule on its left edge.
                Carries "Proof for" eyebrow + display customer name +
                optional company subline + What-changed-in-vN callout.
                Replaces the V1 hero strip that used to sit above the
                page main. */}
            <div className="order-2 lg:order-none relative bg-surface border border-line rounded-[14px] overflow-hidden px-6 py-6">
              <StatusRule colour={tokens.brand} />
              <div className="pl-2">
                {(() => {
                  const trimmedCompany = proof.company?.trim() ?? ''
                  const trimmedName = proof.customer_name?.trim() ?? ''
                  const companyProminent = trimmedCompany.length > 0
                  const primary = companyProminent ? proof.company! : proof.customer_name
                  const subline = companyProminent && trimmedName.length > 0
                    ? proof.customer_name
                    : trimmedCompany || null
                  return (
                    <>
                      <span className="eyebrow">Proof for</span>
                      <h1
                        className="mt-2 font-display font-medium tracking-[-0.02em] text-ink leading-[1.05] break-words"
                        style={{ fontSize: 'clamp(26px, 3vw, 32px)' }}
                      >
                        {primary}
                      </h1>
                      {subline && (
                        <p className="mt-1 text-[14px] text-ink-mute">{subline}</p>
                      )}
                    </>
                  )
                })()}
                {activeVersion.change_notes && (
                  <div className="mt-4 rounded-[10px] bg-canvas border border-line-soft p-4">
                    <span className="eyebrow text-brand block mb-1.5">
                      What changed in v{activeVersion.version_number}
                    </span>
                    <p className="text-[13px] leading-[1.5] text-ink-soft whitespace-pre-line m-0">
                      {activeVersion.change_notes}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Specification PanelShell — preserved verbatim from PR 7
                except the outer <section className="bg-canvas"> and
                max-w-1180 wrappers (the aside is the container now).
                Renders below the customer card. Per-direction-pricing
                versions skip the panel entirely (migration 000144). */}
            {!activeVersion.is_per_direction_pricing && (
              <PanelShell
                eyebrow="As proofed"
                title="Specification"
                icon={Layers}
                accent={tokens.brand}
                className="order-6 lg:order-none"
              >
                <dl
                  aria-labelledby="section-specification-heading"
                  className="divide-y divide-line-soft"
                >
                  <h2 id="section-specification-heading" className="sr-only">Specification</h2>
                  <SpecRow label="Material" value={activeVersion.material_display} />
                  {/* Sides — derived from the image set. Two-sided
                      iff any image on the active version carries
                      side='back'; otherwise front only.
                      Pre-migration-000085 data with null sides reads
                      as front only. */}
                  <SpecRow
                    label="Sides"
                    value={
                      (versionImages[activeVersion.id] ?? []).some((img) => img.side === 'back')
                        ? 'Front and back'
                        : 'Front only'
                    }
                  />
                  {lockedFinishVariant && (
                    <SpecRow label="Finish" value={lockedFinishVariant.display_name} />
                  )}
                  {activeOption && (
                    <SpecRow label={optionLabelSingular} value={activeOption.display_name} />
                  )}
                  {activeVersion.ink_names.length > 0 && (
                    <SpecRow label="Ink colours" value={activeVersion.ink_names.join('\n')} />
                  )}
                  {activeVersion.names.length > 0 && !(activeVersion.has_personalisation && activePersonalisationPricing) && (
                    <SpecRow label="Names on card" value={activeVersion.names.join('\n')} />
                  )}
                  {activeVersion.has_personalisation && activePersonalisationPricing && (
                    <SpecRow label="Personalisation" value="Unique data per card" />
                  )}
                  <SpecRow
                    label="Revision"
                    value={`v${activeVersion.version_number}${heroRevisionDate ? ` · ${heroRevisionDate}` : ''}`}
                  />
                </dl>
              </PanelShell>
            )}

            {/* Pricing PanelShell + split-name / shipping callouts.
                Renders here in the left rail when the table is
                narrow enough to fit (up to 3 columns total = qty +
                2 variant prices, i.e. variants.length <= 2). Wider
                tables (4+ columns) overflow the 360px rail and
                render in the right column via the same JSX block
                below. Variant-round versions skip the panel
                entirely. */}
            {!activeVersion.is_variant_round && livePricingSnapshot.variants.length <= 2 && (
              <>
                <PanelShell
                  eyebrow={
                    !activeVersion.custom_quote && activeOption && versionOptions.length > 0 && materialHasSurcharges
                      ? `Prices shown for ${activeOption.display_name} ${optionLabelSingular.toLowerCase()}`
                      : 'Inclusive of VAT'
                  }
                  title="Pricing"
                  icon={currencyIcon(activeVersion.currency)}
                  accent={tokens.brand}
                  className="order-8 lg:order-none"
                  action={
                    !activeVersion.custom_quote ? (
                      <span className="num text-[12px] font-medium text-ink uppercase tracking-[0.18em]">
                        {activeVersion.currency}
                        {activeVersion.currency === 'GBP' ? ' · VAT included' : ''}
                      </span>
                    ) : undefined
                  }
                >
                  <h2 id="section-pricing-heading" className="sr-only">Pricing</h2>
                  {activeVersion.custom_quote ? (
                    <div className="py-6 text-center">
                      <p className="mx-auto max-w-md font-display text-[18px] leading-snug text-ink-soft">
                        This proof requires a custom quote. We'll be in touch separately with pricing.
                      </p>
                    </div>
                  ) : (
                    <>
                      <PaperPricingTable
                        snapshot={livePricingSnapshot}
                        currency={activeVersion.currency!}
                        displayQuantities={activeVersion.display_quantities}
                        quoteMinQuantity={activeVersion.quote_min_quantity}
                        quoteMaxQuantity={activeVersion.quote_max_quantity}
                        quantitySurcharges={quantitySurcharges}
                        personalisationPricing={activePersonalisationPricing}
                      />
                      {personalisationBreakevenQty != null && (
                        <p className="mt-3 text-[13px] text-ink-mute leading-relaxed">
                          A minimum personalisation charge applies below {personalisationBreakevenQty.toLocaleString()} cards.
                        </p>
                      )}
                      {/* Shipping note as a quiet footer line inside
                          the Pricing PanelShell — mirrors the V2
                          prototype's "Prices exclude shipping" treatment.
                          Avoids floating a standalone shipping card
                          below the panel when there's no split-name
                          tooling alongside it to pair with. */}
                      {activeVersion.shipping_note && (
                        <p className="mt-3 text-[12px] text-ink-mute whitespace-pre-line text-right border-t border-line-soft pt-3">
                          {activeVersion.shipping_note}
                        </p>
                      )}
                    </>
                  )}
                </PanelShell>

                {/* Split-name tooling callout — full-width card below
                    the Pricing PanelShell when applicable. Contains a
                    multi-line calc + explanation, so it earns its own
                    card chrome (unlike shipping, which collapses to
                    an inline footer line above). */}
                {!activeVersion.custom_quote &&
                  activeVersion.names.length >= 2 &&
                  activeVersion.split_name_surcharge_snapshot != null &&
                  activeVersion.split_name_surcharge_snapshot > 0 && (
                    <div className="order-8 lg:order-none rounded-[10px] bg-surface border border-line p-4">
                      <span className="eyebrow text-brand">Split-name tooling</span>
                      <p className="mt-2 text-[15px] leading-snug text-ink font-medium">
                        Add{' '}
                        <span className="num font-medium">
                          {formatPrice(
                            (activeVersion.names.length - 1) *
                              activeVersion.split_name_surcharge_snapshot,
                            activeVersion.currency!,
                          )}
                        </span>{' '}
                        to the prices above
                      </p>
                      <p className="mt-1.5 text-[12px] text-ink-mute">
                        {activeVersion.names.length - 1} extra{' '}
                        {activeVersion.names.length - 1 === 1 ? 'name' : 'names'} ×{' '}
                        {formatPrice(
                          activeVersion.split_name_surcharge_snapshot,
                          activeVersion.currency!,
                        )}{' '}
                        tooling
                      </p>
                    </div>
                  )}
              </>
            )}

            {/* About this proof — quiet disclaimer card. Lives in the
                left rail as the final card so it closes the spec
                column. Always rendered (not gated), so it sits below
                whatever Specs/Pricing the version carries. */}
            <div className="order-10 lg:order-none rounded-[10px] bg-surface border border-line-soft p-5 flex items-start gap-3">
              <Info size={18} aria-hidden="true" className="text-brand mt-0.5 shrink-0" />
              <div className="min-w-0">
                <span className="eyebrow block mb-1.5">About this proof</span>
                <p className="whitespace-pre-line text-[13px] leading-[1.6] text-ink-soft m-0">
                  {publicSettings?.about_proof_copy ?? ABOUT_PROOF_COPY_DEFAULT}
                </p>
              </div>
            </div>

          </aside>

          {/* Right column — contact sheet. `contents` on mobile (see
              <main> note) so its cards re-sequence with the left rail's;
              real two-column flex container on lg+. */}
          <div className="contents lg:flex lg:flex-col lg:gap-7 lg:min-w-0">

            {/* Version pill row — chronological, click switches the
                active version via setActiveVersion. When there are many
                revisions the older ones collapse behind a "+N earlier"
                chip so the row stays compact; the current (latest)
                version carries a coral accent + dot so it's always the
                identifiable anchor, kept distinct from the ink "you're
                viewing this" fill. */}
            {versions.length > 1 && (() => {
              const RECENT = 5
              const tooMany = versions.length > RECENT + 1
              const activeIdx = versions.findIndex((v) => v.id === activeVersion.id)
              const recentStart = Math.max(0, versions.length - RECENT)
              const activeInRecent = activeIdx >= recentStart
              // Collapse only when there are many AND the customer is
              // viewing one of the recent versions — never hide the one
              // they're looking at. Manual expand overrides.
              const collapsed = tooMany && !showAllVersions && activeInRecent
              const visible = collapsed ? versions.slice(recentStart) : versions
              const hiddenCount = collapsed ? recentStart : 0
              const toggleCls =
                'inline-flex items-center h-8 px-3 rounded-full text-[12px] border border-line bg-surface text-ink-mute hover:bg-canvas hover:text-ink transition-colors'
              return (
                <div className="order-3 lg:order-none flex flex-wrap items-center gap-2.5">
                  <span className="eyebrow mr-1.5">History</span>
                  {collapsed && (
                    <button
                      type="button"
                      onClick={() => setShowAllVersions(true)}
                      className={toggleCls}
                      aria-label={`Show ${hiddenCount} earlier versions`}
                    >
                      +{hiddenCount} earlier
                    </button>
                  )}
                  {visible.map((v) => {
                    const active = v.id === activeVersion.id
                    const isCurrent = v.is_current
                    const dateLabel = new Date(v.created_at).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                    })
                    const cls = [
                      'inline-flex items-center gap-2 h-8 px-3 rounded-full text-[13px] transition-colors border',
                      active
                        ? 'bg-ink text-on-ink border-ink'
                        : isCurrent
                          ? '' // coral accent applied via inline style below
                          : 'bg-surface text-ink-soft border-line hover:bg-canvas',
                    ].join(' ')
                    // Current-but-not-viewed: coral-tinted fill, coral
                    // border, dark-coral text — the anchor of the row.
                    const style =
                      !active && isCurrent
                        ? {
                            backgroundColor: 'var(--c-brand-50)',
                            color: 'var(--c-brand-900)',
                            borderColor: 'var(--c-brand-300)',
                          }
                        : undefined
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setActiveVersion(v)}
                        aria-pressed={active}
                        aria-label={`Version ${v.version_number}, ${dateLabel}${isCurrent ? ' (current)' : ''}`}
                        className={cls}
                        style={style}
                      >
                        <span className="font-mono font-medium">v{v.version_number}</span>
                        <span
                          className={active ? 'text-on-ink/70' : isCurrent ? '' : 'text-ink-dim'}
                          aria-hidden="true"
                        >
                          ·
                        </span>
                        <span className="text-[12px]">{dateLabel}</span>
                        {isCurrent && (
                          <span
                            aria-hidden="true"
                            className="ml-1 text-[10px] font-semibold uppercase tracking-[0.12em]"
                            // Coral on the ink "viewing" pill (brand-300
                            // reads on black); inherits the pill's
                            // dark-coral text otherwise.
                            style={active ? { color: 'var(--c-brand-300)' } : undefined}
                          >
                            Current
                          </span>
                        )}
                      </button>
                    )
                  })}
                  {tooMany && !collapsed && activeInRecent && (
                    <button
                      type="button"
                      onClick={() => setShowAllVersions(false)}
                      className={toggleCls}
                    >
                      Show fewer
                    </button>
                  )}
                </div>
              )
            })()}

          {/* ───── Plates ─────
              Near-white section. Groups come from buildImageGroups
              (shared first, then named); each named group gets a
              section heading + approval pill (when an approved
              approval row exists on the current version) and a
              grid of numbered plates. Plate numbers pick up one
              of the four brand colours in rotation — a quiet
              echo of the logomark across the grid. */}
          {(() => {
            // Variant-round branch (build-plan step 4). Routes ahead
            // of every standard derivation below so the existing code
            // path is byte-identical for every non-variant version.
            // is_variant_round is false on every row in production
            // today (000138 default); the branch is dead code until
            // step 5 produces a real variant-round version.
            if (activeVersion?.is_variant_round) {
              return renderVariantRound()
            }
            const groups = buildImageGroups(displayImages)
            const sharedGroup = groups.find((g) => g.kind === 'shared') ?? null
            const namedGroups = groups.filter((g) => g.kind === 'named')
            if (!sharedGroup && namedGroups.length === 0) return null

            // Virtual-pair shared images into named groups for
            // sides those groups lack. Drops the standalone
            // shared section entirely when every shared image
            // got consumed — avoids showing the same image
            // twice. Partial consumption (shared has B, named
            // consumed F but not B) leaves the unused shared
            // images on the standalone section so no image is
            // ever dropped from the page. See the helper for
            // the colour-rotation note and the "reference
            // equality" semantics on the clone.
            const { augmentedNamedGroups, unconsumedSharedImages } =
              augmentNamedGroupsWithSharedPairs(sharedGroup, namedGroups)
            const sharedStandaloneImages = unconsumedSharedImages
            const renderSharedStandalone = sharedStandaloneImages.length > 0
            const sharedStandaloneGroup: ImageGroup | null =
              renderSharedStandalone && sharedGroup
                ? { ...sharedGroup, images: sharedStandaloneImages }
                : null

            // Heading for the standalone Shared section. Two layers:
            //
            // 1. Sides label — derived from the sides actually present
            //    in the standalone Shared group: 'Front and back' /
            //    'Front' / 'Back', or null when only side=null images
            //    exist (legacy pre-migration-000071 data, unobserved
            //    in production today).
            //
            // 2. "Shared · " prefix — added only when activeVersion.names
            //    is non-empty. The prefix earns its place by contrasting
            //    against the per-name card sections rendered elsewhere
            //    on the page; on membership-card style proofs (no names)
            //    the prefix is noise and the heading just describes the
            //    card faces directly.
            //
            // Schema (000071) constrains side to ('front' | 'back'), so
            // no overlay branch is needed; if side ever widens, schema
            // and render path are coordinated changes that include
            // updating this derivation.
            const sharedHeading: string = (() => {
              if (!sharedStandaloneGroup) return ''
              const sides = new Set(sharedStandaloneGroup.images.map((i) => i.side))
              const hasFront = sides.has('front')
              const hasBack = sides.has('back')
              const label =
                hasFront && hasBack
                  ? 'Front and back'
                  : hasFront
                    ? 'Front'
                    : hasBack
                      ? 'Back'
                      : null
              const hasNames = activeVersion.names.length > 0
              if (hasNames) {
                return label ? `Shared · ${label}` : 'Shared'
              }
              return label ?? 'Card design'
            })()

            // Proof-count subtext reads the project's true
            // image count — count each shared image once, not
            // per injected instance. Keeps "N proofs · M
            // recipients" accurate when a single shared front
            // renders inside two named pairs.
            // plateCount (was used to drive the "(NN)" count chip
            // in the V1 section header) dropped in PR 12c —
            // the V2 "The set" header uses names · sides framing
            // instead of unique-proofs count.
            // Recipient count derives from activeVersion.names —
            // the canonical list of who the proof is for — rather
            // than namedGroups (which is filtered by the active
            // option tab). Without this, switching to an option
            // tab whose images don't include any per-name plates
            // dropped the "· N people" subtitle even though the
            // spec sheet below still listed the names. The shared-
            // only fallback (no per-name images at all) keeps the
            // "1 / Shared" copy.
            const recipientCount = activeVersion.names.length > 0
              ? activeVersion.names.length
              : (sharedGroup ? 1 : 0)

            // Per-group pairing rule — front + back in the same
            // group render side-by-side at md+. Inherited from
            // the da895cf pairing shipment; unchanged here.
            // After augmentation, named groups that received a
            // shared injection now satisfy this predicate and
            // flip to the paired layout automatically.
            const groupIsPair = (g: ImageGroup) =>
              g.images.some((i) => i.side === 'front') &&
              g.images.some((i) => i.side === 'back')

            return (
              <section
                aria-labelledby="section-proofs-heading"
                className="order-4 lg:order-none bg-canvas text-ink"
              >
                {/* V2 section header: "The set" h2 + count eyebrow
                    + gradient hairline. Right slot still hosts the
                    MaterialOptionTabs strip when the version has 2+
                    material options. Replaces the V1 "Proofs (NN) /
                    N unique proofs · N people" treatment. Count copy
                    moves to the eyebrow slot and trades the "N people"
                    framing for "front + back" / sides description,
                    closer to the V2 prototype's contact-sheet brief.
                    Membership cards still skip the count entirely. */}
                <div className="mb-6 flex flex-wrap items-baseline gap-3 sm:gap-4">
                  <h2
                    id="section-proofs-heading"
                    className="font-display font-medium tracking-[-0.02em] text-ink leading-tight"
                    style={{ fontSize: 'clamp(22px, 3vw, 28px)' }}
                  >
                    The set
                  </h2>
                  {activeVersion.card_type !== 'membership' && (() => {
                    const namesLabel = recipientCount === 1
                      ? sharedGroup && namedGroups.length === 0
                        ? 'Shared'
                        : '1 name'
                      : `${String(recipientCount).padStart(2, '0')} names`
                    const sidesLabel = augmentedNamedGroups.some(groupIsPair) ||
                      (sharedStandaloneGroup && groupIsPair(sharedStandaloneGroup))
                      ? 'front + back'
                      : 'front only'
                    return (
                      <span className="eyebrow">{namesLabel} · {sidesLabel}</span>
                    )
                  })()}
                  <span
                    aria-hidden="true"
                    className="hidden sm:block flex-1 h-px"
                    style={{ background: 'linear-gradient(to right, var(--c-line), transparent)' }}
                  />
                  {showOptionSwitcher && (
                    <div className="basis-full sm:basis-auto sm:ml-auto">
                      <MaterialOptionTabs
                        label={optionLabelSingular}
                        // Inside the !is_per_direction_pricing gate; null
                        // currency only reaches code that this branch
                        // never renders (per migration 000142).
                        currency={activeVersion.currency!}
                        showSurcharges={!activeVersion.custom_quote}
                        onSelect={setActiveOptionCode}
                        tabs={versionOptions.map((code) => {
                          const o = materialOptions.find(
                            (x) =>
                              x.material_id === activeVersion.material_id &&
                              x.code === code,
                          )
                          return {
                            code,
                            displayName: o?.display_name ?? code,
                            surchargeFromPrice: optionFromPrice(code),
                            isActive: effectiveOptionCode === code,
                          }
                        })}
                      />
                    </div>
                  )}
                </div>

                {/* V2 contact-sheet card layout. Each recipient
                    (or the shared-standalone group) renders as a
                    self-contained card panel: header band with a
                    chip / heading / sides indicator, image grid
                    with a hairline divider between front + back,
                    per-recipient action band below. Renders in a
                    vertical stack with consistent spacing between
                    recipients. */}
                <div className="space-y-5">
                  {/* Shared standalone group — renders when there
                      are unconsumed shared images. Uses a "Shared"
                      eyebrow heading instead of a numbered chip
                      since it's not a recipient. */}
                  {sharedStandaloneGroup && (() => {
                    const sharedPrimary = sharedHeading.split(' · ')[0] ?? 'Shared'
                    const sharedDetail = sharedHeading.includes(' · ')
                      ? sharedHeading.split(' · ').slice(1).join(' · ')
                      : null
                    return (
                    <div className="bg-surface border border-line rounded-[14px] overflow-hidden">
                      <div className="flex items-center gap-3 px-5 py-4 border-b border-line-soft">
                        {/* No numbered chip on the shared block —
                            "Shared" doesn't belong in a recipient
                            sequence. Use a quieter icon-only chip
                            to keep the visual rhythm with numbered
                            cards below. */}
                        <span className="grid place-items-center h-9 w-9 rounded-full bg-canvas border border-line text-ink-mute">
                          <Layers size={14} aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                          <div className="font-display font-medium text-ink text-[17px] leading-tight truncate">
                            {sharedPrimary}
                          </div>
                          {sharedDetail && (
                            <div className="eyebrow mt-0.5">{sharedDetail}</div>
                          )}
                        </div>
                        <span className="ml-auto inline-flex items-center gap-1.5 eyebrow text-ink-mute">
                          <Eye size={12} aria-hidden="true" />
                          {groupIsPair(sharedStandaloneGroup) ? '2 sides' : `${sharedStandaloneGroup.images.length} ${sharedStandaloneGroup.images.length === 1 ? 'side' : 'sides'}`}
                        </span>
                      </div>
                      <div
                        className={
                          groupIsPair(sharedStandaloneGroup)
                            ? 'grid grid-cols-1 gap-px bg-line-soft md:grid-cols-2'
                            : 'space-y-5 p-5'
                        }
                      >
                        {sharedStandaloneGroup.images.map((img, idx) => (
                          <div
                            key={img.id}
                            className={groupIsPair(sharedStandaloneGroup) ? 'bg-surface p-5' : ''}
                          >
                            <PlateCard
                              image={img}
                              brandColor={BRAND_ORDER[idx % BRAND_ORDER.length]}
                              alt={`Proof version ${activeVersion.version_number}`}
                              onClick={() => openDetailView({
                                images: sharedStandaloneGroup.images,
                                index: idx,
                                displayLabel: 'Shared',
                                versionId: activeVersion.id,
                                recipientName: SHARED_APPROVAL_KEY,
                              })}
                              recipientLabel="Shared"
                            />
                          </div>
                        ))}
                      </div>
                      {/* Shared band routing — preserved verbatim
                          from the prior layout. names.length > 0 →
                          renderSharedInfoBand (status-only, shared
                          section approved-by-implication once every
                          named recipient approves). names empty →
                          renderActionBand (all-shared one-off, the
                          shared section IS the proof). */}
                      <div className="border-t border-line-soft px-5 py-4">
                        {(activeVersion?.names.length ?? 0) > 0
                          ? renderSharedInfoBand()
                          : renderActionBand(SHARED_APPROVAL_KEY)}
                      </div>
                    </div>
                    )
                  })()}

                  {augmentedNamedGroups.length > 0 && (() => {
                    // Running colour-rotation index across all groups
                    // in reading order so each rendered image-instance
                    // on the page gets a distinct bullet colour from
                    // BRAND_ORDER (red → pink → indigo → teal). Starts
                    // at the number of images actually rendered in the
                    // standalone shared section — NOT the full shared-
                    // group size — so shared images consumed into named
                    // groups via virtual pairing don't inflate the
                    // offset. A shared image injected into two
                    // different named groups therefore picks up two
                    // different colours (one per rendered instance).
                    let colorIdx = sharedStandaloneGroup
                      ? sharedStandaloneGroup.images.length
                      : 0
                    return augmentedNamedGroups.map((group, groupIdx) => {
                      const pill =
                        group.heading != null ? approvalPillFor(group.heading) : null
                      const startIdx = colorIdx
                      colorIdx += group.images.length
                      const heading = group.heading
                      const bandHeading =
                        heading != null ? `${firstName(heading)}'s card` : ''
                      // Numbered chip — recipient index in the
                      // augmented sequence, zero-padded to two digits.
                      // Shared block above doesn't carry a number, so
                      // we count named groups from 01 regardless of
                      // whether a shared block precedes them.
                      const chipLabel = String(groupIdx + 1).padStart(2, '0')
                      const isPair = groupIsPair(group)
                      const sidesLabel = isPair
                        ? '2 sides'
                        : `${group.images.length} ${group.images.length === 1 ? 'side' : 'sides'}`
                      return (
                        <div
                          key={group.heading ?? ''}
                          className="bg-surface border border-line rounded-[14px] overflow-hidden"
                        >
                          {/* Card header band: numbered chip + name +
                              optional approval pill on its right + sides
                              indicator far right. */}
                          <div className="flex items-center gap-3 px-5 py-4 border-b border-line-soft">
                            <span className="grid place-items-center h-9 w-9 rounded-full bg-canvas border border-line eyebrow text-ink">
                              {chipLabel}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="font-display font-medium text-ink text-[17px] leading-tight truncate">
                                {bandHeading}
                              </div>
                            </div>
                            {pill && (
                              <span
                                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 eyebrow"
                                style={{
                                  background: 'rgba(14,155,78,0.14)',
                                  color: 'var(--c-in-stock)',
                                  border: '1px solid rgba(14,155,78,0.3)',
                                  letterSpacing: '0.14em',
                                }}
                              >
                                <svg
                                  width="9"
                                  height="9"
                                  viewBox="0 0 12 12"
                                  fill="none"
                                  aria-hidden="true"
                                >
                                  <path
                                    d="M2.5 6.5L5 9L9.5 3.5"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                                {pill}
                              </span>
                            )}
                            <span className="inline-flex items-center gap-1.5 eyebrow text-ink-mute">
                              <Eye size={12} aria-hidden="true" />
                              {sidesLabel}
                            </span>
                          </div>
                          {/* Image grid — front + back side-by-side at
                              md+, stacked at smaller widths. The gap-px
                              + bg-line-soft creates the hairline divider
                              between cells without per-cell borders. */}
                          <div
                            className={
                              isPair
                                ? 'grid grid-cols-1 gap-px bg-line-soft md:grid-cols-2'
                                : 'space-y-5 p-5'
                            }
                          >
                            {group.images.map((img, localIdx) => {
                              const dotIdx = startIdx + localIdx
                              return (
                                <div
                                  key={img.id}
                                  className={isPair ? 'bg-surface p-5' : ''}
                                >
                                  <PlateCard
                                    image={img}
                                    brandColor={BRAND_ORDER[dotIdx % BRAND_ORDER.length]}
                                    alt={`${group.heading} — proof version ${activeVersion.version_number}`}
                                    onClick={() => openDetailView({
                                      images: group.images,
                                      index: localIdx,
                                      displayLabel: group.heading ?? null,
                                      versionId: activeVersion.id,
                                      recipientName: group.heading ?? SHARED_APPROVAL_KEY,
                                    })}
                                    recipientLabel={group.heading ?? undefined}
                                  />
                                </div>
                              )
                            })}
                          </div>
                          {/* Per-recipient action band — Phase 2.5
                              approve / request-changes pair with its
                              state-machine renderer. Lives inside the
                              card with its own top border so the
                              divider reads as "now act on this
                              recipient" rather than as a free-floating
                              afterthought. */}
                          {group.heading != null && (
                            <div className="border-t border-line-soft px-5 py-4">
                              {renderActionBand(group.heading)}
                            </div>
                          )}
                        </div>
                      )
                    })
                  })()}
                </div>
              </section>
            )
          })()}

          {/* ───── QR codes (migrations 000168 / 000169) ─────
              Renders a dedicated verification panel for any QR
              codes on the active version. Sits between the proof
              images band and Construction so the customer reviews
              QR contents while the artwork is still fresh in
              their head. Renders nothing when the version has no
              QRs (no banner, no heading) so legacy proofs stay
              visually unchanged. */}
          <QrCodePanel
            qrImages={versionQrImages[activeVersion.id] ?? []}
            names={activeVersion.names ?? []}
            isVariantRound={activeVersion.is_variant_round ?? false}
            className="order-5 lg:order-none"
            introCopy={publicSettings?.qr_panel_intro_copy}
            vcardCopy={publicSettings?.qr_panel_vcard_copy}
          />

          {/* Metal thickness guide (migration 000177). Contextual
              section explaining the three metal card thickness
              options (300μm / 500μm / 800μm). Renders only on
              metal proofs (material_code starts with 'metal_').
              Metal proofs never carry the letterpress Construction
              panel, so the two never stack — each material gets at
              most one contextual panel in this slot. */}
          {activeVersion.material_code?.startsWith('metal_') && (
            <PanelShell
              eyebrow="About this material"
              title="Thickness"
              icon={Layers}
              accent={tokens.brand}
              className="order-7 lg:order-none"
            >
              {/* Two-column grid mirroring the "Material notes"
                  card: intro narrative left, the coral-accented
                  thickness list right. Stacks to one column below md
                  in reading order (intro → list). */}
              <div className="grid gap-8 md:grid-cols-[1fr_2fr] md:items-start">
                <p className="max-w-[62ch] whitespace-pre-line text-[15px] leading-[1.7] text-ink-soft">
                  {thicknessNotes.intro}
                </p>
                <MetalThicknessPanel
                  options={thicknessSetForMaterial(thicknessNotes, activeVersion.material_code)}
                />
              </div>
            </PanelShell>
          )}

          {/* Letterpress construction guide (migration 000135).
              Renders only when all three layer fields populate, so
              non-letterpress and gilded versions naturally drop the
              entire panel. */}
          {activeVersion.front_colour_name && activeVersion.core_colour_name && activeVersion.back_colour_name && (
            <PanelShell
              eyebrow="About this material"
              title="Construction"
              icon={Layers}
              accent={tokens.brand}
              className="order-7 lg:order-none"
            >
              {/* One-third / two-third split: the explanatory text in
                  the left column, the layered cross-section diagram in
                  the right. Mirrors the Thickness / QR two-column
                  pattern, weighted 1:2 so the diagram gets the room.
                  Stacks to one column below md, in reading order (text
                  first, then diagram). */}
              <div className="grid gap-6 md:gap-8 md:grid-cols-[1fr_2fr] md:items-start">
                <p className="text-[14px] leading-[1.6] text-ink-soft m-0">
                  Three layers of genuine Colorplan paper, bonded
                  together and visible along the card's edges — a
                  signature detail of our letterpress cards.
                </p>
                <LayeredConstructionPanel
                  front_name={activeVersion.front_colour_name}
                  front_hex={activeVersion.front_colour_hex}
                  core_name={activeVersion.core_colour_name}
                  core_hex={activeVersion.core_colour_hex}
                  back_name={activeVersion.back_colour_name}
                  back_hex={activeVersion.back_colour_hex}
                />
              </div>
            </PanelShell>
          )}

          {/* ───── Specification + Notes on ink ─────
              Spec sheet is a two-column grid with the heading
              intro on the left and a hairline-ruled dl on the
              right. Notes block-quote sits below, separated by a
              top-border rule. Notes only render when the version
              has change_notes content.

              Per-direction-pricing variant rounds (000142, renamed 000144) hide the whole
              section — every per-direction material is a separate
              decision and the version row carries no aggregate
              material/currency to put on the spec sheet. */}
          {/* Specs PanelShell moved into the left-rail aside in V2.
              Notes card was here too — its copy lives in the
              customer card at the top of the aside now. */}

          {/* ───── Pricing ─────
              Darker ink section (#0f0d0b) — visually distinct
              from the spec section so the reader senses a
              landing page as they scroll. Table styled for the
              dark palette with mono numerals in the right-hand
              columns and a large serif quantity on the left.
              Custom-quote mode collapses the table to a quiet
              message. Split-name tooling callout + shipping
              footer ride along underneath.

              Variant-round versions render a copy of this
              pricing card at the top of renderVariantRound's
              comparison view (build-plan step 4), so the
              standalone section here is gated off to avoid a
              duplicate. is_variant_round is false on every row
              in production today, so this gate is a no-op for
              every existing proof. */}
          {/* Wide-table Pricing — renders here in the right column
              when the snapshot has 3 or more priced variants
              (4+ total columns: qty + N variant prices). The
              360px left rail comfortably fits up to 3 columns
              (qty + 2 prices); anything wider overflows.
              Single- and two-variant pricing stay in the left
              rail per V2 design intent. JSX shape mirrors the
              aside's Pricing block above. */}
          {!activeVersion.is_variant_round && livePricingSnapshot.variants.length > 2 && (
            <>
              <PanelShell
                eyebrow={
                  !activeVersion.custom_quote && activeOption && versionOptions.length > 0 && materialHasSurcharges
                    ? `Prices shown for ${activeOption.display_name} ${optionLabelSingular.toLowerCase()}`
                    : 'Inclusive of VAT'
                }
                title="Pricing"
                icon={currencyIcon(activeVersion.currency)}
                accent={tokens.brand}
                className="order-8 lg:order-none"
                action={
                  !activeVersion.custom_quote ? (
                    <span className="num text-[12px] font-medium text-ink uppercase tracking-[0.18em]">
                      {activeVersion.currency}
                      {activeVersion.currency === 'GBP' ? ' · VAT included' : ''}
                    </span>
                  ) : undefined
                }
              >
                <h2 id="section-pricing-heading" className="sr-only">Pricing</h2>
                {activeVersion.custom_quote ? (
                  <div className="py-6 text-center">
                    <p className="mx-auto max-w-md font-display text-[18px] leading-snug text-ink-soft">
                      This proof requires a custom quote. We'll be in touch separately with pricing.
                    </p>
                  </div>
                ) : (
                  <>
                    <PaperPricingTable
                      snapshot={livePricingSnapshot}
                      currency={activeVersion.currency!}
                      displayQuantities={activeVersion.display_quantities}
                      quoteMinQuantity={activeVersion.quote_min_quantity}
                      quoteMaxQuantity={activeVersion.quote_max_quantity}
                      quantitySurcharges={quantitySurcharges}
                      personalisationPricing={activePersonalisationPricing}
                    />
                    {personalisationBreakevenQty != null && (
                      <p className="mt-3 text-[13px] text-ink-mute leading-relaxed">
                        A minimum personalisation charge applies below {personalisationBreakevenQty.toLocaleString()} cards.
                      </p>
                    )}
                    {/* Shipping note as a quiet footer line inside the
                        Pricing PanelShell (same treatment as the aside
                        copy above). Avoids floating a stranded half-
                        width shipping card below the panel when
                        split-name tooling isn't applicable. */}
                    {activeVersion.shipping_note && (
                      <p className="mt-3 text-[12px] text-ink-mute whitespace-pre-line text-right border-t border-line-soft pt-3">
                        {activeVersion.shipping_note}
                      </p>
                    )}
                  </>
                )}
              </PanelShell>

              {/* Split-name tooling callout — full-width card below
                  the Pricing PanelShell when applicable. */}
              {!activeVersion.custom_quote &&
                activeVersion.names.length >= 2 &&
                activeVersion.split_name_surcharge_snapshot != null &&
                activeVersion.split_name_surcharge_snapshot > 0 && (
                  <div className="order-8 lg:order-none rounded-[10px] bg-surface border border-line p-4 mt-4">
                    <span className="eyebrow text-brand">Split-name tooling</span>
                    <p className="mt-2 text-[15px] leading-snug text-ink font-medium">
                      Add{' '}
                      <span className="num font-medium">
                        {formatPrice(
                          (activeVersion.names.length - 1) *
                            activeVersion.split_name_surcharge_snapshot,
                          activeVersion.currency!,
                        )}
                      </span>{' '}
                      to the prices above
                    </p>
                    <p className="mt-1.5 text-[12px] text-ink-mute">
                      {activeVersion.names.length - 1} extra{' '}
                      {activeVersion.names.length - 1 === 1 ? 'name' : 'names'} ×{' '}
                      {formatPrice(
                        activeVersion.split_name_surcharge_snapshot,
                        activeVersion.currency!,
                      )}{' '}
                      tooling
                    </p>
                  </div>
                )}
            </>
          )}

          {/* ───── About {material} ─────
              Two-column layout: copy on the left, swatch orb on
              the right. Swatch gradient derived from the
              material display name (copper/steel/gold/etc) with
              an indigo fallback. Section only renders when the
              material has a description configured — if not,
              the section collapses silently.

              Per-direction-pricing variant rounds (000142, renamed 000144) carry no
              version-level material so material_description is
              null and this section auto-hides. The defensive
              !is_per_direction_pricing gate makes that explicit and
              survives any future schema drift. */}
          {!activeVersion.is_per_direction_pricing && activeVersion.material_description && (
            <section aria-labelledby="section-material-heading" className="order-9 lg:order-none">
              <PanelShell
                eyebrow="Material notes"
                title={`About our ${activeVersion.material_display.toLowerCase()} cards`}
                icon={BookOpen}
                accent={tokens.brand}
              >
                  <h2 id="section-material-heading" className="sr-only">
                    About our {activeVersion.material_display.toLowerCase()} cards
                  </h2>
                  {/* One-third / two-third grid at md+ (narrative
                      left, key features right) — matches the Thickness
                      and Construction cards. Stacks to a single
                      column below the breakpoint in reading order:
                      narrative → features. When key_features is
                      null or empty the right column renders an
                      empty <div> so the grid shape stays stable
                      and narrative width (max-w-[62ch]) doesn't
                      reshape across materials. */}
                  <div className="grid gap-8 md:grid-cols-[1fr_2fr] md:items-start">
                    <p className="max-w-[62ch] whitespace-pre-line text-[15px] leading-[1.7] text-ink-soft">
                      {activeVersion.material_description}
                    </p>
                    <div>
                      {/* Numbered editorial key features list
                          (migration 000100). Each entry is a
                          {title, body} pair. Gated on presence
                          of curated features; right column
                          wrapper stays regardless so the grid
                          shape stays stable across materials. */}
                      {activeVersion.key_features && activeVersion.key_features.length > 0 && (
                        <ul className="max-w-[62ch] space-y-4">
                          {activeVersion.key_features.map((feature, i) => (
                            <li key={i} className="grid grid-cols-[36px_1fr] items-baseline gap-3">
                              <span
                                aria-hidden="true"
                                className="num font-medium text-brand leading-none"
                                style={{ fontSize: 22 }}
                              >
                                {String(i + 1).padStart(2, '0')}
                              </span>
                              <div>
                                <p className="mb-0.5 text-[14px] font-medium text-ink">
                                  {feature.title}
                                </p>
                                <p className="text-[13px] leading-[1.55] text-ink-mute">
                                  {feature.body}
                                </p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  {/* Material disclaimer — full-width below the
                      grid, conditional. Sits inside the same
                      PanelShell so it reads as part of the same
                      surface rather than a separate block. */}
                  {activeVersion.material_disclaimer && (
                    <p className="mt-8 max-w-[62ch] whitespace-pre-line text-[13px] leading-[1.6] text-ink-mute border-t border-line-soft pt-5">
                      {activeVersion.material_disclaimer}
                    </p>
                  )}
              </PanelShell>
            </section>
          )}

          </div>
        </main>
      )}

      {/* Footer — replaces the dark-ink BrandRule footer with the
          prototype's quiet two-column line on canvas. Left: eyebrow-
          styled brand mark. Right: privacy reminder + version ref.
          Both lines sit at 12px in ink-mute on the warm-cream canvas. */}
      <footer className="mx-auto max-w-[1280px] px-6 sm:px-7 mt-6 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3 py-4 border-t border-line text-[12px] text-ink-mute">
          <span className="eyebrow">PlasmaDesign · craft-press business cards</span>
          <span className="flex items-center gap-3">
            <span>This proof URL is private. Please don't share publicly.</span>
            {(proofRef || activeVersion) && (
              <span className="hidden sm:inline-flex items-center gap-2">
                <span className="w-px h-3 bg-line" aria-hidden="true" />
                <span className="font-mono">
                  {proofRef}
                  {proofRef && activeVersion ? ' · ' : ''}
                  {activeVersion ? `v${activeVersion.version_number}` : ''}
                </span>
              </span>
            )}
          </span>
        </div>
      </footer>

      {/* Detail view (Phase 2).
          Replaces the previous dark fullscreen lightbox with a
          non-modal, light-register zoom that coexists with the
          request-changes panel. z-index sits below the panel
          (z-40) and the approve modal (z-50). When the panel is
          open, the detail view insets so it doesn't cover it. */}
      {detailView && (
        <ProofDetailView
          // Re-keying on (versionId, recipientName, roundVariantId)
          // forces a remount when the trigger group changes — the
          // component seeds `index` from `initialIndex` once on
          // mount, so without the key a second click would keep the
          // first session's index. Multiple opens of the same group
          // re-use one instance, so the index seed is honoured.
          key={`${detailView.versionId}|${detailView.recipientName}|${detailView.roundVariant?.id ?? ''}`}
          images={detailView.images}
          initialIndex={detailView.index}
          displayLabel={detailView.displayLabel}
          close={closeDetailView}
          onRequestChanges={() => {
            // Variant rounds use the variant-specific opener so the
            // edge function picks up round_variant_id; standard
            // path uses the per-recipient opener.
            if (detailView.roundVariant) {
              openVariantActionPanel(detailView.versionId, {
                id: detailView.roundVariant.id,
                display_name: detailView.roundVariant.displayName,
              })
            } else {
              openActionPanel(
                detailView.versionId,
                detailView.recipientName,
                'request_changes',
              )
            }
          }}
          hideRequestChanges={actionPanel != null}
          panelOpen={actionPanel != null}
          onCurrentSideChange={setDetailViewSide}
        />
      )}

      {/* Docked panel / bottom sheet for both customer actions —
          request_changes and approve. Replaces the previous dark-
          backdrop approve modal so the proof and the zoomed detail
          view stay visible while the customer reads the disclaimer.
          Shares actionName / actionComment / actionError /
          submitAction across both flows, so the optimistic per-
          recipient state machine (actionResults / successMessages
          keyed by bandKey / variantBandKey) is preserved verbatim. */}
      {actionPanel && (
        <ActionPanel
          actionPanel={actionPanel}
          actionName={actionName}
          setActionName={setActionName}
          actionComment={actionComment}
          setActionComment={setActionComment}
          actionError={actionError}
          actionSubmitting={actionSubmitting}
          introCopy={publicSettings?.request_changes_confirmation_copy ?? null}
          closeActionPanel={closeActionPanel}
          submitAction={() => void submitAction()}
          submitted={requestChangesSubmitted}
          disclaimerText={publicSettings?.disclaimer_text ?? null}
          disclaimerAckedThisSession={disclaimerAckedThisSession}
          actionDisclaimerAcked={actionDisclaimerAcked}
          setActionDisclaimerAcked={setActionDisclaimerAcked}
          actionDisclaimerExpanded={actionDisclaimerExpanded}
          setActionDisclaimerExpanded={setActionDisclaimerExpanded}
          // Same qrRowsForSlot predicate submitAction's server-mirror
          // guard uses, so the panel's QR tick + the Confirm-disabled
          // gate stay in lockstep. The panel doesn't need to know
          // about the GridImage shape — it just needs the count.
          slotQrCount={
            actionPanel.type === 'approve'
              ? qrRowsForSlot({
                  qrImages: versionQrImages[actionPanel.versionId] ?? [],
                  slotName: actionPanel.name,
                  versionHasNames: (activeVersion?.names ?? []).length > 0,
                }).length
              : 0
          }
          actionQrConfirmed={actionQrConfirmed}
          setActionQrConfirmed={setActionQrConfirmed}
          // Earlier-version acknowledgement. activeVersion is the
          // version being approved (the panel always opens for the
          // active version). When it's not the current proof, the
          // panel renders an extra warning block + tick at the top
          // and gates Confirm on it.
          isEarlierVersion={activeVersion ? !activeVersion.is_current : false}
          earlierVersionNumber={activeVersion?.version_number ?? null}
          latestVersionNumber={latestVersion?.version_number ?? null}
          actionEarlierVersionAcked={actionEarlierVersionAcked}
          setActionEarlierVersionAcked={setActionEarlierVersionAcked}
        />
      )}
    </div>
  )
}

// Editorial plate card — single image with a two-line caption
// strip below. Primary line: brand-colour bullet + side label
// ("Front" / "Back" on two-sided projects, stripped filename
// stem on one-sided multi-image groups, blank on one-sided
// single-image groups — applyCaptions stamps image.label with
// the right value for every case). Secondary line: raw
// uploaded original_filename (with extension), muted and
// truncated with a full-name tooltip on hover. Hidden when
// original_filename is null (pre-migration-000021 legacy
// rows). Clicking the image opens the detail view via the
// parent's onClick handler. Download link uses the real
// uploaded filename so the customer's downloads folder
// matches what they saw on the page.
function PlateCard({
  image,
  brandColor,
  alt,
  onClick,
  recipientLabel,
}: {
  image: GridImage
  brandColor: string
  alt: string
  // Caller-provided opener. Carries no per-image payload anymore —
  // the call site knows the image's group context (recipient,
  // variant, version) and passes it through when it builds the
  // closure for openDetailView (Phase 2 detail-view rework).
  onClick: () => void
  recipientLabel?: string
}) {
  const downloadHref = image.signed_url ?? '#'
  const downloadName = image.original_filename ?? 'proof.jpg'
  // Compose "{RECIPIENT} · {SIDE}" per README §4 screenshot
  // pattern. Falls back gracefully when either piece is missing:
  // recipient-only → "{RECIPIENT}", side-only → "{SIDE}",
  // neither → empty (label cell collapses).
  const sideText = (image.label ?? '').toUpperCase()
  const captionLabel = recipientLabel
    ? sideText
      ? `${recipientLabel.toUpperCase()} · ${sideText}`
      : recipientLabel.toUpperCase()
    : sideText
  return (
    <div className="relative">
      <figure className="relative">
        <button
          type="button"
          onClick={() => image.signed_url && onClick()}
          // Focus halo uses outline-2 + outline-offset-1 to match the
          // design-system primitive pattern (see Input.tsx for the
          // Tailwind v4 ring-vs-outline rationale). Colour: brand
          // coral, pulled via arbitrary-value syntax so the focused
          // halo lands consistently across the bridged custom
          // properties.
          className="block w-full overflow-hidden rounded-[6px] border border-line bg-canvas focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] cursor-zoom-in"
          // captionLabel carries recipient + side ("MARIE · FRONT") so
          // every plate on the page has a distinct accessible name. The
          // page-level descriptor (`alt`, e.g. "Marie — proof version 2")
          // is appended only when it adds information — for shared
          // single-image groups captionLabel is empty and `alt` already
          // names the plate. "View larger" tells the user it's a button
          // that opens a dialog rather than just an image.
          aria-label={[captionLabel, captionLabel === alt ? null : alt, 'view larger']
            .filter(Boolean)
            .join(', ')}
        >
          {image.signed_url ? (
            <img src={image.signed_url} alt={alt} className="block w-full bg-canvas" />
          ) : (
            <div className="aspect-[5/3] w-full bg-canvas" />
          )}
        </button>
        {/* Two-line caption. Top line: brand-dot + RECIPIENT · SIDE on
            the left, plain "Download ↓" link on the right. The
            filename sits on its own full-width line below, so a long
            recipient name can never squeeze it down to a useless
            "Proo…" stub (the old three-column grid did exactly that
            once a name and filename competed for one narrow row). The
            recipient name wraps rather than truncating — names matter
            more than the internal filename. All label copy reads
            `.eyebrow` typography (mono, uppercase, 0.18em tracking). */}
        <figcaption className="mt-3 border-t border-line-soft pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0">
              <span
                aria-hidden="true"
                className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-[2px]"
                style={{ background: brandColor }}
              />
              {captionLabel && (
                <span
                  className="eyebrow text-ink break-words"
                  style={{ letterSpacing: '0.18em' }}
                >
                  {captionLabel}
                </span>
              )}
            </div>
            {image.signed_url && (
              <a
                href={downloadHref}
                download={downloadName}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                // -my-2 py-2 expands the tap target vertically (~36px)
                // without stretching the row's visual height, so the
                // link stays in register with the recipient label.
                className="inline-flex shrink-0 items-center -my-2 py-2 eyebrow text-ink-mute hover:text-ink transition-colors focus:outline-none focus-visible:underline"
                style={{ letterSpacing: '0.18em' }}
              >
                Download ↓
              </a>
            )}
          </div>
          {image.original_filename && (
            <span
              className="mt-1.5 block font-mono text-[12px] text-ink-dim truncate"
              title={image.original_filename}
            >
              {image.original_filename}
            </span>
          )}
        </figcaption>
      </figure>
    </div>
  )
}

// Spec row inside the Specification PanelShell. Eyebrow-style mono
// label on the left, sans value on the right. divide-y on the
// parent <dl> paints the hairlines between rows; this component
// just provides the label/value pair. Optional swatchHex left in
// the API for parity with the previous PaperSpecRow shape (the
// LayeredConstructionPanel could plug into the same component), but
// none of the live call sites use it today.
function SpecRow({
  label,
  value,
  swatchHex,
}: {
  label: string
  value: string
  swatchHex?: string
}) {
  return (
    <div className="grid grid-cols-[130px_1fr] items-baseline gap-4 py-3 sm:grid-cols-[180px_1fr] sm:gap-6">
      <dt className="eyebrow" style={{ letterSpacing: '0.22em' }}>
        {label}
      </dt>
      <dd className="whitespace-pre-line text-[14px] leading-[1.5] text-ink font-medium">
        {swatchHex ? (
          <span className="inline-flex items-center gap-2.5">
            <CoreColourSwatch hex={swatchHex} size={16} ariaLabel={`${value} swatch`} />
            <span>{value}</span>
          </span>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

// Paper-register pricing table — large serif quantity on the
// left, mono price + per-card columns on the right. Drives off
// the same PricingSnapshot shape as the designer-side
// PricingDisplay component, restyled for the paper palette.
// Multi-variant projects fall back to a simpler grid (rare on
// customer proofs in practice); single-variant — the common
// case and the one the design mocks — gets the editorial
// treatment.
//
// Row-set logic (post migration 000095 — single-list model):
//   * visibleQuantities — derived from display_quantities on
//     the material. If the curated list is populated AND
//     intersects the snapshot, we render the intersection
//     sorted ascending. If the material has not been curated
//     (null) OR its curated list has no intersection with the
//     snapshot (thin-tier fallthrough), we show the first 10
//     tiers ascending from the snapshot so the table never
//     renders zero rows. No "show more" toggle any more — the
//     QuantityLookup below handles anything outside the shown
//     rows, within the designer's quote bounds.
//   * lookupSet — the full snapshot tier list, in ascending
//     order. Fed only to the QuantityLookup below; the table
//     itself never shows it.
const DISPLAY_FALLBACK_CAP = 10

function PaperPricingTable({
  snapshot,
  currency,
  displayQuantities,
  quoteMinQuantity,
  quoteMaxQuantity,
  quantitySurcharges,
  personalisationPricing,
}: {
  snapshot: PricingSnapshot
  currency: Currency
  displayQuantities: number[] | null
  quoteMinQuantity: number | null
  quoteMaxQuantity: number | null
  quantitySurcharges: Record<number, number>
  // Personalisation (migration 000172). Live rate + floor for the
  // proof's currency, or null when the version isn't personalised or
  // sits in a mode that bypasses the standard grid. When non-null,
  // two rows render beneath the base grid: a Personalisation row and
  // a bold Total row. Otherwise the table renders exactly as before.
  personalisationPricing: PersonalisationPricing | null
}) {
  const { variants } = snapshot
  if (!variants?.length) return null

  const lookupSet = [
    ...new Set(variants.flatMap((v) => Object.keys(v.prices).map(Number))),
  ].sort((a, b) => a - b)
  const snapshotSet = new Set(lookupSet)

  // Curated list intersected with the snapshot (drops any
  // entries the snapshot does not actually price). Edge case
  // #5 fallthrough: if curation is populated but the intersection
  // is empty (designer listed tiers the snapshot does not price),
  // fall back to the first 10 ascending. Same treatment when
  // display_quantities itself is null (not yet curated).
  const displayFromCurated = displayQuantities
    ? displayQuantities.filter((q) => snapshotSet.has(q)).sort((a, b) => a - b)
    : []
  const visibleQuantities =
    displayFromCurated.length > 0
      ? displayFromCurated
      : lookupSet.slice(0, DISPLAY_FALLBACK_CAP)

  // Compile per-qty personalisation surcharges once for the visible
  // quantities. Empty map when personalisationPricing is null so the
  // render paths can read surcharges[qty] without a null guard.
  const personalisationSurcharges = compilePersonalisationSurcharges(
    visibleQuantities,
    personalisationPricing,
  )
  const hasPersonalisation = personalisationPricing != null

  // Single-variant path — the design mock's shape. Multi-
  // variant proofs (rare: thickness + ink count variants in
  // the same material) fall through to a compact per-variant
  // grid below. Both paths render the prominent QuantityLookup
  // card underneath: the lookup's result grid mirrors the
  // multi-variant main-table shape regardless of variant count,
  // so the same component serves both surfaces.
  if (variants.length === 1) {
    const variant = variants[0]
    const rows = visibleQuantities
      .filter((qty) => variant.prices[String(qty)] != null)
      .map((qty) => ({
        qty,
        price: variant.prices[String(qty)] + (quantitySurcharges[qty] ?? 0),
      }))
    if (rows.length === 0) return null
    return (
      <>
        <table className="w-full border-collapse">
          <caption className="sr-only">{`Pricing by quantity in ${currency}`}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="eyebrow py-3 text-left">
                Quantity
              </th>
              <th scope="col" className="eyebrow py-3 text-right">
                Price
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ qty, price }) => {
              const personalisation = personalisationSurcharges[qty] ?? 0
              const total = price + personalisation
              return (
                <Fragment key={qty}>
                  <tr
                    className={hasPersonalisation ? '' : 'border-b border-line-soft'}
                  >
                    <td
                      className="py-4 leading-none num font-medium text-ink text-[19px] sm:text-[24px]"
                      rowSpan={hasPersonalisation ? 3 : 1}
                    >
                      {qty.toLocaleString()}
                    </td>
                    <td
                      className={[
                        hasPersonalisation ? 'pt-4 pb-1' : 'py-4',
                        'text-right num text-[15px] text-ink',
                      ].join(' ')}
                    >
                      {formatPrice(price, currency)}
                    </td>
                  </tr>
                  {hasPersonalisation && (
                    <>
                      <tr>
                        <td className="py-1 text-right eyebrow">
                          Personalisation
                        </td>
                        <td className="py-1 text-right num text-[12px] text-ink-mute">
                          + {formatPrice(personalisation, currency)}
                        </td>
                      </tr>
                      <tr className={hasPersonalisation ? 'border-b border-line-soft' : ''}>
                        <td className="pt-1 pb-4 text-right eyebrow text-ink font-semibold">
                          Total
                        </td>
                        <td className="pt-1 pb-4 text-right num font-semibold text-[15px] text-ink">
                          {formatPrice(total, currency)}
                        </td>
                      </tr>
                    </>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        <QuantityLookup
          variants={variants}
          currency={currency}
          lookupSet={lookupSet}
          quoteMinQuantity={quoteMinQuantity}
          quoteMaxQuantity={quoteMaxQuantity}
          quantitySurcharges={quantitySurcharges}
          personalisationPricing={personalisationPricing}
        />
      </>
    )
  }

  // Multi-variant fallback — compact grid, one column per
  // variant. Not styled as editorially as the single-variant
  // path; this branch is rare on customer proofs (most
  // materials ship with a single variant_id on the snapshot).
  // Same QuantityLookup card renders below the grid — the
  // lookup's result grid is column-per-variant too, so it
  // reads consistently with the main table above.
  return (
    <>
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{`Pricing by quantity in ${currency}`}</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="eyebrow py-3 pr-2 text-left sm:pr-4">
              Quantity
            </th>
            {variants.map((v) => (
              <th
                key={v.variant_id}
                scope="col"
                className="eyebrow py-3 pl-2 text-right sm:pl-4"
              >
                {/* Compact unit on mobile (e.g. "300µm") so the four
                    columns fit without horizontal scroll; full label
                    ("300 micron") on sm+. normal-case keeps the µm unit
                    lowercase — the eyebrow's uppercase would turn µ into
                    a capital Mu that reads as "M". Non-micron variants
                    (ink counts, finishes) are unaffected by the replace. */}
                <span className="sm:hidden normal-case">{v.display.replace(/\s*microns?\b/i, 'µm')}</span>
                <span className="hidden sm:inline">{v.display}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleQuantities.map((qty) => {
            const surcharge = quantitySurcharges[qty] ?? 0
            const personalisation = personalisationSurcharges[qty] ?? 0
            return (
              <Fragment key={qty}>
                <tr className={hasPersonalisation ? '' : 'border-b border-line-soft'}>
                  <td
                    className="py-4 pr-2 leading-none num font-medium text-ink text-[17px] sm:text-[22px] sm:pr-4"
                    rowSpan={hasPersonalisation ? 3 : 1}
                  >
                    {qty.toLocaleString()}
                  </td>
                  {variants.map((v) => {
                    const base = v.prices[String(qty)]
                    if (base == null) {
                      return (
                        <td
                          key={v.variant_id}
                          className={[
                            hasPersonalisation ? 'pt-4 pb-1' : 'py-4',
                            'pl-2 text-right num text-[14px] text-ink-dim sm:pl-4',
                          ].join(' ')}
                        >
                          —
                        </td>
                      )
                    }
                    const price = base + surcharge
                    return (
                      <td
                        key={v.variant_id}
                        className={[
                          hasPersonalisation ? 'pt-4 pb-1' : 'py-4',
                          'pl-2 text-right num text-[13px] sm:text-[15px] text-ink sm:pl-4',
                        ].join(' ')}
                      >
                        {formatPrice(price, currency)}
                      </td>
                    )
                  })}
                </tr>
                {hasPersonalisation && (
                  <>
                    <tr>
                      {variants.map((v, idx) => (
                        <td
                          key={v.variant_id}
                          className="py-1 pl-2 text-right num text-[12px] text-ink-mute sm:pl-4"
                        >
                          {idx === 0 && (
                            <span className="mr-2 eyebrow">Personalisation</span>
                          )}
                          + {formatPrice(personalisation, currency)}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-b border-line-soft">
                      {variants.map((v, idx) => {
                        const base = v.prices[String(qty)]
                        if (base == null) {
                          return (
                            <td
                              key={v.variant_id}
                              className="pt-1 pb-4 pl-2 text-right num text-[13px] text-ink-dim sm:pl-4"
                            >
                              {idx === 0 && (
                                <span className="mr-2 eyebrow font-semibold">Total</span>
                              )}
                              —
                            </td>
                          )
                        }
                        const total = base + surcharge + personalisation
                        return (
                          <td
                            key={v.variant_id}
                            className="pt-1 pb-4 pl-2 text-right sm:pl-4"
                          >
                            {idx === 0 && (
                              <span className="mr-2 eyebrow font-semibold text-ink">Total</span>
                            )}
                            <span className="num font-semibold text-[15px] text-ink">
                              {formatPrice(total, currency)}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  </>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
    <QuantityLookup
      variants={variants}
      currency={currency}
      lookupSet={lookupSet}
      quoteMinQuantity={quoteMinQuantity}
      quoteMaxQuantity={quoteMaxQuantity}
      quantitySurcharges={quantitySurcharges}
      personalisationPricing={personalisationPricing}
    />
    </>
  )
}

// Prominent quantity picker card that sits below the pricing
// table. Dedicated card treatment — serif heading, body-size
// input, optional result grid — so the picker reads as a
// proper feature rather than a caption-weight footnote. Works
// for both single-variant and multi-variant proofs; the result
// grid is always column-per-variant (using variants[i].display
// as the header, same source as the main multi-variant table),
// which means a single grid shape serves one variant or many.
//
// Customer types a number, lookup runs against the version's
// snapshot tier set (lookupSet) in memory — no DB round-trip,
// so no debounce. Branch order inside the parsed-query block:
//
//   1. query < quote_min_quantity  → small-runs caption, no grid.
//   2. query > quote_max_quantity  → large-runs caption, no grid.
//   3. Exact match in any variant  → one row, caption "For {qty}".
//                                    Exact-match uses lookupSet
//                                    membership (union across
//                                    variants), so a tier priced
//                                    by only some variants still
//                                    captures — the grid cell for
//                                    the variant that doesn't
//                                    price it renders a "—".
//   4. Below lowest snapshot tier  → one row at the lowest,
//                                    caption "Below our listed
//                                    range. Lowest tier:". Only
//                                    fires when quote bounds are
//                                    null or set wider than the
//                                    snapshot.
//   5. Above highest snapshot tier → one row at the highest,
//                                    caption "Above our listed
//                                    range. Highest tier is
//                                    {highestTier}. For volumes
//                                    beyond that, get in touch."
//                                    Customer's typed value never
//                                    appears in this caption next
//                                    to the highest-tier value —
//                                    avoids two numbers fighting
//                                    for attention in one sentence.
//   6. Between two tiers           → two bracketing rows,
//                                    caption "{qty} falls between
//                                    two tiers. Closest tiers:".
//
// Bounds are checked before snapshot-range branches because the
// designer's bounds are a commercial gate: "please get in touch
// for small runs" should win over "below our listed range" when
// both would apply. The out-of-bounds captions (branches 1-2)
// render at body size with no grid — they're a commercial message,
// not a tier signpost.
//
// Empty / non-numeric input → no result panel, just the card at
// rest (heading + input, no caption, no grid, no stray spacing).
// No error state, no red text; mismatch is informational, not
// a correction.
function QuantityLookup({
  variants,
  currency,
  lookupSet,
  quoteMinQuantity,
  quoteMaxQuantity,
  quantitySurcharges,
  personalisationPricing,
}: {
  variants: PricingVariant[]
  currency: Currency
  lookupSet: number[]
  quoteMinQuantity: number | null
  quoteMaxQuantity: number | null
  quantitySurcharges: Record<number, number>
  personalisationPricing: PersonalisationPricing | null
}) {
  const hasPersonalisation = personalisationPricing != null
  const personalisationAt = (qty: number): number =>
    personalisationPricing
      ? Math.max(personalisationPricing.min_charge, qty * personalisationPricing.per_card_rate)
      : 0
  const [raw, setRaw] = useState('')
  if (lookupSet.length === 0) return null
  if (variants.length === 0) return null

  const parsed = /^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : null
  const query = parsed != null && parsed > 0 ? parsed : null

  // Per-cell price resolver. Returns null when this variant
  // doesn't price this tier; the grid cell renders a "—"
  // placeholder in that case, matching the main multi-variant
  // table's treatment.
  const priceAt = (qty: number, variant: PricingVariant): number | null => {
    const base = variant.prices[String(qty)]
    if (base == null) return null
    return base + (quantitySurcharges[qty] ?? 0)
  }

  // Resolve the query into a caption + the set of tier rows to
  // render. Bounds (branches 1-2) set tiers=[] so the grid is
  // suppressed entirely; the commercial message stands alone.
  let caption: string | null = null
  let tiers: number[] = []
  if (query != null) {
    const lowest = lookupSet[0]
    const highest = lookupSet[lookupSet.length - 1]
    if (quoteMinQuantity != null && query < quoteMinQuantity) {
      caption = 'Please get in touch for pricing on small runs.'
      tiers = []
    } else if (quoteMaxQuantity != null && query > quoteMaxQuantity) {
      caption = 'Please get in touch for pricing on large runs.'
      tiers = []
    } else if (lookupSet.includes(query)) {
      caption = `For ${query.toLocaleString()}`
      tiers = [query]
    } else if (query < lowest) {
      caption = 'Below our listed range. Lowest tier:'
      tiers = [lowest]
    } else if (query > highest) {
      caption = `Above our listed range. Highest tier is ${highest.toLocaleString()}. For volumes beyond that, get in touch.`
      tiers = [highest]
    } else {
      // Between two tiers — find the brackets. lookupSet is
      // sorted ascending, so linear scan is fine (typical
      // lengths are well under 40 entries).
      let lower = lowest
      let upper = highest
      for (let i = 0; i < lookupSet.length - 1; i++) {
        if (lookupSet[i] < query && query < lookupSet[i + 1]) {
          lower = lookupSet[i]
          upper = lookupSet[i + 1]
          break
        }
      }
      caption = `${query.toLocaleString()} falls between two tiers. Closest tiers:`
      tiers = [lower, upper]
    }
  }

  return (
    <div className="mt-6 py-5 px-5 rounded-[10px] bg-canvas border border-line">
      <h3
        id="quantity-picker-heading"
        className="mb-3 font-display font-medium tracking-[-0.02em] text-ink leading-tight text-[17px] sm:text-[22px]"
      >
        Need a price for a specific quantity?
      </h3>
      <div className="flex max-w-sm items-center gap-3">
        <input
          // type=text + inputMode=numeric instead of type=number:
          //   * mobile keyboards still pop the numeric pad via inputMode
          //   * screen readers announce "edit text" instead of "spin
          //     button" (no implicit ↑/↓ semantics that this UI doesn't
          //     support — the parsed regex below already handles
          //     non-digit input)
          //   * iOS no longer accepts pasted non-numerics into the
          //     visible value (type=number silently drops them, leaving
          //     the field looking empty; type=text shows them and the
          //     regex rejects them, which is the better UX)
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setRaw('') }}
          placeholder="Enter quantity"
          aria-labelledby="quantity-picker-heading"
          // Focus halo follows the design-system primitive pattern
          // (see Input.tsx) — outline-2 + offset + brand colour via
          // arbitrary-value syntax. No `outline-none` at base so the
          // Tailwind v4 outline-style cascade lands correctly.
          className="font-mono min-w-0 flex-1 h-[44px] rounded-[8px] px-4 text-[15px] text-ink bg-surface border border-line placeholder:text-ink-dim transition-colors focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
        />
        <span aria-hidden="true" className="text-ink-mute" style={{ fontSize: 18 }}>
          →
        </span>
      </div>
      {/* Result panel — rendered only when the input has
          parsed into a query. The card feels compact at rest
          when the input is empty. aria-live/role=status sits
          on the caption <p> only — wrapping the whole panel
          (including the result table) caused screen readers
          to re-announce every cell on each keystroke. The
          caption already contains the human-readable result
          ("For 1,000", "Below our listed range. Lowest tier:")
          so announcing just it is sufficient feedback. */}
      {caption && (
        <div className="mt-6">
          <p
            aria-live="polite"
            role="status"
            className="text-[14px] leading-snug text-ink-soft"
          >
            {caption}
          </p>
          {tiers.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse">
                <caption className="sr-only">{`Closest pricing tiers in ${currency}`}</caption>
                <thead>
                  <tr className="border-b border-line">
                    {/* Blank header above the qty column — the
                        large numeral in each body row is self-
                        describing, no "Total quantity" heading
                        needed. */}
                    <th aria-hidden="true" className="py-3 pr-4" />
                    {variants.map((v) => (
                      <th
                        key={v.variant_id}
                        scope="col"
                        className="eyebrow py-3 pl-4 text-right"
                      >
                        {v.display}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((qty) => {
                    const personalisation = personalisationAt(qty)
                    return (
                      <Fragment key={qty}>
                        <tr className={hasPersonalisation ? '' : 'border-b border-line-soft'}>
                          <td
                            className="py-4 pr-4 leading-none num text-ink"
                            style={{ fontSize: 22, fontWeight: 500 }}
                            rowSpan={hasPersonalisation ? 3 : 1}
                          >
                            {qty.toLocaleString()}
                          </td>
                          {variants.map((v) => {
                            const price = priceAt(qty, v)
                            if (price == null) {
                              return (
                                <td
                                  key={v.variant_id}
                                  className={[
                                    hasPersonalisation ? 'pt-4 pb-1' : 'py-4',
                                    'pl-4 text-right num text-[14px] text-ink-dim',
                                  ].join(' ')}
                                >
                                  —
                                </td>
                              )
                            }
                            return (
                              <td
                                key={v.variant_id}
                                className={[
                                  hasPersonalisation ? 'pt-4 pb-1' : 'py-4',
                                  'pl-4 text-right num text-[15px] text-ink',
                                ].join(' ')}
                              >
                                {formatPrice(price, currency)}
                              </td>
                            )
                          })}
                        </tr>
                        {hasPersonalisation && (
                          <>
                            <tr>
                              {variants.map((v, idx) => (
                                <td
                                  key={v.variant_id}
                                  className="py-1 pl-4 text-right num text-[12px] text-ink-mute"
                                >
                                  {idx === 0 && (
                                    <span className="mr-2 eyebrow">Personalisation</span>
                                  )}
                                  + {formatPrice(personalisation, currency)}
                                </td>
                              ))}
                            </tr>
                            <tr className="border-b border-line-soft">
                              {variants.map((v, idx) => {
                                const price = priceAt(qty, v)
                                if (price == null) {
                                  return (
                                    <td
                                      key={v.variant_id}
                                      className="pt-1 pb-4 pl-4 text-right num text-[13px] text-ink-dim"
                                    >
                                      {idx === 0 && (
                                        <span className="mr-2 eyebrow font-semibold">Total</span>
                                      )}
                                      —
                                    </td>
                                  )
                                }
                                const total = price + personalisation
                                return (
                                  <td
                                    key={v.variant_id}
                                    className="pt-1 pb-4 pl-4 text-right"
                                  >
                                    {idx === 0 && (
                                      <span className="mr-2 eyebrow font-semibold text-ink">Total</span>
                                    )}
                                    <span className="num font-semibold text-[15px] text-ink">
                                      {formatPrice(total, currency)}
                                    </span>
                                  </td>
                                )
                              })}
                            </tr>
                          </>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Turn a flat image list into grouped-by-recipient sections for
// the customer proof page. Returned groups carry a `kind`
// discriminator so the page layout can route shared vs named
// groups into different containers (hero block vs responsive
// grid) without inferring from heading strings.
//
//   * Shared (null-name) group gets kind: 'shared'. Heading is
//     "Shared" when it sits alongside named groups, null when it
//     stands alone (keeps the legacy single-block layout for
//     versions with no per-name imagery).
//   * Named groups get kind: 'named' with the chip name as heading.
//     Ordered by first appearance in the image list (which follows
//     sort_order).
//   * Within each group, images sort front → back → unlabelled.
//   * Caption rule per image:
//       side present    → "Front" or "Back"
//       side null, ≥ 2 images in group → original filename stem
//       side null, 1 image in group    → blank (no label row)
//   * Side labels suppressed entirely when the project is one-
//     sided (i.e. no image in the set has side='back'). In that
//     case every image has side='front' (post-migration-000085)
//     or side=null (legacy data), and "Front" captions would be
//     redundant — the customer only ever sees one side, so
//     labelling it would just add noise.
//
// The ImageCard / Caption components read each image's `label`
// field, so the caption rule is applied by rewriting `label`
// before the group is handed off.
interface ImageGroup {
  kind: 'shared' | 'named'
  heading: string | null
  images: GridImage[]
}

// Virtual-pair the shared group into each named group for sides
// the named group doesn't already cover. Result: when shared
// carries a front and named groups only carry backs (the
// "shared design / per-person backs" classic shape), each
// named group ends up with both sides and renders as a paired
// card via groupIsPair / md:grid-cols-2 at render time, rather
// than the shared front rendering standalone and each named
// back rendering as its own single-image card.
//
// Consumed shared images — those injected into at least one
// named group — are excluded from the `unconsumedSharedImages`
// return so the caller can render the standalone shared
// section with only the leftovers (or skip it entirely when
// every shared image got consumed).
//
// No-op in two cases: no named groups at all (all-shared
// project) or no shared group (fully bespoke project). The
// augmented named groups then equal the input namedGroups and
// unconsumed equals the full shared list (or []).
//
// Shared images get cloned by reference into each named group
// that needs them — the same image object may appear in two
// named groups, which is fine for rendering (React keys off
// image.id and GridImage is treated as immutable everywhere
// downstream). The colour-rotation bullet runs on a per-
// rendered-instance index (see render), so the same shared
// image injected into Alec and Kyle picks up different dot
// colours — that was a deliberate call to keep the page's
// chromatic motif cycling through all four brand colours
// across every rendered card rather than pinning each shared
// image to a single colour.
function augmentNamedGroupsWithSharedPairs(
  sharedGroup: ImageGroup | null,
  namedGroups: ImageGroup[],
): { augmentedNamedGroups: ImageGroup[]; unconsumedSharedImages: GridImage[] } {
  if (!sharedGroup || namedGroups.length === 0) {
    return {
      augmentedNamedGroups: namedGroups,
      unconsumedSharedImages: sharedGroup?.images ?? [],
    }
  }
  const sideWeight = (s: GridImage['side']): number =>
    s === 'front' ? 0 : s === 'back' ? 1 : 2
  const consumed = new Set<string>()
  const augmented = namedGroups.map((group) => {
    const hasFront = group.images.some((i) => i.side === 'front')
    const hasBack = group.images.some((i) => i.side === 'back')
    const injections: GridImage[] = []
    if (!hasFront) {
      const sharedFront = sharedGroup.images.find((i) => i.side === 'front')
      if (sharedFront) {
        injections.push(sharedFront)
        consumed.add(sharedFront.id)
      }
    }
    if (!hasBack) {
      const sharedBack = sharedGroup.images.find((i) => i.side === 'back')
      if (sharedBack) {
        injections.push(sharedBack)
        consumed.add(sharedBack.id)
      }
    }
    if (injections.length === 0) return group
    const merged = [...group.images, ...injections]
    merged.sort((a, b) => sideWeight(a.side) - sideWeight(b.side))
    return { ...group, images: merged }
  })
  const unconsumed = sharedGroup.images.filter((i) => !consumed.has(i.id))
  return { augmentedNamedGroups: augmented, unconsumedSharedImages: unconsumed }
}

function buildImageGroups(images: GridImage[]): ImageGroup[] {
  const shared: GridImage[] = []
  const namedOrder: string[] = []
  const namedByKey = new Map<string, GridImage[]>()

  for (const img of images) {
    const name = img.associated_name ?? null
    if (name == null) {
      shared.push(img)
      continue
    }
    if (!namedByKey.has(name)) {
      namedByKey.set(name, [])
      namedOrder.push(name)
    }
    namedByKey.get(name)!.push(img)
  }

  const sideWeight = (s: GridImage['side']): number =>
    s === 'front' ? 0 : s === 'back' ? 1 : 2
  const sideSort = (a: GridImage, b: GridImage) => sideWeight(a.side) - sideWeight(b.side)
  shared.sort(sideSort)
  for (const arr of namedByKey.values()) arr.sort(sideSort)

  // One-sided detection is global across the whole image set, not
  // per-group, so a named group containing only front images
  // doesn't swallow the Front/Back labels of a second group with
  // both sides. The flag drives applyCaptions below.
  const isOneSided = !images.some((img) => img.side === 'back')

  const applyCaptions = (group: GridImage[]): GridImage[] => {
    const single = group.length === 1
    return group.map((img) => {
      let label = ''
      if (!isOneSided && img.side === 'front') label = 'Front'
      else if (!isOneSided && img.side === 'back') label = 'Back'
      else if (!single && img.original_filename) {
        label = img.original_filename.replace(/\.[^.]*$/, '')
      }
      return { ...img, label }
    })
  }

  const hasNamed = namedOrder.length > 0
  const groups: ImageGroup[] = []
  if (shared.length > 0) {
    groups.push({
      kind: 'shared',
      heading: hasNamed ? 'Shared' : null,
      images: applyCaptions(shared),
    })
  }
  for (const name of namedOrder) {
    groups.push({ kind: 'named', heading: name, images: applyCaptions(namedByKey.get(name)!) })
  }
  return groups
}

// Loading / 404 / abandoned screens. Restyled to the PlasmaDesign
// Stock Control design system landed in reskin PRs 1-2: warm-cream
// canvas, IBM Plex Sans display headings, mono eyebrows, hairline
// borders. Same content, new chrome.
function PlasmaEyebrow() {
  return (
    <div className="inline-flex items-center gap-2">
      <PlasmaWordmark size="sm" tagline="Proofs" />
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas text-ink">
      <div className="text-center">
        <PlasmaEyebrow />
        {/* motion-reduce:animate-none disables the rotation for users
            with `prefers-reduced-motion: reduce`. The static ring still
            renders so the layout doesn't collapse — paired with the
            visible "Loading proof" text below it the loading state
            remains comprehensible without motion. role/aria-label give
            SR users an explicit cue that loading is in progress
            (the .animate-spin div alone isn't announced). */}
        <div
          role="status"
          aria-label="Loading"
          className="mx-auto mt-8 h-7 w-7 animate-spin motion-reduce:animate-none rounded-full border-2 border-line"
          style={{ borderTopColor: 'var(--c-ink)' }}
        />
        <p className="eyebrow mt-5" style={{ letterSpacing: '0.24em' }}>
          Loading proof
        </p>
      </div>
    </div>
  )
}

function NotFoundScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas text-ink">
      <div className="text-center px-6">
        <PlasmaEyebrow />
        <h1 className="h-display mt-8">Not found</h1>
        <p className="body-soft mx-auto mt-4 max-w-sm">
          This proof link isn't valid or has expired. If you were sent here recently, please get in touch.
        </p>
        <p
          className="eyebrow mt-10"
          style={{ letterSpacing: '0.32em', color: 'var(--c-ink-dim)' }}
        >
          404
        </p>
      </div>
    </div>
  )
}

function AbandonedScreen({ proof }: { proof: PublicProof }) {
  // Same masthead rule as the live page: company prominent when
  // present (with the contact name as a muted sub-line), contact
  // name prominent when no company. Keeps the customer's brand
  // presence coherent across the live and abandoned screens.
  const trimmedCompany = proof.company?.trim() ?? ''
  const trimmedName = proof.customer_name?.trim() ?? ''
  const companyProminent = trimmedCompany.length > 0
  const primary = companyProminent ? proof.company! : proof.customer_name
  const subline = companyProminent && trimmedName.length > 0 ? proof.customer_name : null
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <header className="mb-12">
          <span className="eyebrow">Proof for</span>
          <h1 className="h1 mt-3" style={{ fontSize: 'clamp(36px, 7vw, 56px)' }}>
            {primary}
          </h1>
          {subline && (
            <p className="body-soft mt-2" style={{ fontSize: 22 }}>
              {subline}
            </p>
          )}
        </header>
        <div className="rounded-[14px] p-10 text-center bg-surface border border-line">
          <span className="eyebrow" style={{ letterSpacing: '0.32em' }}>
            Closed
          </span>
          <h2 className="h2 mt-3">This proof is closed</h2>
          <p className="body-soft mx-auto mt-3 max-w-md" style={{ fontSize: 16 }}>
            If you'd like to revisit your business cards, please get in touch.
          </p>
        </div>
      </div>
    </div>
  )
}
