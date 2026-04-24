import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { PublicProof, PublicProofVersion, PublicMaterialOption, PublicMaterialOptionSurcharge } from '../lib/types'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import { formatPrice } from '../lib/currency'
import { type GridImage } from '../components/ImageGrid'
import { logCustomerEvent } from '../lib/audit'
import { getPublicSettings, type PublicSettings } from '../lib/publicSettings'
import type { PricingSnapshot, PricingVariant, Currency } from '../lib/types'

const SIGNED_URL_TTL = 60 * 60 * 24 // 24 hours

export default function CustomerProofPage() {
  const { id } = useParams<{ id: string }>()

  const [proof, setProof] = useState<PublicProof | null>(null)
  const [versions, setVersions] = useState<PublicProofVersion[]>([])
  const [activeVersion, setActiveVersion] = useState<PublicProofVersion | null>(null)
  const [versionImages, setVersionImages] = useState<Record<string, GridImage[]>>({})
  const [materialOptions, setMaterialOptions] = useState<PublicMaterialOption[]>([])
  const [optionSurcharges, setOptionSurcharges] = useState<PublicMaterialOptionSurcharge[]>([])
  const [activeOptionCode, setActiveOptionCode] = useState<string | null>(null)
  const [publicSettings, setPublicSettings] = useState<PublicSettings | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  // Guards the once-per-page-load proof_version_views insert. A
  // ref survives React strict-mode's double-invoke of effects
  // whereas state wouldn't.
  const viewRecordedRef = useRef(false)
  // Disclaimer acknowledgement is now a server-side event —
  // authoritative timestamp lives on proofs.disclaimer_acknowledged_at
  // and rides along with the public_proofs read (migrations 000091 +
  // 000092). Client-side state here is just the transient
  // saving / error signal while the edge function round-trips;
  // the actual ack value is read from `proof.disclaimer_acknowledged_at`
  // and kept in sync by patching the proof state in-place after
  // a successful write.
  const [ackSaving, setAckSaving] = useState(false)
  const [ackError, setAckError] = useState<string | null>(null)

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

  // Call the acknowledge-disclaimer edge function. Idempotent on
  // the server — second click returns the existing timestamp —
  // but we still gate client-side on already-ack'd / in-flight
  // so the button UX is tight. Patches the proof state in place
  // on success so the checkbox renders as ticked + disabled
  // immediately without a refetch round-trip.
  async function handleAckChange(checked: boolean) {
    if (!checked) return
    if (!id || !proof) return
    if (proof.disclaimer_acknowledged_at) return
    if (ackSaving) return
    setAckSaving(true)
    setAckError(null)
    try {
      const { data, error } = await supabase.functions.invoke<{
        acknowledged_at?: string
        error?: string
      }>('acknowledge-disclaimer', { body: { proofId: id } })
      if (error) throw new Error(error.message || 'Network error')
      if (!data?.acknowledged_at) throw new Error(data?.error ?? 'Unknown error')
      setProof((prev) =>
        prev ? { ...prev, disclaimer_acknowledged_at: data.acknowledged_at! } : prev,
      )
    } catch (err) {
      setAckError((err as Error).message || 'Could not save')
    } finally {
      setAckSaving(false)
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

    // Fire a single view audit entry per page load. We don't expose the
    // customer's email on the public view, so actor_email stays null; the
    // row still tells us "someone viewed this proof at this time".
    void logCustomerEvent({
      action: 'version.viewed',
      targetType: 'proof',
      targetId: freshProof.id,
      targetLabel: freshProof.customer_name ?? 'proof view',
      metadata: {
        user_agent: navigator.userAgent,
        viewed_version: initialVersion?.version_number ?? null,
      },
    })

    if (rawVersions.length > 0) {
      // Load images for all versions
      const versionIds = rawVersions.map((v) => v.id)
      const { data: imageRows } = await supabase
        .from('public_proof_version_images')
        .select('*')
        .in('proof_version_id', versionIds)
        .order('sort_order')

      const imagesWithUrls = await Promise.all(
        ((imageRows ?? []) as Omit<GridImage, 'signed_url'>[]).map(async (img) => {
          const { data } = await supabase.storage
            .from('proof-images')
            .createSignedUrl((img as any).image_path, SIGNED_URL_TTL)
          return { ...img, signed_url: data?.signedUrl ?? '' }
        })
      )

      const byVersion: Record<string, GridImage[]> = {}
      imagesWithUrls.forEach((img) => {
        const pvid = (img as any).proof_version_id as string
        if (!byVersion[pvid]) byVersion[pvid] = []
        byVersion[pvid].push(img as GridImage)
      })
      setVersionImages(byVersion)

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
  const APPROVED_GREEN = '#4ade80'
  const BRAND_ORDER = ['#e11735', '#d81c7e', '#4a21a6', '#3ba58a']
  const SERIF = "'Cormorant Garamond', Georgia, serif"
  const SANS = "'Inter Tight', system-ui, sans-serif"
  const MONO = "'JetBrains Mono', ui-monospace, monospace"

  // Swatch gradient in the About section — derived from the
  // material display string. Falls back to an indigo-tinted
  // neutral for materials we don't have an explicit swatch for.
  // Lives here rather than as a DB column because swatch
  // rendering is a pure design concern; the same material can
  // carry a different swatch treatment on a different page.
  function materialSwatchGradient(display: string): string {
    const t = display.toLowerCase()
    if (/copper/.test(t))
      return 'radial-gradient(circle at 35% 30%, #e5a87b 0%, #b96c3d 45%, #6b3d22 100%)'
    if (/gold/.test(t))
      return 'radial-gradient(circle at 35% 30%, #f5d878 0%, #c9a13f 45%, #7c6020 100%)'
    if (/steel|gunmetal|gun metal/.test(t))
      return 'radial-gradient(circle at 35% 30%, #c5d0d8 0%, #7a8b98 45%, #3e4a55 100%)'
    if (/carbon/.test(t))
      return 'radial-gradient(circle at 35% 30%, #8a969e 0%, #4a545c 45%, #1a1f23 100%)'
    if (/walnut|cherry|birch|maple|bamboo|wood/.test(t))
      return 'radial-gradient(circle at 35% 30%, #c89a6c 0%, #8e5a30 45%, #4a2d18 100%)'
    if (/paper|card/.test(t))
      return 'radial-gradient(circle at 35% 30%, #f7f3ea 0%, #d8cfbe 45%, #988c76 100%)'
    return 'radial-gradient(circle at 35% 30%, #a79be0 0%, #6b58b3 45%, #2d2352 100%)'
  }

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
                <span
                  className="uppercase tracking-[0.22em] text-white/55"
                  style={{ fontFamily: MONO, fontSize: 12 }}
                >
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
                  <span
                    className="uppercase tracking-[0.22em] text-white/45"
                    style={{ fontFamily: MONO, fontSize: 12 }}
                  >
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
                      <span
                        className="uppercase"
                        style={{
                          fontFamily: MONO,
                          fontSize: 12,
                          color: tone.label,
                          letterSpacing: '0.3em',
                        }}
                      >
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
                    <span
                      className="text-white/75"
                      style={{ fontFamily: MONO, fontSize: 12 }}
                    >
                      {isApprovedKind
                        ? `Signed off ${heroApprovalStrip.dateLabel ?? 'today'} · ${total} / ${total} proof${total === 1 ? '' : 's'}`
                        : 'Some proofs already signed off, others awaiting review'}
                    </span>
                  </div>
                )
              })()}
            </div>
            <p
              className="uppercase tracking-[0.24em] text-white/45"
              style={{ fontFamily: MONO, fontSize: 12 }}
            >
              {(activeVersion?.names?.length ?? 0) >= 2 ? 'Proofs for' : 'Proof for'}
            </p>
            <h1
              className="mt-4 leading-[0.98] tracking-[-0.015em] text-white"
              style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 61 }}
            >
              {proof.customer_name}
            </h1>
            {proof.company && (
              <p
                className="mt-3 italic text-white/55"
                style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 28 }}
              >
                {proof.company}
              </p>
            )}

            {activeVersion && (
              <div className="mt-10 flex flex-wrap items-start gap-x-10 gap-y-5">
                <div>
                  <p
                    className="uppercase tracking-[0.22em] text-white/40"
                    style={{ fontFamily: MONO, fontSize: 11 }}
                  >
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
                  <p
                    className="uppercase tracking-[0.22em] text-white/40"
                    style={{ fontFamily: MONO, fontSize: 11 }}
                  >
                    Revision
                  </p>
                  <p className="mt-1.5 text-[14px] text-white">
                    v{activeVersion.version_number}
                    {heroRevisionDate ? ` · ${heroRevisionDate}` : ''}
                  </p>
                </div>
                {activeVersion.names.length > 0 && (
                  <div>
                    <p
                      className="uppercase tracking-[0.22em] text-white/40"
                      style={{ fontFamily: MONO, fontSize: 11 }}
                    >
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
                          className="mt-3 block uppercase tracking-[0.22em] text-[#1a1612]/55"
                          style={{ fontFamily: MONO, fontSize: 12 }}
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
                        <span
                          className="uppercase tracking-[0.22em] text-[#1a1612]/55"
                          style={{ fontFamily: MONO, fontSize: 11 }}
                        >
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
                        groupIsPair(sharedStandaloneGroup)
                          ? 'grid grid-cols-1 gap-6 md:grid-cols-2'
                          : 'space-y-6',
                      ].join(' ')}
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
                                    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 uppercase tracking-[0.22em]"
                                    style={{
                                      fontFamily: MONO,
                                      fontSize: 12,
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
                      className="mt-6 uppercase tracking-[0.22em] text-white/45"
                      style={{ fontFamily: MONO, fontSize: 12 }}
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
                      <p
                        className="uppercase tracking-[0.22em] text-white/45"
                        style={{ fontFamily: MONO, fontSize: 12 }}
                      >
                        Prices shown for {activeOption.display_name} {optionLabelSingular.toLowerCase()}
                      </p>
                    )}
                  {!activeVersion.custom_quote && (
                    <p
                      className="mt-1 uppercase tracking-[0.22em] text-white/45"
                      style={{ fontFamily: MONO, fontSize: 12 }}
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
                  snapshot={activeVersion.pricing_snapshot}
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
                          <p
                            className="uppercase tracking-[0.22em]"
                            style={{ fontFamily: MONO, fontSize: 12, color: ACCENT }}
                          >
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
                            className="mt-2 uppercase tracking-[0.22em] text-white/45"
                            style={{ fontFamily: MONO, fontSize: 12 }}
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
                        <p
                          className="uppercase tracking-[0.22em] text-white/45"
                          style={{ fontFamily: MONO, fontSize: 12 }}
                        >
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
                <h2
                  className="leading-none text-[#1a1612]"
                  style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                >
                  About our {activeVersion.material_display.toLowerCase()} cards
                </h2>
                  <div className="mt-8 grid items-start gap-10 sm:grid-cols-[1.4fr_1fr] sm:gap-16">
                    <div>
                      <p className="max-w-[62ch] whitespace-pre-line text-[15px] leading-[1.7] text-[#1a1612]/80">
                        {activeVersion.material_description}
                      </p>
                      {/* Key features — curated bullet list per
                          material (migration 000099). Hidden
                          cleanly when the material hasn't been
                          curated (null) or the list is empty, so
                          materials without features don't leave
                          stray mt-6 spacing. 6px ACCENT-filled
                          circle bullet aligns visually with the
                          first line of each feature via a small
                          top offset (the flex baseline would sit
                          the dot on the text baseline, too low;
                          cap height reads better). */}
                      {activeVersion.key_features && activeVersion.key_features.length > 0 && (
                        <ul className="mt-6 max-w-[62ch] space-y-2">
                          {activeVersion.key_features.map((feature, i) => (
                            <li key={i} className="grid grid-cols-[10px_1fr] items-start gap-3">
                              <span
                                aria-hidden
                                className="mt-[0.55em] h-[6px] w-[6px] rounded-full"
                                style={{ background: ACCENT }}
                              />
                              <span className="text-[15px] leading-[1.6] text-[#1a1612]/85">
                                {feature}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {activeVersion.material_disclaimer && (
                        <p className="mt-6 max-w-[62ch] whitespace-pre-line text-[13px] leading-[1.6] text-[#1a1612]/60">
                          {activeVersion.material_disclaimer}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-center sm:-mt-24 sm:items-end">
                      {/* Material swatch — real card-stack image
                          uploaded via admin → material content
                          (materials.icon_url). Falls back to a
                          decorative gradient sphere when the
                          admin hasn't uploaded an image yet so
                          the section never collapses awkwardly.
                          drop-shadow filter (vs box-shadow)
                          means the glow wraps the image's real
                          alpha shape, not its bounding box —
                          reads right for transparent PNGs of
                          card stacks and still fine on opaque
                          images. object-contain preserves the
                          natural aspect rather than cropping to
                          a square. */}
                      {/* Sized to read as a feature, not a
                          thumbnail. 14rem on mobile / 20rem on
                          sm+ (up from 10rem/12rem pre-fix).
                          Fits inside the ~1fr right column of
                          the sm:grid-cols-[1.4fr_1fr] grid at
                          the section's max-w-[1040px] outer
                          width with room to spare, and stays
                          well within a 375px mobile viewport
                          once the grid stacks to single
                          column. Top-alignment with the body
                          paragraph is already handled by the
                          outer grid's items-start; no per-
                          column self-alignment needed. */}
                      {activeVersion.material_icon_url ? (
                        <img
                          src={activeVersion.material_icon_url}
                          alt={`${activeVersion.material_display} swatch`}
                          className="h-56 w-56 object-contain sm:h-80 sm:w-80"
                          style={{
                            // Neutral greyscale shadow — reads as
                            // "image resting on the page" rather
                            // than carrying a brand glow. Same
                            // offset + blur as the previous
                            // ACCENT_GLOW version; only the tint
                            // swaps out. Fallback gradient sphere
                            // (below) keeps its ACCENT-tinted
                            // shadow because it's a decorative
                            // placeholder, not a product image.
                            filter: 'drop-shadow(0 40px 60px rgba(0,0,0,0.28))',
                          }}
                        />
                      ) : (
                        <div
                          aria-hidden
                          className="h-56 w-56 rounded-full sm:h-80 sm:w-80"
                          style={{
                            background: materialSwatchGradient(activeVersion.material_display),
                            boxShadow: `0 40px 80px -20px ${ACCENT_GLOW}, inset -14px -14px 40px rgba(0,0,0,0.35)`,
                          }}
                        />
                      )}
                    </div>
                  </div>
              </div>
            </section>
          )}

          {/* ───── Before you approve (acknowledgement gate) ─────
              Final block before the footer. Permanent-state
              read-receipt on the legal disclaimer copy: the
              customer ticks "I've read this" once, the edge
              function writes proof.disclaimer_acknowledged_at,
              and subsequent visits render the checkbox ticked
              + disabled with a small timestamp line below.
              No un-tick affordance — ack is permanent per
              proof (scaffolding for the future Approve flow
              which will gate on this column being non-null).
              Section only renders when publicSettings.disclaimer_text
              is populated — an empty disclaimer would leave an
              empty gate. Ink background (INK_DEEP, same as the
              Pricing section) sets the gate apart from the
              near-white About block above. */}
          {publicSettings?.disclaimer_text && (
            <section className="py-16" style={{ background: INK_DEEP }}>
              <div className="mx-auto max-w-[1040px] px-6 sm:px-8">
                <div
                  className="rounded-xl px-7 py-8"
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.12)',
                  }}
                >
                  <p
                    className="uppercase tracking-[0.32em]"
                    style={{
                      fontFamily: MONO,
                      fontSize: 10,
                      // Brand teal — the one from the 4-colour
                      // signature rule. Ties the gate's kicker
                      // visually to the brand palette without
                      // using the Plasma indigo (which carries
                      // the "interactive" signal elsewhere).
                      color: BRAND_ORDER[3],
                    }}
                  >
                    Before you approve
                  </p>
                  <h2
                    className="mt-3 text-white"
                    style={{
                      fontFamily: SERIF,
                      fontWeight: 400,
                      fontSize: 36,
                      lineHeight: 1.1,
                    }}
                  >
                    Please check this proof carefully.
                  </h2>
                  <p className="mt-6 max-w-[72ch] whitespace-pre-line text-[15px] leading-[1.75] text-white/75">
                    {publicSettings.disclaimer_text}
                  </p>
                  {publicSettings.reply_email && (
                    <p className="mt-5 text-[13px] text-white/60">
                      Need changes? Reply to{' '}
                      <a
                        href={`mailto:${publicSettings.reply_email}`}
                        className="text-white/85 underline underline-offset-4 hover:text-white"
                      >
                        {publicSettings.reply_email}
                      </a>
                      .
                    </p>
                  )}
                  {(() => {
                    const ackAt = proof.disclaimer_acknowledged_at
                    const isAcked = !!ackAt
                    // Label borders: solid green tint when
                    // acked (reads as "done"), default white
                    // hairline otherwise. Cursor disabled
                    // signals the locked state.
                    const labelClass = [
                      'mt-8 flex w-fit items-center gap-3 rounded-lg px-4 py-3 transition-colors',
                      isAcked
                        ? 'cursor-default'
                        : ackSaving
                          ? 'cursor-wait'
                          : 'cursor-pointer hover:border-white/30',
                    ].join(' ')
                    const labelStyle = isAcked
                      ? { border: '1px solid rgba(74,222,128,0.45)' }
                      : { border: '1px solid rgba(255,255,255,0.15)' }
                    return (
                      <>
                        <label className={labelClass} style={labelStyle}>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={isAcked}
                            disabled={isAcked || ackSaving}
                            onChange={(e) => handleAckChange(e.target.checked)}
                          />
                          <span
                            aria-hidden
                            className="grid h-5 w-5 shrink-0 place-items-center rounded-[4px]"
                            style={
                              isAcked
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
                            {isAcked && (
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
                            className="uppercase tracking-[0.24em] text-white/85"
                            style={{ fontFamily: MONO, fontSize: 11 }}
                          >
                            I've read this and understand the terms
                          </span>
                        </label>
                        {/* Post-checkbox status line —
                            "Acknowledged {date}" when ack'd;
                            muted-red retry message on edge-
                            function failure; nothing while
                            saving (the cursor-wait + disabled
                            input carry that signal). */}
                        {isAcked && ackAt && (
                          <p
                            className="mt-3 uppercase tracking-[0.2em] text-white/50"
                            style={{ fontFamily: MONO, fontSize: 10 }}
                          >
                            Acknowledged{' '}
                            {(() => {
                              const d = new Date(ackAt)
                              if (Number.isNaN(d.getTime())) return ackAt
                              const datePart = d.toLocaleDateString('en-GB', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                              })
                              const timePart = d.toLocaleTimeString('en-GB', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                              return `${datePart}, ${timePart}`
                            })()}
                          </p>
                        )}
                        {ackError && !isAcked && (
                          <p
                            className="mt-3 text-[12px] text-rose-300/90"
                            style={{ fontFamily: MONO }}
                          >
                            Couldn't save, please try again.
                          </p>
                        )}
                      </>
                    )
                  })()}
                </div>
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
            <span
              className="uppercase tracking-[0.22em] text-white/45"
              style={{ fontFamily: MONO, fontSize: 12 }}
            >
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
            <p
              className="uppercase tracking-[0.22em] text-white/45"
              style={{ fontFamily: MONO, fontSize: 12 }}
            >
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
          <img
            src={lightboxSrc}
            alt="Proof image"
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
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

          {/* Grid: spotlight (auto) + rail (1fr), 32px gap,
              vertically centered so the big serif v-number
              sits visually aligned with the rail's y-axis. */}
          <div
            className="grid items-center gap-8"
            style={{ gridTemplateColumns: 'auto 1fr' }}
          >
            {/* Spotlight — min-width so narrow active
                numbers (v1, v2) don't collapse the column,
                right-hand hairline separates from the rail. */}
            <div
              className="min-w-[120px] pr-8"
              style={{ borderRight: '1px solid rgba(255,255,255,0.1)' }}
            >
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
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#1a1612]/25 px-3 py-1 uppercase tracking-[0.22em] text-[#6b6558] transition-colors hover:border-[color:var(--a)] hover:bg-[color:var(--a)] hover:text-white"
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
              className="py-4 pr-4 text-left uppercase tracking-[0.22em] text-white/45"
              style={{ fontFamily: mono, fontSize: 12 }}
            >
              Total quantity
            </th>
            {variants.map((v) => (
              <th
                key={v.variant_id}
                className="py-4 pl-4 text-right uppercase tracking-[0.22em] text-white/45"
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
                  className="py-4 pr-4 leading-none text-white"
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
                        className="py-4 pl-4 text-right text-white/30"
                        style={{ fontFamily: mono, fontSize: 14 }}
                      >
                        —
                      </td>
                    )
                  }
                  const price = base + surcharge
                  return (
                    <td key={v.variant_id} className="py-4 pl-4 text-right">
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
          <h1 className="mt-1 text-3xl font-bold text-gray-900">{proof.customer_name}</h1>
          {proof.company && (
            <p className="mt-1 text-lg text-gray-500">{proof.company}</p>
          )}
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
