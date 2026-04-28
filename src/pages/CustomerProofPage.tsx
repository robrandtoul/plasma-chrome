import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { PublicProof, PublicProofVersion, PublicMaterialOption, PublicMaterialOptionSurcharge, PublicPriceTier, PublicMaterialVariant } from '../lib/types'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import type { ProofEventState } from '../lib/types'
import { formatPrice } from '../lib/currency'
import { type GridImage } from '../components/ImageGrid'
import { getPublicSettings, type PublicSettings } from '../lib/publicSettings'
import type { PricingSnapshot, PricingVariant, Currency } from '../lib/types'

export default function CustomerProofPage() {
  const { id } = useParams<{ id: string }>()

  const [proof, setProof] = useState<PublicProof | null>(null)
  const [versions, setVersions] = useState<PublicProofVersion[]>([])
  const [activeVersion, setActiveVersion] = useState<PublicProofVersion | null>(null)
  const [versionImages, setVersionImages] = useState<Record<string, GridImage[]>>({})
  const [materialOptions, setMaterialOptions] = useState<PublicMaterialOption[]>([])
  const [optionSurcharges, setOptionSurcharges] = useState<PublicMaterialOptionSurcharge[]>([])
  // Live pricing — replaces the proof_versions.pricing_snapshot
  // read since Phase 2 (migration 000117). Both lists cover every
  // material × currency referenced by this proof's versions; the
  // active version's pricing snapshot shape is rebuilt from these
  // rows in livePricingSnapshot below.
  const [tierRows, setTierRows] = useState<PublicPriceTier[]>([])
  const [variantRows, setVariantRows] = useState<PublicMaterialVariant[]>([])
  const [activeOptionCode, setActiveOptionCode] = useState<string | null>(null)
  const [publicSettings, setPublicSettings] = useState<PublicSettings | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  // Guards the once-per-page-load proof_version_views insert. A
  // ref survives React strict-mode's double-invoke of effects
  // whereas state wouldn't.
  const viewRecordedRef = useRef(false)
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
  const [actionPanel, setActionPanel] = useState<
    | { versionId: string; name: string; type: 'approve' | 'request_changes' }
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

  useEffect(() => {
    if (!id) { setNotFound(true); return }
    loadProof(id)
  }, [id])

  useEffect(() => {
    if (!lightboxSrc) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxSrc(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightboxSrc])

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
    if (!activeVersion || viewRecordedRef.current) return
    const versionId = activeVersion.id
    const t = window.setTimeout(() => {
      if (viewRecordedRef.current) return
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
      viewRecordedRef.current = true
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

  function openActionPanel(
    versionId: string,
    recipientName: string,
    type: 'approve' | 'request_changes',
  ) {
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
  }

  function closeActionPanel() {
    setActionPanel(null)
    setActionError(null)
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
          // doesn't have to distinguish absent-vs-null.
          material_option_code: activeOptionCode ?? null,
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
      // the post-action state keyed on (versionId, name) so other
      // bands stay independent. The next page load picks the same
      // shape from approvals[] + latest_events_by_name on the view.
      const verb = actionPanel.type === 'approve' ? 'approval' : 'change request'
      const message =
        result.status === 'partial'
          ? `Thanks, ${name}. Your ${verb} has been recorded, but we couldn't notify the team automatically. To make sure they see it, please also reply to the email you received with this proof link.`
          : `Thanks, ${name}. Your ${verb} has been recorded and the team has been notified.`
      const key = bandKey(actionPanel.versionId, actionPanel.name)
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
      closeActionPanel()
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

    const [proofResult, versionsResult, settingsResult] = await Promise.all([
      supabase.from('public_proofs').select('*').eq('id', proofId).maybeSingle(),
      supabase.from('public_proof_versions').select('*').eq('proof_id', proofId).order('version_number', { ascending: true }),
      getPublicSettings(),
    ])

    if (proofResult.error || !proofResult.data) {
      setNotFound(true)
      setLoading(false)
      return
    }

    const freshProof = proofResult.data as PublicProof
    setProof(freshProof)
    setPublicSettings(settingsResult)

    const rawVersions = (versionsResult.data ?? []) as PublicProofVersion[]
    setVersions(rawVersions)
    const initialVersion = rawVersions.find((v) => v.is_current) ?? rawVersions[rawVersions.length - 1] ?? null
    setActiveVersion(initialVersion)

    // Customer view tracking happens in the proof_version_views
    // table via the record_proof_view RPC fired below (after a
    // 2.5s settle delay). The previous duplicate write to
    // audit_log via logCustomerEvent has been removed alongside
    // the dropped log_customer_event RPC (audit finding H2).

    if (rawVersions.length > 0) {
      // Load images for every version of this proof. Images come
      // from the customer-proof-images edge function (anon-callable)
      // which validates the proof exists and signs URLs server-side
      // using service-role. Replaces the previous direct
      // storage.from('proof-images').createSignedUrl(...) loop;
      // closes audit finding H1 (anon storage path enumeration)
      // by removing the customer-side need for an anon SELECT
      // policy on storage.objects.
      const { data: imgData, error: imgError } = await supabase.functions.invoke<{ images: GridImage[] }>(
        'customer-proof-images',
        { body: { proofId } },
      )
      if (imgError || !imgData?.images) {
        // Graceful failure: render the page without images rather
        // than blocking the whole load. The function itself does
        // per-image graceful degradation; this branch covers
        // hard failures (network, function error).
        setVersionImages({})
      } else {
        const byVersion: Record<string, GridImage[]> = {}
        imgData.images.forEach((img) => {
          // proof_version_id rides on the row but isn't in the
          // GridImage type. Same shape (and same cast pattern) as
          // the pre-shipment direct-fetch path.
          const pvid = (img as unknown as { proof_version_id: string }).proof_version_id
          if (!byVersion[pvid]) byVersion[pvid] = []
          byVersion[pvid].push(img)
        })
        setVersionImages(byVersion)
      }

      // Load material options for every material referenced by these versions
      const materialIds = [...new Set(rawVersions.map(v => v.material_id))]
      const { data: optionRows } = await supabase
        .from('public_material_options')
        .select('*')
        .in('material_id', materialIds)
        .order('sort_order')

      const loadedOptions = (optionRows ?? []) as PublicMaterialOption[]
      setMaterialOptions(loadedOptions)

      if (loadedOptions.length > 0) {
        const optionIds = loadedOptions.map(o => o.id)
        const { data: surchargeRows } = await supabase
          .from('public_material_option_surcharges')
          .select('*')
          .in('material_option_id', optionIds)
        setOptionSurcharges((surchargeRows ?? []) as PublicMaterialOptionSurcharge[])
      }

      // Live pricing (Phase 2, migration 000117). Mirrors the
      // material_options + option_surcharges sequential pattern
      // above: variants first, then tier rows scoped to those
      // variant IDs and the currencies this proof's versions use.
      // The per-version PricingSnapshot shape is rebuilt on the fly
      // in livePricingSnapshot below, so InkPricingTable's render
      // code stays unchanged.
      const { data: variantData } = await supabase
        .from('public_material_variants')
        .select('*')
        .in('material_id', materialIds)
        .order('sort_order')
      const loadedVariants = (variantData ?? []) as PublicMaterialVariant[]
      setVariantRows(loadedVariants)

      if (loadedVariants.length > 0) {
        const currencies = [...new Set(rawVersions.map(v => v.currency))]
        const variantIds = loadedVariants.map(v => v.id)
        const { data: tierData } = await supabase
          .from('public_price_tiers')
          .select('*')
          .in('material_variant_id', variantIds)
          .in('currency', currencies)
        setTierRows((tierData ?? []) as PublicPriceTier[])
      }
    }

    setLoading(false)
  }

  if (loading) return <LoadingScreen />
  if (notFound || !proof) return <NotFoundScreen />
  if (proof.status === 'abandoned') return <AbandonedScreen proof={proof} />

  const isApproved = proof.status === 'approved'
  const viewingApprovedVersion = isApproved && activeVersion?.is_current === true

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
    const event: ProofEventState | undefined =
      activeVersion.latest_events_by_name.find(
        (e) =>
          e.name === name ||
          (name === SHARED_APPROVAL_KEY && e.name == null),
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

    // Banner layouts per state. Light theme — sits inside the
    // PAPER-backed proofs section so the editorial register is
    // preserved.
    const bannerBase =
      'mt-6 flex flex-col gap-2 rounded-md px-5 py-4 text-[#1a1612]'
    const KICKER_STYLE = {
      fontFamily: MONO,
      fontSize: 11,
      letterSpacing: '0.22em',
    } as const
    const BODY_STYLE = { fontFamily: SERIF, fontWeight: 400, fontSize: 18, lineHeight: 1.35 } as const

    if (state.kind === 'optimistic') {
      const approved = state.type === 'approve'
      return (
        <div
          className={bannerBase}
          style={{
            background: approved ? 'rgba(74,222,128,0.14)' : 'rgba(229,114,49,0.12)',
            border: `1px solid ${approved ? 'rgba(74,222,128,0.45)' : 'rgba(229,114,49,0.45)'}`,
          }}
        >
          <span
            className="uppercase"
            style={{ ...KICKER_STYLE, color: approved ? '#1e7a3e' : '#a04116' }}
          >
            {(approved ? 'APPROVED' : 'CHANGES REQUESTED') + (named ? ` FOR ${name}` : '')}
          </span>
          <span style={BODY_STYLE}>
            by {state.actorName}
            {formatBandDate(state.createdAt) ? ` on ${formatBandDate(state.createdAt)}` : ''}.
          </span>
          {state.comment && (
            <p className="text-[14px] leading-[1.55] text-[#1a1612]/80" style={{ fontFamily: SANS }}>
              "{state.comment}"
            </p>
          )}
          {successMessage && (
            <p className="text-[13px] leading-[1.55] text-[#1a1612]/70" style={{ fontFamily: SANS }}>
              {successMessage}
            </p>
          )}
        </div>
      )
    }

    if (state.kind === 'carried') {
      const subtitle =
        state.carriedFromVersionNumber != null
          ? `Approved (carried from v${state.carriedFromVersionNumber})`
          : 'Approved (carried from a previous version)'
      return (
        <div
          className={bannerBase}
          style={{
            background: 'rgba(74,222,128,0.08)',
            border: '1px solid rgba(74,222,128,0.30)',
          }}
        >
          <span className="uppercase" style={{ ...KICKER_STYLE, color: '#1e7a3e' }}>
            {('Approved' + forSuffix).toUpperCase()}
          </span>
          <span style={{ ...BODY_STYLE, fontSize: 15, color: '#1a1612' }}>
            {subtitle}
          </span>
        </div>
      )
    }

    if (state.kind === 'approved' || state.kind === 'changes_requested') {
      const approved = state.kind === 'approved'
      return (
        <div
          className={bannerBase}
          style={{
            background: approved ? 'rgba(74,222,128,0.14)' : 'rgba(229,114,49,0.12)',
            border: `1px solid ${approved ? 'rgba(74,222,128,0.45)' : 'rgba(229,114,49,0.45)'}`,
          }}
        >
          <span
            className="uppercase"
            style={{ ...KICKER_STYLE, color: approved ? '#1e7a3e' : '#a04116' }}
          >
            {(approved ? 'APPROVED' : 'CHANGES REQUESTED') + (named ? ` FOR ${name}` : '')}
          </span>
          {(state.actorName || state.createdAt) && (
            <span style={BODY_STYLE}>
              {state.actorName ? `by ${state.actorName}` : ''}
              {state.actorName && formatBandDate(state.createdAt) ? ' ' : ''}
              {formatBandDate(state.createdAt)
                ? `${state.actorName ? 'on' : 'On'} ${formatBandDate(state.createdAt)}`
                : ''}
              .
            </span>
          )}
          {state.comment && (
            <p className="text-[14px] leading-[1.55] text-[#1a1612]/80" style={{ fontFamily: SANS }}>
              "{state.comment}"
            </p>
          )}
        </div>
      )
    }

    // pending — render the two buttons
    const approveLabel = `Approve ${recipientLabel}${named ? "'s design" : ''}`
    return (
      <div className="mt-6 flex flex-col gap-3 sm:items-start">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => openActionPanel(activeVersion.id, name, 'approve')}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = CTA_TEAL_HOVER
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = CTA_TEAL
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.background = CTA_TEAL_PRESSED
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.background = CTA_TEAL_HOVER
            }}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md px-6 py-3 text-white transition-colors focus-visible:outline-none focus-visible:ring-2"
            style={{
              background: CTA_TEAL,
              fontFamily: MONO,
              fontSize: 11,
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              // Focus ring uses CTA_TEAL_RING (the brighter brand
              // teal at 50% alpha) — overrides Tailwind's default
              // ring colour so the focus state matches the resting
              // primary fill.
              ['--tw-ring-color' as string]: CTA_TEAL_RING,
            }}
          >
            {approveLabel}
          </button>
          <button
            type="button"
            onClick={() => openActionPanel(activeVersion.id, name, 'request_changes')}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = CTA_GHOST_HOVER_BG
              e.currentTarget.style.borderColor = CTA_GHOST_HOVER_BORDER
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.borderColor = CTA_GHOST_BORDER
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.background = CTA_GHOST_PRESSED_BG
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.background = CTA_GHOST_HOVER_BG
            }}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md px-6 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2"
            style={{
              background: 'transparent',
              border: `1px solid ${CTA_GHOST_BORDER}`,
              color: CTA_GHOST_TEXT,
              fontFamily: MONO,
              fontSize: 11,
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              ['--tw-ring-color' as string]: CTA_TEAL_RING,
            }}
          >
            Request changes
          </button>
        </div>
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

  // Derived: options for the currently-viewed version.
  const versionOptions = activeVersion?.material_options ?? []
  const showOptionSwitcher = versionOptions.length >= 2
  const activeOption = activeOptionCode && activeVersion
    ? materialOptions.find(o => o.material_id === activeVersion.material_id && o.code === activeOptionCode) ?? null
    : null

  // Filter images for the active option (if this version is in option mode)
  const allVersionImages = activeVersion ? (versionImages[activeVersion.id] ?? []) : []
  const displayImages = versionOptions.length > 0 && activeOptionCode
    ? allVersionImages.filter(img => img.material_option === activeOptionCode || img.material_option == null)
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

  // Per-quantity surcharge map for the active option, baked into every
  // pricing cell. Empty for base options or materials with no surcharges
  // (e.g. wood species).
  const quantitySurcharges: Record<number, number> = {}
  if (activeOption && activeVersion) {
    optionSurcharges
      .filter(s => s.material_option_id === activeOption.id && s.currency === activeVersion.currency)
      .forEach(s => { quantitySurcharges[s.quantity] = s.surcharge })
  }

  // Smallest-quantity surcharge for a given option in the active currency,
  // or null if this option carries no surcharge (base/Natural, or wood).
  function optionFromPrice(code: string): number | null {
    if (!activeVersion) return null
    const o = materialOptions.find(x => x.material_id === activeVersion.material_id && x.code === code)
    if (!o) return null
    const sorted = optionSurcharges
      .filter(s => s.material_option_id === o.id && s.currency === activeVersion.currency)
      .sort((a, b) => a.quantity - b.quantity)
    const first = sorted[0]
    return first && first.surcharge > 0 ? first.surcharge : null
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

  // ── Editorial treatment tokens (Variant B) ────────────────────
  // Deep ink hero + pricing. Near-white "paper" for plates +
  // Important info + About sections. Universal indigo accent
  // (brand-sympathetic — sampled from the Plasma logomark).
  // Approval semantic owns green. Brand 4-colour motif appears
  // as a hair-thin signature rule under the masthead, above the
  // footer, and as rotating dots on plate captions.
  const INK = '#141210'
  const INK_DEEP = '#0f0d0b'
  const PAPER = '#f7f6f2'
  const PAPER_BORDER = 'rgba(26,22,18,0.12)'
  const ACCENT = '#7b3ff2'
  const ACCENT_GLOW = 'rgba(123,63,242,0.55)'
  // Customer-CTA palette (deep teal). Scoped to the per-recipient
  // Approve / Request changes action band + the modal Confirm
  // button — kept separate from the page-wide ACCENT (which is the
  // editorial purple used on the masthead glow, plate cards,
  // version dots, blockquote marks, etc) so the brand register on
  // the rest of the page is untouched. If the designer dashboard
  // ever wants the same teal CTA, it can opt in to these tokens
  // explicitly rather than inheriting via a shared name.
  const CTA_TEAL          = '#2F7A60'
  const CTA_TEAL_HOVER    = '#3D8C72'
  const CTA_TEAL_PRESSED  = '#26644F'
  const CTA_TEAL_RING     = 'rgba(81,180,148,0.5)'
  // Secondary (Request changes) — firmer than the previous near-
  // invisible grey so it doesn't disappear next to the new
  // confident teal primary.
  const CTA_GHOST_BORDER  = '#B8A99A'
  const CTA_GHOST_TEXT    = '#5F564D'
  const CTA_GHOST_HOVER_BG = '#FAF7F2'
  const CTA_GHOST_PRESSED_BG = '#F2EDE4'
  const CTA_GHOST_HOVER_BORDER = '#9F8E7E'
  const APPROVED_GREEN = '#4ade80'
  const BRAND_ORDER = ['#e11735', '#d81c7e', '#4a21a6', '#3ba58a']
  const SERIF = "'Cormorant Garamond', Georgia, serif"
  const SANS = "'Inter Tight', system-ui, sans-serif"
  const MONO = "'JetBrains Mono', ui-monospace, monospace"
  // Customer-page typographic registers. Replace the small
  // uppercase-mono treatment for short editorial labels (Register
  // A) and sentence-fragment text (Register B). Mono stays for
  // CTA buttons, pricing-grid numerals, file names, segmented
  // pill toggles, the DOWNLOAD chip, and the FRONT/BACK side
  // label — all locked-in keep-on-mono per the inventory.
  const REG_A_BASE = {
    fontFamily: SANS,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
  }
  const REG_B_BASE = {
    fontFamily: SANS,
    letterSpacing: '-0.005em',
  }
  // Surface colour palette for the new registers. Dark sections
  // use #C8C8C8 for primary labels (one stop above the previous
  // text-white/45 ≈ #737373); light cream sections use #5F564D
  // for primary, #3F362D for kickers needing more presence.
  // Coloured highlights (status pills, brand-teal kickers) keep
  // their existing colour and only swap typography — the brief
  // is explicit on that.
  const LABEL_DARK = '#c8c8c8'
  const LABEL_LIGHT = '#5f564d'
  const LABEL_DARK_MUTED = 'rgba(255,255,255,0.55)'

  // Short customer-facing reference — the proof's Help Scout
  // conversation id, prefixed with PL · for the editorial feel.
  // Exposed on public_proofs by migration 000089. Hidden
  // entirely when null (override proofs with no linked HS
  // thread, per migration 000067) rather than falling back to
  // a synthesised value — mixed formats in the same badge
  // spot read worse than just not rendering.
  const proofRef = proof.helpscout_conversation_id
    ? `PL · ${proof.helpscout_conversation_id}`
    : null

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

  return (
    <div className="antialiased" style={{ fontFamily: SANS, background: INK }}>

      {/* ───── Top: deep ink hero ─────
          Masthead (logo + brand rule) → approval strip →
          editorial hero (customer name + facts) → Revisions
          tabs + option switcher. Flat ink backdrop with a
          subtle top-down gradient easing from a slightly
          warmer near-black (#1b1725) at the top into INK at
          the bottom. Calmer than the earlier dual-glow /
          conic-brand treatment; lets the hero typography
          carry the section without chromatic noise behind
          it. */}
      <div className="relative overflow-hidden text-white" style={{ background: INK }}>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: `linear-gradient(180deg, #1b1725 0%, ${INK} 100%)` }}
        />
        <div className="relative">

          {/* Masthead */}
          <div className="border-b border-white/10">
            <div className="mx-auto flex max-w-[1040px] flex-wrap items-center justify-between gap-3 px-6 py-5 sm:px-8">
              <div className="flex items-center gap-3">
                <img
                  src="/logo-cards.png"
                  alt="Plasma"
                  className="h-10 w-auto"
                  style={{ filter: `drop-shadow(0 0 18px ${ACCENT_GLOW})` }}
                />
                <span className="ml-1 h-4 w-px bg-white/20" />
                <span style={{ ...REG_A_BASE, color: LABEL_DARK }}>
                  Proof Viewer
                </span>
              </div>
              <div className="flex items-center gap-5">
                {/* Masthead right-side = proof reference only.
                    The material + variant composite that used
                    to ride here was dropped — the hero facts
                    row, revisions finish-picker, and spec sheet
                    already carry the same information three
                    times below. */}
                {proofRef && (
                  <span style={{ ...REG_A_BASE, color: LABEL_DARK }}>
                    {proofRef}
                  </span>
                )}
              </div>
            </div>
            {/* Brand 4-colour signature rule — quiet echo of the
                Plasma logomark palette. Hair-thin, sits between
                the masthead and the approval strip below. */}
            <div className="flex h-[2px] w-full">
              {BRAND_ORDER.map((c, i) => (
                <div key={i} className="flex-1" style={{ background: c }} />
              ))}
            </div>
          </div>

          {/* Hero — approval chip (when applicable) + "Proofs for"
              eyebrow + customer name + italic company + quick-
              facts row (material / revision / names). Scaled so
              the name reads as the page's dominant object at
              61px. The approval chip sits INSIDE the hero,
              above the eyebrow, so it's the first thing the
              customer sees on landing — replaces the old
              between-masthead-and-hero banner. */}
          <div className="mx-auto max-w-[1040px] px-6 py-20 sm:px-8">
            {/* Approval-chip slot — always rendered as a
                fixed-height wrapper regardless of approval
                state, so switching versions via the revisions
                timeline (approved ↔ unapproved) doesn't shift
                the "Proofs for" eyebrow + customer name up
                and down.
                Desktop (sm+): h-7 dot (28px) + py-2 vertical
                padding (16px) + 1px top border + 1px bottom
                border = 46px single-row pill. sm:min-h-[46px]
                matches that exactly.
                Mobile (<sm): the c521f7c restructure stacks
                the chip vertically — dot/label cluster on
                row 1, secondary text on row 2. Height adds
                the second row's ~18px line-height + 8px
                inter-row gap (~72px baseline). At narrow
                viewports the secondary text wraps to 2 lines
                (partial-approval copy, or approved copy
                below ~390px) pushing rendered height to
                ~90px. min-h-[120px] reserves floor above
                that worst case so the layout stays locked
                across approved ↔ unapproved flips on phone;
                a few extra pixels of empty dark ink when
                unapproved is invisible, whereas
                under-reserving brings the jump back.
                display: flex (not default block) keeps the
                chip out of line-box formatting so baseline-
                alignment + ambient line-height don't add
                half-leading on top of the box. */}
            <div className="mb-10 flex min-h-[120px] items-start sm:min-h-[46px]">
              {heroApprovalStrip && activeVersion && (() => {
                const total = versionImages[activeVersion.id]?.length ?? 0
                const isApprovedKind = heroApprovalStrip.kind === 'approved'
                // Colour tokens for the chip. Green for full
                // approval, sky-blue for the carry-forward
                // partial state — same palette the old banner
                // used, now in one unified chip pattern.
                const tone = isApprovedKind
                  ? {
                      bg: 'rgba(74,222,128,0.1)',
                      border: 'rgba(74,222,128,0.4)',
                      glow: '0 0 32px rgba(74,222,128,0.18)',
                      dotBg: APPROVED_GREEN,
                      dotGlow: '0 0 14px rgba(74,222,128,0.5)',
                      label: APPROVED_GREEN,
                      divider: 'rgba(74,222,128,0.3)',
                    }
                  : {
                      bg: 'rgba(125,211,252,0.1)',
                      border: 'rgba(125,211,252,0.4)',
                      glow: '0 0 32px rgba(125,211,252,0.18)',
                      dotBg: '#7dd3fc',
                      dotGlow: '0 0 14px rgba(125,211,252,0.5)',
                      label: '#7dd3fc',
                      divider: 'rgba(125,211,252,0.3)',
                    }
                return (
                  // Stacks vertically at narrow viewports —
                  // dot + label cluster on one row, secondary
                  // text on the next — so the secondary text
                  // doesn't wrap awkwardly inside a single-row
                  // pill and leave the | separator orphaned.
                  // At sm+ the layout returns to the original
                  // single-row pattern verbatim.
                  //
                  // Mobile also swaps the shape tokens:
                  //   * rounded-3xl (24px) instead of the
                  //     desktop's rounded-full semicircle —
                  //     straightens the pill's top/bottom
                  //     edges so the stacked content isn't
                  //     fighting a tight curve.
                  //   * pl-4 pr-6 instead of the desktop's
                  //     tight pl-2 pr-5 — gives the tick
                  //     circle and the end of the secondary
                  //     text real breathing room from the
                  //     inner edges. Desktop padding stays
                  //     asymmetric because the dot sits flush
                  //     against the semicircle's curve.
                  <div
                    className="inline-flex flex-col items-start gap-2 rounded-3xl py-2 pl-4 pr-6 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4 sm:rounded-full sm:pl-2 sm:pr-5"
                    style={{
                      background: tone.bg,
                      border: `1px solid ${tone.border}`,
                      boxShadow: tone.glow,
                    }}
                  >
                    {/* Dot + label cluster — always stays
                        inline regardless of viewport so the
                        mobile stacked shape is a clean 2-row
                        layout rather than dot / label / text
                        on three separate rows. */}
                    <div className="flex items-center gap-4">
                      <span
                        aria-hidden
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full"
                        style={{ background: tone.dotBg, boxShadow: tone.dotGlow }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <path
                            d="M3 7L6 10L11 4"
                            stroke="white"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      <span style={{ ...REG_A_BASE, color: tone.label }}>
                        {isApprovedKind ? 'Approved' : 'Partially approved'}
                      </span>
                    </div>
                    {/* Divider — only meaningful between
                        adjacent inline items on the desktop
                        row. Hidden (display:none) on mobile so
                        it both disappears visually and drops
                        out of the flex layout (no ghost gap). */}
                    <span
                      aria-hidden
                      className="hidden h-4 w-px shrink-0 sm:inline-block"
                      style={{ background: tone.divider }}
                    />
                    <span style={{ ...REG_A_BASE, color: LABEL_DARK }}>
                      {isApprovedKind
                        ? `Signed off ${heroApprovalStrip.dateLabel ?? 'today'} · ${total} / ${total} proof${total === 1 ? '' : 's'}`
                        : 'Some proofs already signed off, others awaiting review'}
                    </span>
                  </div>
                )
              })()}
            </div>
            <p style={{ ...REG_A_BASE, color: LABEL_DARK }}>
              {(activeVersion?.names?.length ?? 0) >= 2 ? 'Proofs for' : 'Proof for'}
            </p>
            {/* Masthead heading rule: when the customer is a
                company, promote the company name to the prominent
                serif H1 and demote the contact's full name to the
                italic sub-line. When there is no company, fall back
                to the contact name in the prominent slot with no
                sub-line.
                Truthy check trims so an empty or whitespace-only
                company string falls back to contact-prominent. The
                sub-line is suppressed when the demoted value is
                also empty or whitespace, so the masthead never
                renders a stranded italic line. */}
            {(() => {
              const trimmedCompany = proof.company?.trim() ?? ''
              const trimmedName = proof.customer_name?.trim() ?? ''
              const companyProminent = trimmedCompany.length > 0
              const primary = companyProminent ? proof.company! : proof.customer_name
              const subline = companyProminent && trimmedName.length > 0
                ? proof.customer_name
                : null
              return (
                <>
                  <h1
                    className="mt-4 leading-[0.98] tracking-[-0.015em] text-white"
                    style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 61 }}
                  >
                    {primary}
                  </h1>
                  {subline && (
                    <p
                      className="mt-3 italic text-white/55"
                      style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 28 }}
                    >
                      {subline}
                    </p>
                  )}
                </>
              )
            })()}

            {activeVersion && (
              <div className="mt-10 flex flex-wrap items-start gap-x-10 gap-y-5">
                <div>
                  <p style={{ ...REG_A_BASE, color: LABEL_DARK }}>
                    Material
                  </p>
                  <p className="mt-1.5 flex items-center gap-2 text-[14px] text-white">
                    <span
                      className="h-[9px] w-[9px] rounded-full"
                      style={{ background: ACCENT, boxShadow: `0 0 14px ${ACCENT}` }}
                    />
                    {activeVersion.material_display}
                  </p>
                </div>
                <div>
                  <p style={{ ...REG_A_BASE, color: LABEL_DARK }}>
                    Revision
                  </p>
                  <p className="mt-1.5 text-[14px] text-white">
                    v{activeVersion.version_number}
                    {heroRevisionDate ? ` · ${heroRevisionDate}` : ''}
                  </p>
                </div>
                {activeVersion.names.length > 0 && (
                  <div>
                    <p style={{ ...REG_A_BASE, color: LABEL_DARK }}>
                      {activeVersion.names.length >= 2 ? 'Names' : 'Name'}
                    </p>
                    <p className="mt-1.5 text-[14px] text-white">
                      {formatNamesList(activeVersion.names)}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ───── Revision history band ─────
          Dedicated zone below the hero — a header row, a
          spotlight column showing the active v-number + Latest/
          History chip + date, and the timeline rail. Coachmark
          overlays the rail on first visit to teach the rail
          interaction (localStorage-persisted, dismisses on
          × click or any dot click). Rationale for finish
          pills NOT living here: they change which proofs are
          visible, so they belong adjacent to the proofs in
          the Plates section header — not grouped with
          time-based revision metadata. */}
      {activeVersion && versions.length > 1 && (
        <RevisionsBand
          versions={versions}
          activeVersion={activeVersion}
          onSelectVersion={setActiveVersion}
          tokens={{
            ink: INK,
            inkDeep: INK_DEEP,
            accent: ACCENT,
            accentGlow: ACCENT_GLOW,
            approvedGreen: APPROVED_GREEN,
            serif: SERIF,
            mono: MONO,
          }}
        />
      )}

      {activeVersion && (
        <>
          {/* ───── Plates ─────
              Near-white section. Groups come from buildImageGroups
              (shared first, then named); each named group gets a
              section heading + approval pill (when an approved
              approval row exists on the current version) and a
              grid of numbered plates. Plate numbers pick up one
              of the four brand colours in rotation — a quiet
              echo of the logomark across the grid. */}
          {(() => {
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

            // Proof-count subtext reads the project's true
            // image count — count each shared image once, not
            // per injected instance. Keeps "N proofs · M
            // recipients" accurate when a single shared front
            // renders inside two named pairs.
            const plateCount = [...(sharedGroup?.images ?? []), ...namedGroups.flatMap((g) => g.images)].length
            const recipientCount = namedGroups.length || (sharedGroup ? 1 : 0)

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
              <section style={{ background: PAPER, color: '#1a1612' }}>
                <div className="mx-auto max-w-[1040px] px-6 py-20 sm:px-8 sm:py-24">
                  {/* Section header — left cluster is the
                      Proofs heading + count subtitle stacked
                      vertically; right cluster is the Finish
                      selector. Finish pills live here (not in
                      the revisions band) because they change
                      which proofs are visible, so they belong
                      adjacent to the proofs they affect rather
                      than grouped with time-based revision
                      metadata. items-end so the pill row hugs
                      the bottom edge of the heading cluster
                      regardless of whether the subtitle
                      renders. */}
                  <div
                    className="mb-10 flex flex-wrap items-end justify-between gap-4 pb-4"
                    style={{ borderBottom: `1px solid ${PAPER_BORDER}` }}
                  >
                    <div>
                      <h2
                        className="leading-none text-[#1a1612]"
                        style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                      >
                        Proofs
                      </h2>
                      {/* Count subtitle — rendered for business
                          cards only. Membership cards hide the
                          whole line (the "proof count vs
                          people" framing doesn't map to
                          membership tiers). The special
                          "Shared" branch survives for the rare
                          all-shared business card (shared group
                          only, no named groups). */}
                      {activeVersion.card_type !== 'membership' && (
                        <span
                          className="mt-3 block"
                          style={{ ...REG_A_BASE, color: LABEL_LIGHT }}
                        >
                          {plateCount === 1 ? '1 unique proof' : `${plateCount} unique proofs`}
                          {recipientCount > 0 && (
                            <>
                              {' · '}
                              {recipientCount === 1
                                ? sharedGroup && namedGroups.length === 0
                                  ? 'Shared'
                                  : '1 person'
                                : `${recipientCount} people`}
                            </>
                          )}
                        </span>
                      )}
                    </div>
                    {/* Finish selector — segmented pill group
                        on a faint ink-tinted surface so it
                        reads as a control rather than
                        decoration. Active pill swaps to solid
                        ink with white text; inactive pills
                        stay ink-at-70% and brighten on hover.
                        Surcharge suffix ("+£49") is preserved
                        from the pre-move rendering so customers
                        still see the cost delta, just in a
                        tighter form. */}
                    {showOptionSwitcher && (
                      <div className="flex flex-wrap items-center gap-3">
                        <span style={{ ...REG_A_BASE, color: LABEL_LIGHT }}>
                          {optionLabelSingular}
                        </span>
                        <div
                          className="inline-flex flex-wrap items-center gap-1 rounded-full p-1"
                          style={{
                            background: 'rgba(26,22,18,0.05)',
                            border: `1px solid ${PAPER_BORDER}`,
                          }}
                        >
                          {versionOptions.map((code) => {
                            const o = materialOptions.find(
                              (x) =>
                                x.material_id === activeVersion.material_id &&
                                x.code === code,
                            )
                            const isActive = activeOptionCode === code
                            const fromPrice = optionFromPrice(code)
                            return (
                              <button
                                key={code}
                                type="button"
                                onClick={() => setActiveOptionCode(code)}
                                className={[
                                  'rounded-full px-3 py-1 uppercase tracking-[0.22em] transition-colors',
                                  isActive
                                    ? 'text-white'
                                    : 'text-[#1a1612]/70 hover:text-[#1a1612]',
                                ].join(' ')}
                                style={{
                                  fontFamily: MONO,
                                  fontSize: 11,
                                  ...(isActive ? { background: '#1a1612' } : {}),
                                }}
                              >
                                {o?.display_name ?? code}
                                {fromPrice != null && !activeVersion.custom_quote && (
                                  <span
                                    className="ml-1.5"
                                    style={{
                                      color: isActive
                                        ? 'rgba(255,255,255,0.7)'
                                        : 'rgba(26,22,18,0.45)',
                                    }}
                                  >
                                    +{formatPrice(fromPrice, activeVersion.currency, 0)}
                                  </span>
                                )}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Shared group — renders alone when there
                      are unconsumed shared images (either no
                      named groups exist, or named groups exist
                      but didn't need every shared image for
                      virtual pairing). Heading stays suppressed;
                      the approval banner in the hero strip
                      carries that signal. Width matches the
                      named groups below for a consistent
                      section-wide image size. */}
                  {sharedStandaloneGroup && (
                    <div
                      className={[
                        'w-full',
                        augmentedNamedGroups.length > 0 ? 'mb-14' : '',
                      ].join(' ')}
                    >
                      <div
                        className={
                          groupIsPair(sharedStandaloneGroup)
                            ? 'grid grid-cols-1 gap-6 md:grid-cols-2'
                            : 'space-y-6'
                        }
                      >
                        {sharedStandaloneGroup.images.map((img, idx) => (
                          <PlateCard
                            key={img.id}
                            image={img}
                            brandColor={BRAND_ORDER[idx % BRAND_ORDER.length]}
                            accent={ACCENT}
                            alt={`Proof version ${activeVersion.version_number}`}
                            onClick={setLightboxSrc}
                          />
                        ))}
                      </div>
                      {/* Phase 2.5: shared-section action band, only
                          rendered when there's no per-recipient list
                          to attach bands to (membership / single-
                          design proofs). When named groups are
                          present, the shared images are virtual-
                          paired into each named group's card and
                          their per-recipient band carries the action
                          surface — a separate shared band would
                          duplicate. */}
                      {augmentedNamedGroups.length === 0 &&
                        renderActionBand(SHARED_APPROVAL_KEY)}
                    </div>
                  )}

                  {augmentedNamedGroups.length > 0 && (
                    <div className="space-y-14">
                      {(() => {
                        // Running colour-rotation index across
                        // all groups in reading order so each
                        // rendered image-instance on the page
                        // gets a distinct bullet colour from
                        // BRAND_ORDER (red → pink → indigo →
                        // teal). Counted starts at the number of
                        // images actually rendered in the
                        // standalone shared section — NOT the
                        // full shared-group size — so shared
                        // images consumed into named groups via
                        // virtual pairing don't inflate the
                        // offset. A shared image injected into
                        // two different named groups therefore
                        // picks up two different colours (one
                        // per rendered instance), which keeps
                        // the palette cycling visibly across
                        // every card rather than clustering two
                        // cards onto the same hue.
                        let colorIdx = sharedStandaloneGroup
                          ? sharedStandaloneGroup.images.length
                          : 0
                        // When a shared-standalone group sits
                        // above the named-groups block, keep the
                        // rule + padding on the first named
                        // group too — treats the shared block as
                        // the preceding sibling so the shared →
                        // first-named boundary reads as a proper
                        // divider, not a floating introduction.
                        // When there's no shared block above,
                        // the first named group opens the list
                        // and shouldn't sit behind a rule
                        // (would read as a bracket).
                        const firstNamedGroupSkipsRule = !sharedStandaloneGroup
                        return augmentedNamedGroups.map((group) => {
                          const pill =
                            group.heading != null ? approvalPillFor(group.heading) : null
                          const startIdx = colorIdx
                          colorIdx += group.images.length
                          return (
                            <div
                              key={group.heading ?? ''}
                              // Hairline rule + symmetric padding
                              // between named groups so each
                              // recipient reads as its own block
                              // rather than blurring into the
                              // next via ambient whitespace. The
                              // rule sits at the top edge of
                              // each group's box; the surrounding
                              // space-y-14 on the parent gives
                              // 56px above the rule (margin) and
                              // the matching pt-14 here gives
                              // 56px below it, so the line floats
                              // centred in a 112px gap.
                              // first:* reset only applied when
                              // firstNamedGroupSkipsRule — i.e.
                              // when no shared block sits above
                              // the named list. With shared
                              // present, every named group
                              // (including the first) keeps the
                              // rule so shared → named reads as
                              // a proper section boundary.
                              className={[
                                'border-t border-[#1a1612]/20 pt-14',
                                firstNamedGroupSkipsRule ? 'first:border-t-0 first:pt-0' : '',
                              ].join(' ')}
                            >
                              <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
                                <h3
                                  className="text-[#1a1612]"
                                  style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 26 }}
                                >
                                  {group.heading}
                                </h3>
                                {pill && (
                                  <span
                                    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1"
                                    style={{
                                      ...REG_A_BASE,
                                      background: 'rgba(74,222,128,0.14)',
                                      color: '#1e7a3e',
                                      border: '1px solid rgba(74,222,128,0.45)',
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
                                        stroke="#1e7a3e"
                                        strokeWidth="1.8"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                    {pill}
                                  </span>
                                )}
                              </div>
                              <div
                                className={
                                  groupIsPair(group)
                                    ? 'grid grid-cols-1 gap-10 md:grid-cols-2'
                                    : 'space-y-10'
                                }
                              >
                                {group.images.map((img, localIdx) => {
                                  const dotIdx = startIdx + localIdx
                                  return (
                                    <PlateCard
                                      key={img.id}
                                      image={img}
                                      brandColor={BRAND_ORDER[dotIdx % BRAND_ORDER.length]}
                                      accent={ACCENT}
                                      alt={`${group.heading} — proof version ${activeVersion.version_number}`}
                                      onClick={setLightboxSrc}
                                    />
                                  )
                                })}
                              </div>
                              {/* Phase 2.5 per-recipient action band. */}
                              {group.heading != null && renderActionBand(group.heading)}
                            </div>
                          )
                        })
                      })()}
                    </div>
                  )}
                </div>
              </section>
            )
          })()}

          {/* ───── Specification + Notes on ink ─────
              Spec sheet is a two-column grid with the heading
              intro on the left and a hairline-ruled dl on the
              right. Notes block-quote sits below, separated by a
              top-border rule. Notes only render when the version
              has change_notes content. */}
          <section className="text-white" style={{ background: INK }}>
            <div className="mx-auto max-w-[1040px] px-6 py-20 sm:px-8 sm:py-24">
              <div className="grid gap-10 sm:grid-cols-[1fr_2fr] sm:gap-16">
                <div>
                  <h2
                    className="leading-[1.02] text-white"
                    style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                  >
                    Specification
                  </h2>
                  <p className="mt-5 max-w-[30ch] text-[14px] leading-[1.55] text-white/55">
                    The details captured in this proof. Final thickness, options, and quantity are confirmed when you place your order.
                  </p>
                </div>
                <dl className="border-t border-white/10">
                  <InkSpecRow label="Material" value={activeVersion.material_display} />
                  {/* Sides — derived from the image set. Two-sided
                      iff any image on the active version carries
                      side='back'; otherwise front only. Pre-
                      migration-000085 data with null sides reads
                      as front only, which matches the historic
                      single-sided proofs' reality. */}
                  <InkSpecRow
                    label="Sides"
                    value={
                      (versionImages[activeVersion.id] ?? []).some((img) => img.side === 'back')
                        ? 'Front and back'
                        : 'Front only'
                    }
                  />
                  {activeOption && (
                    <InkSpecRow label={optionLabelSingular} value={activeOption.display_name} />
                  )}
                  {activeVersion.ink_names.length > 0 && (
                    <InkSpecRow
                      label="Ink colours"
                      value={activeVersion.ink_names.join('\n')}
                    />
                  )}
                  {activeVersion.names.length > 0 && (
                    <InkSpecRow
                      label="Names on card"
                      value={activeVersion.names.join('\n')}
                    />
                  )}
                  <InkSpecRow
                    label="Revision"
                    value={`v${activeVersion.version_number}${heroRevisionDate ? ` · ${heroRevisionDate}` : ''}`}
                  />
                </dl>
              </div>

              {activeVersion.change_notes && (
                <div className="mt-20 grid gap-10 border-t border-white/10 pt-14 sm:grid-cols-[1fr_2fr] sm:gap-16">
                  <div>
                    <h2
                      className="leading-[1.02] text-white"
                      style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                    >
                      Notes
                    </h2>
                  </div>
                  <div>
                    <p
                      className="text-white"
                      style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 26, lineHeight: 1.4 }}
                    >
                      <span style={{ color: ACCENT }}>“</span>
                      <span className="whitespace-pre-line">{activeVersion.change_notes}</span>
                      <span style={{ color: ACCENT }}>”</span>
                    </p>
                    <p
                      className="mt-6"
                      style={{ ...REG_A_BASE, color: LABEL_DARK }}
                    >
                      — Plasma Design · v{activeVersion.version_number}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ───── Pricing ─────
              Darker ink section (#0f0d0b) — visually distinct
              from the spec section so the reader senses a
              landing page as they scroll. Table styled for the
              dark palette with mono numerals in the right-hand
              columns and a large serif quantity on the left.
              Custom-quote mode collapses the table to a quiet
              message. Split-name tooling callout + shipping
              footer ride along underneath. */}
          <section className="text-white" style={{ background: INK_DEEP }}>
            <div className="mx-auto max-w-[1040px] px-6 py-20 sm:px-8 sm:py-24">
              <div className="mb-10 flex flex-wrap items-baseline justify-between gap-3 border-b border-white/10 pb-4">
                <div>
                  <h2
                    className="leading-none text-white"
                    style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                  >
                    Pricing
                  </h2>
                </div>
                <div className="text-right">
                  {!activeVersion.custom_quote &&
                    activeOption &&
                    versionOptions.length > 0 &&
                    materialHasSurcharges && (
                      <p style={{ ...REG_A_BASE, color: LABEL_DARK }}>
                        Prices shown for {activeOption.display_name} {optionLabelSingular.toLowerCase()}
                      </p>
                    )}
                  {!activeVersion.custom_quote && (
                    <p
                      className="mt-1"
                      style={{ ...REG_A_BASE, color: LABEL_DARK }}
                    >
                      {activeVersion.currency}
                      {activeVersion.currency === 'GBP' ? ' · VAT included' : ''}
                    </p>
                  )}
                </div>
              </div>

              {activeVersion.custom_quote ? (
                <div className="py-6 text-center">
                  <p
                    className="mx-auto max-w-md text-white/70"
                    style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 22 }}
                  >
                    This proof requires a custom quote. We'll be in touch separately with pricing.
                  </p>
                </div>
              ) : (
                <InkPricingTable
                  snapshot={livePricingSnapshot}
                  currency={activeVersion.currency}
                  displayQuantities={activeVersion.display_quantities}
                  quoteMinQuantity={activeVersion.quote_min_quantity}
                  quoteMaxQuantity={activeVersion.quote_max_quantity}
                  quantitySurcharges={quantitySurcharges}
                  serif={SERIF}
                  mono={MONO}
                />
              )}

              {/* Split-name + shipping callouts — two side-by-
                  side cards on the ink. Split-name only renders
                  when there's an extra-name surcharge to apply;
                  shipping renders whenever the version has a
                  shipping_note set. Hidden in custom-quote mode
                  (no prices to modify). */}
              {!activeVersion.custom_quote &&
                (((activeVersion.names.length >= 2 &&
                  activeVersion.split_name_surcharge_snapshot != null &&
                  activeVersion.split_name_surcharge_snapshot > 0) ||
                  !!activeVersion.shipping_note)) && (
                  <div
                    className={[
                      'mt-8 grid gap-6',
                      activeVersion.names.length >= 2 &&
                      activeVersion.split_name_surcharge_snapshot != null &&
                      activeVersion.split_name_surcharge_snapshot > 0 &&
                      activeVersion.shipping_note
                        ? 'sm:grid-cols-2'
                        : 'sm:grid-cols-1',
                    ].join(' ')}
                  >
                    {activeVersion.names.length >= 2 &&
                      activeVersion.split_name_surcharge_snapshot != null &&
                      activeVersion.split_name_surcharge_snapshot > 0 && (
                        <div className="border border-white/10 p-6">
                          <p style={{ ...REG_A_BASE, color: ACCENT }}>
                            Split-name tooling
                          </p>
                          <p
                            className="mt-3 text-white"
                            style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 24, lineHeight: 1.25 }}
                          >
                            Add{' '}
                            <span style={{ fontFamily: MONO, fontSize: 20 }}>
                              {formatPrice(
                                (activeVersion.names.length - 1) *
                                  activeVersion.split_name_surcharge_snapshot,
                                activeVersion.currency,
                              )}
                            </span>{' '}
                            to the prices above
                          </p>
                          <p
                            className="mt-2"
                            style={{
                              ...REG_B_BASE,
                              fontSize: 13,
                              fontWeight: 400,
                              color: LABEL_DARK_MUTED,
                            }}
                          >
                            {activeVersion.names.length} names ×{' '}
                            {formatPrice(
                              activeVersion.split_name_surcharge_snapshot,
                              activeVersion.currency,
                            )}{' '}
                            tooling each beyond the first
                          </p>
                        </div>
                      )}
                    {activeVersion.shipping_note && (
                      <div className="border border-white/10 p-6">
                        <p style={{ ...REG_A_BASE, color: LABEL_DARK }}>
                          Shipping
                        </p>
                        <p
                          className="mt-3 whitespace-pre-line text-white"
                          style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 22, lineHeight: 1.3 }}
                        >
                          {activeVersion.shipping_note}
                        </p>
                      </div>
                    )}
                  </div>
                )}
            </div>
          </section>

          {/* ───── About {material} ─────
              Two-column layout: copy on the left, swatch orb on
              the right. Swatch gradient derived from the
              material display name (copper/steel/gold/etc) with
              an indigo fallback. Section only renders when the
              material has a description configured — if not,
              the section collapses silently. */}
          {activeVersion.material_description && (
            <section style={{ background: PAPER, color: '#1a1612' }}>
              {/* Outer padding matches the Plates section's
                  py-20 sm:py-24 rhythm now that the inner
                  pt-12 + border-top wrapper has been removed.
                  The ink-deep Pricing → PAPER About transition
                  already produces a strong visual break; an
                  additional hairline rule on top of that was
                  belt-and-braces and read as redundant. */}
              <div className="mx-auto max-w-[1040px] px-6 py-20 sm:px-8 sm:py-24">
                {/* Serif heading at the Plates size — keeps the
                    three near-white sections reading at equal
                    typographic weight. */}
                {/* Mono kicker above the h2 — editorial frame
                    for the About section. Always renders,
                    regardless of whether the material has
                    curated key_features, because it's section
                    chrome rather than feature-list chrome. */}
                <p className="mb-3" style={{ ...REG_A_BASE, color: ACCENT }}>
                  Material notes
                </p>
                <h2
                  className="leading-none text-[#1a1612]"
                  style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                >
                  About our {activeVersion.material_display.toLowerCase()} cards
                </h2>
                {/* Hairline ACCENT rule between heading and the
                    content grid. Replaces the grid's former mt-8
                    with its own vertical margins (mt-6 mb-5).
                    Pairs with the kicker as section chrome; both
                    render unconditionally. */}
                <div
                  aria-hidden
                  className="mt-6 mb-5 h-px w-12"
                  style={{ background: ACCENT }}
                />
                  {/* Balanced two-column grid at md+ (narrative
                      left, key features right). Stacks to a
                      single column below the breakpoint in
                      reading order: narrative → features. When
                      key_features is null or empty the right
                      column renders an empty <div>; the grid
                      keeps its two-column shape so narrative
                      width (max-w-[62ch]) stays stable and the
                      right side reads as deliberate breathing
                      room rather than the layout reshaping. */}
                  <div className="grid gap-10 md:grid-cols-2">
                    <p className="max-w-[62ch] whitespace-pre-line text-[15px] leading-[1.7] text-[#1a1612]/80">
                      {activeVersion.material_description}
                    </p>
                    <div>
                      {/* Numbered editorial key features list
                          (migration 000100). Each entry is a
                          {title, body} pair. Gated on presence
                          of curated features; right column
                          wrapper stays regardless so the grid
                          shape stays stable across materials.
                          items-baseline aligns the 24px serif
                          numeral's baseline with the title's
                          baseline — standard editorial
                          treatment, numeral reads tall. */}
                      {activeVersion.key_features && activeVersion.key_features.length > 0 && (
                        <ul className="max-w-[62ch] space-y-[1.15rem]">
                          {activeVersion.key_features.map((feature, i) => (
                            <li key={i} className="grid grid-cols-[40px_1fr] items-baseline gap-3">
                              <span
                                aria-hidden
                                className="leading-none"
                                style={{ fontFamily: SERIF, fontSize: 24, color: ACCENT }}
                              >
                                {String(i + 1).padStart(2, '0')}
                              </span>
                              <div>
                                <p className="mb-0.5 text-[14px] font-medium text-[#1a1612]">
                                  {feature.title}
                                </p>
                                <p className="text-[13px] leading-[1.55] text-[#1a1612]/70">
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
                      grid, conditional. Stronger vertical break
                      (mt-10) than the previous single-column
                      layout's mt-6 so the disclaimer reads as a
                      summary row rather than a continuation of
                      either column above it. max-w-[62ch] keeps
                      the reading width sensible within the
                      wider container. */}
                  {activeVersion.material_disclaimer && (
                    <p className="mt-10 max-w-[62ch] whitespace-pre-line text-[13px] leading-[1.6] text-[#1a1612]/60">
                      {activeVersion.material_disclaimer}
                    </p>
                  )}
              </div>
            </section>
          )}

        </>
      )}

      {/* ───── Footer ───── */}
      <footer className="text-white" style={{ background: INK }}>
        {/* Brand rule again on top of the footer — bookends the
            page with the 4-colour signature. */}
        <div className="flex h-[2px] w-full">
          {BRAND_ORDER.map((c, i) => (
            <div key={i} className="flex-1" style={{ background: c }} />
          ))}
        </div>
        <div className="mx-auto flex max-w-[1040px] flex-wrap items-center justify-between gap-3 px-6 py-10 sm:px-8">
          <div className="flex items-center gap-3">
            <img src="/logo-cards.png" alt="Plasma" className="h-8 w-auto opacity-70" />
            <span style={{ ...REG_A_BASE, color: LABEL_DARK }}>
              © PlasmaDesign
            </span>
          </div>
          {/* Proof ref · version — drops either piece when its
              underlying value isn't available (override proofs
              with null helpscout_conversation_id; the rare
              no-version page state). Full collapse when both
              are missing so the footer doesn't render an empty
              paragraph. */}
          {(proofRef || activeVersion) && (
            <p style={{ ...REG_A_BASE, color: LABEL_DARK }}>
              {proofRef}
              {proofRef && activeVersion ? ' · ' : ''}
              {activeVersion ? `v${activeVersion.version_number}` : ''}
            </p>
          )}
        </div>
      </footer>

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            type="button"
            aria-label="Close"
            onClick={(e) => { e.stopPropagation(); setLightboxSrc(null) }}
            className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <span aria-hidden="true" className="text-2xl leading-none">×</span>
          </button>
          <img
            src={lightboxSrc}
            alt="Proof image"
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Phase 2 action confirmation modal —
          two-layer scroll pattern: outer backdrop owns the scroll,
          inner flex wrapper uses min-h-full + items-center so the
          card centres when it fits and pushes the page-scroll
          when it doesn't. The disclaimer block + tick box can
          push total height past 740px on a 360-wide viewport in
          the full-text state; without the scroll the bottom of
          the card (Confirm button) was unreachable. */}
      {actionPanel && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/80"
          onClick={() => { if (!actionSubmitting) closeActionPanel() }}
        >
          <div className="flex min-h-full items-center justify-center px-4 py-8">
          <div
            className="w-full max-w-[560px] rounded-xl px-7 py-8 text-white"
            style={{
              background: INK,
              border: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p
              style={{
                ...REG_A_BASE,
                color: actionPanel.type === 'approve' ? APPROVED_GREEN : BRAND_ORDER[1],
              }}
            >
              {actionPanel.type === 'approve'
                ? actionPanel.name === SHARED_APPROVAL_KEY
                  ? 'Approve this proof'
                  : `Approve ${actionPanel.name}'s design`
                : actionPanel.name === SHARED_APPROVAL_KEY
                  ? 'Request changes'
                  : `Request changes for ${actionPanel.name}`}
            </p>
            <p
              className="mt-4 max-w-[60ch] whitespace-pre-line text-[15px] leading-[1.7] text-white/80"
              style={{ fontFamily: SANS }}
            >
              {actionPanel.type === 'approve'
                ? publicSettings?.approve_confirmation_copy ?? ''
                : publicSettings?.request_changes_confirmation_copy ?? ''}
            </p>

            <div className="mt-6">
              <label
                className="block"
                style={{ ...REG_A_BASE, color: LABEL_DARK }}
              >
                Your name <span className="text-rose-300/90">*</span>
              </label>
              <input
                type="text"
                value={actionName}
                onChange={(e) => setActionName(e.target.value)}
                disabled={actionSubmitting}
                autoFocus
                className="mt-2 w-full rounded-md bg-white/[0.04] px-4 py-3 text-white placeholder-white/30 outline-none ring-1 ring-white/15 transition-colors focus:ring-white/40"
                style={{ fontFamily: SANS, fontSize: 15 }}
              />
            </div>

            {actionPanel.type === 'request_changes' && (
              <div className="mt-5">
                <label
                  className="block"
                  style={{
                    ...REG_B_BASE,
                    fontSize: 14,
                    fontWeight: 500,
                    color: LABEL_DARK,
                  }}
                >
                  What changes do you need? <span className="text-rose-300/90">*</span>
                </label>
                <textarea
                  value={actionComment}
                  onChange={(e) => setActionComment(e.target.value)}
                  disabled={actionSubmitting}
                  rows={5}
                  className="mt-2 w-full rounded-md bg-white/[0.04] px-4 py-3 text-white placeholder-white/30 outline-none ring-1 ring-white/15 transition-colors focus:ring-white/40"
                  style={{ fontFamily: SANS, fontSize: 15 }}
                />
              </div>
            )}

            {actionPanel.type === 'approve' && (
              <div className="mt-5">
                <label
                  className="block"
                  style={{
                    ...REG_B_BASE,
                    fontSize: 14,
                    fontWeight: 500,
                    color: LABEL_DARK,
                  }}
                >
                  Anything to add?{' '}
                  <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.45)' }}>
                    (optional)
                  </span>
                </label>
                <textarea
                  value={actionComment}
                  onChange={(e) => setActionComment(e.target.value)}
                  disabled={actionSubmitting}
                  rows={3}
                  className="mt-2 w-full rounded-md bg-white/[0.04] px-4 py-3 text-white placeholder-white/30 outline-none ring-1 ring-white/15 transition-colors focus:ring-white/40"
                  style={{ fontFamily: SANS, fontSize: 15 }}
                />
              </div>
            )}

            {/* ───── Per-action disclaimer + tick box ─────
                Modal is the canonical home for the disclaimer
                copy. The bottom-of-page card mirrors the same
                string from publicSettings as informational
                reference. The tick box gates Confirm and is
                reset on every modal open — the per-action ack
                is captured implicitly by the existence of the
                proof_events row. The session-scoped flag only
                changes how prominently the text is rendered:
                full block on the first action, one-line
                reminder + "Show disclaimer" affordance on
                subsequent actions in the same page session. */}
            {actionPanel.type === 'approve' && publicSettings?.disclaimer_text && (
              <div className="mt-6">
                <p style={{ ...REG_A_BASE, color: LABEL_DARK }}>
                  Disclaimer
                </p>
                {disclaimerAckedThisSession && !actionDisclaimerExpanded ? (
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                    <p
                      className="text-[14px] leading-[1.6] text-white/70"
                      style={{ fontFamily: SANS }}
                    >
                      By confirming, you reaffirm you have read the disclaimer.
                    </p>
                    <button
                      type="button"
                      onClick={() => setActionDisclaimerExpanded(true)}
                      className="self-start underline-offset-4 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 rounded-sm"
                      style={{ ...REG_A_BASE, color: LABEL_DARK }}
                    >
                      Show disclaimer
                    </button>
                  </div>
                ) : (
                  <p
                    className="mt-2 max-w-[60ch] whitespace-pre-line rounded-md px-4 py-3 text-[14px] leading-[1.65] text-white/75"
                    style={{
                      fontFamily: SANS,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.10)',
                    }}
                  >
                    {publicSettings.disclaimer_text}
                  </p>
                )}
                <label
                  className={[
                    'mt-4 flex w-fit items-center gap-3 rounded-lg px-4 py-3 transition-colors',
                    actionSubmitting
                      ? 'cursor-wait'
                      : 'cursor-pointer hover:border-white/30',
                  ].join(' ')}
                  style={{
                    border: actionDisclaimerAcked
                      ? '1px solid rgba(74,222,128,0.45)'
                      : '1px solid rgba(255,255,255,0.15)',
                  }}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={actionDisclaimerAcked}
                    disabled={actionSubmitting}
                    onChange={(e) => setActionDisclaimerAcked(e.target.checked)}
                  />
                  <span
                    aria-hidden
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-[4px]"
                    style={
                      actionDisclaimerAcked
                        ? {
                            background: APPROVED_GREEN,
                            border: `1.5px solid ${APPROVED_GREEN}`,
                          }
                        : {
                            background: 'rgba(255,255,255,0.04)',
                            border: '1.5px solid rgba(255,255,255,0.45)',
                          }
                    }
                  >
                    {actionDisclaimerAcked && (
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M2.5 6.5L5 9L9.5 3.5"
                          stroke="#0f0d0b"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </span>
                  <span
                    style={{
                      ...REG_B_BASE,
                      fontSize: 14,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.92)',
                    }}
                  >
                    I confirm I have read the disclaimer above
                  </span>
                </label>
              </div>
            )}

            {actionError && (
              <p
                className="mt-5 max-w-[60ch] text-[14px] leading-[1.55] text-rose-300/90"
                style={{ fontFamily: SANS }}
              >
                {actionError}
              </p>
            )}

            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={closeActionPanel}
                disabled={actionSubmitting}
                className="inline-flex min-h-[44px] items-center justify-center rounded-md px-6 py-3 text-white/70 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.18)',
                  fontFamily: MONO,
                  fontSize: 11,
                  letterSpacing: '0.22em',
                  textTransform: 'uppercase',
                }}
              >
                Cancel
              </button>
              {(() => {
                // Confirm-button gating mirrors submitAction's
                // guard. Approve flow with a configured
                // disclaimer requires the tick box; without a
                // disclaimer or for Request Changes, the button
                // is enabled as soon as the modal opens.
                const disclaimerGate =
                  actionPanel.type === 'approve' &&
                  !!publicSettings?.disclaimer_text &&
                  !actionDisclaimerAcked
                const confirmDisabled = actionSubmitting || disclaimerGate
                return (
                  <button
                    type="button"
                    onClick={() => void submitAction()}
                    disabled={confirmDisabled}
                    onMouseEnter={(e) => {
                      if (confirmDisabled) return
                      if (actionPanel.type === 'approve') {
                        e.currentTarget.style.background = CTA_TEAL_HOVER
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (actionPanel.type === 'approve') {
                        e.currentTarget.style.background = CTA_TEAL
                      }
                    }}
                    onMouseDown={(e) => {
                      if (confirmDisabled) return
                      if (actionPanel.type === 'approve') {
                        e.currentTarget.style.background = CTA_TEAL_PRESSED
                      }
                    }}
                    onMouseUp={(e) => {
                      if (actionPanel.type === 'approve') {
                        e.currentTarget.style.background = CTA_TEAL_HOVER
                      }
                    }}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-md px-6 py-3 transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2"
                    style={{
                      background: actionPanel.type === 'approve' ? CTA_TEAL : '#ffffff',
                      color: actionPanel.type === 'approve' ? '#ffffff' : INK_DEEP,
                      fontFamily: MONO,
                      fontSize: 11,
                      letterSpacing: '0.22em',
                      textTransform: 'uppercase',
                      ['--tw-ring-color' as string]:
                        actionPanel.type === 'approve' ? CTA_TEAL_RING : 'rgba(255,255,255,0.4)',
                    }}
                  >
                    {actionSubmitting ? 'Sending…' : 'Confirm'}
                  </button>
                )
              })()}
            </div>
          </div>
          </div>
        </div>
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
// ── Revisions band ───────────────────────────────────────────
// Dedicated zone below the hero containing the section header
// ("Revision history" + "Viewing latest" / "Viewing v{n} of
// {total}" status), a spotlight column showing the
// active version as a big serif number with a Latest/History
// chip + date, and the RevisionsTimeline rail on the right.
// Lays on a subtle accent-tinted gradient over the ink
// background so the whole band reads as its own zone
// separate from the hero above.
//
// The band also owns the first-visit coachmark — lifted to
// band scope (vs the timeline component itself) so wrapping
// onSelectVersion picks up both "× click dismiss" and "any
// rail-dot click dismiss" in one place without the timeline
// needing to know about coach state. localStorage persists
// dismissal across reloads (key: pv_timeline_coach_seen),
// scoped globally because it's teaching the interaction,
// not a per-proof note.
//
// Responsive note: the coachmark's DOM query only matches
// when the timeline is in wide mode (dot rail). In the
// narrow stepper path the query returns null, the
// measurement gate stays unset, and the coachmark silently
// hides — the stepper's prev/next arrows already telegraph
// the interaction, no tooltip needed.
function RevisionsBand({
  versions,
  activeVersion,
  onSelectVersion,
  tokens,
}: {
  versions: PublicProofVersion[]
  activeVersion: PublicProofVersion
  onSelectVersion: (v: PublicProofVersion) => void
  tokens: {
    ink: string
    inkDeep: string
    accent: string
    accentGlow: string
    approvedGreen: string
    serif: string
    mono: string
  }
}) {
  const { ink, accent, accentGlow, approvedGreen, serif, mono } = tokens
  const railRef = useRef<HTMLDivElement>(null)

  const [coachSeen, setCoachSeen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    try {
      return localStorage.getItem('pv_timeline_coach_seen') === '1'
    } catch {
      // Safari private mode — don't nag in that case either.
      return true
    }
  })
  const dismissCoach = () => {
    try {
      localStorage.setItem('pv_timeline_coach_seen', '1')
    } catch {
      // storage unavailable — still dismiss in-memory
    }
    setCoachSeen(true)
  }
  const handleSelectVersion = (v: PublicProofVersion) => {
    onSelectVersion(v)
    if (!coachSeen) dismissCoach()
  }

  const latest = versions[versions.length - 1]
  const isLatestActive = activeVersion.id === latest.id
  const activeDate = new Date(activeVersion.created_at)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    .toUpperCase()

  const chipBase =
    'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 uppercase tracking-[0.22em]'
  const LatestChip = () => (
    <span
      className={chipBase}
      style={{
        fontFamily: mono,
        fontSize: 10,
        background: 'rgba(74,222,128,0.15)',
        color: approvedGreen,
        border: '1px solid rgba(74,222,128,0.35)',
      }}
    >
      <span
        className="h-[5px] w-[5px] rounded-full"
        style={{ background: approvedGreen }}
      />
      Latest
    </span>
  )
  const HistoryChip = () => (
    <span
      className={chipBase}
      style={{
        fontFamily: mono,
        fontSize: 10,
        background: 'rgba(123,63,242,0.15)',
        color: accent,
        border: '1px solid rgba(123,63,242,0.35)',
      }}
    >
      <span className="h-[5px] w-[5px] rounded-full" style={{ background: accent }} />
      History
    </span>
  )

  return (
    <section className="border-t border-white/10" style={{ background: ink }}>
      <div
        style={{
          background:
            'linear-gradient(180deg, rgba(123,63,242,0.04) 0%, rgba(123,63,242,0) 100%)',
        }}
      >
        <div className="mx-auto max-w-[1040px] px-6 py-8 sm:px-8">
          {/* Header row — "REVISION HISTORY" mono label on the
              left; "VIEWING LATEST" / "VIEWING V{n} OF {total}"
              on the right. Whitespace-nowrap on the label so it
              doesn't wrap when the band gets narrow. */}
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
            <span
              className="uppercase whitespace-nowrap text-white/80"
              style={{ fontFamily: mono, fontSize: 11, letterSpacing: '0.3em' }}
            >
              Revision history
            </span>
            <span
              className="uppercase tracking-[0.22em] text-white/45"
              style={{ fontFamily: mono, fontSize: 11 }}
            >
              {isLatestActive
                ? 'Viewing latest'
                : `Viewing v${activeVersion.version_number} of ${versions.length}`}
            </span>
          </div>

          {/* Grid: stacks vertically below sm: so the rail gets
              full content width for the narrow / stepper mode
              on phones; switches to spotlight (auto) + rail
              (1fr) at sm+, vertically centered so the big serif
              v-number sits visually aligned with the rail's
              y-axis. */}
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-8">
            {/* Spotlight — min-width + right-hand hairline only
                apply at sm+ where the spotlight is a column.
                Below sm: the spotlight is a stacked row above
                the rail and neither rule makes sense. */}
            <div className="sm:min-w-[120px] sm:border-r sm:border-white/10 sm:pr-8">
              <div className="flex items-baseline gap-3">
                <span
                  className="leading-none text-white"
                  style={{ fontFamily: serif, fontWeight: 400, fontSize: 56 }}
                >
                  v{activeVersion.version_number}
                </span>
                {isLatestActive ? <LatestChip /> : <HistoryChip />}
              </div>
              <p
                className="mt-2 uppercase text-white/55"
                style={{ fontFamily: mono, fontSize: 11, letterSpacing: '0.24em' }}
              >
                {activeDate}
              </p>
            </div>

            {/* Rail column — the timeline renders inside; the
                coachmark sits absolutely positioned above the
                active dot, scoped by railRef for the DOM
                query + parent-relative coords. position:
                relative on the wrapper is load-bearing for
                the coachmark's absolute positioning. */}
            <div ref={railRef} className="relative">
              <RevisionsTimeline
                versions={versions}
                activeVersion={activeVersion}
                onSelectVersion={handleSelectVersion}
                tokens={tokens}
              />
              {!coachSeen && (
                <RevisionsCoachmark
                  parentRef={railRef}
                  activeVersionNumber={activeVersion.version_number}
                  isLatestActive={isLatestActive}
                  onDismiss={dismissCoach}
                  accent={accent}
                  accentGlow={accentGlow}
                  mono={mono}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ── Revisions coachmark ──────────────────────────────────────
// First-visit tooltip pointing at the active dot on the
// revisions rail. Box is edge-clamped to stay inside the
// parent container; arrow is clamped to stay inside the box's
// rounded corners but always sits directly above the active
// dot. Measurement runs aggressively — useEffect + raf x2 +
// document.fonts.ready + ResizeObserver on both parent and
// the active button + MutationObserver on the parent subtree
// + window resize — because any of those can shift the dot's
// x-position between mount and first paint in practice.
//
// Render is gated on `layout !== null` so we don't flash a
// mispositioned box while the measurement pipeline warms up.
// In narrow (stepper) mode the active-dot selector returns
// null, layout never sets, component returns null. No
// special-case branch needed.
function RevisionsCoachmark({
  parentRef,
  activeVersionNumber,
  isLatestActive,
  onDismiss,
  accent,
  accentGlow,
  mono,
}: {
  parentRef: React.RefObject<HTMLDivElement | null>
  activeVersionNumber: number
  isLatestActive: boolean
  onDismiss: () => void
  accent: string
  accentGlow: string
  mono: string
}) {
  const BOX_W = 260
  const MARGIN = 6
  const [layout, setLayout] = useState<{
    boxLeft: number
    arrowOffset: number
  } | null>(null)

  // useEffect (not useLayoutEffect) because ancestor DOM refs
  // aren't set when a descendant's useLayoutEffect runs — React
  // commits bottom-up, so the rail wrapper's ref is only assigned
  // after this component's layout effect would fire, meaning the
  // effect would bail on parent=null and the whole measurement
  // pipeline would silently never set up. useEffect fires after
  // the full commit phase completes, by which point all refs in
  // the tree are populated. The component gates render on
  // layout !== null so there's no paint-flash concern from the
  // slightly later fire timing.
  useEffect(() => {
    const parent = parentRef.current
    if (!parent) return

    const measure = () => {
      const p = parentRef.current
      if (!p) return
      const dot = p.querySelector<HTMLElement>(
        'button[data-rev-active="1"] span > span',
      )
      if (!dot) return
      const parentRect = p.getBoundingClientRect()
      const dotRect = dot.getBoundingClientRect()
      const dotCenterX = dotRect.left + dotRect.width / 2 - parentRect.left
      const parentW = parentRect.width
      const boxLeft = Math.max(
        MARGIN,
        Math.min(parentW - BOX_W - MARGIN, dotCenterX - BOX_W / 2),
      )
      const arrowOffset = Math.max(14, Math.min(BOX_W - 14, dotCenterX - boxLeft))
      setLayout({ boxLeft, arrowOffset })
    }

    // Run now, then again on two consecutive animation
    // frames (first frame lays the rail out, second frame
    // lets any style recalc settle), then again when fonts
    // finish loading (serif metrics change dot spacing at
    // font-swap moment).
    //
    // raf2 lives in the outer closure so the rAF1 callback
    // can assign to it without needing to hang a property
    // off the rAF1 number primitive (which throws TypeError
    // in strict mode and silently kills the whole pipeline
    // on mount — the symptom was the coachmark never
    // rendering because setLayout never committed).
    let raf1: number | null = null
    let raf2: number | null = null
    measure()
    raf1 = requestAnimationFrame(() => {
      measure()
      raf2 = requestAnimationFrame(measure)
    })
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(measure).catch(() => {
        // document.fonts not implemented / rejected — skip
      })
    }

    const ro = new ResizeObserver(() => measure())
    ro.observe(parent)
    const activeBtn = parent.querySelector<HTMLElement>('button[data-rev-active="1"]')
    if (activeBtn) ro.observe(activeBtn)
    const onWindowResize = () => measure()
    window.addEventListener('resize', onWindowResize)

    // Belt-and-braces: when the timeline swaps from its
    // placeholder h-7 div to the real rail (after its own
    // useLayoutEffect flips width from null to a number),
    // the rAF chain should catch it — but a MutationObserver
    // on the parent's subtree gives us a direct signal on
    // the exact commit that adds the active-dot button, so
    // the coachmark always measures against real DOM rather
    // than racing a state update.
    const mo = new MutationObserver(() => measure())
    mo.observe(parent, { childList: true, subtree: true })

    return () => {
      if (raf1 != null) cancelAnimationFrame(raf1)
      if (raf2 != null) cancelAnimationFrame(raf2)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', onWindowResize)
    }
  }, [parentRef, activeVersionNumber])

  if (!layout) return null

  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{
        left: layout.boxLeft,
        bottom: 'calc(100% + 14px)',
        width: BOX_W,
      }}
    >
      <div
        className="pointer-events-auto relative rounded-xl px-4 py-3"
        style={{
          background: 'rgba(28,22,48,0.98)',
          border: `1px solid ${accent}`,
          boxShadow: `0 10px 30px rgba(0,0,0,0.4), 0 0 40px ${accentGlow}`,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p
              className="uppercase"
              style={{
                fontFamily: mono,
                fontSize: 9,
                color: accent,
                letterSpacing: '0.22em',
              }}
            >
              Tip · Revision history
            </p>
            <p className="mt-2 text-[13px] leading-[1.5] text-white/85">
              Click any dot to see how the proof changed. You're on{' '}
              <span style={{ color: accent }}>v{activeVersionNumber}</span>
              {isLatestActive ? ' — the latest.' : '.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss tip"
            className="shrink-0 leading-none text-white/40 transition-colors hover:text-white/80"
            style={{ fontSize: 18 }}
          >
            ×
          </button>
        </div>
        {/* Arrow — 12×12 rotated square inheriting the box's
            bg + the two border edges that face the dot below,
            so it reads as a continuous diamond arrow on the
            border. arrowOffset is the x-centre of the arrow
            within the box; offset by 6 to centre the rotated
            square. */}
        <span
          aria-hidden
          className="absolute h-3 w-3 rotate-45"
          style={{
            bottom: -7,
            left: layout.arrowOffset - 6,
            background: 'rgba(28,22,48,0.98)',
            borderRight: `1px solid ${accent}`,
            borderBottom: `1px solid ${accent}`,
          }}
        />
      </div>
    </div>
  )
}

// ── Revisions timeline ───────────────────────────────────────
// Horizontal rail of version markers that replaces the old
// "v1 v2 v3" button strip. Dots are connected by a faint white
// base line; a glowing accent-coloured segment runs from v1 up
// to the active marker. Labelled markers (v1, latest, active,
// current) render serif v-numbers + mono dates inline; the
// remaining versions render as small tick dots that tooltip to
// "v{n} · {date}" on hover. "Current" (green) and "Viewing"
// (accent) chips ride on the label clusters — Current is
// always pinned to the latest marker, Viewing renders on the
// active marker only when active !== latest.
//
// Overflow handling: for projects with 20+ versions, the rail
// would get visually cramped. Always include v1, latest,
// active, and the is_current marker; fill remaining slots with
// evenly-sampled intermediates up to a width-derived cap
// (~12–20 markers at laptop/desktop widths). Sampled
// intermediates are always unlabelled ticks.
//
// Knockout detail: the rail line runs horizontally through the
// full row at the dots' y-centre. Where a label cluster
// renders inline with its dot, the cluster carries
// background: ink so it visually erases the line segment
// behind the v-number, date, and chip text. Without this,
// the line would strike through each label.
//
// Narrow mode: collapses to a stepper (prev · centre pill ·
// next) at container widths < 520px. Centre pill opens a
// dropdown list of all versions; tap selects + closes.
// Threshold intentionally smaller than Tailwind's sm
// breakpoint so it only engages on genuinely narrow
// containers, not just on phone-sized viewports where the
// timeline could still fit with sampling.
function RevisionsTimeline({
  versions,
  activeVersion,
  onSelectVersion,
  tokens,
}: {
  versions: PublicProofVersion[]
  activeVersion: PublicProofVersion
  onSelectVersion: (v: PublicProofVersion) => void
  tokens: {
    ink: string
    inkDeep: string
    accent: string
    accentGlow: string
    approvedGreen: string
    serif: string
    mono: string
  }
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  const [open, setOpen] = useState(false)

  // Sync-measure container width before first paint so narrow
  // viewports don't flash the wide layout. ResizeObserver
  // handles subsequent width changes (window resize, parent
  // layout reflow).
  useLayoutEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Close the narrow-mode dropdown on outside click. Scoped to
  // this instance so other dropdowns elsewhere on the page
  // (if any ever exist) wouldn't interfere.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!dropdownRef.current) return
      if (!dropdownRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const { ink, inkDeep, accent, accentGlow, approvedGreen, serif, mono } = tokens

  const fmtDate = (iso: string) =>
    new Date(iso)
      .toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
      .toUpperCase()

  const latest = versions[versions.length - 1]
  const current = versions.find((v) => v.is_current) ?? latest
  const activeIdx = versions.findIndex((v) => v.id === activeVersion.id)
  const isLatestActive = activeVersion.id === latest.id

  // Green "Current" chip — always pinned to the latest marker,
  // regardless of the designer's is_current selection. Kept as
  // a local component so the two renderers (wide timeline +
  // narrow dropdown + narrow centre pill) share the styling.
  const CurrentChip = () => (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-[3px] uppercase tracking-[0.2em]"
      style={{
        fontFamily: mono,
        fontSize: 9,
        background: 'rgba(74,222,128,0.15)',
        color: approvedGreen,
        border: `1px solid rgba(74,222,128,0.35)`,
      }}
    >
      Current
    </span>
  )
  // Accent "Viewing" chip — rides on the active marker only
  // when active !== latest. Leading 5px dot echoes the rail
  // dot colour so the chip visually ties back to the marker.
  const ViewingChip = () => (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px] uppercase tracking-[0.2em]"
      style={{
        fontFamily: mono,
        fontSize: 9,
        background: 'rgba(123,63,242,0.18)',
        color: accent,
        border: `1px solid rgba(123,63,242,0.45)`,
      }}
    >
      <span
        className="h-[5px] w-[5px] shrink-0 rounded-full"
        style={{ background: accent }}
      />
      Viewing
    </span>
  )

  // Don't render until we've measured; avoids the wide-mode
  // flash on narrow viewports. h-7 placeholder reserves the
  // row height so the surrounding layout doesn't shift when
  // the timeline lands.
  if (width === null) {
    return <div ref={wrapperRef} className="relative h-7" />
  }

  const NARROW_THRESHOLD = 520
  const isNarrow = width < NARROW_THRESHOLD

  // ── Narrow / stepper mode ─────────────────────────────────
  if (isNarrow) {
    const canPrev = activeIdx > 0
    const canNext = activeIdx < versions.length - 1
    return (
      <div ref={wrapperRef} className="relative">
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            aria-label="Previous version"
            disabled={!canPrev}
            onClick={() => canPrev && onSelectVersion(versions[activeIdx - 1])}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/15 text-white/70 transition-colors hover:border-white/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/15 disabled:hover:text-white/70"
            style={{ fontFamily: mono, fontSize: 18 }}
          >
            ‹
          </button>
          <div className="relative flex-1" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex h-11 w-full items-center justify-center gap-3 rounded-full border border-white/15 px-4 hover:border-white/35"
            >
              <span
                className="leading-none text-white"
                style={{ fontFamily: serif, fontWeight: 400, fontSize: 20 }}
              >
                v{activeVersion.version_number}
              </span>
              <span
                className="uppercase tracking-[0.2em] text-white/50"
                style={{ fontFamily: mono, fontSize: 9 }}
              >
                of {versions.length}
              </span>
              {isLatestActive ? <CurrentChip /> : <ViewingChip />}
              <span
                className="text-white/50"
                style={{ fontFamily: mono, fontSize: 12 }}
                aria-hidden
              >
                ▾
              </span>
            </button>
            {open && (
              <div
                className="absolute left-0 right-0 top-full z-20 mt-2 max-h-[320px] overflow-y-auto overflow-x-hidden rounded-lg shadow-xl ring-1 ring-white/15"
                style={{ background: inkDeep }}
              >
                {[...versions].reverse().map((v, i) => {
                  const isActiveRow = v.id === activeVersion.id
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => {
                        onSelectVersion(v)
                        setOpen(false)
                      }}
                      className={[
                        'flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors',
                        i > 0 ? 'border-t border-white/10' : '',
                        isActiveRow ? 'bg-white/[0.04]' : 'hover:bg-white/[0.03]',
                      ].join(' ')}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="leading-none text-white"
                          style={{ fontFamily: serif, fontWeight: 400, fontSize: 20 }}
                        >
                          v{v.version_number}
                        </span>
                        <span
                          className="uppercase tracking-[0.2em] text-white/50"
                          style={{ fontFamily: mono, fontSize: 9 }}
                        >
                          {fmtDate(v.created_at)}
                        </span>
                      </div>
                      {v.id === latest.id && <CurrentChip />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Next version"
            disabled={!canNext}
            onClick={() => canNext && onSelectVersion(versions[activeIdx + 1])}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/15 text-white/70 transition-colors hover:border-white/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/15 disabled:hover:text-white/70"
            style={{ fontFamily: mono, fontSize: 18 }}
          >
            ›
          </button>
        </div>
      </div>
    )
  }

  // ── Wide / timeline mode ──────────────────────────────────
  //
  // Pick the displayed marker set. Always-include set uses a
  // Set keyed on version id to dedupe the common case where
  // multiple roles land on the same version (active === latest
  // === current, active === current, etc.) Remaining slots are
  // filled from intermediates by even-interval sampling so the
  // sampled ticks visually space the rail without clustering.
  const maxMarkers = Math.max(6, Math.min(20, Math.floor((width - 160) / 26)))
  const alwaysIds = new Set<string>([
    versions[0].id,
    latest.id,
    current.id,
    activeVersion.id,
  ])
  const intermediates = versions.filter((v) => !alwaysIds.has(v.id))
  const remaining = Math.max(0, maxMarkers - alwaysIds.size)
  const sampledIds = new Set<string>()
  if (remaining > 0 && intermediates.length > 0) {
    const take = Math.min(remaining, intermediates.length)
    const step = intermediates.length / take
    for (let i = 0; i < take; i++) {
      const idx = Math.min(
        intermediates.length - 1,
        Math.floor(i * step + step / 2),
      )
      sampledIds.add(intermediates[idx].id)
    }
  }
  const displayed = versions.filter(
    (v) => alwaysIds.has(v.id) || sampledIds.has(v.id),
  )
  const displayedActiveIdx = displayed.findIndex((v) => v.id === activeVersion.id)
  const activePct =
    displayed.length > 1 ? (displayedActiveIdx / (displayed.length - 1)) * 100 : 0

  return (
    <div ref={wrapperRef} className="relative">
      {/* Base rail — faint white baseline running the full row
          width at the dots' y-centre (top:14 = half of h-7).
          h-px is 1 physical pixel — reads as a hair-thin track
          against the ink backdrop. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 h-px bg-white/15"
        style={{ top: 14 }}
      />
      {/* Filled rail — accent-coloured segment from the start
          of the rail up to the active marker. Width is a
          percentage of the full rail, derived from the
          active's index within the displayed set. Soft
          box-shadow glow ties it visually to the active dot's
          glow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 h-px transition-all duration-200"
        style={{
          top: 14,
          width: `${activePct}%`,
          background: accent,
          boxShadow: `0 0 8px ${accentGlow}`,
        }}
      />
      {/* Markers — flex-distributed across the full rail. Each
          marker is h-7 items-center so size-swaps between
          active / inactive / tick dots happen inside a locked
          row height rather than pushing the cluster up or
          down. */}
      <div className="relative flex h-7 items-center justify-between">
        {displayed.map((v) => {
          const isActive = v.id === activeVersion.id
          const isLabeled = alwaysIds.has(v.id)
          const isLatestMarker = v.id === latest.id

          if (!isLabeled) {
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => onSelectVersion(v)}
                title={`v${v.version_number} · ${fmtDate(v.created_at)}`}
                className="flex h-7 items-center"
                data-rev-active={isActive ? '1' : undefined}
              >
                {/* Dot slot is a span (not div) so the coachmark's
                    DOM query — button[data-rev-active="1"] span > span —
                    resolves to the real dot element first in
                    document order. */}
                <span className="grid h-[22px] w-[22px] place-items-center">
                  <span className="block h-1.5 w-1.5 rounded-full bg-white/40 transition-colors hover:bg-white/70" />
                </span>
              </button>
            )
          }

          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onSelectVersion(v)}
              className="flex h-7 items-center gap-2"
              data-rev-active={isActive ? '1' : undefined}
            >
              <span className="grid h-[22px] w-[22px] place-items-center">
                <span
                  className="block rounded-full transition-all"
                  style={
                    isActive
                      ? {
                          width: 18,
                          height: 18,
                          background: accent,
                          boxShadow: `0 0 12px ${accentGlow}`,
                        }
                      : {
                          width: 12,
                          height: 12,
                          background: 'transparent',
                          border: `1.5px solid ${accent}`,
                        }
                  }
                />
              </span>
              {/* Label cluster — ink background knocks out the
                  rail line behind the text. h-7 items-center
                  matches the outer row so the serif size swap
                  between 22px (active) and 18px (inactive)
                  happens inside a fixed-height slot and can't
                  shift the cluster vertically. */}
              <div
                className="flex h-7 items-center gap-2 px-2"
                style={{ background: ink }}
              >
                <span
                  className="leading-none text-white"
                  style={{
                    fontFamily: serif,
                    fontWeight: 400,
                    fontSize: isActive ? 22 : 18,
                  }}
                >
                  v{v.version_number}
                </span>
                <span
                  className="uppercase tracking-[0.2em] text-white/50"
                  style={{ fontFamily: mono, fontSize: 9 }}
                >
                  {fmtDate(v.created_at)}
                </span>
                {isLatestMarker && <CurrentChip />}
                {isActive && !isLatestActive && <ViewingChip />}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// truncated with a full-name tooltip on hover. Hidden when
// original_filename is null (pre-migration-000021 legacy
// rows). Clicking the image opens the lightbox via the
// parent's onClick handler. Download link uses the real
// uploaded filename so the customer's downloads folder
// matches what they saw on the page.
function PlateCard({
  image,
  brandColor,
  accent,
  alt,
  onClick,
}: {
  image: GridImage
  brandColor: string
  accent: string
  alt: string
  onClick: (src: string) => void
}) {
  const MONO = "'JetBrains Mono', ui-monospace, monospace"
  const downloadHref = image.signed_url ?? '#'
  const downloadName = image.original_filename ?? 'proof.jpg'
  return (
    <div className="relative">
      <figure className="relative">
        <button
          type="button"
          onClick={() => image.signed_url && onClick(image.signed_url)}
          className="block w-full overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ outlineColor: accent }}
          aria-label={alt}
        >
          {image.signed_url ? (
            <img
              src={image.signed_url}
              alt={alt}
              className="block w-full"
              style={{ background: '#f4f1ea' }}
            />
          ) : (
            <div className="aspect-[5/3] w-full" style={{ background: '#f4f1ea' }} />
          )}
        </button>
        {/* Two-line caption — primary side label on top, raw
            filename on a muted line below, Download button
            right-aligned opposite. items-start so the button
            hugs the top of the caption block and lines up with
            the primary label; min-w-0 + flex-1 on the left so
            truncate works on the filename line when it's long. */}
        <figcaption className="mt-4 flex items-start justify-between gap-4 border-t border-[#1a1612]/15 pt-3">
          <div className="min-w-0 flex-1">
            <div
              className="flex items-center gap-2 uppercase tracking-[0.22em] text-[#1a1612]"
              style={{ fontFamily: MONO, fontSize: 12 }}
            >
              <span
                className="h-[6px] w-[6px] shrink-0 rounded-[1px]"
                style={{ background: brandColor }}
              />
              {image.label && <span className="truncate">{image.label}</span>}
            </div>
            {image.original_filename && (
              <div
                className="mt-1 truncate text-[#1a1612]/50"
                style={{ fontFamily: MONO, fontSize: 12 }}
                title={image.original_filename}
              >
                {image.original_filename}
              </div>
            )}
          </div>
          {image.signed_url && (
            <a
              href={downloadHref}
              download={downloadName}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border border-[#1a1612]/25 px-3 py-1 uppercase tracking-[0.22em] text-[#6b6558] transition-colors hover:border-[color:var(--a)] hover:bg-[color:var(--a)] hover:text-white"
              style={{
                fontFamily: MONO,
                fontSize: 12,
                // CSS variable so the hover styles above pick
                // up the indigo accent cleanly without inline
                // hover handlers.
                ['--a' as string]: accent,
              }}
            >
              Download ↓
            </a>
          )}
        </figcaption>
      </figure>
    </div>
  )
}

// Spec sheet row on the ink section — mono label on the left,
// mono value on the right. Hairline top border stacks multiple
// rows as a spec sheet rather than a card grid.
function InkSpecRow({ label, value }: { label: string; value: string }) {
  const MONO = "'JetBrains Mono', ui-monospace, monospace"
  return (
    <div className="grid grid-cols-[140px_1fr] items-baseline gap-6 border-t border-white/10 py-5 sm:grid-cols-[200px_1fr] sm:gap-8">
      <dt
        className="uppercase tracking-[0.22em] text-white/45"
        style={{ fontFamily: MONO, fontSize: 12 }}
      >
        {label}
      </dt>
      <dd
        className="whitespace-pre-line text-white/95"
        style={{ fontFamily: MONO, fontSize: 14 }}
      >
        {value}
      </dd>
    </div>
  )
}

// Ink-themed pricing table — large serif quantity on the left,
// mono price + per-card columns on the right. Drives off the
// same PricingSnapshot shape as the designer-side
// PricingDisplay component, but restyled for the dark palette.
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

function InkPricingTable({
  snapshot,
  currency,
  displayQuantities,
  quoteMinQuantity,
  quoteMaxQuantity,
  quantitySurcharges,
  serif,
  mono,
}: {
  snapshot: PricingSnapshot
  currency: Currency
  displayQuantities: number[] | null
  quoteMinQuantity: number | null
  quoteMaxQuantity: number | null
  quantitySurcharges: Record<number, number>
  serif: string
  mono: string
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
          <thead>
            <tr className="border-b border-white/15">
              <th
                className="py-4 text-left uppercase tracking-[0.22em] text-white/45"
                style={{ fontFamily: mono, fontSize: 12 }}
              >
                Total quantity
              </th>
              <th
                className="py-4 text-right uppercase tracking-[0.22em] text-white/45"
                style={{ fontFamily: mono, fontSize: 12 }}
              >
                Price
              </th>
              <th
                className="py-4 text-right uppercase tracking-[0.22em] text-white/45"
                style={{ fontFamily: mono, fontSize: 12 }}
              >
                Per card
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ qty, price }) => (
              <tr
                key={qty}
                className="border-b"
                style={{ borderColor: 'rgba(255,255,255,0.08)' }}
              >
                <td
                  className="py-5 leading-none text-white"
                  style={{ fontFamily: serif, fontWeight: 400, fontSize: 28 }}
                >
                  {qty.toLocaleString()}
                </td>
                <td
                  className="py-5 text-right text-white"
                  style={{ fontFamily: mono, fontSize: 16 }}
                >
                  {formatPrice(price, currency)}
                </td>
                <td
                  className="py-5 text-right text-white/50"
                  style={{ fontFamily: mono, fontSize: 13 }}
                >
                  {formatPrice(price / qty, currency, 2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <QuantityLookup
          variants={variants}
          currency={currency}
          lookupSet={lookupSet}
          quoteMinQuantity={quoteMinQuantity}
          quoteMaxQuantity={quoteMaxQuantity}
          quantitySurcharges={quantitySurcharges}
          serif={serif}
          mono={mono}
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
        <thead>
          <tr className="border-b border-white/15">
            <th
              className="py-4 pr-2 text-left uppercase tracking-[0.22em] text-white/45 sm:pr-4"
              style={{ fontFamily: mono, fontSize: 12 }}
            >
              Total quantity
            </th>
            {variants.map((v) => (
              <th
                key={v.variant_id}
                className="py-4 pl-2 text-right uppercase tracking-[0.22em] text-white/45 sm:pl-4"
                style={{ fontFamily: mono, fontSize: 12 }}
              >
                {v.display}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleQuantities.map((qty) => {
            const surcharge = quantitySurcharges[qty] ?? 0
            return (
              <tr
                key={qty}
                className="border-b"
                style={{ borderColor: 'rgba(255,255,255,0.08)' }}
              >
                <td
                  className="py-4 pr-2 leading-none text-white sm:pr-4"
                  style={{ fontFamily: serif, fontWeight: 400, fontSize: 24 }}
                >
                  {qty.toLocaleString()}
                </td>
                {variants.map((v) => {
                  const base = v.prices[String(qty)]
                  if (base == null) {
                    return (
                      <td
                        key={v.variant_id}
                        className="py-4 pl-2 text-right text-white/30 sm:pl-4"
                        style={{ fontFamily: mono, fontSize: 14 }}
                      >
                        —
                      </td>
                    )
                  }
                  const price = base + surcharge
                  return (
                    <td key={v.variant_id} className="py-4 pl-2 text-right sm:pl-4">
                      <div
                        className="text-white"
                        style={{ fontFamily: mono, fontSize: 15 }}
                      >
                        {formatPrice(price, currency)}
                      </div>
                      <div
                        className="text-white/45"
                        style={{ fontFamily: mono, fontSize: 12 }}
                      >
                        {formatPrice(price / qty, currency, 2)} each
                      </div>
                    </td>
                  )
                })}
              </tr>
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
      serif={serif}
      mono={mono}
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
  serif,
  mono,
}: {
  variants: PricingVariant[]
  currency: Currency
  lookupSet: number[]
  quoteMinQuantity: number | null
  quoteMaxQuantity: number | null
  quantitySurcharges: Record<number, number>
  serif: string
  mono: string
}) {
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
    <div className="mt-8 border border-white/15 p-8">
      <h3
        id="quantity-picker-heading"
        className="text-white"
        style={{ fontFamily: serif, fontWeight: 400, fontSize: 28, lineHeight: 1.1 }}
      >
        Need a price for a specific quantity?
      </h3>
      <input
        type="number"
        inputMode="numeric"
        pattern="[0-9]*"
        min={1}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setRaw('') }}
        placeholder="Enter quantity"
        aria-labelledby="quantity-picker-heading"
        className="mt-5 w-full max-w-sm bg-transparent px-4 py-3 text-white placeholder:text-white/30 focus:outline-none"
        style={{
          fontFamily: mono,
          fontSize: 18,
          border: '1px solid rgba(255,255,255,0.15)',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.45)' }}
        onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)' }}
      />
      {/* Result panel — rendered only when the input has
          parsed into a query. The card feels compact at rest
          when the input is empty. aria-live/role=status makes
          screen readers announce caption changes as the
          customer types without re-announcing the rest of
          the card's chrome. */}
      {caption && (
        <div className="mt-8" aria-live="polite" role="status">
          <p
            className="text-white/80"
            style={{ fontFamily: serif, fontWeight: 400, fontSize: 16, lineHeight: 1.4 }}
          >
            {caption}
          </p>
          {tiers.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-white/15">
                    {/* Blank header above the qty column — the
                        serif quantity in each body row is
                        self-describing, no "Total quantity"
                        heading needed. */}
                    <th aria-hidden className="py-3 pr-4" />
                    {variants.map((v) => (
                      <th
                        key={v.variant_id}
                        className="py-3 pl-4 text-right uppercase tracking-[0.22em] text-white/45"
                        style={{ fontFamily: mono, fontSize: 12 }}
                      >
                        {v.display}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((qty) => (
                    <tr
                      key={qty}
                      className="border-b"
                      style={{ borderColor: 'rgba(255,255,255,0.08)' }}
                    >
                      <td
                        className="py-4 pr-4 leading-none text-white"
                        style={{ fontFamily: serif, fontWeight: 400, fontSize: 24 }}
                      >
                        {qty.toLocaleString()}
                      </td>
                      {variants.map((v) => {
                        const price = priceAt(qty, v)
                        if (price == null) {
                          return (
                            <td
                              key={v.variant_id}
                              className="py-4 pl-4 text-right text-white/30"
                              style={{ fontFamily: mono, fontSize: 14 }}
                            >
                              —
                            </td>
                          )
                        }
                        return (
                          <td key={v.variant_id} className="py-4 pl-4 text-right">
                            <div
                              className="text-white"
                              style={{ fontFamily: mono, fontSize: 16 }}
                            >
                              {formatPrice(price, currency)}
                            </div>
                            <div
                              className="text-white/45"
                              style={{ fontFamily: mono, fontSize: 12 }}
                            >
                              {formatPrice(price / qty, currency, 2)} each
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// "Alice", "Alice and Bob", "Alice, Bob and Carol". Keeps the
// reading natural; avoids a comma before "and" — two-name lists
// don't want the Oxford comma either way.
function formatNamesList(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
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

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
        <p className="text-sm text-gray-400">Loading your proof…</p>
      </div>
    </div>
  )
}

function NotFoundScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <p className="text-4xl font-bold text-gray-200">404</p>
        <p className="mt-2 text-sm text-gray-400">This proof link isn't valid or has expired.</p>
      </div>
    </div>
  )
}

function AbandonedScreen({ proof }: { proof: PublicProof }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
        <header className="mb-12">
          <p className="text-sm font-medium uppercase tracking-widest text-gray-400">Proof for</p>
          {/* Same masthead rule as the live page: company prominent
              when present (with the contact name as a muted sub-
              line), contact name prominent when no company. Keeps
              the customer's brand presence coherent across the live
              and abandoned screens. */}
          {(() => {
            const trimmedCompany = proof.company?.trim() ?? ''
            const trimmedName = proof.customer_name?.trim() ?? ''
            const companyProminent = trimmedCompany.length > 0
            const primary = companyProminent ? proof.company! : proof.customer_name
            const subline = companyProminent && trimmedName.length > 0
              ? proof.customer_name
              : null
            return (
              <>
                <h1 className="mt-1 text-3xl font-bold text-gray-900">{primary}</h1>
                {subline && (
                  <p className="mt-1 text-lg text-gray-500">{subline}</p>
                )}
              </>
            )
          })()}
        </header>
        <div className="rounded-2xl bg-white p-10 text-center shadow-sm ring-1 ring-gray-200">
          <h2 className="text-xl font-semibold text-gray-800">This proof is closed</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            If you'd like to revisit your business cards, please get in touch.
          </p>
        </div>
      </div>
    </div>
  )
}
