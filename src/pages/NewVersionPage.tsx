import { useEffect, useState, useRef, Fragment, type ChangeEvent, type CSSProperties } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import { formatPrice } from '../lib/currency'
import { pluralLabel, variantLabel } from '../lib/labels'
import { DEFAULT_DISPLAY_QUANTITIES } from '../lib/constants'
import { PricingDisplayField, type PricingDisplayValue } from '../components/PricingDisplayField'
import { CurrencyField } from '../components/CurrencyField'
import NameChipInput from '../components/NameChipInput'
import { matchImageToName } from '../lib/matchImageToName'
import { useImageFileDrop } from '../lib/useImageFileDrop'
import { PageDropOverlay } from '../components/PageDropOverlay'
import type { Currency, ProofNameApproval } from '../lib/types'
import { SHARED_APPROVAL_KEY } from '../lib/types'

interface Material {
  id: string
  display_name: string
  requires_ink_names: boolean
  option_label: string | null
  display_quantities: number[] | null
  multi_variant: boolean
  // Needed so the inheritance path can tag a material as "archived
  // since the prior version was made" and surface a warning near
  // the picker. Filtered out of the default list, but present when
  // the inherited material has been archived since v1.
  archived_at: string | null
}

interface Variant {
  id: string
  display_name: string
  variant_type: string
  sort_order: number
  ink_count: number | null
}

interface MaterialOption {
  id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
}

interface PriceTierRow {
  material_variant_id: string
  quantity: number
  total_price: number
}

interface ImageEntry {
  localId: string
  file: File
  preview: string
  // Pre-populated from matchImageToName when the file is added.
  // Designer can override via the per-image dropdowns before save.
  associated_name: string | null
  side: 'front' | 'back' | null
}

// One v1 image, loaded on mount to drive carry-forward cards.
// file_path is the storage key shared across versions when Keep is
// on — no copy happens. preview is a short-TTL signed URL.
interface V1Image {
  v1RowId: string
  file_path: string
  preview: string
  original_filename: string | null
  associated_name: string | null   // null = shared
  material_option: string | null   // null = no-option
  // Null back-compat for pre-migration-000085 data. App-level
  // back-compat treats null as 'front' in carry-match and
  // rendering. Post-migration data is strictly 'front' | 'back'.
  side: 'front' | 'back' | null
}

// Snapshot of every value inherited from v(N-1) at form-load time.
// Per-field carried/edited indicators derive from comparing this
// snapshot to current form state — see the c.* derivations in render.
// Null on v1 creation (no inheritance source) and the indicators
// collapse to "not carried" everywhere.
interface InheritedSnapshot {
  versionNumber: number
  materialId: string
  variantIds: string[]
  currency: Currency
  cardType: 'business' | 'membership'
  sidedness: 'one-sided' | 'two-sided'
  shared: boolean
  pricingDisplay: PricingDisplayValue
  names: string[]
  inkNamesArray: string[]
  inkNamesText: string
  materialOptions: string[]
}

// Everything the UI + save path needs to decide carry-forward
// outcomes. Null when creating v1 (no prior version to carry from);
// the form falls back to the existing flat image UI in that case.
interface V1CarryContext {
  versionId: string
  versionNumber: number
  names: string[]
  materialOptions: string[]   // codes — '' represents "no-option" equivalent on v2
  images: V1Image[]
  approvalsByName: Record<string, ProofNameApproval>  // keyed by recipient name OR SHARED_APPROVAL_KEY
}

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg']
const MAX_IMAGES = 12

