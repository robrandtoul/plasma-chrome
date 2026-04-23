import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { PublicProof, PublicProofVersion, PublicMaterialOption, PublicMaterialOptionSurcharge } from '../lib/types'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import { formatPrice } from '../lib/currency'
import { type GridImage } from '../components/ImageGrid'
import { logCustomerEvent } from '../lib/audit'
import { getPublicSettings, type PublicSettings } from '../lib/publicSettings'
import type { PricingSnapshot, Currency } from '../lib/types'

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
  const tabStripRef = useRef<HTMLDivElement>(null)
  // Guards the once-per-page-load proof_version_views insert. A
  // ref survives React strict-mode's double-invoke of effects
  // whereas state wouldn't.
  const viewRecordedRef = useRef(false)

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

  // On initial load, scroll the active tab to the left edge of the strip.
  useEffect(() => {
    if (loading) return
    const strip = tabStripRef.current
    if (!strip) return
    const activeTab = strip.querySelector<HTMLElement>('[data-active="true"]')
    if (!activeTab) return
    strip.scrollLeft = Math.max(0, activeTab.offsetLeft - 8)
  }, [loading])

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
  const APPROVED_GLOW = 'rgba(74,222,128,0.4)'
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
          tabs + option switcher. Dual-glow backdrop with a low-
          opacity 4-colour conic gradient on the opposite side —
          adds a chromatic hint of the brand palette behind the
          material glow without going garish. */}
      <div className="relative overflow-hidden text-white" style={{ background: INK }}>
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 right-[-120px] h-[520px] w-[520px] rounded-full blur-[120px]"
          style={{ background: ACCENT_GLOW }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-52 left-[-160px] h-[480px] w-[480px] rounded-full blur-[140px] opacity-30"
          style={{
            background: `conic-gradient(from 210deg, ${BRAND_ORDER[0]}, ${BRAND_ORDER[1]}, ${BRAND_ORDER[2]}, ${BRAND_ORDER[3]}, ${BRAND_ORDER[0]})`,
          }}
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
                {activeOption && (
                  <span
                    className="inline-flex items-center gap-2 uppercase tracking-[0.22em] text-white/60"
                    style={{ fontFamily: MONO, fontSize: 12 }}
                  >
                    <span
                      className="h-[6px] w-[6px] rounded-full"
                      style={{ background: ACCENT }}
                    />
                    {activeVersion?.material_display}
                    {activeOption ? ` · ${activeOption.display_name}` : ''}
                  </span>
                )}
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

          {/* Approval strip — three states: green full / blue
              partial / silent. Version chip on the right echoes
              the Plates-section name + approval shape. */}
          {heroApprovalStrip && (
            <div className="border-b border-white/10">
              <div className="mx-auto flex max-w-[1040px] flex-wrap items-center justify-between gap-3 px-6 py-4 sm:px-8">
                {heroApprovalStrip.kind === 'approved' ? (
                  <div className="flex items-center gap-4">
                    <span
                      className="inline-flex items-center gap-2 uppercase tracking-[0.22em]"
                      style={{ fontFamily: MONO, fontSize: 12, color: APPROVED_GREEN }}
                    >
                      <span
                        className="h-[6px] w-[6px] rounded-full"
                        style={{
                          background: APPROVED_GREEN,
                          boxShadow: `0 0 8px ${APPROVED_GLOW}`,
                        }}
                      />
                      Approved
                    </span>
                    {heroApprovalStrip.dateLabel && (
                      <span className="text-[13px] text-white/70">
                        Approved on {heroApprovalStrip.dateLabel}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-4">
                    <span
                      className="inline-flex items-center gap-2 uppercase tracking-[0.22em] text-sky-300"
                      style={{ fontFamily: MONO, fontSize: 12 }}
                    >
                      <span
                        className="h-[6px] w-[6px] rounded-full bg-sky-300"
                        style={{ boxShadow: '0 0 8px rgba(125,211,252,0.45)' }}
                      />
                      Partially approved
                    </span>
                    <span className="max-w-[56ch] text-[13px] text-white/70">
                      Some proofs are already approved from a previous version. The rest are awaiting your review.
                    </span>
                  </div>
                )}
                <span
                  className="uppercase tracking-[0.22em] text-white/45"
                  style={{ fontFamily: MONO, fontSize: 12 }}
                >
                  v{activeVersion?.version_number ?? '—'}
                </span>
              </div>
            </div>
          )}

          {/* Hero — "Proofs for" label + customer name + italic
              company + quick-facts row (material / revision /
              names). Scaled so the name reads as the page's
              dominant object at 76px. */}
          <div className="mx-auto max-w-[1040px] px-6 py-20 sm:px-8">
            <p
              className="uppercase tracking-[0.24em] text-white/45"
              style={{ fontFamily: MONO, fontSize: 12 }}
            >
              {(activeVersion?.names?.length ?? 0) >= 2 ? 'Proofs for' : 'Proof for'}
            </p>
            <h1
              className="mt-4 leading-[0.98] tracking-[-0.015em] text-white"
              style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 72 }}
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

          {/* Revisions tabs + option switcher — both sit on the
              ink row below the hero, ordered left→right so the
              axes read as "which version, in which finish". Only
              renders when there's more than one version or the
              version offers ≥2 options — silent when the page
              collapses to a single-version / single-option proof. */}
          {activeVersion && (versions.length > 1 || showOptionSwitcher) && (
            <div className="border-t border-white/10">
              <div
                ref={tabStripRef}
                className="mx-auto flex max-w-[1040px] flex-wrap items-center gap-x-8 gap-y-3 px-6 py-4 sm:px-8"
              >
                {versions.length > 1 && (
                  <>
                    <span
                      className="uppercase tracking-[0.22em] text-white/45"
                      style={{ fontFamily: MONO, fontSize: 12 }}
                    >
                      Revisions
                    </span>
                    <div className="flex flex-wrap gap-6">
                      {[...versions].reverse().map((v) => {
                        const isActive = activeVersion?.id === v.id
                        return (
                          <button
                            key={v.id}
                            data-active={isActive ? 'true' : undefined}
                            onClick={() => setActiveVersion(v)}
                            className={[
                              'relative uppercase tracking-[0.22em] transition-colors',
                              isActive
                                ? 'text-white'
                                : 'text-white/70 hover:text-white',
                            ].join(' ')}
                            style={{ fontFamily: MONO, fontSize: 13 }}
                          >
                            <span className="inline-flex items-center gap-2">
                              v{v.version_number}
                              {v.is_current && (
                                <span
                                  className="tracking-[0.22em]"
                                  style={{ fontFamily: MONO, fontSize: 11, color: ACCENT }}
                                >
                                  · {isApproved ? 'Approved' : 'Current'}
                                </span>
                              )}
                            </span>
                            {isActive && (
                              <span
                                className="absolute -bottom-[17px] left-0 right-0 h-[2px]"
                                style={{ background: ACCENT, boxShadow: `0 0 10px ${ACCENT}` }}
                              />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
                {showOptionSwitcher && (
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {versionOptions.map((code) => {
                      const o = materialOptions.find(
                        (x) =>
                          x.material_id === activeVersion.material_id && x.code === code,
                      )
                      const isActive = activeOptionCode === code
                      const fromPrice = optionFromPrice(code)
                      return (
                        <button
                          key={code}
                          onClick={() => setActiveOptionCode(code)}
                          className={[
                            'rounded-full px-3.5 py-1.5 uppercase tracking-[0.22em] transition-colors',
                            isActive
                              ? 'text-white'
                              : 'text-white/80 ring-1 ring-white/20 hover:text-white hover:ring-white/40',
                          ].join(' ')}
                          style={{
                            fontFamily: MONO,
                            fontSize: 12,
                            ...(isActive
                              ? { background: ACCENT, boxShadow: `0 0 20px ${ACCENT_GLOW}` }
                              : {}),
                          }}
                        >
                          {o?.display_name ?? code}
                          {fromPrice != null && !activeVersion.custom_quote && (
                            <span
                              className={['ml-1.5', isActive ? 'text-white/80' : 'text-white/50'].join(' ')}
                            >
                              (+from {formatPrice(fromPrice, activeVersion.currency, 0)})
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

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
                  <div
                    className="mb-10 flex flex-wrap items-baseline justify-between gap-3 pb-4"
                    style={{ borderBottom: `1px solid ${PAPER_BORDER}` }}
                  >
                    <h2
                      className="leading-none text-[#1a1612]"
                      style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                    >
                      Proofs
                    </h2>
                    <span
                      className="uppercase tracking-[0.22em] text-[#1a1612]/55"
                      style={{ fontFamily: MONO, fontSize: 12 }}
                    >
                      {plateCount === 1 ? '1 proof' : `${plateCount} proofs`}
                      {recipientCount > 0 && (
                        <>
                          {' · '}
                          {recipientCount === 1
                            ? sharedGroup && namedGroups.length === 0
                              ? 'Shared'
                              : '1 recipient'
                            : `${recipientCount} recipients`}
                        </>
                      )}
                    </span>
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
                        return augmentedNamedGroups.map((group) => {
                          const pill =
                            group.heading != null ? approvalPillFor(group.heading) : null
                          const startIdx = colorIdx
                          colorIdx += group.images.length
                          return (
                            <div key={group.heading ?? ''}>
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
                  <p
                    className="uppercase tracking-[0.24em] text-white/40"
                    style={{ fontFamily: MONO, fontSize: 12 }}
                  >
                    § 02
                  </p>
                  <h2
                    className="mt-3 leading-[1.02] text-white"
                    style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                  >
                    Specification
                  </h2>
                  <p className="mt-5 max-w-[30ch] text-[14px] leading-[1.55] text-white/55">
                    Everything that's going to the printer. These are the values your approval locks in.
                  </p>
                </div>
                <dl className="border-t border-white/10">
                  <InkSpecRow label="Material" value={activeVersion.material_display} />
                  {activeOption && (
                    <InkSpecRow label={optionLabelSingular} value={activeOption.display_name} />
                  )}
                  {activeVersion.ink_names.length > 0 && (
                    <InkSpecRow
                      label={activeVersion.ink_names.length === 1 ? 'Ink' : 'Inks'}
                      value={activeVersion.ink_names.join('\n')}
                    />
                  )}
                  {activeVersion.names.length > 0 && (
                    <InkSpecRow
                      label={activeVersion.names.length === 1 ? 'Name' : 'Names'}
                      value={formatNamesList(activeVersion.names)}
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
                    <p
                      className="uppercase tracking-[0.24em] text-white/40"
                      style={{ fontFamily: MONO, fontSize: 12 }}
                    >
                      § 03
                    </p>
                    <h2
                      className="mt-3 leading-[1.02] text-white"
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
                  <p
                    className="uppercase tracking-[0.24em] text-white/40"
                    style={{ fontFamily: MONO, fontSize: 12 }}
                  >
                    § 04
                  </p>
                  <h2
                    className="mt-2 leading-none text-white"
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
                  featuredQuantities={activeVersion.featured_quantities}
                  quantitySurcharges={quantitySurcharges}
                  accent={ACCENT}
                  accentGlow={ACCENT_GLOW}
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
                            to any quantity
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

          {/* ───── Important information (global disclaimer) ─────
              Near-white paper. Top rule matches the About
              section below — the two read as a paired
              appendix block. */}
          {publicSettings?.disclaimer_text && (
            <section style={{ background: PAPER, color: '#1a1612' }}>
              <div className="mx-auto max-w-[1040px] px-6 pb-10 pt-20 sm:px-8">
                <div className="pt-10" style={{ borderTop: `1px solid ${PAPER_BORDER}` }}>
                  {/* Heading matches the Plates section — Cormorant
                      400 at 36px, leading-none — so the three
                      near-white sections (Plates / Important info
                      / About) read as equal-weight editorial
                      blocks rather than Plates carrying all the
                      typographic presence. */}
                  <h2
                    className="leading-none text-[#1a1612]"
                    style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                  >
                    Important information
                  </h2>
                  <p className="mt-6 max-w-[78ch] whitespace-pre-line text-[15px] leading-[1.7] text-[#1a1612]/80">
                    {publicSettings.disclaimer_text}
                  </p>
                  {publicSettings.reply_email && (
                    <p className="mt-5 text-[13px] text-[#1a1612]/70">
                      Need changes? Reply to{' '}
                      <a
                        href={`mailto:${publicSettings.reply_email}`}
                        className="underline underline-offset-4 hover:text-[#1a1612]"
                      >
                        {publicSettings.reply_email}
                      </a>
                      .
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* ───── About {material} ─────
              Two-column layout: copy on the left, swatch orb on
              the right. Swatch gradient derived from the
              material display name (copper/steel/gold/etc) with
              an indigo fallback. Section only renders when the
              material has a description configured — if not,
              the section collapses silently. */}
          {activeVersion.material_description && (
            <section style={{ background: PAPER, color: '#1a1612' }}>
              <div className="mx-auto max-w-[1040px] px-6 pb-24 pt-10 sm:px-8">
                <div className="pt-12" style={{ borderTop: `1px solid ${PAPER_BORDER}` }}>
                  {/* Serif heading at the Plates size — keeps the
                      three near-white sections reading at equal
                      typographic weight. */}
                  <h2
                    className="leading-none text-[#1a1612]"
                    style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 46 }}
                  >
                    About {activeVersion.material_display}
                  </h2>
                  <div className="mt-8 grid items-start gap-10 sm:grid-cols-[1.4fr_1fr] sm:gap-16">
                    <div>
                      <p className="max-w-[62ch] whitespace-pre-line text-[15px] leading-[1.7] text-[#1a1612]/80">
                        {activeVersion.material_description}
                      </p>
                      {activeVersion.material_disclaimer && (
                        <p className="mt-4 max-w-[62ch] whitespace-pre-line text-[13px] leading-[1.6] text-[#1a1612]/60">
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
                            filter: `drop-shadow(0 40px 60px ${ACCENT_GLOW})`,
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
              © Plasma Design
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
function InkPricingTable({
  snapshot,
  currency,
  featuredQuantities,
  quantitySurcharges,
  accent,
  accentGlow,
  serif,
  mono,
}: {
  snapshot: PricingSnapshot
  currency: Currency
  featuredQuantities: number[]
  quantitySurcharges: Record<number, number>
  accent: string
  accentGlow: string
  serif: string
  mono: string
}) {
  const [showAll, setShowAll] = useState(false)
  const { variants } = snapshot
  if (!variants?.length) return null

  const allQuantities = [
    ...new Set(variants.flatMap((v) => Object.keys(v.prices).map(Number))),
  ].sort((a, b) => a - b)
  const featured = new Set(featuredQuantities)
  const visibleQuantities = showAll
    ? allQuantities
    : allQuantities.filter((q) => featured.has(q))
  const hiddenCount = allQuantities.length - allQuantities.filter((q) => featured.has(q)).length
  const showToggle = hiddenCount > 0

  // Single-variant path — the design mock's shape. Multi-
  // variant proofs (rare: thickness + ink count variants in
  // the same material) fall through to a compact per-variant
  // list below.
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
          {showToggle && (
            <tr>
              <td colSpan={3} className="pt-4 text-center">
                <button
                  type="button"
                  aria-expanded={showAll}
                  onClick={() => setShowAll((v) => !v)}
                  className="inline-flex items-center gap-2 rounded-full px-5 py-2 uppercase tracking-[0.22em] text-white transition-all hover:brightness-110"
                  style={{
                    fontFamily: mono,
                    fontSize: 12,
                    background: accent,
                    boxShadow: `0 0 24px ${accentGlow}`,
                  }}
                >
                  {showAll ? 'Show fewer quantities ↑' : 'Show all quantities ↓'}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    )
  }

  // Multi-variant fallback — compact grid, one column per
  // variant. Not styled as editorially as the single-variant
  // path; this branch is rare on customer proofs (most
  // materials ship with a single variant_id on the snapshot).
  return (
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
          {showToggle && (
            <tr>
              <td colSpan={1 + variants.length} className="pt-4 text-center">
                <button
                  type="button"
                  aria-expanded={showAll}
                  onClick={() => setShowAll((v) => !v)}
                  className="inline-flex items-center gap-2 rounded-full px-5 py-2 uppercase tracking-[0.22em] text-white transition-all hover:brightness-110"
                  style={{
                    fontFamily: mono,
                    fontSize: 12,
                    background: accent,
                    boxShadow: `0 0 24px ${accentGlow}`,
                  }}
                >
                  {showAll ? 'Show fewer quantities ↑' : 'Show all quantities ↓'}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
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