export default function NewVersionPage() {
  const { id: proofId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [proofName, setProofName] = useState('')
  const [proofCompany, setProofCompany] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [selectedMaterialId, setSelectedMaterialId] = useState('')
  const [variants, setVariants] = useState<Variant[]>([])
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([])
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [variantTiers, setVariantTiers] = useState<Record<string, PriceTierRow[]>>({})
  const [expandedVariants, setExpandedVariants] = useState<Record<string, boolean>>({})
  // Inheritance tracking. On v2+ creation we snapshot every inherited
  // value into inheritedSnapshot once the prior version loads. From
  // there each field derives its own isCarried/isEdited live by
  // comparing the snapshot to current state — so "modify then revert"
  // naturally clears the edited indicator without bespoke flag
  // bookkeeping. Null on v1 (no prior version) and the comparisons
  // collapse to "not carried" everywhere.
  //
  // inheritedVariantIdsRef stashes the variant IDs to restore after
  // the material's variants load — can't be state because the
  // variants-loading effect needs to read it synchronously and it
  // shouldn't trigger a re-render when consumed. Cleared once the
  // effect applies it.
  //
  // inheritedMaterialArchived surfaces a warning near the material
  // field when the inherited material has been archived since the
  // prior version was made. Designer can keep it or pick fresh.
  const [inheritedSnapshot, setInheritedSnapshot] = useState<InheritedSnapshot | null>(null)
  const [inheritedMaterialArchived, setInheritedMaterialArchived] = useState(false)
  const inheritedVariantIdsRef = useRef<string[] | null>(null)
  // Inherited material_options stash — mirrors the variant-ids
  // pattern above. Material-options don't live on state at mount
  // time (they're fetched by the material-variants effect once
  // the material id is known), so we stash the inherited codes
  // here and let that effect re-apply them after its own
  // options query resolves. Without this, the effect's
  // unconditional setSelectedOptions([base.code]) stomps the
  // inherited set before the carry-render ever sees it, and v1
  // images saved under a non-base option (e.g. Brushed / Mirror
  // on Steel, or any non-Natural species on Wood) render as
  // EmptySlot cells on v2.
  const inheritedMaterialOptionsRef = useRef<string[] | null>(null)
  // Two separate ink states so each form path (free-text vs per-ink) keeps
  // typing feel. They only cross over when the designer switches materials
  // between the "requires per-ink names" set and everything else.
  const [inkNamesText, setInkNamesText] = useState('')
  const [inkNamesArray, setInkNamesArray] = useState<string[]>([])
  // Split-name tooling recipients. Pre-filled from the project's
  // most-recent prior version (if any) on mount — designer still
  // edits freely. Empty list is valid and allowed at submit.
  const [names, setNames] = useState<string[]>([])
  // ── Shape controls (card type + sidedness + shared toggle) ────────────────
  // cardType is the top-level mode — 'business' is the standard
  // split-name workflow (names are required recipient people),
  // 'membership' covers "one design for everyone" (empty names)
  // and "tier variants" (non-empty names, e.g. Bronze / Silver /
  // Gold). Membership with ≥1 variants produces per-variant
  // slots identical in shape to business per-name slots; only
  // the UI copy differs. Stored as proof_versions.card_type
  // (migration 000086).
  //
  // sidedness + shared drive the slot universe along with names[]
  // and the material's options. Shared is only meaningful when
  // there are ≥2 identities (names or variants) on a two-sided
  // project: with a single identity there's only one card and
  // the shared/per-identity distinction collapses. When ON one
  // side is a single design shared across every card (that side
  // is internally always 'front' by convention — not surfaced in
  // UI) and the other is per-identity. When OFF every card has
  // its own design on every side. One-sided projects are always
  // per-identity, no shared option. Membership with 0 variants
  // has a single shared slot per side — no per-identity dimension
  // to collapse.
  //
  // v1 defaults: business card, two-sided, shared OFF. On v2+
  // creation, the mount effect reads cardType from v(N-1)'s
  // card_type column and derives sidedness + shared from the
  // prior version's images:
  //   cardType  = v(N-1).card_type
  //   sidedness = exists image with side='back' ? 'two-sided' : 'one-sided'
  //   shared    = sidedness === 'two-sided'
  //               && exists image with associated_name IS NULL
  //                  AND side='front'
  //
  // Flipping any of these can invalidate approvals if v(N-1) had
  // approved images whose slots vanish in the new shape. Handlers
  // below compute the impact and fire a confirm before applying.
  // Card type flip affects the Name-vs-Variant copy and validation
  // requirement but not the underlying shape machinery — see
  // handleCardTypeChange.
  const [cardType, setCardType] = useState<'business' | 'membership'>('business')
  const [sidedness, setSidedness] = useState<'one-sided' | 'two-sided'>('two-sided')
  const [shared, setShared] = useState(false)
  const [changeNotes, setChangeNotes] = useState('')
  const [pricingDisplay, setPricingDisplay] = useState<PricingDisplayValue | null>(null)
  const [availableOptions, setAvailableOptions] = useState<MaterialOption[]>([])
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [imagesByOption, setImagesByOption] = useState<Record<string, ImageEntry[]>>({ '': [] })
  const [activeImageOption, setActiveImageOption] = useState('')

  // ── Shape B carry-forward state ──────────────────────────────────────────
  // v1Carry is null when creating v1 or when the form can't find an
  // is_current prior version. The render path and save path both
  // key off this — null → legacy flat UI, non-null → grouped UI
  // with Keep toggles and carry semantics.
  const [v1Carry, setV1Carry] = useState<V1CarryContext | null>(null)
  // Keep toggle state per v1 row. Default true on mount for every
  // carried row. Flips to false automatically when a replacement
  // is queued for that row (and stays false even if the replacement
  // is later cleared — designer intent is to replace, not keep).
  const [keepByV1RowId, setKeepByV1RowId] = useState<Record<string, boolean>>({})
  // Replacement files queued per v1 row. File + preview for the
  // card's render. Undefined entry = no replacement.
  const [replacementByV1RowId, setReplacementByV1RowId] = useState<
    Record<string, { file: File; preview: string }>
  >({})
  const [fileError, setFileError] = useState('')
  const [fileNote, setFileNote] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [validationToast, setValidationToast] = useState('')

  // ── Form collapse state (Tier 2c) ─────────────────────────────────────────
  // The form is collapsed by default on v2+ creation behind a tight
  // summary card showing "what this version inherits". Designer
  // expands by clicking "Edit details" and the form stays expanded
  // for the rest of the page lifecycle. Default true on v1 (no
  // inheritance to summarise — full form visible from the start),
  // flipped via the effect below once we know whether there's an
  // inheritance source. Submit-time validation failure also
  // auto-expands so the offending field is visible.
  const [formExpanded, setFormExpanded] = useState(false)

  const imageSectionRef     = useRef<HTMLElement | null>(null)
  const pricingDisplayRef   = useRef<HTMLElement | null>(null)
  const materialRef         = useRef<HTMLSelectElement>(null)
  const variantRef          = useRef<HTMLDivElement>(null)
  const currencyRef         = useRef<HTMLDivElement>(null)
  const inkNamesRef         = useRef<HTMLDivElement>(null)
  const namesRef            = useRef<HTMLDivElement>(null)
  const toastTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hidden file input behind the section-level drop zone's click-
  // to-browse affordance. The zone is keyboard-accessible (Enter /
  // Space activate the click), so the input has to be focusable
  // via this ref rather than wrapped in a label.
  const sectionDropInputRef = useRef<HTMLInputElement>(null)

  // Page-wide drop affordance + zone-level drag styling. Mirrors the
  // EditVersionPage pattern. The hook captures the latest onFiles
  // via a ref internally so addFilesBatch's closure (defined further
  // down) stays current without re-binding window listeners. Per-
  // cell drop zones (CarryCard, EmptySlot) call e.stopPropagation
  // in their drop handlers, so window-level drops only fire for
  // drops outside any per-cell zone.
  const { isZoneDragOver, isPageDragOver, zoneProps } = useImageFileDrop({ onFiles: (f) => addFilesBatch(f) })

  useEffect(() => {
    if (!proofId) return

    let cancelled = false

    async function load() {
      // Customer name + company for the page chrome. Fires in
      // parallel; not ordering-sensitive.
      void supabase.from('proofs').select('contacts(full_name, companies(name))').eq('id', proofId!).single()
        .then(({ data }) => {
          if (cancelled) return
          const c = (data?.contacts as any)
          if (c) {
            setProofName(c.full_name ?? '')
            setProofCompany(c.companies?.name ?? '')
          }
        })

      // Materials for the picker. Filtered to active + published +
      // non-archived by default. Inheritance below prepends an
      // archived material back in if the prior version used one,
      // so the designer can continue with it.
      const materialsPromise = supabase
        .from('materials')
        .select('id, display_name, requires_ink_names, option_label, display_quantities, multi_variant, archived_at')
        .eq('is_active', true)
        .eq('is_published', true)
        .is('archived_at', null)
        .order('sort_order')

      // Inheritance from the proof's current version. Single query
      // pulls currency + material + variant (via pricing_snapshot) +
      // names so all four form fields hydrate from the same source.
      // is_current = true targets the designer's promoted working
      // version rather than "latest created" — if those have
      // diverged (via Set as current in the modal), the promoted
      // version is the source of truth. Runs before the
      // settings-defaults fetch so currency inheritance wins over
      // the admin-configured default (specific intent beats global
      // default).
      const inheritPromise = supabase
        .from('proof_versions')
        .select('id, version_number, currency, material_id, pricing_snapshot, names, ink_names, material_options, card_type, custom_quote')
        .eq('proof_id', proofId!)
        .eq('is_current', true)
        .maybeSingle()

      const [materialsResult, inheritResult] = await Promise.all([materialsPromise, inheritPromise])
      if (cancelled) return

      let materialsList = (materialsResult.data ?? []) as Material[]
      let currencyInherited = false
      let pricingDisplayInherited = false
      // Partial snapshot — captured progressively across the
      // inherited block, finalised once sidedness + shared are
      // derived from v1's image set further below. Null when
      // there's nothing to inherit (v1 creation).
      let partialSnapshot: Omit<InheritedSnapshot, 'sidedness' | 'shared'> | null = null
      const inherited = inheritResult.data as {
        id: string
        version_number: number
        currency: string
        material_id: string
        pricing_snapshot: { variants?: { variant_id?: string }[] } | null
        names: string[] | null
        ink_names: string[] | null
        material_options: string[] | null
        card_type: 'business' | 'membership'
        custom_quote: boolean
      } | null

      if (inherited) {
        // Names chip-list — previously pulled from "latest created"
        // in a separate query; now folded into this one so it
        // tracks the same is_current version as the other fields.
        const inheritedNames = Array.isArray(inherited.names) ? inherited.names : []
        if (inheritedNames.length > 0) {
          setNames(inheritedNames)
        }

        // Currency — always inheritable.
        setCurrency(inherited.currency as Currency)
        currencyInherited = true

        // Material — if the inherited material is archived, it
        // won't appear in the filtered list above. Fetch it
        // unfiltered and prepend so the picker can still show it
        // as the selected value.
        const inMain = materialsList.some((m) => m.id === inherited.material_id)
        if (!inMain) {
          const { data: archivedMatData } = await supabase
            .from('materials')
            .select('id, display_name, requires_ink_names, option_label, display_quantities, multi_variant, archived_at')
            .eq('id', inherited.material_id)
            .maybeSingle()
          if (!cancelled && archivedMatData) {
            materialsList = [archivedMatData as Material, ...materialsList]
            setInheritedMaterialArchived(true)
          }
        }
        setMaterials(materialsList)
        setSelectedMaterialId(inherited.material_id)

        // Variants — stash in a ref for the variants-loading
        // effect to consume once the material's variants finish
        // loading. Without this, the material-effect's auto-select
        // would stomp the inherited IDs before they could be
        // applied.
        const variantIds = Array.isArray(inherited.pricing_snapshot?.variants)
          ? inherited.pricing_snapshot!.variants!
              .map((v) => v.variant_id)
              .filter((id): id is string => typeof id === 'string')
          : []
        if (variantIds.length > 0) {
          inheritedVariantIdsRef.current = variantIds
        }

        // Material options — stash in a ref for the same effect
        // to consume once that effect's options query resolves.
        // Mirrors the variant-ids pattern above. Same stomping
        // hazard: the effect unconditionally sets
        // selectedOptions=[base.code] on load, which would drop
        // v1's full option set (e.g. ['brushed', 'mirror']) down
        // to just the base. That in turn leaves carry-forward
        // images saved under non-base options invisible on v2
        // because the carry filter keys on activeImageOption.
        if (
          Array.isArray(inherited.material_options) &&
          inherited.material_options.length > 0
        ) {
          inheritedMaterialOptionsRef.current = inherited.material_options
        }

        // Ink names — inherited ink_names is a plain text[] on the
        // DB. Which form-state slot we write to depends on the
        // inherited material's requires_ink_names flag: true =>
        // positional (inkNamesArray, one per ink slot on the
        // variant); false => free-form comma-separated
        // (inkNamesText). materialsList has the inherited material
        // by now (either native or prepended as archived), so the
        // lookup is safe. No explicit truncate/pad — the render
        // loop reads by index up to the current variant's ink_count,
        // and save-time slice(0, inkCount) drops anything beyond.
        // Extra entries persist in state so toggling variant up and
        // down within a material doesn't lose designer data.
        const inheritedMaterialRecord = materialsList.find((m) => m.id === inherited.material_id)
        const inheritedInkNamesRaw = Array.isArray(inherited.ink_names) ? inherited.ink_names : []
        let snapshotInkNamesArray: string[] = []
        let snapshotInkNamesText = ''
        if (inheritedMaterialRecord && inheritedInkNamesRaw.length > 0) {
          if (inheritedMaterialRecord.requires_ink_names) {
            setInkNamesArray(inheritedInkNamesRaw)
            snapshotInkNamesArray = inheritedInkNamesRaw
          } else {
            const joined = inheritedInkNamesRaw.join(', ')
            setInkNamesText(joined)
            snapshotInkNamesText = joined
          }
        }

        // Pricing display (Tier 1) — was previously not inherited
        // ("per-version choice" per an old comment). In practice
        // a custom-quote project stays custom-quote across versions
        // and a standard-priced project stays standard. Carrying
        // forward removes a redundant click. Settings-default
        // fallback below only fires when nothing was inherited.
        const inheritedPricingDisplay: PricingDisplayValue = inherited.custom_quote ? 'custom' : 'standard'
        setPricingDisplay(inheritedPricingDisplay)
        pricingDisplayInherited = true

        // Stash partial snapshot values; sidedness + shared get
        // derived from v1's images in the image-loading block
        // below, where the snapshot is finalised and committed to
        // state.
        partialSnapshot = {
          versionNumber: inherited.version_number,
          materialId: inherited.material_id,
          variantIds,
          currency: inherited.currency as Currency,
          cardType: inherited.card_type,
          pricingDisplay: inheritedPricingDisplay,
          names: inheritedNames,
          inkNamesArray: snapshotInkNamesArray,
          inkNamesText: snapshotInkNamesText,
          materialOptions:
            Array.isArray(inherited.material_options) ? inherited.material_options : [],
        }
      } else {
        // v1 — no inheritance, just hydrate the picker with the
        // unfiltered active+published materials.
        setMaterials(materialsList)
      }

      // Form-collapse decision (Tier 2c). Made HERE rather than via
      // a useEffect on [inheritedVersionNumber] because the effect
      // pattern races: the effect fires on initial render with the
      // dep value still null (inheritance not yet loaded), opens
      // the form, and never re-collapses when inheritance arrives.
      // Setting it inline here means the decision is made once with
      // real data: expand on v1 (no inheritance source — full form
      // visible from the start), collapse on v2+ (summary card
      // takes over until the designer clicks Edit or hits a
      // validation failure).
      setFormExpanded(inherited === null)

      // Shape B carry-forward load. Only runs when we have an
      // inherited (is_current) version — that's the v1 we're
      // cloning from. Fetches all images + approvals in parallel,
      // builds signed URLs for the image previews (1h TTL matches
      // the edit and modal paths), and stashes the lot in
      // v1Carry. Default Keep=on for every carried image.
      //
      // If no inherited version exists (v1 creation), skip entirely
      // — the form falls back to the legacy flat image UI.
      if (inherited) {
        const [imagesResult, approvalsResult] = await Promise.all([
          supabase
            .from('proof_version_images')
            .select('id, image_path, original_filename, associated_name, material_option, side, sort_order')
            .eq('proof_version_id', inherited.id)
            .order('sort_order'),
          supabase
            .from('proof_name_approvals')
            .select('*')
            .eq('proof_version_id', inherited.id),
        ])
        if (cancelled) return

        const imageRows = (imagesResult.data ?? []) as {
          id: string
          image_path: string
          original_filename: string | null
          associated_name: string | null
          material_option: string | null
          side: 'front' | 'back' | null
          sort_order: number
        }[]

        const imagesWithUrls: V1Image[] = await Promise.all(
          imageRows.map(async (r) => {
            const { data: urlData } = await supabase.storage
              .from('proof-images')
              .createSignedUrl(r.image_path, 3600)
            return {
              v1RowId: r.id,
              file_path: r.image_path,
              preview: urlData?.signedUrl ?? '',
              original_filename: r.original_filename,
              associated_name: r.associated_name,
              material_option: r.material_option,
              side: r.side,
            }
          }),
        )
        if (cancelled) return

        const approvalsByName: Record<string, ProofNameApproval> = {}
        for (const a of (approvalsResult.data ?? []) as ProofNameApproval[]) {
          approvalsByName[a.name] = a
        }

        const keepDefaults: Record<string, boolean> = {}
        for (const img of imagesWithUrls) keepDefaults[img.v1RowId] = true

        setV1Carry({
          versionId: inherited.id,
          versionNumber: inherited.version_number,
          names: Array.isArray(inherited.names) ? inherited.names : [],
          materialOptions: Array.isArray(inherited.material_options) ? inherited.material_options : [],
          images: imagesWithUrls,
          approvalsByName,
        })
        setKeepByV1RowId(keepDefaults)

        // Shape inheritance — derived from v(N-1)'s data. Null
        // side normalises to 'front' for back-compat with pre-
        // migration-000085 data. With validation enforcing "every
        // slot has at least one image", derivation reliably
        // reconstructs the v(N-1) shape.
        //
        //   cardType  — read straight from v(N-1).card_type
        //               (migration 000086 added the explicit
        //               column; we no longer infer from
        //               names.length).
        //   sidedness — any image has side='back' → two-sided
        //   shared    — two-sided AND any image has
        //               associated_name IS NULL AND side='front'
        //               (shared side is always 'front' by
        //               convention — see state declaration above)
        setCardType(inherited.card_type)
        // Default the snapshot to the v1 state-defaults — only
        // overwritten if there's at least one v1 image to derive
        // from (matches the actual setSidedness/setShared paths).
        let inheritedSidedness: 'one-sided' | 'two-sided' = 'two-sided'
        let inheritedShared = false
        if (imagesWithUrls.length > 0) {
          const sideOf = (img: V1Image) => img.side ?? 'front'
          const hasBack = imagesWithUrls.some((i) => sideOf(i) === 'back')
          const nextSidedness: 'one-sided' | 'two-sided' = hasBack ? 'two-sided' : 'one-sided'
          const hasSharedFront = imagesWithUrls.some(
            (i) => i.associated_name == null && sideOf(i) === 'front',
          )
          setSidedness(nextSidedness)
          setShared(nextSidedness === 'two-sided' && hasSharedFront)
          inheritedSidedness = nextSidedness
          inheritedShared = nextSidedness === 'two-sided' && hasSharedFront
        }

        // Finalise the inheritance snapshot — partialSnapshot was
        // populated up top in the same `if (inherited)` block, so
        // it's guaranteed non-null here. Per-field carried/edited
        // indicators in render compare this snapshot to current
        // state.
        if (partialSnapshot) {
          setInheritedSnapshot({
            ...partialSnapshot,
            sidedness: inheritedSidedness,
            shared: inheritedShared,
          })
        }
      }

      // Settings defaults — both currency and pricing display
      // defaults only apply when we didn't inherit one (Tier 1
      // brought pricingDisplay into the inheritance set, so the
      // settings default is now strictly a v1-creation fallback).
      const { data: settings } = await supabase
        .from('settings')
        .select('default_pricing_display, default_currency')
        .eq('id', 1)
        .single()
      if (cancelled) return
      if (settings) {
        if (!pricingDisplayInherited && settings.default_pricing_display != null) {
          setPricingDisplay((settings.default_pricing_display === 'custom_quote' ? 'custom' : 'standard') as PricingDisplayValue)
        }
        if (!currencyInherited && settings.default_currency != null) {
          setCurrency(settings.default_currency as Currency)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [proofId])

  useEffect(() => {
    setVariants([])
    setSelectedVariantIds([])
    setVariantTiers({})
    setAvailableOptions([])
    setSelectedOptions([])
    setActiveImageOption('')
    setImagesByOption({ '': [] })
    if (!selectedMaterialId) return

    let cancelled = false

    async function load() {
      const [variantsResult, optionsResult] = await Promise.all([
        supabase.from('material_variants')
          .select('id, display_name, variant_type, sort_order, ink_count')
          .eq('material_id', selectedMaterialId)
          .eq('is_active', true)
          .order('sort_order'),
        supabase.from('material_options')
          .select('id, code, display_name, is_base, sort_order')
          .eq('material_id', selectedMaterialId)
          .order('sort_order'),
      ])
      if (cancelled) return

      const v = (variantsResult.data ?? []) as Variant[]
      setVariants(v)

      // Variants — apply inherited IDs first (if the mount
      // effect stashed any), otherwise fall through to the
      // material's auto-select defaults. Intersection with the
      // freshly-loaded variants is defensive in case a variant
      // has been retired between versions. Consume the ref
      // either way so a subsequent material change doesn't
      // accidentally re-apply.
      //
      // Note: the previous version of this block used an early
      // `return` when inherited variants applied, which also
      // silently skipped the options initialisation below. That
      // turned out to be the root cause of v1 images rendering
      // as EmptySlot cells on v2 — availableOptions stayed at
      // [], activeImageOption stayed at '', and the carry
      // filter keyed on activeImageOption never matched any v1
      // image that had a material_option set. Switched to an
      // applied-flag + fall-through so options always run.
      let variantsApplied = false
      if (inheritedVariantIdsRef.current) {
        const validInherited = inheritedVariantIdsRef.current.filter((id) =>
          v.some((x) => x.id === id),
        )
        inheritedVariantIdsRef.current = null
        if (validInherited.length > 0) {
          setSelectedVariantIds(validInherited)
          variantsApplied = true
        }
        // Fell through — inherited IDs no longer match any
        // variant (rare: variant retired). The auto-select below
        // picks defaults. Per-field carried/edited derivation
        // compares against the snapshot, so the indicator just
        // surfaces as "edited" — no flag bookkeeping needed.
      }
      if (!variantsApplied) {
        const pickedMaterial = materials.find((m) => m.id === selectedMaterialId)
        if (pickedMaterial?.multi_variant) {
          setSelectedVariantIds(v.map((x) => x.id))
        } else if (v.length === 1) {
          setSelectedVariantIds([v[0].id])
        } else {
          setSelectedVariantIds([])
        }
      }

      // Options — apply inherited option codes first (if the
      // mount effect stashed any), otherwise fall back to the
      // material's base option. Without the inherited branch,
      // v2 would always boot with just [base.code] selected and
      // v1 images saved under any non-base option would render
      // as EmptySlot cells on their respective tabs. Intersection
      // with loaded options is defensive — an option code may
      // have been retired or renamed since v1.
      const options = (optionsResult.data ?? []) as MaterialOption[]
      setAvailableOptions(options)
      if (options.length > 0) {
        let optionsApplied = false
        if (inheritedMaterialOptionsRef.current) {
          const validInheritedOpts = inheritedMaterialOptionsRef.current.filter(
            (code) => options.some((o) => o.code === code),
          )
          inheritedMaterialOptionsRef.current = null
          if (validInheritedOpts.length > 0) {
            setSelectedOptions(validInheritedOpts)
            setActiveImageOption(validInheritedOpts[0])
            setImagesByOption(
              Object.fromEntries(validInheritedOpts.map((c) => [c, []])),
            )
            optionsApplied = true
          }
        }
        if (!optionsApplied) {
          const base = options.find((o) => o.is_base) ?? options[0]
          setSelectedOptions([base.code])
          setActiveImageOption(base.code)
          setImagesByOption({ [base.code]: [] })
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [selectedMaterialId])

  // ── Shape B carry-forward helpers ────────────────────────────────────────
  // Keep toggle fires on designer click. When flipping from on→off,
  // we clear any replacement file queued for this row (designer has
  // decided the image is gone; holding onto a replacement would be
  // confusing). When flipping off→on, designer is explicitly
  // re-carrying; no replacement side effect.
  function handleKeepToggle(v1RowId: string, next: boolean) {
    setKeepByV1RowId((prev) => ({ ...prev, [v1RowId]: next }))
    if (!next) {
      setReplacementByV1RowId((prev) => {
        const { [v1RowId]: _, ...rest } = prev
        return rest
      })
    }
  }

  // Replacement upload auto-flips Keep off. The carry row is
  // semantically replaced — new file_path, new proof_version_images
  // row. Approval can't carry for the slot.
  function handleReplacementUpload(v1RowId: string, file: File) {
    setReplacementByV1RowId((prev) => ({
      ...prev,
      [v1RowId]: { file, preview: URL.createObjectURL(file) },
    }))
    setKeepByV1RowId((prev) => ({ ...prev, [v1RowId]: false }))
  }

  function handleReplacementClear(v1RowId: string) {
    setReplacementByV1RowId((prev) => {
      const entry = prev[v1RowId]
      if (entry) URL.revokeObjectURL(entry.preview)
      const { [v1RowId]: _, ...rest } = prev
      return rest
    })
    // Restore Keep to on — designer changed their mind about the
    // replacement, so the v1 image is now the intended carry again.
    setKeepByV1RowId((prev) => ({ ...prev, [v1RowId]: true }))
  }

  useEffect(() => {
    setVariantTiers({})
    setExpandedVariants({})
    if (selectedVariantIds.length === 0 || currency === null) return

    // Capture the selection for this fetch so the callback can
    // seed an empty-tiers entry for every variant we asked for.
    // Having an entry for every selected variant (even those with
    // zero price_tiers rows, like 5–8 ink variants) lets
    // downstream logic distinguish "loaded, no prices" from "still
    // loading". The custom-quote detection below relies on that
    // distinction.
    const requested = selectedVariantIds
    supabase.from('price_tiers')
      .select('material_variant_id, quantity, total_price')
      .in('material_variant_id', requested)
      .eq('currency', currency)
      .order('quantity')
      .then(({ data }) => {
        const rows = (data ?? []) as PriceTierRow[]
        const tiersMap: Record<string, PriceTierRow[]> = {}
        for (const vid of requested) tiersMap[vid] = []
        rows.forEach((r) => {
          tiersMap[r.material_variant_id]?.push(r)
        })
        setVariantTiers(tiersMap)
      })
  }, [selectedVariantIds, currency])

  // activeKey is the map key for the currently visible finish tab
  const hasOptions = availableOptions.length > 0
  const optionMode  = hasOptions && selectedOptions.length > 0
  const activeKey   = optionMode ? activeImageOption : ''

  function toggleOption(code: string) {
    setSelectedOptions(prev => {
      if (prev.includes(code)) {
        // Deselecting — revoke previews and remove from map
        setImagesByOption(ibf => {
          const imgs = ibf[code] ?? []
          imgs.forEach(img => URL.revokeObjectURL(img.preview))
          const { [code]: _removed, ...rest } = ibf
          return rest
        })
        const next = prev.filter(c => c !== code)
        if (activeImageOption === code) setActiveImageOption(next[0] ?? '')
        return next
      } else {
        // Selecting — if entering finish mode for first time, migrate '' images
        setImagesByOption(ibf => {
          if (prev.length === 0) {
            const { '': noFinishImgs = [], ...rest } = ibf
            return { ...rest, [code]: noFinishImgs }
          }
          return { ...ibf, [code]: [] }
        })
        if (prev.length === 0) setActiveImageOption(code)
        return [...prev, code]
      }
    })
  }

  // Section-level batch drop. Called from the new section-level
  // drop zone, the page-wide drop handler (window-level), and the
  // zone's click-to-browse picker. Auto-distributes each file to a
  // slot in the active option tab using the matchImageToName
  // heuristic for filename hints, drop-order alternation for null
  // sides (front, back, front, back, reset per batch), and a
  // shape-derived fallback identity when the heuristic returns no
  // name.
  //
  // Per-slot precision drops on EmptySlot still call addFilesToSlot
  // directly (those zones e.stopPropagation in their drop handlers
  // so window-level drops do not double-fire). CarryCard's per-card
  // drop similarly stays out of this path. So this batch handler
  // only fires for drops outside any per-cell zone.
  function addFilesBatch(files: File[]) {
    setFileError('')
    setFileNote('')
    if (files.length === 0) return

    // Gate: slot universe must exist before any image can land. In
    // Business mode with no names, the cell builder has no slots and
    // an entry would be unreachable from the grid. Surface the same
    // copy as the disabled-state caption on the zone.
    if (!hasAnySlot) {
      setFileError('Add a name first to drop images.')
      return
    }

    const optionCode = activeKey
    const freshInOption = (imagesByOption[optionCode] ?? []).length
    const remaining = MAX_IMAGES - freshInOption

    const partition = partitionFiles(files, remaining)

    // Surface the right error for an all-rejected batch. Type wins
    // over size wins over cap because that mirrors how a designer
    // would diagnose: did anything get accepted at all, was it the
    // wrong kind, the wrong size, or the slot full?
    if (partition.ok.length === 0) {
      if (partition.rejectedByType > 0) {
        setFileError('Only image files can be added.')
      } else if (partition.rejectedBySize > 0) {
        setFileError('Each image must be 10 MB or smaller.')
      } else if (partition.rejectedByLimit > 0) {
        setFileNote(`Can't add more, ${MAX_IMAGES}-image limit reached for this tab.`)
      }
      return
    }

    // Duplicate detection within the active option's fresh entries.
    // Signature is name + size — robust enough for accidental re-
    // drags of the same Finder selection without needing to read
    // file bytes. Skipped duplicates surface in fileNote, never in
    // fileError (the designer's intent is benign).
    const existingSignatures = new Set(
      (imagesByOption[optionCode] ?? []).map((e) => `${e.file.name}|${e.file.size}`),
    )
    const dedupedOk: File[] = []
    const duplicateNames: string[] = []
    for (const file of partition.ok) {
      const sig = `${file.name}|${file.size}`
      if (existingSignatures.has(sig)) {
        duplicateNames.push(file.name)
        continue
      }
      existingSignatures.add(sig)
      dedupedOk.push(file)
    }

    // Identity-aware slot resolver. The previous implementation
    // resolved side from the heuristic or alternator first, then
    // picked the identity, which produced orphan entries on
    // asymmetric shapes: a file matched to "Richard" (back-only in
    // a two-sided + shared shape) could land on front when the
    // alternator happened to point there, with the cell builder
    // silently filtering it out and the entry accumulating in
    // state as a duplicate-detection ghost.
    //
    // The shape rule used by the cell builder is the source of
    // truth: each identity has a fixed set of valid sides given
    // the (sidedness, shared, cardType, names) combination. The
    // resolver below queries that set per identity and overrides
    // the heuristic side when the identity has only one valid
    // side. The drop-order alternator only fires when the chosen
    // identity has both sides available, so it cannot produce an
    // invalid slot.
    const isMembershipSingle = cardType === 'membership' && names.length === 0

    // Returns the valid sides for a given identity in the current
    // shape. Empty list = identity has no slots at all (e.g. a
    // shared identity in a non-shared shape, or a named identity
    // in a membership-single shape). Mirrors the cell builder's
    // slotTuples logic.
    function availableSidesForIdentity(identity: string | null): Array<'front' | 'back'> {
      if (sidedness === 'one-sided') {
        // One-sided: every identity that has any slot has front.
        if (isMembershipSingle) return identity == null ? ['front'] : []
        return identity == null ? [] : (names.includes(identity) ? ['front'] : [])
      }
      // Two-sided.
      if (isMembershipSingle) {
        return identity == null ? ['front', 'back'] : []
      }
      if (shared) {
        // Shared front collapses to a single shared identity;
        // back stays per-identity.
        return identity == null ? ['front'] : (names.includes(identity) ? ['back'] : [])
      }
      // Two-sided + not shared: per-identity on both sides.
      return identity == null ? [] : (names.includes(identity) ? ['front', 'back'] : [])
    }

    // Per-batch alternator for hintless files where the chosen
    // identity has both sides available. Resets per drop so two
    // consecutive single-file drops both start front. State only
    // advances when the alternator actually fires, so a batch of
    // back-only-identity files does not accidentally desync the
    // front/back rhythm for any later both-sides-available file.
    let nextHintlessSide: 'front' | 'back' = 'front'
    function alternateSide(): 'front' | 'back' {
      const s = nextHintlessSide
      nextHintlessSide = nextHintlessSide === 'front' ? 'back' : 'front'
      return s
    }

    // Fallback identity preference order when the heuristic has no
    // name match. Shared comes first if the shape exposes a shared
    // identity (membership-single, or two-sided + shared), then
    // each named identity in chip order. The resolver walks this
    // list looking for the first identity whose available sides
    // can satisfy the file's resolved side hint, falling back to
    // any identity with at least one slot if none match the side
    // preference.
    const fallbackOrder: Array<string | null> = []
    if (isMembershipSingle || (sidedness === 'two-sided' && shared)) {
      fallbackOrder.push(null)
    }
    for (const name of names) fallbackOrder.push(name)

    function resolveSlot(file: File): { identity: string | null; side: 'front' | 'back' } | null {
      const match = matchImageToName(file.name, names)
      const heuristicSide: 'front' | 'back' | null =
        sidedness === 'one-sided' ? 'front' : match.side
      const heuristicIdentity =
        match.associatedName != null && names.includes(match.associatedName)
          ? match.associatedName
          : null

      // Helper: given a candidate identity and a side hint, pick
      // a side that lives in the identity's available list.
      // Returns null when the identity has no slots at all.
      function pickSideFor(identity: string | null, hint: 'front' | 'back' | null): 'front' | 'back' | null {
        const sides = availableSidesForIdentity(identity)
        if (sides.length === 0) return null
        if (hint != null && sides.includes(hint)) return hint
        if (sides.length === 1) return sides[0]
        return alternateSide()
      }

      // Try the heuristic identity first when it actually matches
      // a current name. The heuristic side hint is honoured if the
      // identity supports it; otherwise the resolver overrides
      // (an asymmetric shape may force the side regardless of
      // what the filename suggests, which beats orphaning).
      if (heuristicIdentity != null) {
        const side = pickSideFor(heuristicIdentity, heuristicSide)
        if (side != null) return { identity: heuristicIdentity, side }
      }

      // Walk the fallback identity order. First pass: find an
      // identity that supports the heuristic side hint (if any).
      // This keeps the side-hint signal informative even for
      // files with no name token: a "Front.jpg" drop biases
      // towards a front-supporting identity.
      if (heuristicSide != null) {
        for (const candidate of fallbackOrder) {
          const sides = availableSidesForIdentity(candidate)
          if (sides.length === 0) continue
          if (sides.includes(heuristicSide)) {
            return { identity: candidate, side: heuristicSide }
          }
        }
      }

      // Second pass: any identity with at least one slot. Side
      // resolves via pickSideFor (which alternates only when
      // both sides are available).
      for (const candidate of fallbackOrder) {
        const side = pickSideFor(candidate, null)
        if (side != null) return { identity: candidate, side }
      }

      // No identity has any valid slot. Should be unreachable
      // because hasAnySlot gated the function entry; defensive
      // null lets the validation pass below report it.
      return null
    }

    const newEntries: ImageEntry[] = []
    const orphanFilenames: string[] = []
    for (const file of dedupedOk) {
      const slot = resolveSlot(file)
      if (slot == null) {
        orphanFilenames.push(file.name)
        continue
      }
      newEntries.push({
        localId: uuidv4(),
        file,
        preview: URL.createObjectURL(file),
        associated_name: slot.identity,
        side: slot.side,
      })
    }

    // Belt-and-braces: cross-check every stamped entry against the
    // exact slot universe the cell builder uses. The resolver
    // above should never produce an orphan when hasAnySlot is
    // true, but a future refactor that diverges from the cell
    // builder's slot rule would silently leak entries into state
    // again. Surfacing fileError here turns that class of bug
    // into a loud failure rather than a silent missing card.
    const validSlotKey = (id: string | null, s: 'front' | 'back') =>
      `${id ?? '__shared__'}|${s}`
    const validKeys = new Set(
      slotTuplesForValidation.map((t) => validSlotKey(t.identity, t.side)),
    )
    const accepted: ImageEntry[] = []
    for (const entry of newEntries) {
      const key = validSlotKey(entry.associated_name, entry.side ?? 'front')
      if (validKeys.has(key)) {
        accepted.push(entry)
      } else {
        URL.revokeObjectURL(entry.preview)
        orphanFilenames.push(entry.file.name)
      }
    }

    // Surface orphan failures as a hard error. These should be
    // unreachable in practice, but reaching this branch means the
    // resolver and the cell builder have diverged, which is a
    // bug the designer should see immediately rather than have
    // silently swallowed by the cell-builder filter.
    if (orphanFilenames.length > 0) {
      const sample = orphanFilenames.slice(0, 3).join(', ')
      const more = orphanFilenames.length > 3 ? `, and ${orphanFilenames.length - 3} more` : ''
      setFileError(
        `Could not place ${orphanFilenames.length} file${orphanFilenames.length === 1 ? '' : 's'}: ${sample}${more}. The slot shape changed mid-drop, refresh and try again.`,
      )
    }

    // Assemble fileNote covering added count, cap overflow, type/
    // size rejections, and duplicates. Errors set fileError above
    // and return early earlier; this branch always has at least
    // one accepted entry to report on (orphans are reported via
    // fileError above and are independent of the success count).
    if (accepted.length === 0) return

    const noteParts: string[] = [`Added ${accepted.length}.`]
    if (partition.rejectedByLimit > 0) {
      noteParts.push(`${partition.rejectedByLimit} skipped (${MAX_IMAGES}-image limit reached).`)
    }
    const ignored: string[] = []
    if (partition.rejectedByType > 0) ignored.push(`${partition.rejectedByType} non-image`)
    if (partition.rejectedBySize > 0) ignored.push(`${partition.rejectedBySize} over 10 MB`)
    if (ignored.length > 0) noteParts.push(`Ignored: ${ignored.join(', ')}.`)
    if (duplicateNames.length > 0) {
      noteParts.push(
        duplicateNames.length === 1
          ? `${duplicateNames[0]} already added.`
          : `${duplicateNames.length} duplicates skipped.`,
      )
    }
    // Only show the note when there's something to report beyond
    // the bare success count. The standard "added N" alone is
    // already obvious from the fresh cards appearing.
    if (noteParts.length > 1) setFileNote(noteParts.join(' '))

    setImagesByOption((prev) => ({
      ...prev,
      [optionCode]: [...(prev[optionCode] ?? []), ...accepted],
    }))
  }

  // Per-slot file addition. Called when the designer drops or
  // clicks-to-upload on an EmptySlot or a FreshImageCard: the
  // associated_name is implied by the slot, so no per-image
  // dropdown is needed. Validates file type + size, respects the
  // per-option MAX_IMAGES cap (counted against fresh entries
  // only — carried images don't consume slots because they
  // already exist in v1's storage). First-file-wins for drops
  // isn't enforced here; this accepts all valid files and the
  // caller's caller decides whether to pass 1 or N.
  function addFilesToSlot(optionCode: string, associated_name: string | null, side: 'front' | 'back', files: File[]) {
    setFileError('')
    setFileNote('')
    if (files.length === 0) return

    const freshInOption = (imagesByOption[optionCode] ?? []).length
    const remaining = MAX_IMAGES - freshInOption
    const partition = partitionFiles(files, remaining)

    if (partition.ok.length === 0) {
      if (partition.rejectedByType > 0) {
        setFileError('Only image files can be added.')
      } else if (partition.rejectedBySize > 0) {
        setFileError('Each image must be 10 MB or smaller.')
      } else if (partition.rejectedByLimit > 0) {
        setFileNote(`Can't add more, ${MAX_IMAGES}-image limit reached for this tab.`)
      }
      return
    }

    const noteParts: string[] = []
    if (partition.rejectedByLimit > 0) {
      noteParts.push(`Added ${partition.ok.length}. ${partition.rejectedByLimit} skipped (${MAX_IMAGES}-image limit reached).`)
    }
    const ignored: string[] = []
    if (partition.rejectedByType > 0) ignored.push(`${partition.rejectedByType} non-image`)
    if (partition.rejectedBySize > 0) ignored.push(`${partition.rejectedBySize} over 10 MB`)
    if (ignored.length > 0) noteParts.push(`Ignored: ${ignored.join(', ')}.`)
    if (noteParts.length > 0) setFileNote(noteParts.join(' '))

    setImagesByOption((prev) => ({
      ...prev,
      [optionCode]: [
        ...(prev[optionCode] ?? []),
        ...partition.ok.map((file) => ({
          localId: uuidv4(),
          file,
          preview: URL.createObjectURL(file),
          associated_name,
          side: side as 'front' | 'back' | null,
        })),
      ],
    }))
  }

  // Replacement-on-drop for carry cards. First file wins; the
  // rest are discarded (replacements are 1:1 by definition).
  // Supersedes any previously-queued replacement for that row by
  // revoking the old object URL first. Uses partitionFiles with an
  // unbounded `remaining` (replacement does not count against the
  // fresh-image cap) and a single-file slice; type and size
  // rejections still surface, just with the replacement-specific
  // copy.
  function handleReplacementDrop(v1RowId: string, files: File[]) {
    if (files.length === 0) return
    const partition = partitionFiles(files.slice(0, 1), Number.POSITIVE_INFINITY)
    if (partition.ok.length === 0) {
      if (partition.rejectedByType > 0) {
        setFileError('Replacement must be an image file.')
      } else if (partition.rejectedBySize > 0) {
        setFileError('Replacement must be 10 MB or smaller.')
      }
      return
    }
    const existing = replacementByV1RowId[v1RowId]
    if (existing) URL.revokeObjectURL(existing.preview)
    handleReplacementUpload(v1RowId, partition.ok[0])
  }

  function removeImage(localId: string) {
    // removeImage operates on whichever option tab the entry
    // lives in — each ImageEntry was stamped with a specific
    // option at drop time. Walk all option keys to locate it;
    // tiny scan compared to the old active-tab-only approach,
    // but correct under the per-slot layout where multiple tabs
    // may hold entries.
    setImagesByOption((prev) => {
      const out: Record<string, ImageEntry[]> = {}
      for (const [key, list] of Object.entries(prev)) {
        const removed = list.find((e) => e.localId === localId)
        if (removed) URL.revokeObjectURL(removed.preview)
        out[key] = list.filter((e) => e.localId !== localId)
      }
      return out
    })
  }

  // Single-click side flip on a FreshImageCard. Toggles entry.side
  // between front and back; the cell builder regroups by
  // (identity, side) on next render, so the card visually moves to
  // its new slot without any extra plumbing. Only meaningful on
  // two-sided projects; the FreshImageCard hides the affordance on
  // one-sided so this should not be reachable in that mode, but
  // the flip is harmless if it is.
  function flipFreshSide(localId: string) {
    setImagesByOption((prev) => {
      const out: Record<string, ImageEntry[]> = {}
      for (const [key, list] of Object.entries(prev)) {
        out[key] = list.map((e) =>
          e.localId === localId
            ? { ...e, side: (e.side ?? 'front') === 'front' ? 'back' : 'front' }
            : e,
        )
      }
      return out
    })
  }

  // Chip removal reconciliation: when the designer drops a chip
  // from the names list, any images currently associated with that
  // name fall back to the "null = shared" convention. The update
  // is purely in-state — the version hasn't been persisted yet, so
  // the cleared association lands in the DB at Save time via the
  // existing insert payload.
  function handleNamesChange(next: string[]) {
    const removed = names.filter((n) => !next.includes(n))
    if (removed.length > 0) {
      // Fresh images: re-stamp associated_name to null (shared)
      // for any image whose name was just removed. UI and save
      // path both read associated_name, so this reassigns them
      // cleanly to the Shared slot.
      setImagesByOption((prev) => {
        const out: Record<string, typeof prev[string]> = {}
        for (const [key, list] of Object.entries(prev)) {
          out[key] = list.map((img) =>
            img.associated_name != null && removed.includes(img.associated_name)
              ? { ...img, associated_name: null }
              : img,
          )
        }
        return out
      })

      // Carry-forward cleanup: clear any queued replacement for
      // v1 images whose name was just removed. The carry card
      // stops rendering when its name leaves names[], so a
      // queued replacement would become zombie state — hidden
      // UI, still holding an ObjectURL and about to leak into
      // the save path via replacementEntries. Revoke the preview
      // URL and drop the entry. Keep toggle state (keepByV1RowId)
      // is left alone so re-adding the name restores the carry
      // cleanly. Save-path filter below is the belt-and-braces
      // guard against any carry rows that still slip through.
      if (v1Carry) {
        const removedSet = new Set(removed)
        const orphanedV1RowIds = v1Carry.images
          .filter((img) => img.associated_name != null && removedSet.has(img.associated_name))
          .map((img) => img.v1RowId)
        if (orphanedV1RowIds.length > 0) {
          setReplacementByV1RowId((prev) => {
            const out: typeof prev = {}
            for (const [k, v] of Object.entries(prev)) {
              if (orphanedV1RowIds.includes(k)) {
                URL.revokeObjectURL(v.preview)
                continue
              }
              out[k] = v
            }
            return out
          })
        }
      }
    }
    setNames(next)
  }

  // ── Shape toggle handlers ──────────────────────────────────────
  // Each handler computes which v1 images would become unreachable
  // under the proposed shape, surfaces a confirm dialog if any of
  // those images carry an approved v1 approval, then (on proceed)
  // cleans up replacementByV1RowId entries for the orphaned rows
  // and revokes their preview URLs. Keep state (keepByV1RowId) is
  // deliberately preserved — if the designer flips back to the
  // original shape, carries resurface.

  function cleanupReplacementsFor(orphanedV1Images: V1Image[]) {
    if (orphanedV1Images.length === 0) return
    const ids = new Set(orphanedV1Images.map((i) => i.v1RowId))
    setReplacementByV1RowId((prev) => {
      const out: typeof prev = {}
      for (const [k, v] of Object.entries(prev)) {
        if (ids.has(k)) {
          URL.revokeObjectURL(v.preview)
          continue
        }
        out[k] = v
      }
      return out
    })
  }

  function confirmShapeFlip(vanishing: V1Image[]): boolean {
    if (!v1Carry || vanishing.length === 0) return true
    const approvedCount = vanishing.filter((i) => {
      const key = i.associated_name ?? SHARED_APPROVAL_KEY
      return v1Carry.approvalsByName[key]?.state === 'approved'
    }).length
    if (approvedCount === 0) return true
    return window.confirm(
      `Flipping this will discard customer approval on ${approvedCount} image${approvedCount === 1 ? '' : 's'}. Continue?`,
    )
  }

  function handleSidednessChange(next: 'one-sided' | 'two-sided') {
    if (next === sidedness) return
    // Two-sided → one-sided: drops every back-side v1 image.
    // Additionally, if shared was ON, it flips to OFF (Shared only
    // exists on two-sided) which orphans every shared-front v1
    // image too. Collect both sets into one vanishing list so the
    // approval-invalidation confirm covers them together.
    //
    // One-sided → two-sided: additive (no v1 back images to lose
    // since v(N-1) was one-sided by definition). Shared stays OFF
    // on the flip; designer opts in explicitly.
    const vanishingV1: V1Image[] = v1Carry
      ? next === 'one-sided'
        ? v1Carry.images.filter((i) => {
            const side = i.side ?? 'front'
            if (side === 'back') return true
            // Front-side shared v1 images also vanish when shared
            // resets to false below.
            return shared && i.associated_name == null
          })
        : []
      : []

    // Fresh entries that would orphan on the same flip. Mirrors the
    // v1 vanishing list against imagesByOption so the unified
    // confirm covers both buckets, and the cleanup branch below
    // drops them and revokes their preview URLs in one pass.
    const vanishingFresh: { optionCode: string; entry: ImageEntry }[] = []
    if (next === 'one-sided') {
      for (const [optionCode, list] of Object.entries(imagesByOption)) {
        for (const entry of list) {
          const side = entry.side ?? 'front'
          if (side === 'back') {
            vanishingFresh.push({ optionCode, entry })
            continue
          }
          if (shared && entry.associated_name == null) {
            vanishingFresh.push({ optionCode, entry })
          }
        }
      }
    }

    // Unified confirm. Approved-v1 images are the only bucket that
    // surfaces a confirm in the v1-only path; here we always
    // confirm whenever any image is at risk so the designer sees
    // the full impact (v1 approvals plus their own queued uploads).
    if (vanishingV1.length > 0 || vanishingFresh.length > 0) {
      const v1ApprovedCount = vanishingV1.filter((i) => {
        const key = i.associated_name ?? SHARED_APPROVAL_KEY
        return v1Carry?.approvalsByName[key]?.state === 'approved'
      }).length
      // If nothing is approved AND nothing fresh is at risk, the
      // flip is purely cosmetic on v1 carry state and we can skip
      // the prompt (matches existing confirmShapeFlip semantics).
      if (v1ApprovedCount > 0 || vanishingFresh.length > 0) {
        const carriedLabel = v1ApprovedCount === 1 ? '1 carried image' : `${v1ApprovedCount} carried images`
        const uploadedLabel = vanishingFresh.length === 1 ? '1 uploaded image' : `${vanishingFresh.length} uploaded images`
        const proceed = window.confirm(
          `Flipping to one-sided will discard ${carriedLabel} and ${uploadedLabel}. Continue?`,
        )
        if (!proceed) return
      }
    }

    cleanupReplacementsFor(vanishingV1)

    // Drop fresh vanishings from imagesByOption and revoke their
    // preview object URLs so they do not leak.
    if (vanishingFresh.length > 0) {
      const idsToDrop = new Set(vanishingFresh.map((v) => v.entry.localId))
      for (const { entry } of vanishingFresh) URL.revokeObjectURL(entry.preview)
      setImagesByOption((prev) => {
        const out: Record<string, ImageEntry[]> = {}
        for (const [key, list] of Object.entries(prev)) {
          out[key] = list.filter((e) => !idsToDrop.has(e.localId))
        }
        return out
      })
    }

    setSidedness(next)
    // Shared resets on every flip: going two→one it's no longer
    // meaningful, and going one→two we don't remember a prior
    // value (Shared default is OFF on v1; v2+ inheritance has
    // already run at mount). Keeps the state model clean.
    setShared(false)
  }

  function handleSharedChange(next: boolean) {
    if (next === shared) return
    // Shared only renders on two-sided, so this handler is
    // unreachable on one-sided. Front-only semantics:
    //   ON→OFF: shared-front v1 images vanish (replaced by
    //           per-name front slots).
    //   OFF→ON: per-name front v1 images vanish (replaced by a
    //           single shared-front slot).
    // Back-side v1 images are unaffected either way.
    const vanishing = v1Carry
      ? v1Carry.images.filter((i) => {
          if ((i.side ?? 'front') !== 'front') return false
          return next ? i.associated_name != null : i.associated_name == null
        })
      : []
    if (!confirmShapeFlip(vanishing)) return
    cleanupReplacementsFor(vanishing)
    setShared(next)
  }

  function handleCardTypeChange(next: 'business' | 'membership') {
    if (next === cardType) return
    // Card type flipping affects the slot universe only when
    // names[] transitions between empty and non-empty. Under the
    // new tiered-membership model, cardType no longer changes
    // the shape when names has ≥1 entries — both modes produce
    // identical per-identity slots, differing only in UI copy
    // and validation relaxation. So vanishing v1 images are
    // computed against the proposed (cardType=next) slot universe
    // using the same rule as save-path slotStillValid.
    const proposedMembershipSingle = next === 'membership' && names.length === 0
    const vanishing = v1Carry
      ? v1Carry.images.filter((img) => {
          const normalizedSide: 'front' | 'back' = img.side ?? 'front'
          if (normalizedSide === 'back' && sidedness === 'one-sided') return true
          if (proposedMembershipSingle) {
            // Only a single Shared slot per side exists; per-
            // identity v1 images orphan.
            return img.associated_name != null
          }
          const isSharedSlotForSide =
            sidedness === 'two-sided' && shared && normalizedSide === 'front'
          if (isSharedSlotForSide) return img.associated_name != null
          if (img.associated_name == null) return true
          return !names.includes(img.associated_name)
        })
      : []
    if (!confirmShapeFlip(vanishing)) return
    cleanupReplacementsFor(vanishing)
    setCardType(next)
    // Names + shared state are intentionally preserved across the
    // flip. When flipping to membership the chip input just re-
    // labels to "Variants (optional)" — the chips and their
    // meanings carry through. Save path writes the preserved
    // names verbatim; the mode only affects validation + UI
    // copy, never the saved payload.
  }

  function toggleVariant(variantId: string) {
    setSelectedVariantIds((prev) =>
      prev.includes(variantId) ? prev.filter((id) => id !== variantId) : [...prev, variantId]
    )
    // Per-field carried/edited derivation compares the current
    // selection against the snapshot — no manual flag clear needed.
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setSubmitAttempted(true)

    // Missing required fields: surface highlights + scroll to the first one in
    // document order. No save attempt, no network. Live validation clears the
    // highlights on the next render as each field becomes valid.
    if (!isValid) {
      // Auto-expand the form on validation failure so the offending
      // field is visible — without this, scrollIntoView would target
      // a hidden section when the form is collapsed in summary view.
      setFormExpanded(true)

      const order: Array<{
        key: keyof typeof validations
        ref: React.RefObject<HTMLElement | null>
      }> = [
        { key: 'pricingDisplay', ref: pricingDisplayRef },
        { key: 'material',       ref: materialRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'variant',        ref: variantRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'currency',       ref: currencyRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'inkNames',       ref: inkNamesRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'names',          ref: namesRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'images',         ref: imageSectionRef },
      ]
      const first = order.find(o => !validations[o.key])
      first?.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })

      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      setValidationToast('Please complete all required fields to save')
      toastTimerRef.current = setTimeout(() => setValidationToast(''), 5000)
      return
    }

    // Button is still a submit-type, so narrow defensively even though
    // isValid guarantees these values.
    if (pricingDisplay === null) return

    setSubmitting(true)

    // Flatten images across all option tabs (in selectedOptions order)
    const optionKeys = optionMode ? selectedOptions : ['']
    const allEntries = optionKeys.flatMap(fk =>
      (imagesByOption[fk] ?? []).map(entry => ({ entry, option: fk === '' ? null : fk }))
    )

    // Shape B: collect the v1 rows that need carrying (keep=true +
    // no replacement) and the replacement uploads (any v1 row with
    // a queued replacement file). Carried rows share file_path with
    // v1 — no upload needed. Replacement rows get their own upload
    // path. Fresh rows (allEntries above) get their own upload
    // paths too.
    //
    // Belt-and-braces guard: skip rows whose (identity, side) tuple
    // is no longer in v2's slot universe. UI already hides carry
    // cells for dead slots, and handleNamesChange / shape toggle
    // handlers purge replacement state, but this filter catches
    // any edge where state wasn't cleaned (e.g. rapid toggle
    // flips, or any future code path that might leave stale
    // keep/replacement entries behind).
    //
    // v2 slot universe by (side, identity):
    //   * side='back' only valid when sidedness='two-sided'
    //   * cardType='membership' + names=[]: every slot is a
    //     single Shared slot (assocName=null). No per-identity
    //     dimension exists in this shape.
    //   * Otherwise (business, OR membership with ≥1 variants):
    //     - two-sided + shared=true: front collapses to a single
    //       Shared slot (assocName=null); back stays per-
    //       identity (name or variant — same DB column).
    //     - otherwise: every valid side is per-identity
    //       (assocName in names[]), no Shared slot.
    // Null-side v1 rows normalise to 'front' for back-compat.
    const v2Names = new Set(names)
    const isMembershipSingle = cardType === 'membership' && names.length === 0
    const slotStillValid = (
      assocName: string | null,
      side: 'front' | 'back' | null,
    ): boolean => {
      const normalizedSide: 'front' | 'back' = side ?? 'front'
      if (normalizedSide === 'back' && sidedness === 'one-sided') return false
      if (isMembershipSingle) return assocName == null
      const isSharedSlotForSide =
        sidedness === 'two-sided' && shared && normalizedSide === 'front'
      if (isSharedSlotForSide) return assocName == null
      return assocName != null && v2Names.has(assocName)
    }

    const carriedV1Rows = v1Carry
      ? v1Carry.images.filter(
          (img) =>
            (keepByV1RowId[img.v1RowId] ?? true) &&
            !replacementByV1RowId[img.v1RowId] &&
            slotStillValid(img.associated_name, img.side),
        )
      : []
    const replacementEntries = v1Carry
      ? v1Carry.images
          .filter(
            (img) =>
              !!replacementByV1RowId[img.v1RowId] &&
              slotStillValid(img.associated_name, img.side),
          )
          .map((img) => ({ v1Img: img, file: replacementByV1RowId[img.v1RowId]!.file }))
      : []

    // Upload replacement + fresh files in parallel. Carried rows
    // are not in this batch — they reuse v1's file_path.
    const freshUploadBatch = [
      ...replacementEntries.map((r) => ({ kind: 'replacement' as const, file: r.file, v1Img: r.v1Img })),
      ...allEntries.map((e) => ({ kind: 'fresh' as const, file: e.entry.file, entry: e.entry, option: e.option })),
    ]

    const uploadResults = await Promise.all(
      freshUploadBatch.map(async (item) => {
        const path = `${proofId}/${uuidv4()}.jpg`
        const { error: uploadError } = await supabase.storage
          .from('proof-images')
          .upload(path, item.file, { contentType: item.file.type, upsert: false })
        return { path, error: uploadError }
      })
    )

    const failedUpload = uploadResults.find((r) => r.error)
    if (failedUpload) {
      const successPaths = uploadResults.filter((r) => !r.error).map((r) => r.path)
      if (successPaths.length > 0) await supabase.storage.from('proof-images').remove(successPaths)
      setError(`Image upload failed: ${failedUpload.error!.message}`)
      setSubmitting(false)
      return
    }

    const uploadedPaths = uploadResults.map((r) => r.path)
    const material = materials.find((m) => m.id === selectedMaterialId)!

    // Freeze the live prices into the version's pricing_snapshot so
    // the version has a stable record independent of any future
    // changes made in Admin → Pricing. Read straight from
    // variantTiers now that the form is read-only — the intermediate
    // variantSnapshots state that used to track user edits is gone.
    const pricingSnapshot = {
      variants: selectedVariantIds.map((vid) => {
        const variant = variants.find((v) => v.id === vid)!
        const display = variant.variant_type === 'default' ? 'Default' : variant.display_name
        const prices: Record<string, number> = {}
        ;(variantTiers[vid] ?? []).forEach((t) => {
          prices[t.quantity] = t.total_price
        })
        return { variant_id: vid, display, prices }
      }),
    }

    // Ink names come from either the comma-separated text field (optional
    // materials) or the per-ink array (mandatory materials).
    const parsedInkNames: string[] = requiresInkNames
      ? inkNamesArray.slice(0, inkCount).map(s => s.trim())
      : inkNamesText.split(',').map(s => s.trim()).filter(Boolean)

    // The currency column is NOT NULL; default to GBP when the designer picked
    // Custom quote without explicitly selecting a currency. Value is not shown
    // to the customer in custom-quote mode.
    const currencyForInsert: Currency = currency ?? 'GBP'

    const { data: versionData, error: insertError } = await supabase
      .from('proof_versions')
      .insert({
        proof_id: proofId,
        material_id: selectedMaterialId,
        material_display: material.display_name,
        ink_names: parsedInkNames,
        currency: currencyForInsert,
        pricing_snapshot: pricingSnapshot,
        change_notes: changeNotes.trim() || null,
        material_options: selectedOptions,
        custom_quote: isCustomQuote,
        // Names array. In Business mode: recipient names. In
        // Membership mode: optional tier variant labels (0+
        // entries). Either way the chips are written verbatim —
        // the mode is an explicit column now (card_type, below),
        // not inferred from names. The DB trigger (migration
        // 000070) snapshots the per-currency split-name tooling
        // surcharge onto the version on INSERT, so no client-
        // side amount calc.
        names: names.map((n) => n.trim()).filter(Boolean),
        // Card type (migration 000086). Makes the Business /
        // Membership distinction explicit so we can tell a
        // single-design business project (empty names) apart
        // from a single-design membership project (also empty
        // names).
        card_type: cardType,
        // Explicit clone lineage. Null when creating v1 (no v1Carry
        // loaded) or admin-inserted rows. Drives downstream
        // analytics and any future "this is a clone of..." UI.
        cloned_from_version_id: v1Carry?.versionId ?? null,
      })
      .select('id')
      .single()

    if (insertError || !versionData) {
      await supabase.storage.from('proof-images').remove(uploadedPaths)
      setError(`Failed to save version: ${insertError?.message ?? 'Unknown error'}`)
      setSubmitting(false)
      return
    }

    // Build image inserts. Three sources:
    //   1. Carried rows: reuse v1's file_path, no upload
    //   2. Replacement rows: new upload path, associated_name +
    //      material_option copied from the v1 row being replaced
    //   3. Fresh rows: new upload path, associated_name + side
    //      from the form's ImageEntry
    // Ordering: carried first (preserving v1 sort_order proxy),
    // then replacement/fresh in upload-batch order. Precise
    // sort_order for customer-page rendering comes from an integer
    // index into the final array.
    // Side is stamped from v1's side with null→'front' back-compat
    // for pre-migration-000085 data. Post-migration every new row
    // is non-null — designer-facing shape controls guarantee every
    // slot has an explicit side, and the slotStillValid filter
    // above will have rejected anything that doesn't fit v2's
    // shape, so this normalisation is only ever reached for rows
    // whose v1 side was null and whose slot still exists on the
    // front side of v2.
    const carriedInserts = carriedV1Rows.map((img) => ({
      proof_version_id: versionData.id,
      image_path: img.file_path,
      material_option: img.material_option,
      original_filename: img.original_filename,
      associated_name: img.associated_name,
      side: (img.side ?? 'front') as 'front' | 'back',
    }))

    // uploadedPaths is laid out as [replacements..., fresh...];
    // slice accordingly to assign paths to the right inserts.
    const replacementPaths = uploadedPaths.slice(0, replacementEntries.length)
    const freshPaths = uploadedPaths.slice(replacementEntries.length)

    const replacementInserts = replacementEntries.map((r, i) => ({
      proof_version_id: versionData.id,
      image_path: replacementPaths[i],
      material_option: r.v1Img.material_option,
      original_filename: r.file.name,
      associated_name: r.v1Img.associated_name,
      // Replacement inherits the v1 row's slot (same associated_name,
      // same side). Null-side v1 rows normalise to 'front' — same
      // back-compat rule as carriedInserts.
      side: (r.v1Img.side ?? 'front') as 'front' | 'back',
    }))

    const freshInserts = allEntries.map(({ entry, option }, i) => ({
      proof_version_id: versionData.id,
      image_path: freshPaths[i],
      material_option: option,
      original_filename: entry.file.name,
      associated_name: entry.associated_name,
      // addFilesToSlot stamps an explicit 'front' | 'back' from the
      // slot's coordinate, so side is always non-null here. Fallback
      // to 'front' is belt-and-braces — never null on new rows.
      side: (entry.side ?? 'front') as 'front' | 'back',
    }))

    const allInserts = [...carriedInserts, ...replacementInserts, ...freshInserts]
    const imageInserts = allInserts.map((row, i) => ({ ...row, sort_order: i }))

    const { error: imgInsertError } = await supabase.from('proof_version_images').insert(imageInserts)

    if (imgInsertError) {
      await supabase.from('proof_versions').delete().eq('id', versionData.id)
      await supabase.storage.from('proof-images').remove(uploadedPaths)
      setError(`Failed to save images: ${imgInsertError.message}`)
      setSubmitting(false)
      return
    }

    // ── Approval carry-forward ──────────────────────────────────
    // Carries an approval from v1 to v2 for a given slot (name or
    // __shared__) iff ALL of the following hold:
    //
    //   1. v1 had an approval with state='approved' for the slot
    //   2. v2's material_options set exactly matches v1's
    //      (any drop or addition blocks carry for every slot)
    //   3. Every v1 image at every (option, name) coordinate for
    //      this slot was carried (keep=true, no replacement), and
    //      no new images were added at any coordinate for the slot
    //
    // Computed client-side here rather than via a DB trigger
    // because the rule depends on per-slot image-set identity,
    // which is easiest to decide with the form's carry state at
    // hand. Audit of approval.carried happens implicitly via the
    // approval row's existence; no separate audit entry.
    if (v1Carry) {
      const v1Opts = new Set(v1Carry.materialOptions)
      const v2Opts = new Set(selectedOptions)
      const optionsMatch =
        v1Opts.size === v2Opts.size &&
        [...v1Opts].every((o) => v2Opts.has(o))

      if (optionsMatch) {
        const now = new Date().toISOString()
        const carriedApprovals: {
          proof_version_id: string
          name: string
          state: 'approved'
          change_request: null
          actor_name: string
          actor_ip: null
          actor_ua: null
          updated_at: string
          carried_from_version_id: string
        }[] = []

        // Candidate slot keys: each name currently on v2 (common
        // with v1 or not — non-common names can't carry since v1
        // didn't approve them), plus the shared sentinel.
        const slotKeys = [SHARED_APPROVAL_KEY, ...names.filter((n) => n.trim().length > 0)]
        for (const nameKey of slotKeys) {
          const v1Approval = v1Carry.approvalsByName[nameKey]
          if (!v1Approval || v1Approval.state !== 'approved') continue

          const assocFilter = nameKey === SHARED_APPROVAL_KEY ? null : nameKey

          // v1's images for this slot (across all option
          // coordinates).
          const v1ImagesForSlot = v1Carry.images.filter(
            (img) => img.associated_name === assocFilter,
          )

          // Identity check — every v1 image must be carried
          // (keep=true, no replacement) AND land in a v2 slot
          // that still exists. A shape flip (e.g. two-sided →
          // one-sided) can orphan v1 images without the
          // designer unticking Keep, so slotStillValid is the
          // authoritative gate. If any v1 image for this slot
          // was dropped, replaced, or orphaned by shape flip,
          // the approval doesn't carry.
          const allCarried = v1ImagesForSlot.every(
            (img) =>
              (keepByV1RowId[img.v1RowId] ?? true) &&
              !replacementByV1RowId[img.v1RowId] &&
              slotStillValid(img.associated_name, img.side),
          )
          if (!allCarried) continue

          // No new images for this slot. Fresh allEntries with
          // associated_name matching this slot would break
          // identity.
          const anyFreshForSlot = allEntries.some(
            ({ entry }) => entry.associated_name === assocFilter,
          )
          if (anyFreshForSlot) continue

          carriedApprovals.push({
            proof_version_id: versionData.id,
            name: nameKey,
            state: 'approved',
            change_request: null,
            actor_name: v1Approval.actor_name,
            actor_ip: null,
            actor_ua: null,
            updated_at: now,
            // Provenance — points at the v1 this approval was
            // carried from. UI resolves to vN via the parent
            // page's already-loaded versions array. Preserved
            // across state-change UPDATEs; nulled if v1 is
            // later deleted (FK ON DELETE SET NULL).
            carried_from_version_id: v1Carry.versionId,
          })
        }

        if (carriedApprovals.length > 0) {
          const { error: approvalErr } = await supabase
            .from('proof_name_approvals')
            .insert(carriedApprovals)
          if (approvalErr) {
            // Approval carry is best-effort — don't unwind the
            // whole version save just because audit/approval
            // writes failed. Log via audit but let the save
            // succeed; designer can manually approve from the
            // modal if needed.
            console.error('[approval-carry] Failed to carry v1 approvals:', approvalErr.message)
          }
        }
      }
    }

    void logAudit({
      action: 'version.added',
      targetType: 'version',
      targetId: versionData.id,
      targetLabel: `${proofName || 'project'} — ${material.display_name}`,
      metadata: {
        proof_id: proofId,
        material_id: selectedMaterialId,
        currency: currencyForInsert,
        image_count: imageInserts.length,
        custom_quote: pricingDisplay === 'custom',
      },
    })

    navigate(`/proofs/${proofId}`)
  }

  const variantType = variants[0]?.variant_type

  // Custom-quote detection. Two independent triggers:
  //   * user-choice: pricingDisplay === 'custom' (PricingDisplayField
  //     radio set to Custom quote)
  //   * auto: any selected variant has loaded with no price_tiers
  //     rows for the current currency — e.g. 5–8 ink variants,
  //     which have no per-tier pricing and are handled out-of-band.
  // Seeding empty arrays in the variantTiers fetch (see above) makes
  // "loaded with no prices" distinguishable from "still loading": a
  // selected variant is only counted if its id has an entry in
  // variantTiers.
  const allTiersLoaded = selectedVariantIds.length > 0
    && selectedVariantIds.every((vid) => vid in variantTiers)
  const autoCustomQuote = allTiersLoaded
    && selectedVariantIds.some((vid) => (variantTiers[vid] ?? []).length === 0)
  const isCustomQuote = pricingDisplay === 'custom' || autoCustomQuote

  // One-way auto-flip of the PricingDisplay radio so the UI doesn't
  // lie about its mode. When a 5+ ink variant makes the form
  // auto-custom, we push the radio to 'custom' so the designer
  // sees a consistent state. Not reversed on the way back —
  // switching to a 4-or-fewer-ink variant after the flip leaves
  // the radio at 'custom' until the designer deliberately flips it
  // back. That matches the model of "you picked a custom-quote
  // variant; the form remembered that intent."
  useEffect(() => {
    if (autoCustomQuote && pricingDisplay !== 'custom') {
      setPricingDisplay('custom')
    }
  }, [autoCustomQuote, pricingDisplay])

  const selectedMaterial = materials.find(m => m.id === selectedMaterialId)
  const isMultiVariant = selectedMaterial?.multi_variant ?? false
  const requiresInkNames = selectedMaterial?.requires_ink_names ?? false

  // Option dimension label — singular ("Finish"/"Species") for in-copy use,
  // plural ("Finishes"/"Species") for the section heading.
  const optionLabelSingular = selectedMaterial?.option_label ?? 'Finish'
  const optionLabelPlural   = pluralLabel(optionLabelSingular)
  const selectedVariant = variants.find(v => v.id === selectedVariantIds[0])
  const inkCount = requiresInkNames ? (selectedVariant?.ink_count ?? 0) : 0
  const variantRequired = !isCustomQuote || requiresInkNames

  // Per-ink-field validity (for the requires-ink-names path). Empty slots fail.
  const inkNameValidities = requiresInkNames && inkCount > 0
    ? Array.from({ length: inkCount }, (_, i) => (inkNamesArray[i] ?? '').trim() !== '')
    : []

  // All "requires a value before save succeeds" checks, derived from state.
  // Flipping any failing field to valid clears its error highlight live.
  const imagesFinishKeys = optionMode ? selectedOptions : ['']

  // Slot universe for validation — one tuple per (identity, side)
  // across the project, shared across every option tab. Mirrors the
  // render-time slot universe in the image section so validation
  // agrees with what the designer can see.
  //
  // Membership + 0 variants: each side is a single Shared slot.
  // Everything else (business, or membership with ≥1 variants):
  // see state-declaration comment for the full rule (sidedness +
  // shared + names).
  const sidesForValidation: ('front' | 'back')[] =
    sidedness === 'two-sided' ? ['front', 'back'] : ['front']
  const slotTuplesForValidation: {
    identity: string | null
    side: 'front' | 'back'
  }[] = []
  const isMembershipSingleValidation = cardType === 'membership' && names.length === 0
  for (const side of sidesForValidation) {
    if (isMembershipSingleValidation) {
      slotTuplesForValidation.push({ identity: null, side })
      continue
    }
    const isSharedSlotForSide =
      sidedness === 'two-sided' && shared && side === 'front'
    if (isSharedSlotForSide) {
      slotTuplesForValidation.push({ identity: null, side })
    } else {
      for (const name of names) slotTuplesForValidation.push({ identity: name, side })
    }
  }
  const hasAnySlot = slotTuplesForValidation.length > 0

  // Count "saved image" at a specific (option, identity, side)
  // slot: kept carries + queued replacements + fresh uploads, all
  // filtered to that tuple. Carries with keep=false and no
  // replacement drop on save, so they don't count. Replacements
  // count even when keep=false (the replacement IS the saved row).
  // Null side on a v1 row is normalised to 'front' for back-compat.
  function savedImagesInSlot(
    optionCode: string,
    identity: string | null,
    side: 'front' | 'back',
  ): number {
    const fresh = (imagesByOption[optionCode] ?? []).filter(
      (e) => e.associated_name === identity && (e.side ?? 'front') === side,
    ).length
    if (!v1Carry) return fresh
    const carryKeptOrReplaced = v1Carry.images.filter((img) => {
      if ((img.material_option ?? '') !== optionCode) return false
      if (img.associated_name !== identity) return false
      if ((img.side ?? 'front') !== side) return false
      const hasRep = !!replacementByV1RowId[img.v1RowId]
      const keep = keepByV1RowId[img.v1RowId] ?? true
      return hasRep || keep
    }).length
    return fresh + carryKeptOrReplaced
  }

  const everySlotHasImage =
    hasAnySlot &&
    imagesFinishKeys.every((fk) =>
      slotTuplesForValidation.every(
        (slot) => savedImagesInSlot(fk, slot.identity, slot.side) > 0,
      ),
    )

  // Names required in Business mode — every Business project has
  // at least one per-name dimension (one-sided: all sides per-
  // name; two-sided + shared: back is per-name; two-sided +
  // !shared: both sides per-name). Empty names[] in business
  // mode therefore means no slots exist. The chip input trims
  // internally, so we count non-blank trimmed entries.
  //
  // Membership mode: variants are optional. 0 variants means a
  // single shared design per side; ≥1 variants means per-variant
  // slots. Either is a valid saveable state.
  const namesValid =
    cardType === 'membership' || names.some((n) => n.trim().length > 0)

  const validations = {
    images:         everySlotHasImage,
    pricingDisplay: pricingDisplay !== null,
    material:       !!selectedMaterialId,
    variant:        !variantRequired || selectedVariantIds.length > 0,
    currency:       isCustomQuote || currency !== null,
    inkNames:       !requiresInkNames || (inkCount > 0 && inkNameValidities.every(Boolean)),
    names:          namesValid,
  } as const
  const isValid = Object.values(validations).every(Boolean)
  const shouldHighlight = (k: keyof typeof validations) => submitAttempted && !validations[k]

  // Specific images message. Priority: no-slot universe first
  // (can't save an empty shape — unreachable once names becomes
  // required, kept as belt-and-braces), then the first empty
  // (option, identity, side) tuple so the designer knows exactly
  // where to upload.
  const imagesHint = !hasAnySlot
    ? 'Add at least one name.'
    : (() => {
        for (const fk of imagesFinishKeys) {
          for (const slot of slotTuplesForValidation) {
            if (savedImagesInSlot(fk, slot.identity, slot.side) === 0) {
              const optionLabel =
                fk === ''
                  ? ''
                  : availableOptions.find((f) => f.code === fk)?.display_name ?? fk
              const identityLabel =
                slot.identity == null ? 'Shared' : slot.identity
              const sideLabel =
                sidedness === 'two-sided'
                  ? slot.side === 'front'
                    ? ' front'
                    : ' back'
                  : ''
              const where = optionLabel ? ` on ${optionLabel}` : ''
              return `Add an image for ${identityLabel}${sideLabel}${where}.`
            }
          }
        }
        return 'At least one proof image required.'
      })()

  // Preserve previously-entered ink data when switching between "requires
  // per-ink" and optional materials — best-effort, joined/split on commas.
  function handleMaterialChange(nextId: string) {
    const prev = materials.find(m => m.id === selectedMaterialId)
    const next = materials.find(m => m.id === nextId)
    const wasRequired = prev?.requires_ink_names ?? false
    const isRequired  = next?.requires_ink_names ?? false
    if (wasRequired && !isRequired) {
      const joined = inkNamesArray.filter(s => s.trim()).join(', ')
      if (joined) setInkNamesText(joined)
    } else if (!wasRequired && isRequired) {
      const parts = inkNamesText.split(',').map(s => s.trim()).filter(Boolean)
      if (parts.length > 0) setInkNamesArray(parts)
    }
    setSelectedMaterialId(nextId)
    // Manual material change clears the archived-material warning
    // — if the designer deliberately swapped away, they're not
    // keeping the archived one. Discard any pending variant
    // inheritance from the ref so a subsequent swap back can't
    // accidentally re-apply it. Per-field carried/edited derivation
    // handles the indicator state via the snapshot comparison.
    setInheritedMaterialArchived(false)
    inheritedVariantIdsRef.current = null
  }

  // Cancel + Save pair, defined once and rendered twice (top of
  // the page beside the heading, and again at the bottom of the
  // form below the image grid). Both renders emit the same JSX,
  // so disabled state, label swaps, a11y hints, and any future
  // chrome stay in lockstep. The submit button carries
  // form="new-version-form" so placement outside the <form>
  // element (top row) is as functional as placement inside
  // (bottom row).
  const actionRow = (
    <div className="flex items-center gap-3">
      <Link
        to={`/proofs/${proofId}`}
        className="text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        Cancel
      </Link>
      <button
        type="submit"
        form="new-version-form"
        disabled={submitting || !isValid}
        title={!isValid ? missingFieldsHint(validations) : undefined}
        aria-label={
          !isValid
            ? `Save version, ${missingFieldsHint(validations)}`
            : undefined
        }
        className={[
          'rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors',
          isValid ? 'bg-gray-900 hover:bg-gray-700' : 'bg-gray-900/60',
          'disabled:cursor-not-allowed disabled:opacity-50',
        ].join(' ')}
      >
        {submitting ? 'Uploading and saving…' : 'Save version'}
      </button>
    </div>
  )

  // ── Per-field carried/edited derivations ───────────────────────
  // The inheritance snapshot captures every value carried from
  // v(N-1) at form-load time. Each carried field then derives
  // isCarried/isEdited live by comparing the snapshot to current
  // state — modify-then-revert naturally clears the edited flag
  // because the comparison flips back to equal.
  //
  // Equality semantics:
  //   * setEquals  — variants, material options. Order isn't
  //     meaningful (the customer view sorts these anyway).
  //   * arrayEquals — names, positional ink names. Order matters
  //     (recipient ordering, positional ink slots).
  //   * Strict !== — scalars (currency, materialId, cardType,
  //     sidedness, shared, pricingDisplay).
  //
  // isCarried gates the visual treatment entirely. A field with
  // no inheritance source (v1 creation, or a snapshot value of
  // empty list for things like names where the carried value was
  // also empty) renders without the violet ribbon.
  const inh = inheritedSnapshot
  const inheritedVersionNumber = inh?.versionNumber ?? null
  const carry = {
    material: {
      isCarried: inh !== null,
      isEdited: inh !== null && inh.materialId !== selectedMaterialId,
    },
    variants: {
      isCarried: inh !== null && inh.variantIds.length > 0,
      isEdited: inh !== null && inh.variantIds.length > 0 && !setEquals(inh.variantIds, selectedVariantIds),
    },
    currency: {
      isCarried: inh !== null,
      isEdited: inh !== null && inh.currency !== currency,
    },
    cardType: {
      isCarried: inh !== null,
      isEdited: inh !== null && inh.cardType !== cardType,
    },
    sidedness: {
      isCarried: inh !== null,
      isEdited: inh !== null && inh.sidedness !== sidedness,
    },
    shared: {
      isCarried: inh !== null,
      isEdited: inh !== null && inh.shared !== shared,
    },
    pricingDisplay: {
      isCarried: inh !== null,
      isEdited: inh !== null && inh.pricingDisplay !== pricingDisplay,
    },
    names: {
      isCarried: inh !== null && inh.names.length > 0,
      isEdited: inh !== null && inh.names.length > 0 && !arrayEquals(inh.names, names),
    },
    inkNames: {
      isCarried:
        inh !== null && (inh.inkNamesArray.length > 0 || inh.inkNamesText.length > 0),
      isEdited:
        inh !== null
        && (inh.inkNamesArray.length > 0 || inh.inkNamesText.length > 0)
        && (
          inh.inkNamesArray.length > 0
            ? !arrayEquals(inh.inkNamesArray, inkNamesArray)
            : inh.inkNamesText !== inkNamesText
        ),
    },
    options: {
      isCarried: inh !== null && inh.materialOptions.length > 0,
      isEdited:
        inh !== null
        && inh.materialOptions.length > 0
        && !setEquals(inh.materialOptions, selectedOptions),
    },
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {validationToast && (
        <div
          role="status"
          className="fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-full bg-rose-50 px-5 py-2.5 text-sm font-medium text-rose-700 shadow-lg ring-1 ring-rose-200"
        >
          {validationToast}
        </div>
      )}
      {/* Page-wide drag overlay. Activates while the designer drags
          a file from outside the browser onto any part of the page.
          Drops are routed via useImageFileDrop's window listeners
          to addFilesBatch, which auto-distributes across slots in
          the active option tab. Per-cell zones (CarryCard,
          EmptySlot) intercept their own drops via stopPropagation
          first, so the overlay never double-fires for a precise
          drop. */}
      <PageDropOverlay visible={isPageDragOver} />
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">

        <div className="mb-6">
          <Link to={`/proofs/${proofId}`} className="text-sm text-gray-400 hover:text-gray-700">← Back to project</Link>
        </div>

        {/* Page heading + top actions. The Cancel + Save pair is
            defined once as `actionRow` below the heading row and
            rendered twice (here and at the bottom of the form) so
            any future chrome — saving spinner, progress pill, etc
            — only has to be added in one place. Both instances
            point at the same form via the submit button's `form=`
            attribute, so placement inside or outside the form
            element doesn't change behaviour. */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Add version</h1>
            {proofName && <p className="mt-1 text-gray-500">{proofName}</p>}
            {proofCompany && <p className="text-sm text-gray-400">{proofCompany}</p>}
          </div>
          {actionRow}
        </div>

        <form id="new-version-form" onSubmit={handleSubmit} className="space-y-6">

          {/* Carry-forward summary card — only renders on v2+ when
              there's an inheritance source. Labelled name-value
              rows show what this version inherits from v(N-1),
              update live as the designer edits in expanded mode.
              Warnings (archived material, currency mismatch)
              render inside the card so they're visible even when
              the form below is collapsed. "Edit details" expands
              the form for the rest of the page lifecycle (no
              re-collapse). */}
          {inheritedVersionNumber !== null && (() => {
            // Resolve current form state into the entities the
            // summary needs. Reads from current state so each row
            // value updates live in expanded mode.
            const summaryMaterial = materials.find((m) => m.id === selectedMaterialId)
            const summarySelectedVariants = variants.filter((v) => selectedVariantIds.includes(v.id))
            const summaryNonBaseOption = availableOptions.find(
              (o) => selectedOptions.includes(o.code) && !o.is_base,
            )
            // Ink names: prefer the positional array (per-ink
            // input on requires_ink_names materials) when populated,
            // otherwise split the free-form text input on commas.
            // Only relevant when the material requires ink names.
            const inkNames = summaryMaterial?.requires_ink_names
              ? (inkNamesArray.filter((n) => n.trim()).length > 0
                  ? inkNamesArray.map((n) => n.trim()).filter(Boolean)
                  : inkNamesText.split(',').map((s) => s.trim()).filter(Boolean))
              : []

            // Build the rows array. Each entry contributes one
            // labelled row to the dl below; rules:
            //   * Material — always rendered (when summaryMaterial
            //     resolves; defensive against the brief load
            //     window between inheritedVersionNumber arriving
            //     and materials list arriving).
            //   * Variant row — derived from material.variant_type
            //     via VARIANT_ROW_LABEL. 'default' returns
            //     undefined and the row skips. ink_count gets
            //     "Ink count" rather than "Inks" so it doesn't
            //     collide with the ink names row below.
            //   * Option — uses material.option_label as the row
            //     label (e.g. "Finish: Brushed", "Species: Oak").
            //     Skips when no non-base option is selected or the
            //     material has no option_label configured.
            //   * Currency — always rendered.
            //   * Inks — only when material requires ink names AND
            //     at least one ink name is filled in.
            //   * Names — only when names list is non-empty.
            //   * Sides — always rendered. "1" / "2 (shared front)" /
            //     "2" depending on sidedness + shared.
            //   * Card type — only when membership (business is
            //     the implicit default).
            const rows: { label: string; value: string }[] = []
            if (summaryMaterial) {
              rows.push({ label: 'Material', value: summaryMaterial.display_name })
              // variant_type lives on the variant rows (all variants
              // of one material share the same variant_type per the
              // material_variants schema), not on the local Material
              // interface. Pull from the first selected variant.
              // Defaults to undefined when variants haven't loaded yet
              // — the row skips anyway in that case.
              const variantType = summarySelectedVariants[0]?.variant_type
              const variantLabel = variantType ? VARIANT_ROW_LABEL[variantType] : undefined
              if (variantLabel && summarySelectedVariants.length > 0) {
                rows.push({
                  label: variantLabel,
                  value: formatVariantsValue(summarySelectedVariants),
                })
              }
              if (summaryNonBaseOption && summaryMaterial.option_label) {
                rows.push({
                  label: summaryMaterial.option_label,
                  value: summaryNonBaseOption.display_name,
                })
              }
            }
            if (currency) rows.push({ label: 'Currency', value: currency })
            if (summaryMaterial?.requires_ink_names && inkNames.length > 0) {
              rows.push({ label: 'Inks', value: formatJoinedList(inkNames) })
            }
            if (names.length > 0) {
              rows.push({ label: 'Names', value: formatJoinedList(names) })
            }
            const sidesValue = sidedness === 'one-sided'
              ? '1'
              : (shared ? '2 (shared front)' : '2')
            rows.push({ label: 'Sides', value: sidesValue })
            if (cardType === 'membership') {
              rows.push({ label: 'Card type', value: 'Membership' })
            }

            return (
              <section className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-gray-200">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-widest text-gray-400">
                  Carried from v{inheritedVersionNumber}
                </h3>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
                  {rows.map(({ label, value }) => (
                    <Fragment key={label}>
                      <dt className="text-right text-sm font-medium text-gray-500">{label}:</dt>
                      <dd className="text-sm text-gray-900">{value}</dd>
                    </Fragment>
                  ))}
                </dl>
                {inheritedMaterialArchived && (
                  <p className="mt-3 text-sm text-amber-700">
                    The material has been archived. Edit details to pick a current one, or keep this for continuity.
                  </p>
                )}
                {!formExpanded && (
                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setFormExpanded(true)}
                      className="text-sm text-gray-600 underline underline-offset-4 hover:text-gray-900"
                    >
                      Edit details
                    </button>
                  </div>
                )}
              </section>
            )
          })()}

          {/* Form fields — pricing display + design + layout. On v2+
              creation these collapse behind the summary card above
              by default, expanding when the designer clicks "Edit
              details" (or when submit-time validation fails on a
              field that lives in here). On v1 creation the
              formExpanded effect sets this open immediately. */}
          {formExpanded && (
          <>
          {/* Pricing display — required choice between standard grid and custom quote */}
          {/* Pricing display — wrapped in the carry-forward
              treatment when this is a v2+ creation. Pill renders
              outside the wrapper so it sits on the field's own
              label line; the violet ribbon wraps the radio cards
              themselves. */}
          {carry.pricingDisplay.isCarried && inheritedVersionNumber != null && (
            <div className="mb-2.5 flex justify-end">
              <CarriedPill edited={carry.pricingDisplay.isEdited} versionNumber={inheritedVersionNumber} />
            </div>
          )}
          <div style={carriedFieldStyle(carry.pricingDisplay.isCarried, carry.pricingDisplay.isEdited)}>
            <PricingDisplayField
              value={pricingDisplay}
              onChange={setPricingDisplay}
              invalid={shouldHighlight('pricingDisplay')}
              forwardRef={pricingDisplayRef}
            />
            {pricingDisplay === null && !shouldHighlight('pricingDisplay') && (
              <p className="-mt-3 text-xs text-gray-400">Select one.</p>
            )}
          </div>

          {/* Specification — split into two sub-groups (Design +
              Layout) with Currency as a standalone line between
              them. The outer SPECIFICATION heading is intentionally
              gone; the sub-headings carry the structure. Sub-
              headings use the same type-style as the old outer
              heading so they read at matching weight. */}
          <section className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-gray-200">
            {/* ── DESIGN ─────────────────────────────────────────
                Material + variant + material options + ink names.
                Everything that describes what the physical card
                looks like. */}
            <h3 className="mb-7 text-sm font-semibold uppercase tracking-widest text-gray-400">Design</h3>

            <div className="mb-8">
              <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-gray-700">
                <span>Material</span>
                {carry.material.isCarried && inheritedVersionNumber != null && !inheritedMaterialArchived && (
                  <CarriedPill edited={carry.material.isEdited} versionNumber={inheritedVersionNumber} />
                )}
              </label>
              <div style={carriedFieldStyle(carry.material.isCarried && !inheritedMaterialArchived, carry.material.isEdited)}>
                <select
                  ref={materialRef}
                  value={selectedMaterialId}
                  onChange={(e) => handleMaterialChange(e.target.value)}
                  className={[selectClass, shouldHighlight('material') ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-300' : ''].join(' ')}
                >
                  <option value="">Select a material…</option>
                  {materials.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </select>
                {shouldHighlight('material') && <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>}
                {inheritedMaterialArchived && inheritedVersionNumber != null && (
                  <p className="mt-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                    The material used in v{inheritedVersionNumber} has been archived. Pick a current material or keep this one.
                  </p>
                )}
              </div>
            </div>

            {variantRequired && variants.length > 0 && variantType !== 'default' && (
              <div ref={variantRef} className="mb-8">
                <label className="mb-2.5 flex flex-wrap items-center gap-2 text-sm font-medium text-gray-700">
                  <span>{variantLabel(variantType)}</span>
                  {carry.variants.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.variants.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                  {isMultiVariant && <span className="ml-1 font-normal text-gray-400">Tick every option you want the customer to see.</span>}
                </label>

                <div style={carriedFieldStyle(carry.variants.isCarried, carry.variants.isEdited)}>
                  {isMultiVariant ? (
                    <div className={[
                      'flex flex-wrap gap-2 rounded-lg',
                      shouldHighlight('variant') ? 'p-2 ring-1 ring-rose-300' : '',
                    ].join(' ')}>
                      {variants.map((v) => {
                        const checked = selectedVariantIds.includes(v.id)
                        return (
                          <button key={v.id} type="button" onClick={() => toggleVariant(v.id)}
                            className={[
                              'rounded-full px-5 py-2 text-sm font-medium transition-colors',
                              checked
                                ? ''
                                : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50',
                            ].join(' ')}
                            style={checked ? selectedChipStyle(carry.variants.isEdited) : undefined}>
                            {v.display_name}
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <select
                      value={selectedVariantIds[0] ?? ''}
                      onChange={(e) => {
                        setSelectedVariantIds(e.target.value ? [e.target.value] : [])
                      }}
                      className={[selectClass, shouldHighlight('variant') ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-300' : ''].join(' ')}
                    >
                      <option value="">Select…</option>
                      {variants.map((v) => <option key={v.id} value={v.id}>{v.display_name}</option>)}
                    </select>
                  )}
                  {shouldHighlight('variant') && <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>}
                  {/* Auto-custom-quote notice. Surfaces when the
                      current variant selection has no price_tiers
                      for the active currency — happens for 5+ ink
                      variants (no tier pricing exists) and the form
                      automatically enters custom-quote mode.
                      Distinguished from the user-picked custom mode
                      by autoCustomQuote (rather than isCustomQuote)
                      so a user who explicitly chose Custom quote
                      doesn't see a redundant notice. */}
                  {autoCustomQuote && (
                    <p className="mt-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                      This ink count has no standard pricing, saving as a custom quote. Price and quantity will be agreed separately.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Option selection — for materials that expose multi-options
                (finishes on metals, species on wood, etc.) */}
            {hasOptions && (
              <div className="mb-8">
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-gray-700">
                  <span>{optionLabelPlural}</span>
                  {carry.options.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.options.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>
                <div style={carriedFieldStyle(carry.options.isCarried, carry.options.isEdited)}>
                  <div className="flex flex-wrap gap-2">
                    {availableOptions.map(o => {
                      const selected = selectedOptions.includes(o.code)
                      return (
                        <button
                          key={o.code}
                          type="button"
                          onClick={() => toggleOption(o.code)}
                          className={[
                            'rounded-full px-5 py-2 text-sm font-medium transition-colors',
                            selected
                              ? ''
                              : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50',
                          ].join(' ')}
                          style={selected ? selectedChipStyle(carry.options.isEdited) : undefined}
                        >
                          {o.display_name}
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-1.5 text-xs text-gray-400">
                    Select which {optionLabelPlural.toLowerCase()} to offer. Each {optionLabelSingular.toLowerCase()} gets its own proof images.
                  </p>
                </div>
              </div>
            )}

            {requiresInkNames ? (
              <div ref={inkNamesRef} className="mb-8">
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-gray-700">
                  <span>Ink names</span>
                  {carry.inkNames.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.inkNames.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>
                <div style={carriedFieldStyle(carry.inkNames.isCarried, carry.inkNames.isEdited)}>
                  {inkCount === 0 ? (
                    <p className="text-sm text-gray-400">Select a variant to enter ink names.</p>
                  ) : (
                    <div className="space-y-2">
                      {Array.from({ length: inkCount }).map((_, i) => {
                        const fieldInvalid = submitAttempted && !inkNameValidities[i]
                        return (
                          <div key={i}>
                            <label className="mb-0.5 block text-xs font-medium text-gray-500">Ink {i + 1}</label>
                            <input
                              type="text"
                              placeholder="e.g. Pantone 185 C"
                              value={inkNamesArray[i] ?? ''}
                              onChange={(e) => {
                                const next = [...inkNamesArray]
                                next[i] = e.target.value
                                setInkNamesArray(next)
                              }}
                              className={[
                                inputClass,
                                fieldInvalid ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-300' : '',
                              ].join(' ')}
                            />
                            {fieldInvalid && <p className="mt-1 text-xs font-medium text-rose-500">Required</p>}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="mb-8">
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-gray-700">
                  <span>Ink names</span>
                  <span className="font-normal text-gray-400">(optional, comma-separated)</span>
                  {carry.inkNames.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.inkNames.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>
                <div style={carriedFieldStyle(carry.inkNames.isCarried, carry.inkNames.isEdited)}>
                  <input type="text" placeholder="e.g. Pantone 185 C, Metallic Gold" value={inkNamesText}
                    onChange={(e) => setInkNamesText(e.target.value)} className={inputClass} />
                </div>
              </div>
            )}

            {/* ── Currency (standalone, no heading) ──────────────
                Sits between Design and Layout with the same
                vertical breathing room as a sub-group, so it
                reads as an equal-weight third unit. Hidden in
                custom-quote mode — no price on display, no need
                for a currency pick. */}
            {!isCustomQuote && (
              <div ref={currencyRef} className="mt-8 mb-8">
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-gray-700">
                  <span>Currency</span>
                  {carry.currency.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.currency.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>
                <div style={carriedFieldStyle(carry.currency.isCarried, carry.currency.isEdited)}>
                  <CurrencyField
                    value={currency}
                    onChange={(c) => setCurrency(c)}
                    invalid={shouldHighlight('currency')}
                    edited={carry.currency.isEdited}
                  />
                  {shouldHighlight('currency')
                    ? <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>
                    : currency === null
                      ? <p className="mt-1.5 text-xs text-gray-400">Select one.</p>
                      : null}
                </div>
              </div>
            )}

            {/* ── LAYOUT ─────────────────────────────────────────
                Card type + names + sidedness + shared. Top-level
                split is Card type: Business card is the standard
                split-name workflow (names + optional shared-
                front); Membership card collapses every slot to
                Shared and hides names + shared toggle entirely.
                Order is card type → names (business only) →
                sidedness → shared (business only + two-sided +
                ≥2 names). Names is required in Business mode and
                irrelevant in Membership; shared side by internal
                convention is always 'front' in Business. */}
            <h3 className="mt-8 mb-7 text-sm font-semibold uppercase tracking-widest text-gray-400">Layout</h3>

            {/* Card type — segmented pill mirroring Sidedness. v1
                defaults to Business. v2+ inheritance derives from
                v(N-1).names.length === 0 (membership) vs non-
                empty (business). Flipping Business → Membership
                orphans any per-name v1 images; the handler fires
                the same approval-invalidation confirm as the
                other shape flips before applying. */}
            <div className="mb-8">
              <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-gray-700">
                <span>Card type</span>
                {carry.cardType.isCarried && inheritedVersionNumber != null && (
                  <CarriedPill edited={carry.cardType.isEdited} versionNumber={inheritedVersionNumber} />
                )}
              </label>
              <div style={carriedFieldStyle(carry.cardType.isCarried, carry.cardType.isEdited)}>
                <fieldset className="inline-flex rounded-xl border border-gray-200 bg-white p-0.5">
                  <legend className="sr-only">Card type</legend>
                  {(['business', 'membership'] as const).map((opt) => {
                    const selected = cardType === opt
                    return (
                      <label
                        key={opt}
                        className={[
                          'cursor-pointer rounded-lg px-5 py-2 text-sm font-semibold transition-colors',
                          'focus-within:ring-2 focus-within:ring-gray-400 focus-within:ring-offset-1',
                          selected ? '' : 'text-gray-500 hover:text-gray-900',
                        ].join(' ')}
                        style={selected ? selectedChipStyle(carry.cardType.isEdited) : undefined}
                      >
                        <input
                          type="radio"
                          name="cardType"
                          value={opt}
                          checked={selected}
                          onChange={() => handleCardTypeChange(opt)}
                          className="sr-only"
                        />
                        {opt === 'business' ? 'Business card' : 'Membership card'}
                      </label>
                    )
                  })}
                </fieldset>
              </div>
            </div>

            {/* Chip input backs the proof_versions.names array.
                Visible in both modes now — Business mode treats
                the chips as recipient names (required, ≥1
                needed); Membership mode treats them as optional
                tier variant labels (0+ entries, Bronze / Silver /
                Gold / etc.). Copy + validation swap on cardType;
                the underlying column is the same. Chip state is
                preserved across Card type flips so re-switching
                carries the chips through. The DB trigger
                snapshots the per-currency split-name tooling
                surcharge onto the version on save (runs
                regardless of mode). */}
            <div ref={namesRef} className="mb-8">
              <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-gray-700">
                {cardType === 'business' ? (
                  <span>Names on this order</span>
                ) : (
                  <>
                    <span>Variants</span>
                    <span className="font-normal text-gray-400">(optional)</span>
                  </>
                )}
                {carry.names.isCarried && inheritedVersionNumber != null && (
                  <CarriedPill edited={carry.names.isEdited} versionNumber={inheritedVersionNumber} />
                )}
              </label>
              <div style={carriedFieldStyle(carry.names.isCarried, carry.names.isEdited)}>
                <NameChipInput
                  names={names}
                  onChange={handleNamesChange}
                  placeholder={
                    cardType === 'business'
                      ? 'Who is this proof for? Press Enter after each name'
                      : 'e.g. Bronze, Silver, Gold. Press Enter after each variant'
                  }
                  ariaLabel={
                    cardType === 'business' ? 'Names on this order' : 'Tier variants'
                  }
                />
                {shouldHighlight('names') && (
                  <p className="mt-1.5 text-xs font-medium text-rose-500">
                    Add at least one name.
                  </p>
                )}
              </div>
            </div>

            {/* Shape controls — sidedness + shared. Together with
                names[] and the material's options, these drive
                the slot universe in the image section below. v1
                defaults: two-sided, Shared OFF. v2+ inherits from
                v(N-1)'s images. Flipping either control can
                invalidate v1 approvals if approved images would
                become unreachable — the handlers above surface a
                confirm first. */}
            <div className="space-y-3">
              <div className="mb-2">
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-gray-700">
                  <span>Sidedness</span>
                  {carry.sidedness.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.sidedness.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>
                <div style={carriedFieldStyle(carry.sidedness.isCarried, carry.sidedness.isEdited)}>
                  <fieldset className="inline-flex rounded-xl border border-gray-200 bg-white p-0.5">
                    <legend className="sr-only">Sidedness</legend>
                    {(['one-sided', 'two-sided'] as const).map((opt) => {
                      const selected = sidedness === opt
                      return (
                        <label
                          key={opt}
                          className={[
                            'cursor-pointer rounded-lg px-5 py-2 text-sm font-semibold transition-colors',
                            'focus-within:ring-2 focus-within:ring-gray-400 focus-within:ring-offset-1',
                            selected ? '' : 'text-gray-500 hover:text-gray-900',
                          ].join(' ')}
                          style={selected ? selectedChipStyle(carry.sidedness.isEdited) : undefined}
                        >
                          <input
                            type="radio"
                            name="sidedness"
                            value={opt}
                            checked={selected}
                            onChange={() => handleSidednessChange(opt)}
                            className="sr-only"
                          />
                          {opt === 'one-sided' ? 'One-sided' : 'Two-sided'}
                        </label>
                      )
                    })}
                  </fieldset>
                </div>
              </div>

              {/* Shared renders on two-sided projects with ≥2
                  identities (names or tier variants — same
                  dimension, different copy). One-sided is always
                  fully per-identity so there's nothing to
                  toggle. With a single identity the "shared
                  across all cards vs personalised per identity"
                  distinction collapses — there's only one card
                  regardless of whether that identity is a person
                  or a tier. Removing from the DOM rather than
                  disabling keeps the form visually simpler. Sub-
                  text describes the effect rather than a state,
                  since "shared" on its own is ambiguous about
                  which side gets shared. State is NOT auto-reset
                  when names drops below 2 or on Card type flip;
                  re-entering the qualifying shape restores the
                  toggle with its prior value. */}
              {sidedness === 'two-sided' && names.length >= 2 && (
                <div style={carriedFieldStyle(carry.shared.isCarried, carry.shared.isEdited)}>
                  <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                        <span>Shared</span>
                        {carry.shared.isCarried && inheritedVersionNumber != null && (
                          <CarriedPill edited={carry.shared.isEdited} versionNumber={inheritedVersionNumber} />
                        )}
                      </div>
                      <div className="text-xs text-gray-500">
                        One side shared across all cards, the other personalised per name.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSharedChange(!shared)}
                      role="switch"
                      aria-checked={shared}
                      aria-label="Shared design"
                      className={[
                        'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
                        shared ? 'bg-gray-900' : 'bg-gray-200',
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'inline-block h-5 w-5 translate-y-0.5 transform rounded-full bg-white transition-transform',
                          shared ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
                        ].join(' ')}
                      />
                    </button>
                  </div>
                </div>
              )}
            </div>

          </section>
          </>
          )}

          {/* Unified image section.
              Per-(option, name) drop targets and empty slots unify
              carry, replacement, and fresh upload into one grid.
              Replaces the former split of a Shape B carry card
              grid above a flat uploader below: cards and empty
              slots co-exist in the flat grid, sorted by the 5-way
              bucket below. Drop a file on a carry card to queue a
              replacement; drop or click on an empty slot to
              upload fresh into that slot's (option, name)
              coordinate. */}
          <section ref={imageSectionRef} className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">
              {v1Carry ? `Proof images, carrying from v${v1Carry.versionNumber}` : 'Proof images'}
            </h2>

            {/* Section-level batch drop zone. Routes drops through
                addFilesBatch which auto-distributes each file to a
                slot using matchImageToName for filename hints, and
                drop-order alternation (front, back, front, back,
                reset per batch) for files where the heuristic
                returns null side. EmptySlot per-slot zones still
                exist below the grid for precise placement; this
                zone is the "drop a folder, walk away" affordance.

                Three states:
                  * Disabled — slot universe is empty (Business
                    mode with no names yet). Click and drop are
                    inert; copy explains why.
                  * Drag-over — page-level or zone-level drag is
                    active. Violet ring matches the form's hybrid
                    styling.
                  * Idle — default. Dashed gray. Click opens the
                    multi-file picker via the local input ref.

                v1Carry's per-card "drop on the card to replace"
                pattern still works through CarryCard's own drop
                handler. The window-level handler in the
                useImageFileDrop hook only fires for drops outside
                any per-cell zone (CarryCard and EmptySlot both
                stopPropagation on their own drop events). */}
            {(() => {
              const dropDisabled = !hasAnySlot
              const isDragActive = isZoneDragOver || isPageDragOver
              const dropZoneStyle: CSSProperties = isDragActive
                ? {
                    background: 'rgba(123,63,242,0.045)',
                    boxShadow: 'inset 0 0 0 1.5px #7b3ff2',
                  }
                : {}
              return (
                <div className="mb-4">
                  <div
                    {...(dropDisabled ? {} : zoneProps)}
                    onClick={() => {
                      if (dropDisabled) return
                      sectionDropInputRef.current?.click()
                    }}
                    role="button"
                    tabIndex={dropDisabled ? -1 : 0}
                    aria-disabled={dropDisabled}
                    onKeyDown={(e) => {
                      if (dropDisabled) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        sectionDropInputRef.current?.click()
                      }
                    }}
                    className={[
                      'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-7 text-center transition-colors',
                      dropDisabled
                        ? 'cursor-not-allowed border-gray-200 bg-gray-50/60 text-gray-400'
                        : isDragActive
                          ? 'cursor-copy border-transparent text-gray-900'
                          : 'cursor-pointer border-gray-300 bg-gray-50/40 text-gray-600 hover:border-gray-400 hover:bg-gray-50',
                    ].join(' ')}
                    style={dropZoneStyle}
                  >
                    {dropDisabled ? (
                      <p className="text-sm font-medium">Add a name first to drop images.</p>
                    ) : isDragActive ? (
                      <p className="text-sm font-semibold">Drop to add</p>
                    ) : (
                      <>
                        <p className="text-sm font-medium">Drop images here, or click to browse</p>
                        <p className="mt-1 text-xs text-gray-400">
                          {v1Carry
                            ? `We will tag each file by name and side, then place it. Drop on a card below to replace a v${v1Carry.versionNumber} image instead.`
                            : 'We will tag each file by name and side, then place it. JPEG up to 10 MB each.'}
                        </p>
                      </>
                    )}
                    <input
                      ref={sectionDropInputRef}
                      type="file"
                      accept={ACCEPTED_TYPES.join(',')}
                      multiple
                      onChange={(e) => {
                        addFilesBatch(Array.from(e.target.files ?? []))
                        e.target.value = ''
                      }}
                      className="sr-only"
                    />
                  </div>
                </div>
              )
            })()}

            {/* Option tabs */}
            {optionMode && selectedOptions.length > 0 && (
              <div className="mb-4 flex gap-0 border-b border-gray-100">
                {selectedOptions.map(fCode => {
                  const f = availableOptions.find(x => x.code === fCode)
                  const isActive = activeImageOption === fCode
                  return (
                    <button
                      key={fCode}
                      type="button"
                      onClick={() => setActiveImageOption(fCode)}
                      className={[
                        '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'border-gray-900 text-gray-900'
                          : 'border-transparent text-gray-400 hover:text-gray-700',
                      ].join(' ')}
                    >
                      {f?.display_name ?? fCode}
                      <span className={['ml-1.5 text-xs', isActive ? 'text-gray-400' : 'text-gray-300'].join(' ')}>
                        ({(imagesByOption[fCode] ?? []).length})
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {(() => {
              // Unified per-slot grid. Assembles cells from three
              // sources: carry cards (v1 images for this tab),
              // fresh-image cards (user-uploaded for this tab),
              // and empty drop zones (slots with no content yet).
              // Sort order surfaces actionable buckets first and
              // settled carries last.
              const activeCode = optionMode ? activeImageOption : ''

              // Slot universe: (identity, side) tuples derived
              // from cardType + sidedness + shared + names.
              // Identity is SHARED_APPROVAL_KEY for shared slots,
              // else a recipient name / variant label. Membership
              // with 0 variants produces a single Shared slot per
              // side. Membership with ≥1 variants behaves exactly
              // like business mode — each variant is an identity
              // slotted per-side, and the Shared toggle applies if
              // there are ≥2. Business mode with shared=true (two-
              // sided) collapses front to Shared, back to per-
              // identity. Shared side is fixed to 'front' by
              // internal convention (see state declaration). Post-
              // migration-000085 v1 images always have side non-
              // null; pre-migration nulls are treated as 'front'
              // for back-compat.
              const sides: ('front' | 'back')[] =
                sidedness === 'two-sided' ? ['front', 'back'] : ['front']
              type SlotTuple = { identity: string; side: 'front' | 'back' }
              const slotTuples: SlotTuple[] = []
              const isMembershipSingle = cardType === 'membership' && names.length === 0
              for (const side of sides) {
                if (isMembershipSingle) {
                  slotTuples.push({ identity: SHARED_APPROVAL_KEY, side })
                  continue
                }
                const isSharedSlotForSide =
                  sidedness === 'two-sided' && shared && side === 'front'
                if (isSharedSlotForSide) {
                  slotTuples.push({ identity: SHARED_APPROVAL_KEY, side })
                } else {
                  for (const name of names) slotTuples.push({ identity: name, side })
                }
              }

              const slotKey = (identity: string, side: 'front' | 'back') => `${identity}|${side}`

              // Carry cells keyed by slot. v1 image matches a slot
              // iff its (identity, side) coordinate matches. v1
              // images whose name was dropped from v2.names[] —
              // or whose (identity, side) combo isn't in the new
              // universe (e.g. Alice-back after flipping to
              // one-sided) — silently don't render.
              const validSlots = new Set(slotTuples.map((s) => slotKey(s.identity, s.side)))
              const carryCellsBySlot: Record<string, V1Image[]> = {}
              if (v1Carry) {
                for (const img of v1Carry.images) {
                  if ((img.material_option ?? '') !== activeCode) continue
                  const identity = img.associated_name ?? SHARED_APPROVAL_KEY
                  const side = img.side ?? 'front'
                  const key = slotKey(identity, side)
                  if (!validSlots.has(key)) continue
                  ;(carryCellsBySlot[key] ??= []).push(img)
                }
              }

              // Fresh cells keyed by slot. Each ImageEntry carries
              // its (associated_name, side) stamped at drop time,
              // so the grouping is cheap.
              const freshCellsBySlot: Record<string, ImageEntry[]> = {}
              for (const entry of (imagesByOption[activeCode] ?? [])) {
                const identity = entry.associated_name ?? SHARED_APPROVAL_KEY
                const side = entry.side ?? 'front'
                const key = slotKey(identity, side)
                if (!validSlots.has(key)) continue
                ;(freshCellsBySlot[key] ??= []).push(entry)
              }

              // Build an intermediate per-cell representation.
              // slotKey is composite now ({identity}|{side}) but
              // carries identity + side for downstream rendering.
              type Cell =
                | { kind: 'carry'; img: V1Image; slotKey: string; identity: string; side: 'front' | 'back' }
                | { kind: 'fresh'; entry: ImageEntry; slotKey: string; identity: string; side: 'front' | 'back' }
                | { kind: 'empty'; slotKey: string; identity: string; side: 'front' | 'back' }

              const cells: Cell[] = []
              for (const tuple of slotTuples) {
                const key = slotKey(tuple.identity, tuple.side)
                const carries = carryCellsBySlot[key] ?? []
                const freshes = freshCellsBySlot[key] ?? []
                for (const img of carries) cells.push({ kind: 'carry', img, slotKey: key, identity: tuple.identity, side: tuple.side })
                for (const entry of freshes) cells.push({ kind: 'fresh', entry, slotKey: key, identity: tuple.identity, side: tuple.side })
                if (carries.length === 0 && freshes.length === 0) {
                  cells.push({ kind: 'empty', slotKey: key, identity: tuple.identity, side: tuple.side })
                }
              }

              // Five-way state bucket for sort:
              //   0: carry with v1 state = changes_requested (hottest)
              //   1: carry with v1 state = null (unreviewed)
              //   2: empty slot (nothing to carry, waiting)
              //   3: fresh-image card (user added)
              //   4: carry with v1 state = approved (settled → Previously approved section)
              function stateBucketFor(cell: Cell): 0 | 1 | 2 | 3 | 4 {
                if (cell.kind === 'empty') return 2
                if (cell.kind === 'fresh') return 3
                const nameKey = cell.img.associated_name ?? SHARED_APPROVAL_KEY
                const approval = v1Carry?.approvalsByName[nameKey]
                if (approval?.state === 'changes_requested') return 0
                if (approval == null) return 1
                return 4
              }

              const nameOrderFor = (identity: string) =>
                identity === SHARED_APPROVAL_KEY ? -1 : names.indexOf(identity)
              const sideOrderFor = (side: 'front' | 'back') => (side === 'front' ? 0 : 1)

              // Sort precedence: bucket → side (fronts before
              // backs within a bucket, per spec) → isShared
              // (Shared before named within the same side) → name
              // order → original index for stability.
              const sortedCells = cells
                .map((cell, originalIdx) => ({
                  cell,
                  originalIdx,
                  bucket: stateBucketFor(cell),
                  sideOrder: sideOrderFor(cell.side),
                  isShared: (cell.identity === SHARED_APPROVAL_KEY ? 0 : 1) as 0 | 1,
                  nameOrder: nameOrderFor(cell.identity),
                }))
                .sort((a, b) => {
                  if (a.bucket !== b.bucket) return a.bucket - b.bucket
                  if (a.sideOrder !== b.sideOrder) return a.sideOrder - b.sideOrder
                  if (a.isShared !== b.isShared) return a.isShared - b.isShared
                  if (a.nameOrder !== b.nameOrder) return a.nameOrder - b.nameOrder
                  return a.originalIdx - b.originalIdx
                })
                .map((x) => x.cell)

              // Open section = buckets 0, 1, 2, 3.
              // Previously approved section = bucket 4.
              const openCells = sortedCells.filter((c) => {
                const b = stateBucketFor(c)
                return b === 0 || b === 1 || b === 2 || b === 3
              })
              const approvedCells = sortedCells.filter((c) => stateBucketFor(c) === 4)
              const showHeadings = openCells.length > 0 && approvedCells.length > 0

              // First-cell-in-slot label rule: within each
              // section's cell sequence, the name label renders on
              // the first cell encountered per slot and hides on
              // subsequent cells for the same slot. Keeps repeat
              // cells tidy (shared + 3 images in one slot feels
              // calmer without the name repeating 3 times).
              function computeLabelVisibility(cellList: Cell[]): boolean[] {
                const seen = new Set<string>()
                return cellList.map((c) => {
                  if (seen.has(c.slotKey)) return false
                  seen.add(c.slotKey)
                  return true
                })
              }

              // Side badge shows Front/Back on two-sided projects,
              // suppressed on one-sided.
              const sideBadge = sidedness === 'two-sided'
              function renderCell(cell: Cell, showLabel: boolean) {
                if (cell.kind === 'carry') {
                  const nameKey = cell.img.associated_name ?? SHARED_APPROVAL_KEY
                  const approval = v1Carry?.approvalsByName[nameKey]
                  const keep = keepByV1RowId[cell.img.v1RowId] ?? true
                  const replacement = replacementByV1RowId[cell.img.v1RowId]
                  return (
                    <CarryCard
                      key={`carry-${cell.img.v1RowId}`}
                      img={cell.img}
                      nameLabel={showLabel ? cell.img.associated_name : undefined}
                      sideLabel={sideBadge ? cell.side : null}
                      approval={approval}
                      v1VersionNumber={v1Carry?.versionNumber ?? 0}
                      keep={keep}
                      replacement={replacement}
                      onKeepChange={(v) => handleKeepToggle(cell.img.v1RowId, v)}
                      onReplacementUpload={(file) => handleReplacementUpload(cell.img.v1RowId, file)}
                      onReplacementClear={() => handleReplacementClear(cell.img.v1RowId)}
                      onReplacementDrop={(files) => handleReplacementDrop(cell.img.v1RowId, files)}
                    />
                  )
                }
                if (cell.kind === 'fresh') {
                  const slotName = cell.identity === SHARED_APPROVAL_KEY ? null : cell.identity
                  return (
                    <FreshImageCard
                      key={`fresh-${cell.entry.localId}`}
                      entry={cell.entry}
                      nameLabel={showLabel ? slotName : undefined}
                      sideLabel={sideBadge ? cell.side : null}
                      twoSided={sidedness === 'two-sided'}
                      onRemove={() => removeImage(cell.entry.localId)}
                      onFlipSide={() => flipFreshSide(cell.entry.localId)}
                    />
                  )
                }
                // empty
                const slotName = cell.identity === SHARED_APPROVAL_KEY ? null : cell.identity
                return (
                  <EmptySlot
                    key={`empty-${cell.slotKey}-${activeCode}`}
                    nameLabel={showLabel ? slotName : undefined}
                    sideLabel={sideBadge ? cell.side : null}
                    onFiles={(files) => addFilesToSlot(activeCode, slotName, cell.side, files)}
                  />
                )
              }

              if (sortedCells.length === 0) {
                return null
              }

              if (!showHeadings) {
                const labels = computeLabelVisibility(sortedCells)
                return (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {sortedCells.map((cell, i) => renderCell(cell, labels[i]))}
                  </div>
                )
              }

              const openLabels = computeLabelVisibility(openCells)
              const approvedLabels = computeLabelVisibility(approvedCells)
              return (
                <>
                  <p className="mb-3 mt-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                    Open
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {openCells.map((cell, i) => renderCell(cell, openLabels[i]))}
                  </div>
                  <p className="mb-3 mt-8 text-xs font-medium uppercase tracking-wide text-gray-500">
                    Previously approved
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {approvedCells.map((cell, i) => renderCell(cell, approvedLabels[i]))}
                  </div>
                </>
              )
            })()}

            {/* Notice if v1 had images on option codes v2 doesn't
                offer, those carry options simply won't appear in
                any tab and their images are silently dropped. */}
            {v1Carry && optionMode && (() => {
              const v1OptionCodes = new Set(
                v1Carry.images.map((i) => i.material_option).filter((c): c is string => c != null),
              )
              const dropped = v1Carry.materialOptions.filter(
                (c) => v1OptionCodes.has(c) && !selectedOptions.includes(c),
              )
              if (dropped.length === 0) return null
              return (
                <p className="mt-4 border-t border-gray-100 pt-4 text-xs text-gray-500">
                  v{v1Carry.versionNumber} had images on {dropped.join(', ')}, these won't carry since v2 doesn't offer {dropped.length === 1 ? 'that option' : 'those options'}.
                </p>
              )
            })()}

            {fileError && <p className="mt-2 text-sm text-red-600">{fileError}</p>}
            {fileNote && <p className="mt-2 text-sm text-gray-500">{fileNote}</p>}
            {shouldHighlight('images') && (
              <p className="mt-2 text-xs font-medium text-rose-500">{imagesHint}</p>
            )}
          </section>

          {/* Bottom-of-form mirror of the top action row. Same
              Cancel + Save pair, same form="new-version-form"
              wiring, so clicking Save here routes through the
              same handleSubmit → validation → scroll-to-first-
              invalid path as the top button. Right-aligned to
              match the top row's visual position within the
              content column. Not sticky — the form needs the
              vertical space for the image grid. */}
          <div className="flex justify-end">
            {actionRow}
          </div>

          {/* Change notes */}
          <section className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-gray-200">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Change notes</h2>
            <textarea rows={3} placeholder="What changed in this version? Shown to the customer."
              value={changeNotes} onChange={(e) => setChangeNotes(e.target.value)} className={inputClass} />
          </section>

          {/* Pricing — one section per selected variant. Read-only
              reference display of live prices pulled from price_tiers
              for the chosen variant and currency. All edits happen
              in Admin → Pricing; designers see the live values here
              to confirm the customer-facing number, not to modify
              it. Hidden in custom-quote mode and until a currency is
              picked. Also gated on formExpanded (Tier 2c) so the
              previews collapse with the form they verify — no point
              showing pricing tables when the variant/currency
              choices that produce them are hidden. */}
          {formExpanded && !isCustomQuote && selectedVariantIds.length > 0 && currency !== null && selectedVariantIds.map((vid) => {
            const variant = variants.find((v) => v.id === vid)
            const tiers = variantTiers[vid] ?? []
            if (!variant) return null

            const material = materials.find((m) => m.id === selectedMaterialId)
            const displaySet = new Set(material?.display_quantities ?? DEFAULT_DISPLAY_QUANTITIES)
            const userExpanded = !!expandedVariants[vid]
            const visibleTiers = tiers.filter((t) => displaySet.has(t.quantity) || userExpanded)
            const hiddenCount = tiers.length - visibleTiers.length
            const showToggle = hiddenCount > 0 || (userExpanded && tiers.length > displaySet.size)
            const variantLabel = variantType === 'default'
              ? material_display_for(selectedMaterialId, materials)
              : variant.display_name

            return (
              <section key={vid} className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-gray-200">
                <h2 className="mb-1 text-sm font-semibold uppercase tracking-widest text-gray-400">
                  Pricing: {variantLabel}
                </h2>
                <p className="mb-4 text-xs text-gray-400">
                  {tiers.length > 0
                    ? `Reference pricing for ${variantLabel} (${currency}).`
                    : 'No price tiers found for this variant and currency.'}
                </p>
                {tiers.length > 0 && (
                  <>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          {/* Mirrors the shared PricingDisplay
                              component's headers so designer and
                              customer views stay in lockstep.
                              Currency suffix dropped from the
                              price column — the cell values
                              already carry the currency via
                              formatPrice. */}
                          <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Total quantity</th>
                          <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Price</th>
                          <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Per card</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleTiers.map((tier) => (
                          <tr key={tier.quantity} className="border-b border-gray-50 last:border-0">
                            <td className="py-2 pr-4 font-medium text-gray-900">{tier.quantity.toLocaleString()}</td>
                            <td className="py-2 pr-4 text-gray-900">
                              {formatPrice(tier.total_price, currency, 2)}
                            </td>
                            <td className="py-2 text-xs text-gray-500">
                              {tier.total_price > 0 ? formatPrice(tier.total_price / tier.quantity, currency, 2) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {showToggle && (
                      <button
                        type="button"
                        onClick={() => setExpandedVariants(prev => ({ ...prev, [vid]: !prev[vid] }))}
                        className="mt-3 text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
                      >
                        {userExpanded
                          ? 'Hide extra tiers'
                          : `Show all tiers${hiddenCount > 0 ? ` (${hiddenCount} more)` : ''}`}
                      </button>
                    )}
                  </>
                )}
              </section>
            )
          })}

          {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

        </form>
      </div>
    </div>
  )
}

// ── Summary card helpers (Tier 2c) ──────────────────────────────────────────
//
// The summary card renders labelled name-value rows in a <dl> grid.
// These helpers shape the row values; the row assembly itself
// happens inline in the IIFE that builds the card (so it can read
// live from current form state and update as the designer edits).
//
// formatJoinedList: shared name-and-N-others truncation used by
// the Names row and the Inks (ink names) row. Three or fewer
// renders the full list with "and" before the last; four or more
// collapses to "first and N others" so the row stays scannable on
// projects with long lists.
function formatJoinedList(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  if (items.length === 3) return `${items[0]}, ${items[1]} and ${items[2]}`
  return `${items[0]} and ${items.length - 1} others`
}

// formatVariantsValue: builds the value cell for the variant row
// (Thickness / Finish / Ink count). Single variant → display_name
// verbatim. Multi-variant → smart strip: tokenise on whitespace,
// detect a shared trailing token, strip from all but the last
// entry, and join with comma + "and". Falls back to a plain
// comma-and-and join when units differ. Examples:
//   ["300 micron", "500 micron", "800 micron"] → "300, 500 and 800 micron"
//   ["1 Ink", "2 Inks"]                         → "1 Ink and 2 Inks" (units differ)
//   ["Natural", "Brushed", "Mirror"]            → "Natural, Brushed and Mirror"
//   ["1mm", "0.8mm"]                            → "1mm and 0.8mm" (single tokens)
function formatVariantsValue(variants: { display_name: string }[]): string {
  if (variants.length === 0) return ''
  if (variants.length === 1) return variants[0].display_name
  const tokens = variants.map((v) => v.display_name.trim().split(/\s+/))
  const lastTokens = tokens.map((t) => t[t.length - 1])
  const sharedUnit =
    lastTokens.every((u) => u === lastTokens[0]) &&
    tokens.every((t) => t.length >= 2)
  if (sharedUnit) {
    const numbers = tokens.map((t) => t.slice(0, -1).join(' '))
    const unit = lastTokens[0]
    if (numbers.length === 2) return `${numbers[0]} and ${numbers[1]} ${unit}`
    return `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]} ${unit}`
  }
  return formatJoinedList(variants.map((v) => v.display_name))
}

// Map material.variant_type → label for the Variant row. Default-
// variant materials (wood, acrylic, carbon fibre seeded as the only
// "default" types in 000009) skip the variant row entirely — the
// Material row alone carries enough information. Ink-count
// materials get "Ink count" rather than "Inks" to disambiguate
// from the separate Inks (ink names) row.
const VARIANT_ROW_LABEL: Record<string, string> = {
  thickness: 'Thickness',
  finish: 'Finish',
  ink_count: 'Ink count',
}

/** Build a compact "Select a X and a Y" hint for the Save button's
 *  disabled tooltip from the current validation results. Pricing
 *  display + currency are the two fields the admin "no default" setting
 *  can leave unselected; other validation errors are reported inline. */
function missingFieldsHint(validations: Record<string, boolean>): string {
  const missing: string[] = []
  if (!validations.pricingDisplay) missing.push('a pricing display')
  if (!validations.currency) missing.push('a currency')
  if (!validations.material) missing.push('a material')
  if (!validations.variant) missing.push('a variant')
  if (!validations.images) missing.push('at least one image')
  if (!validations.inkNames) missing.push('ink names')
  if (missing.length === 0) return 'Some required fields are incomplete'
  if (missing.length === 1) return `Select ${missing[0]}`
  if (missing.length === 2) return `Select ${missing[0]} and ${missing[1]}`
  return `Select ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
}

function material_display_for(id: string, materials: Material[]) {
  return materials.find((m) => m.id === id)?.display_name ?? ''
}

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
const selectClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 bg-white'

// ── Carry-forward visual treatment (D) ──────────────────────────────────────
// Each carried field on v2+ creation gets a left-border ribbon, a soft
// background tint, and a small pill on the label line. When the
// designer edits the value the ribbon switches to gray and the pill
// flips to "edited" — a quiet but unmistakable signal of which fields
// inherited and which have been touched.

// Pill that sits next to the field label. Violet "from v{N}" while
// the value matches the snapshot, gray "edited" once the designer
// modifies it.
function CarriedPill({ edited, versionNumber }: { edited: boolean; versionNumber: number }) {
  if (edited) {
    return (
      <span
        className="inline-flex items-center rounded-full text-[11px] font-medium"
        style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px' }}
      >
        edited
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center rounded-full text-[11px] font-medium"
      style={{ background: 'rgba(123,63,242,0.12)', color: '#5b2bba', padding: '2px 8px' }}
    >
      from v{versionNumber}
    </span>
  )
}

// Style applied to the wrapper around a carried field's control.
// Empty object when the field isn't carried (v1 creation, or a field
// that wasn't in the inherited snapshot) so the call site can apply
// it unconditionally.
function carriedFieldStyle(carried: boolean, edited: boolean): CSSProperties {
  if (!carried) return {}
  return {
    borderLeft: edited ? '4px solid #f59e0b' : '4px solid #7b3ff2',
    background: edited ? 'rgba(245,158,11,0.06)' : 'rgba(123,63,242,0.045)',
    paddingLeft: '12px',
    paddingTop: '8px',
    paddingBottom: '8px',
    borderRadius: '6px',
  }
}

// Inline style for the selected state of a hybrid chip / segmented
// control button. Soft violet tint with a 1.5px violet ring via
// inset box-shadow (no layout shift). Replaces the previous
// black-filled selected state on variant chips, material-options
// chips, card-type segmented, sidedness segmented, and the currency
// segmented (CurrencyField.tsx).
const hybridChipSelectedStyle: CSSProperties = {
  background: 'rgba(123,63,242,0.16)',
  color: '#5b2bba',
  boxShadow: 'inset 0 0 0 1.5px #7b3ff2',
}

// Same shape as the violet hybrid above, retinted amber for the
// edited state. Picked at the call site by passing the field's
// carry.X.isEdited so that an edited carried field's selected
// chip / segmented button matches the field's amber border, tint
// and pill instead of leaving a violet active selection inside
// an amber wrapper.
const hybridChipEditedSelectedStyle: CSSProperties = {
  background: 'rgba(245,158,11,0.16)',
  color: '#92400e',
  boxShadow: 'inset 0 0 0 1.5px #f59e0b',
}

// Picks the right hue for a selected chip / segmented button based
// on whether the field has been edited away from its inherited
// value. Call sites pass the field's carry.X.isEdited; when the
// field isn't carried at all (v1 creation) the flag is false so
// violet wins, which is correct because v1 has no inheritance and
// the violet/amber distinction collapses to "just the selected
// look".
function selectedChipStyle(edited: boolean): CSSProperties {
  return edited ? hybridChipEditedSelectedStyle : hybridChipSelectedStyle
}

// Validates a batch of files against the new-version constraints
// in one pass: ACCEPTED_TYPES (JPEG only), MAX_FILE_SIZE (10 MB
// per file), and a caller-supplied cap on remaining slots. Returns
// the survivors plus per-reason rejection counts so each call site
// can shape its own messaging. Pass Number.POSITIVE_INFINITY for
// `remaining` when the cap does not apply (e.g. CarryCard
// replacements, which do not consume MAX_IMAGES). The order of
// filtering matters: type first, size second, cap last; a non-
// image file is rejected as non-image even if it would also have
// been over size.
function partitionFiles(files: File[], remaining: number): {
  ok: File[]
  rejectedByType: number
  rejectedBySize: number
  rejectedByLimit: number
} {
  const okByType = files.filter((f) => ACCEPTED_TYPES.includes(f.type))
  const rejectedByType = files.length - okByType.length
  const okBySize = okByType.filter((f) => f.size <= MAX_FILE_SIZE)
  const rejectedBySize = okByType.length - okBySize.length
  const ok = okBySize.slice(0, Math.max(0, remaining))
  const rejectedByLimit = okBySize.length - ok.length
  return { ok, rejectedByType, rejectedBySize, rejectedByLimit }
}

// Order-sensitive equality (recipient names, positional ink names).
function arrayEquals<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// Order-insensitive equality (variant ids, material option codes —
// "[300um, 500um]" and "[500um, 300um]" describe the same selection).
function setEquals<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((v) => setB.has(v))
}

// One carry-forward card, one v1 image. Three visual states:
//
//   * Keep on, no replacement: normal, full opacity, toggle on.
//   * Keep off, no replacement: de-emphasised (faded thumb,
//     muted controls) so the designer sees at a glance what
//     will NOT carry.
//   * Replacement queued (regardless of the toggle state): amber
//     ring + "Replacing with: <filename>" caption below the
//     original thumb. Keep toggle is forced visually off and
//     disabled; Undo re-enables the toggle path.
//
// Thumb swaps to the replacement's preview once one is queued —
// the designer needs to verify at a glance that the file they
// just dropped is the one they intended. The v1 filename stays
// as the caption below the thumb and the amber "Replacing with
// {filename}" block spells out the new file, so the "what's
// being replaced" context isn't lost when the thumb swaps. In
// the other two states (Keep on / Keep off, no replacement) the
// thumb is the v1 preview.
function CarryCard({
  img,
  nameLabel,
  sideLabel,
  approval,
  v1VersionNumber,
  keep,
  replacement,
  onKeepChange,
  onReplacementUpload,
  onReplacementClear,
  onReplacementDrop,
}: {
  img: V1Image
  // null => Shared; string => named recipient; undefined =>
  // hide the label row entirely (first-cell-in-slot rule).
  nameLabel: string | null | undefined
  // 'front' | 'back' renders a side badge; null suppresses it
  // (one-sided projects).
  sideLabel: 'front' | 'back' | null
  // v1's approval for this card's slot. Drives the inline pill
  // above the thumbnail (amber for changes_requested; emerald
  // signal is on the card chrome itself).
  approval: ProofNameApproval | undefined
  v1VersionNumber: number
  keep: boolean
  replacement: { file: File; preview: string } | undefined
  onKeepChange: (v: boolean) => void
  onReplacementUpload: (file: File) => void
  onReplacementClear: () => void
  // Drop-target receiver — first file wins, bypasses the hidden
  // file input. Same end state as the Replace button path.
  onReplacementDrop: (files: File[]) => void
}) {
  const hasReplacement = !!replacement
  const showGhosted = !keep && !hasReplacement
  const displayLabel = img.original_filename ?? 'v1 image'
  const [dragOver, setDragOver] = useState(false)

  function handleReplaceInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    // Same checks as the page-level path (type + size), routed
    // through partitionFiles for consistency. The Replace button
    // is a single-file picker, so cap is unbounded. Silent bail
    // on rejection matches the prior behaviour (CarryCard has no
    // fileError surface of its own).
    const partition = partitionFiles([file], Number.POSITIVE_INFINITY)
    if (partition.ok.length === 0) {
      e.target.value = ''
      return
    }
    onReplacementUpload(partition.ok[0])
    // Clear the native input so picking the same file again
    // later still triggers change.
    e.target.value = ''
  }

  // Toggle on = effectively Keep=true AND no replacement. Replacement
  // overrides the toggle visually + functionally.
  const effectiveKeepOn = keep && !hasReplacement

  // Chrome precedence:
  //   1. Replacement queued  → amber (action committed, approval
  //      being discarded on save — action state wins)
  //   2. Otherwise if approved → emerald (approval base, at rest)
  //   3. Otherwise            → neutral gray
  // Emerald only shows at rest. Amber replacement-state overrides
  // it, keeping the "action committed" signal consistent with how
  // the Open section already uses amber on changes_requested pills.
  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      setDragOver(true)
    }
  }
  function handleDragLeave() { setDragOver(false) }
  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    // Stop the native event from bubbling to window, where the
    // useImageFileDrop hook's drop listener would otherwise also
    // pick it up and route the file through addFilesBatch in
    // addition to the replacement queue. React's synthetic
    // stopPropagation stops the React tree only; we need the
    // native one to break out of bubble-to-window.
    e.nativeEvent.stopPropagation()
    setDragOver(false)
    onReplacementDrop(Array.from(e.dataTransfer.files))
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={[
        'rounded-xl p-2.5 transition-all',
        hasReplacement
          ? 'bg-amber-50 ring-1 ring-amber-200'
          : approval?.state === 'approved'
            ? 'bg-emerald-50 ring-1 ring-emerald-200'
            : 'bg-gray-50 ring-1 ring-gray-200',
        dragOver ? 'ring-2 ring-indigo-400 ring-offset-1' : '',
      ].join(' ')}
    >
      {/* Label row — sits above the thumbnail. Shared cards get
          a muted pill; named cards show the name as plain text.
          The changes_requested pill sits inline on Open-section
          amber cards; the previous "approved" pill is gone since
          the emerald card chrome carries that signal now, and
          dropping it frees horizontal room before the name label
          truncates.
          nameLabel === undefined hides the entire row for repeat
          cells in the same slot (first-cell-in-slot label rule). */}
      {(nameLabel !== undefined || sideLabel != null) && (
        <div
          className={[
            'mb-2 flex items-center gap-2 transition-opacity',
            showGhosted ? 'opacity-40' : '',
          ].join(' ')}
        >
          {nameLabel !== undefined && (
            nameLabel == null ? (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                Shared
              </span>
            ) : (
              <span
                className="truncate text-sm font-medium text-gray-700"
                title={nameLabel}
              >
                {nameLabel}
              </span>
            )
          )}
          {sideLabel != null && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
              {sideLabel === 'front' ? 'Front' : 'Back'}
            </span>
          )}
          {approval?.state === 'changes_requested' && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
              v{v1VersionNumber} changes requested
            </span>
          )}
        </div>
      )}
      <img
        src={replacement?.preview ?? img.preview}
        alt={displayLabel}
        className={[
          'h-32 w-full rounded-lg object-cover transition-opacity',
          showGhosted ? 'opacity-40' : '',
        ].join(' ')}
      />
      <p
        className={[
          'mt-2 truncate text-xs font-normal',
          hasReplacement ? 'text-gray-500' : 'text-gray-400',
        ].join(' ')}
        title={displayLabel}
      >
        {displayLabel}
      </p>
      {hasReplacement && (
        <div className="mt-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-amber-700">
            Replacing with
          </p>
          <p
            className="truncate text-xs text-amber-800"
            title={replacement!.file.name}
          >
            {replacement!.file.name}
          </p>
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        {/* Keep toggle (switch). Disabled while a replacement is
            queued, since the toggle is irrelevant until Undo. */}
        <button
          type="button"
          role="switch"
          aria-checked={effectiveKeepOn}
          aria-label="Keep"
          disabled={hasReplacement}
          onClick={() => onKeepChange(!keep)}
          className={[
            'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
            effectiveKeepOn ? 'bg-gray-900' : 'bg-gray-300',
            hasReplacement ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
              effectiveKeepOn ? 'translate-x-[1.125rem] translate-y-0.5' : 'translate-x-0.5 translate-y-0.5',
            ].join(' ')}
          />
        </button>
        {hasReplacement ? (
          <button
            type="button"
            onClick={onReplacementClear}
            className="shrink-0 text-xs font-medium text-amber-800 underline-offset-2 hover:text-amber-900 hover:underline"
          >
            Undo
          </button>
        ) : (
          <label
            className={[
              'shrink-0 cursor-pointer text-xs font-medium underline-offset-2 hover:underline',
              showGhosted ? 'text-gray-400 hover:text-gray-600' : 'text-gray-500 hover:text-gray-900',
            ].join(' ')}
          >
            Replace
            <input
              type="file"
              accept={ACCEPTED_TYPES.join(',')}
              onChange={handleReplaceInput}
              className="sr-only"
            />
          </label>
        )}
      </div>
    </div>
  )
}

// Fresh-image card — a user-uploaded file with no v1 parent. Lives
// in the same grid as CarryCards / EmptySlots. Doesn't carry a
// Keep toggle (nothing to carry), no approval pill (nothing to
// carry an approval from). associated_name is implicit from the
// slot the file was dropped into and is stored on the underlying
// ImageEntry in imagesByOption.
function FreshImageCard({
  entry,
  nameLabel,
  sideLabel,
  twoSided,
  onRemove,
  onFlipSide,
}: {
  entry: ImageEntry
  nameLabel: string | null | undefined
  sideLabel: 'front' | 'back' | null
  // Drives whether the Move-to-{other-side} affordance renders. On
  // one-sided projects every fresh entry is front by definition, so
  // there is nothing to flip to.
  twoSided: boolean
  onRemove: () => void
  // Single-click toggle of entry.side. The cell builder regroups
  // the card to its new slot on the next render.
  onFlipSide: () => void
}) {
  // Effective side for the flip-button copy. Pulls from entry rather
  // than sideLabel because sideLabel is null on one-sided projects
  // (the badge is suppressed) but entry.side is still meaningful.
  const currentSide: 'front' | 'back' = entry.side ?? 'front'
  const flipTargetLabel = currentSide === 'front' ? 'back' : 'front'
  return (
    <div className="rounded-xl bg-gray-50 p-2.5 ring-1 ring-gray-200 transition-all">
      {(nameLabel !== undefined || sideLabel != null) && (
        <div className="mb-2 flex items-center gap-2">
          {nameLabel !== undefined && (
            nameLabel == null ? (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                Shared
              </span>
            ) : (
              <span
                className="truncate text-sm font-medium text-gray-700"
                title={nameLabel}
              >
                {nameLabel}
              </span>
            )
          )}
          {sideLabel != null && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
              {sideLabel === 'front' ? 'Front' : 'Back'}
            </span>
          )}
        </div>
      )}
      <img
        src={entry.preview}
        alt={entry.file.name}
        className="h-32 w-full rounded-lg object-cover"
      />
      <p className="mt-2 truncate text-xs text-gray-400" title={entry.file.name}>
        {entry.file.name}
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        {twoSided ? (
          <button
            type="button"
            onClick={onFlipSide}
            className="shrink-0 text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
            aria-label={`Move to ${flipTargetLabel}`}
          >
            Move to {flipTargetLabel}
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
        >
          Remove
        </button>
      </div>
    </div>
  )
}

// Empty drop zone — same footprint as a CarryCard, dashed muted
// border, click or drop to upload into this slot's coordinate.
// associated_name gets stamped on the uploaded ImageEntry from
// the slot, so no per-image dropdown is needed anywhere else.
// Multi-file drops are accepted; the slot's cell turns into one
// or more FreshImageCards in the same slot grouping, stacked by
// the main grid's sort.
function EmptySlot({
  nameLabel,
  sideLabel,
  onFiles,
}: {
  nameLabel: string | null | undefined
  sideLabel: 'front' | 'back' | null
  onFiles: (files: File[]) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      setDragOver(true)
    }
  }
  function handleDragLeave() { setDragOver(false) }
  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    // Stop bubble to window so the useImageFileDrop hook's drop
    // listener does not also fire and double-route the file
    // through addFilesBatch. See CarryCard.handleDrop for the
    // full reasoning.
    e.nativeEvent.stopPropagation()
    setDragOver(false)
    onFiles(Array.from(e.dataTransfer.files))
  }
  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    onFiles(Array.from(e.target.files ?? []))
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={[
        'flex cursor-pointer flex-col rounded-xl border-2 border-dashed p-2.5 transition-all',
        dragOver
          ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-400 ring-offset-1'
          : 'border-gray-200 bg-gray-50/50 hover:border-gray-300 hover:bg-gray-50',
      ].join(' ')}
    >
      {(nameLabel !== undefined || sideLabel != null) && (
        <div className="mb-2 flex items-center gap-2">
          {nameLabel !== undefined && (
            nameLabel == null ? (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                Shared
              </span>
            ) : (
              <span
                className="truncate text-sm font-medium text-gray-700"
                title={nameLabel}
              >
                {nameLabel}
              </span>
            )
          )}
          {sideLabel != null && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
              {sideLabel === 'front' ? 'Front' : 'Back'}
            </span>
          )}
        </div>
      )}
      <div
        className={[
          'flex h-32 w-full items-center justify-center rounded-lg text-center text-xs',
          dragOver ? 'text-indigo-700' : 'text-gray-400',
        ].join(' ')}
      >
        {dragOver ? 'Drop to add' : 'Drop image here or click to upload'}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        multiple
        onChange={handleInputChange}
        className="sr-only"
      />
    </div>
  )
}
