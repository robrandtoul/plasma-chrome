import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { useImageFileDrop } from '../lib/useImageFileDrop'
import { pluralLabel } from '../lib/labels'
import { DEFAULT_DISPLAY_QUANTITIES } from '../lib/constants'
import { PricingDisplay } from '../components/PricingDisplay'
import { PricingDisplayField, type PricingDisplayValue } from '../components/PricingDisplayField'
import { CurrencyField } from '../components/CurrencyField'
import { DesignerChrome } from '../design'
import { PageDropOverlay } from '../components/PageDropOverlay'
import NameChipInput from '../components/NameChipInput'
import { matchImageToName } from '../lib/matchImageToName'
import { safeRemoveImagePaths } from '../lib/imageStorage'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import { VariantDropZone } from '../components/VariantDropZone'
import type { Currency, LetterpressCoreColour, PricingSnapshot } from '../lib/types'
import { usePersonalisationPricing } from '../lib/quote/usePersonalisationPricing'
import { CoreColourSwatch } from '../components/CoreColourSwatch'
import { QrCodeUploadSection, type QrEntry } from '../components/QrCodeUploadSection'
import type { QrKind } from '../lib/qrCodes'
import { LAYER_COLOUR_MATERIAL_CODES } from '../lib/letterpress'
import VersionPreviewGate from '../components/VersionPreviewGate'
import MessageSendPanel from '../components/MessageSendPanel'
import { firstName } from '../lib/firstName'
import { customerProofPath } from '../lib/customerProofUrl'

// Materials whose physical edge construction exposes the three-
// layer Colorplan stack (un-gilded letterpress) and therefore want
// the front + core + back colour pickers. Mirrored from
// NewVersionPage so the two stay in lockstep — if the catalogue
// ever adds another un-gilded letterpress SKU, update both.

// ── Types ──────────────────────────────────────────────────────────────────────

type EditImage =
  | { kind: 'existing'; id: string; image_path: string; preview: string; material_option: string | null; original_filename: string | null; associated_name: string | null; side: 'front' | 'back' | null }
  | { kind: 'new';      localId: string; file: File; preview: string; associated_name: string | null; side: 'front' | 'back' | null }

// Stable identifier for an EditImage regardless of variant. Used
// by the soft-remove + Undo path (lastRemovedRef equality check)
// and by removeImage's find loop. Keeps the discriminated-union
// branching out of those call sites.
const entryId = (e: EditImage): string =>
  e.kind === 'existing' ? e.id : e.localId

// Toast variant carrying optional Undo affordance. Used by both
// the existing validation-fail flow (rose pill, no action) and
// the soft-delete-with-Undo flow on Remove (slate pill with
// inline Undo button). Both auto-dismiss at 5s; the undo path's
// timer also commits the removal (revokes blob URL on kind:'new'
// entries; existing entries have signed URLs, no revoke needed).
type Toast =
  | { kind: 'validation'; text: string }
  | { kind: 'undo'; text: string; onUndo: () => void }

interface MaterialOption {
  id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg']
const MAX_IMAGES = 12

// ── Component ──────────────────────────────────────────────────────────────────

export default function EditVersionPage() {
  const { id: proofId, versionId } = useParams<{ id: string; versionId: string }>()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [proofName, setProofName] = useState('')
  const [proofCompany, setProofCompany] = useState('')
  const [versionNumber, setVersionNumber] = useState(0)
  // Linked Help Scout conversation id, populated by loadAll. Null
  // means the proof was never linked to a HS thread; the post-
  // preview MessageSendPanel reads this flag to decide between
  // rendering the editor or the no-conversation continue-only
  // path. Mirrors the same field on NewVersionPage.
  const [proofHelpScoutConversationId, setProofHelpScoutConversationId] =
    useState<string | null>(null)
  // Preview gate state. After a successful save, render
  // VersionPreviewGate; when the designer clicks "Looks good"
  // the gate flips to MessageSendPanel (same as NewVersionPage)
  // so they can send the customer a Help Scout reply with the
  // proof URL. "Go back and edit" clears this so the form re-
  // appears with state intact for further editing. Both flags
  // are ephemeral, no DB.
  const [savedVersionForPreview, setSavedVersionForPreview] = useState<{ currency: Currency | null } | null>(null)
  const [previewApproved, setPreviewApproved] = useState(false)
  // ── Variant rounds (build-plan step 5.5) ────────────────────────────────
  // EditVersionPage doesn't yet support editing variant-round versions.
  // When a variant-round version is loaded, the form renders an alert
  // banner and disables every input + the save button so accidental
  // tweaks can't reach the database. Standard versions render
  // unchanged.
  const [isVariantRound, setIsVariantRound] = useState(false)
  // Lock detection (build-plan item 4). A variant round is "locked"
  // once any customer has submitted a Choose-this-direction selection
  // — that lands as a proof_name_approvals row with name='__shared__'
  // for the version. Pre-lock variant rounds get the new edit form
  // below; post-lock variant rounds keep the disabled-banner UX.
  const [isLocked, setIsLocked] = useState(false)
  // Per-variant edit state. Populated on load when isVariantRound is
  // true. Each side carries existingImages (DB rows already on the
  // version), removedExistingIds (which of those got soft-removed in
  // this session — diffed against the DB on save), and newFiles
  // (queued uploads). backFiles===null on a variant means no Back
  // side; an empty arrays state ([], removedIds=[]) means a Back
  // section was just toggled on but nothing's queued yet.
  type ExistingVariantImage = {
    id: string
    imagePath: string
    signedUrl: string
    originalFilename: string | null
  }
  type VariantEditSide = {
    existingImages: ExistingVariantImage[]
    removedExistingIds: string[]
    newFiles: File[]
  }
  type VariantEditRow = {
    id: string
    code: string
    display_name: string
    originalDisplayName: string
    front: VariantEditSide
    back: VariantEditSide | null
  }
  const [variantEditRows, setVariantEditRows] = useState<VariantEditRow[]>([])
  const [materialDisplay, setMaterialDisplay] = useState('')
  // Two ink states: one for the comma-separated optional UI, one for the
  // per-ink mandatory UI. Only the one matching the loaded material's
  // requires_ink_names flag is populated on mount.
  const [inkNamesText, setInkNamesText] = useState('')
  const [inkNamesArray, setInkNamesArray] = useState<string[]>([])
  const [requiresInkNames, setRequiresInkNames] = useState(false)
  const [optionLabelSingular, setOptionLabelSingular] = useState('Finish')
  const [currency, setCurrency] = useState<Currency>('GBP')
  const [names, setNames] = useState<string[]>([])
  const [changeNotes, setChangeNotes] = useState('')
  const [pricingDisplay, setPricingDisplay] = useState<PricingDisplayValue | null>(null)
  const [pricingSnapshot, setPricingSnapshot] = useState<PricingSnapshot | null>(null)
  // Personalisation flag and supporting material metadata (migration
  // 000172). Loaded from the version row + its joined material so the
  // gate (supports_personalisation && cardType === 'membership') can
  // render the same way the new-version form does. cardType isn't
  // editable from this page; it's read once at load and used only for
  // the gate.
  const [hasPersonalisation, setHasPersonalisation] = useState(false)
  const [materialSupportsPersonalisation, setMaterialSupportsPersonalisation] = useState(false)
  const [cardType, setCardType] = useState<'business' | 'membership'>('business')
  const [shippingNote, setShippingNote] = useState('')
  // Live per-currency rate + min charge for the personalisation
  // checkbox helper. Read live so an admin rate change propagates
  // to the designer-facing copy without a redeploy — see the
  // matching hook in NewVersionPage.
  const { pricing: personalisationLivePricing } = usePersonalisationPricing(currency)
  const [displayQuantities, setDisplayQuantities] = useState<number[]>(DEFAULT_DISPLAY_QUANTITIES)
  const [availableOptions, setAvailableOptions] = useState<MaterialOption[]>([])
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [editImagesByOption, setEditImagesByOption] = useState<Record<string, EditImage[]>>({ '': [] })
  const [activeImageOption, setActiveImageOption] = useState('')
  const [originalImageIds, setOriginalImageIds] = useState<Set<string>>(new Set())
  // Snapshot of each existing artwork image's associated_name at load
  // time. Used at save time to detect whether any kept artwork row's
  // slot assignment shifted — one of the three triggers for
  // invalidating qr_confirmed_at (alongside artwork add and remove).
  // A QR confirmation was given on top of the artwork visible to the
  // slot; any mutation to that surface means the prior tick is stale.
  const [originalArtworkAssocById, setOriginalArtworkAssocById] = useState<Record<string, string | null>>({})
  // Migration 000168. QR codes loaded into a separate bucket so the
  // artwork image-grid editor (editImagesByOption) doesn't have to
  // know about them. originalQrIds backs the "what got removed?"
  // diff at save time, same pattern as originalImageIds.
  const [qrEntries, setQrEntries] = useState<QrEntry[]>([])
  const [originalQrIds, setOriginalQrIds] = useState<Set<string>>(new Set())
  // Snapshot of each existing QR's associated_name at load time. Used
  // at save time to detect whether any kept QR's slot assignment
  // changed — which is the third trigger for invalidating
  // qr_confirmed_at on existing approvals (alongside add and remove).
  // Migration 000169's contract: customer ticks "QRs OK" for the
  // QR set visible to their slot; any mutation to that set means
  // the prior tick no longer covers the current state.
  const [originalQrAssocByEntryId, setOriginalQrAssocByEntryId] = useState<Record<string, string | null>>({})
  // Letterpress layer colours (migrations 000133 + 000135).
  // materialCode is the stable identifier the pickers key on; it
  // gates the block's visibility and the validation rules. Loaded
  // once from the version's joined material row in loadAll.
  // coreColours is the catalogue (RLS-filtered to active rows for
  // designers) — shared across all three pickers. The three
  // selectedXxxColourId fields mirror the version's three FK
  // columns: front_colour_id, core_colour_id, back_colour_id.
  const [materialCode, setMaterialCode] = useState<string>('')
  const [coreColours, setCoreColours] = useState<LetterpressCoreColour[]>([])
  const [selectedFrontColourId, setSelectedFrontColourId] = useState<string | null>(null)
  const [selectedCoreColourId, setSelectedCoreColourId] = useState<string | null>(null)
  const [selectedBackColourId, setSelectedBackColourId] = useState<string | null>(null)
  const [fileError, setFileError] = useState('')
  const [fileNote, setFileNote] = useState('')
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fileRef         = useRef<HTMLInputElement>(null)
  const dragIndexRef    = useRef<number | null>(null)
  const imageSectionRef = useRef<HTMLElement | null>(null)
  const materialRef     = useRef<HTMLInputElement>(null)
  const inkNamesRef     = useRef<HTMLDivElement>(null)
  const frontColourRef  = useRef<HTMLDivElement>(null)
  const coreColourRef   = useRef<HTMLDivElement>(null)
  const backColourRef   = useRef<HTMLDivElement>(null)
  const toastTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stash for undo-after-Remove. See NewVersionPage for the full
  // mechanic explainer; same shape adjusted for EditImage's
  // discriminated union. URL revocation only fires for kind:'new'
  // entries on commit; existing images carry signed URLs.
  const lastRemovedRef  = useRef<{
    entry: EditImage
    optionKey: string
    index: number
    timerId: ReturnType<typeof setTimeout>
  } | null>(null)

  useEffect(() => {
    if (!proofId || !versionId) return
    loadAll(proofId, versionId)
  }, [proofId, versionId])

  // Commit any pending soft-delete on unmount so the blob URL
  // doesn't leak across page navigations. See removeImage for
  // the soft-delete + 5s commit mechanic.
  useEffect(() => {
    return () => {
      commitPendingRemoval()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadAll(pid: string, vid: string) {
    const [proofResult, versionResult, imagesResult] = await Promise.all([
      supabase.from('proofs').select('helpscout_conversation_id, contacts(full_name, companies(name))').eq('id', pid).single(),
      supabase
        .from('proof_versions')
        .select('version_number, material_id, material_display, ink_names, currency, change_notes, pricing_snapshot, shipping_note, material_options, custom_quote, names, core_colour_id, front_colour_id, back_colour_id, is_variant_round, card_type, has_personalisation, materials(code, display_quantities, requires_ink_names, option_label, multi_variant, supports_personalisation)')
        .eq('id', vid)
        .single(),
      supabase
        .from('proof_version_images')
        .select('id, image_path, sort_order, material_option, original_filename, associated_name, side, round_variant_id, is_qr_code, qr_decoded_data, qr_kind, qr_vcard_slug')
        .eq('proof_version_id', vid)
        .order('sort_order'),
    ])

    if (versionResult.error || !versionResult.data) {
      navigate(`/proofs/${pid}`)
      return
    }

    const c = (proofResult.data?.contacts as any)
    if (c) {
      setProofName(c.full_name ?? '')
      setProofCompany(c.companies?.name ?? '')
    }
    // Stash the linked Help Scout conversation id (if any). Used
    // by the post-preview MessageSendPanel to switch between the
    // reply editor and the no-conversation continue-only path.
    const hsConvId = (proofResult.data as any)?.helpscout_conversation_id ?? null
    setProofHelpScoutConversationId(hsConvId)

    const v = versionResult.data as any
    setVersionNumber(v.version_number)
    setMaterialDisplay(v.material_display)
    setIsVariantRound(!!v.is_variant_round)
    const rawInkNames = (v.ink_names as string[]) ?? []
    const materialMeta = (v.materials as any) ?? {}
    const materialRequiresInkNames: boolean = !!materialMeta.requires_ink_names
    setRequiresInkNames(materialRequiresInkNames)
    setOptionLabelSingular(materialMeta.option_label ?? 'Finish')
    setMaterialCode(materialMeta.code ?? '')
    setMaterialSupportsPersonalisation(!!materialMeta.supports_personalisation)
    setCardType((v.card_type as 'business' | 'membership') ?? 'business')
    setHasPersonalisation(!!v.has_personalisation)
    setSelectedFrontColourId((v.front_colour_id as string | null) ?? null)
    setSelectedCoreColourId((v.core_colour_id as string | null) ?? null)
    setSelectedBackColourId((v.back_colour_id as string | null) ?? null)

    // Fetch the active layer-colour catalogue when this version is on
    // a material that wants the pickers. Shared across all three
    // (front/core/back) so one fetch is enough. Skipping otherwise
    // saves an unnecessary round trip on the much more common
    // non-letterpress edit path.
    if (LAYER_COLOUR_MATERIAL_CODES.has(materialMeta.code ?? '')) {
      void supabase
        .from('letterpress_core_colours')
        .select('id, name, hex_value, is_active, sort_order')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })
        .then(({ data }) => {
          setCoreColours((data ?? []) as LetterpressCoreColour[])
        })
    }
    if (materialRequiresInkNames) {
      setInkNamesArray(rawInkNames)
    } else {
      setInkNamesText(rawInkNames.join(', '))
    }
    setCurrency(v.currency as Currency)
    setNames(Array.isArray(v.names) ? (v.names as string[]) : [])
    setChangeNotes(v.change_notes ?? '')
    setPricingDisplay(v.custom_quote ? 'custom' : 'standard')
    setPricingSnapshot(v.pricing_snapshot as PricingSnapshot)
    setShippingNote(v.shipping_note)
    setDisplayQuantities(v.materials?.display_quantities ?? DEFAULT_DISPLAY_QUANTITIES)

    const versionOptions = (v.material_options as string[]) ?? []
    const materialId = v.material_id as string

    // Load available options for this material
    const { data: optionData } = await supabase
      .from('material_options')
      .select('id, code, display_name, is_base, sort_order')
      .eq('material_id', materialId)
      .order('sort_order')
    const options = (optionData ?? []) as MaterialOption[]
    setAvailableOptions(options)
    setSelectedOptions(versionOptions)
    setActiveImageOption(versionOptions[0] ?? '')

    type RawImageRow = {
      id: string
      image_path: string
      sort_order: number
      material_option: string | null
      original_filename: string | null
      associated_name: string | null
      side: 'front' | 'back' | null
      is_qr_code: boolean | null
      qr_decoded_data: string | null
      qr_kind: QrKind | null
      qr_vcard_slug: string | null
    }
    const allRawRows = (imagesResult.data ?? []) as RawImageRow[]
    // Migration 000168 — split QRs out of the artwork editor. The
    // existing image-grid pathway never sees is_qr_code=true rows;
    // they're handled by the QrCodeUploadSection below. originalQrIds
    // backs the deletion diff at save time.
    const rawImages = allRawRows.filter((img) => img.is_qr_code !== true)
    const rawQrRows = allRawRows.filter((img) => img.is_qr_code === true)
    const ids = new Set(rawImages.map((img) => img.id))
    setOriginalImageIds(ids)
    setOriginalArtworkAssocById(
      Object.fromEntries(rawImages.map((img) => [img.id, img.associated_name])),
    )
    setOriginalQrIds(new Set(rawQrRows.map((img) => img.id)))
    setOriginalQrAssocByEntryId(
      Object.fromEntries(rawQrRows.map((img) => [img.id, img.associated_name])),
    )

    const withPreviews = await Promise.all(
      rawImages.map(async (img) => {
        const { data } = await supabase.storage
          .from('proof-images')
          .createSignedUrl(img.image_path, 3600)
        return {
          kind: 'existing' as const,
          id: img.id,
          image_path: img.image_path,
          material_option: img.material_option,
          original_filename: img.original_filename,
          associated_name: img.associated_name,
          side: img.side,
          preview: data?.signedUrl ?? '',
        }
      })
    )

    // Seed QR entries from the saved rows. Each entry rides as
    // source='existing' with the row id baked in so the save diff
    // can compute removals; the file/decoded data live on the row
    // itself, no decode round-trip required at load time.
    const qrEntriesFromDb = await Promise.all(
      rawQrRows.map(async (img) => {
        const { data } = await supabase.storage
          .from('proof-images')
          .createSignedUrl(img.image_path, 3600)
        return {
          id: img.id,
          source: 'existing' as const,
          imagePath: img.image_path,
          signedUrl: data?.signedUrl ?? '',
          decodedData: img.qr_decoded_data ?? '',
          kind: (img.qr_kind ?? 'text') as QrKind,
          associatedName: img.associated_name,
          originalFilename: img.original_filename,
          // Migration 000192: the editor doesn't currently let
          // designers re-link the slug after save, but carrying it
          // through here keeps the customer page's live-fetch path
          // working when this version is the one being viewed.
          vcardSlug: img.qr_vcard_slug ?? undefined,
        }
      }),
    )
    setQrEntries(qrEntriesFromDb)

    // Group images by option key
    const ibf: Record<string, EditImage[]> = {}
    for (const img of withPreviews) {
      let key: string
      if (versionOptions.length === 0) {
        key = ''
      } else {
        // Images with null material_option belong to the base option (migrated data)
        key = img.material_option ?? (options.find(o => o.is_base)?.code ?? versionOptions[0])
      }
      if (!ibf[key]) ibf[key] = []
      ibf[key].push(img)
    }
    // Ensure all selectedOptions have entries (some may have no images yet)
    for (const code of versionOptions) {
      if (!ibf[code]) ibf[code] = []
    }
    if (versionOptions.length === 0 && !ibf['']) ibf[''] = []
    setEditImagesByOption(ibf)

    // ── Variant-round edit-state load (build-plan item 4) ─────────────
    // Branch off the standard path: when this version is a variant
    // round, load proof_round_variants + the lock probe so the
    // pre-lock edit form has everything it needs to render. Existing
    // images get signed URLs for the thumbnail strip; new uploads use
    // VariantDropZone's own blob-URL lifecycle.
    if (v.is_variant_round) {
      const [variantsResult, lockResult] = await Promise.all([
        supabase
          .from('proof_round_variants')
          .select('id, code, display_name, sort_order')
          .eq('proof_version_id', vid)
          .order('sort_order'),
        supabase
          .from('proof_name_approvals')
          .select('id')
          .eq('proof_version_id', vid)
          .eq('name', SHARED_APPROVAL_KEY)
          .limit(1),
      ])

      const locked = (lockResult.data ?? []).length > 0
      setIsLocked(locked)

      const variants = (variantsResult.data ?? []) as Array<{
        id: string
        code: string
        display_name: string
        sort_order: number
      }>

      // Sign URLs for every existing variant image up front so the
      // edit form can render thumbnails without a per-tile signing
      // round-trip. URL TTL matches what the customer-page edge
      // function uses; the edit page is short-lived enough that an
      // hour is plenty.
      const allImages = (imagesResult.data ?? []) as Array<{
        id: string
        image_path: string
        original_filename: string | null
        side: 'front' | 'back' | null
        round_variant_id: string | null
      }>
      const variantImages = allImages.filter((img) => img.round_variant_id)
      const signedById = new Map<string, string>()
      await Promise.all(
        variantImages.map(async (img) => {
          const { data } = await supabase.storage
            .from('proof-images')
            .createSignedUrl(img.image_path, 3600)
          if (data?.signedUrl) signedById.set(img.id, data.signedUrl)
        }),
      )

      const rows: VariantEditRow[] = variants.map((variant) => {
        const variantImgs = variantImages.filter(
          (img) => img.round_variant_id === variant.id,
        )
        const front = variantImgs.filter((img) => img.side === 'front' || img.side == null)
        const back = variantImgs.filter((img) => img.side === 'back')
        return {
          id: variant.id,
          code: variant.code,
          display_name: variant.display_name,
          originalDisplayName: variant.display_name,
          front: {
            existingImages: front.map((img) => ({
              id: img.id,
              imagePath: img.image_path,
              signedUrl: signedById.get(img.id) ?? '',
              originalFilename: img.original_filename,
            })),
            removedExistingIds: [],
            newFiles: [],
          },
          back: back.length > 0
            ? {
                existingImages: back.map((img) => ({
                  id: img.id,
                  imagePath: img.image_path,
                  signedUrl: signedById.get(img.id) ?? '',
                  originalFilename: img.original_filename,
                })),
                removedExistingIds: [],
                newFiles: [],
              }
            : null,
        }
      })
      setVariantEditRows(rows)
    }

    setLoading(false)
  }

  // Derived
  const hasOptions   = availableOptions.length > 0
  const optionMode   = hasOptions && selectedOptions.length > 0
  const optionLabelPlural = pluralLabel(optionLabelSingular)
  const activeKey     = optionMode ? activeImageOption : ''
  const currentImages = editImagesByOption[activeKey] ?? []
  const isCustomQuote = pricingDisplay === 'custom'

  // The saved snapshot carries no per-tier prices when every variant's
  // prices map is empty (the shape a 5+ ink version has, and what any
  // historical custom-quote version produces). In that case the
  // designer MUST NOT be allowed to flip the Pricing display radio
  // from Custom back to Standard — saving would produce a version
  // marked as standard-priced with an empty grid on the customer
  // page. Since EditVersionPage doesn't allow variant changes, the
  // radio toggle is the only path to that bad state, so gating the
  // radio at the source is sufficient without a save-time guard.
  //
  // Defensive default: treat a missing / malformed pricing_snapshot
  // as "no prices available" and disable.
  const snapshotHasNoPrices = (() => {
    if (!pricingSnapshot || !Array.isArray(pricingSnapshot.variants) || pricingSnapshot.variants.length === 0) {
      return true
    }
    return pricingSnapshot.variants.every((v) => {
      const prices = v?.prices ?? {}
      return Object.keys(prices).length === 0
    })
  })()

  // Edit doesn't allow variant changes, so ink-field count defaults to what
  // was saved (min 1 so a version somehow created with no names can be fixed).
  const editInkCount = requiresInkNames ? Math.max(inkNamesArray.length, 1) : 0

  const inkNameValidities = requiresInkNames && editInkCount > 0
    ? Array.from({ length: editInkCount }, (_, i) => (inkNamesArray[i] ?? '').trim() !== '')
    : []

  const imagesFinishKeys = optionMode ? selectedOptions : ['']
  // Letterpress layer colours gate (migrations 000133 + 000135).
  // EditVersionPage doesn't allow material swaps, so
  // requiresLayerColours resolves to a stable value once loadAll runs.
  const requiresLayerColours = LAYER_COLOUR_MATERIAL_CODES.has(materialCode)
  const validations = {
    images:      imagesFinishKeys.every(fk => (editImagesByOption[fk] ?? []).length > 0),
    material:    materialDisplay.trim() !== '',
    inkNames:    !requiresInkNames || (editInkCount > 0 && inkNameValidities.every(Boolean)),
    frontColour: !requiresLayerColours || selectedFrontColourId !== null,
    coreColour:  !requiresLayerColours || selectedCoreColourId !== null,
    backColour:  !requiresLayerColours || selectedBackColourId !== null,
  } as const
  const isValid = Object.values(validations).every(Boolean)
  const shouldHighlight = (k: keyof typeof validations) => submitAttempted && !validations[k]

  const invalidOptionKey = !validations.images
    ? imagesFinishKeys.find(fk => (editImagesByOption[fk] ?? []).length === 0)
    : undefined
  const imagesHint = invalidOptionKey !== undefined && invalidOptionKey !== ''
    ? `At least one image required for ${availableOptions.find(f => f.code === invalidOptionKey)?.display_name ?? invalidOptionKey}.`
    : 'At least one proof image required.'

  function toggleOption(code: string) {
    setSelectedOptions(prev => {
      if (prev.includes(code)) {
        // Deselecting — revoke new image previews and remove from map
        setEditImagesByOption(ibf => {
          const imgs = ibf[code] ?? []
          imgs.forEach(img => { if (img.kind === 'new') URL.revokeObjectURL(img.preview) })
          const { [code]: _removed, ...rest } = ibf
          return rest
        })
        const next = prev.filter(c => c !== code)
        if (activeImageOption === code) setActiveImageOption(next[0] ?? '')
        return next
      } else {
        // Selecting — if entering finish mode for first time, migrate '' images
        setEditImagesByOption(ibf => {
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

  function addFiles(files: File[]) {
    setFileError('')
    setFileNote('')
    if (files.length === 0) return

    const okByType = files.filter(f => ACCEPTED_TYPES.includes(f.type))
    const rejectedByType = files.length - okByType.length
    if (okByType.length === 0) {
      setFileError('Only image files can be added.')
      return
    }

    const okBySize = okByType.filter(f => f.size <= MAX_FILE_SIZE)
    const rejectedBySize = okByType.length - okBySize.length
    if (okBySize.length === 0) {
      setFileError('Each image must be 10 MB or smaller.')
      return
    }

    const remaining = MAX_IMAGES - currentImages.length
    if (remaining <= 0) {
      setFileNote(`Can't add more — ${MAX_IMAGES}-image limit reached.`)
      return
    }

    const toAdd = okBySize.slice(0, remaining)
    const rejectedByLimit = okBySize.length - toAdd.length

    const notes: string[] = []
    if (rejectedByLimit > 0) {
      notes.push(`Added ${toAdd.length}. ${rejectedByLimit} skipped (${MAX_IMAGES}-image limit reached).`)
    }
    if (rejectedByType > 0 || rejectedBySize > 0) {
      const reasons: string[] = []
      if (rejectedByType > 0) reasons.push(`${rejectedByType} non-image`)
      if (rejectedBySize > 0) reasons.push(`${rejectedBySize} over 10 MB`)
      notes.push(`Ignored: ${reasons.join(', ')}.`)
    }
    if (notes.length > 0) setFileNote(notes.join(' '))

    setEditImagesByOption(prev => {
      const cur = prev[activeKey] ?? []
      return {
        ...prev,
        [activeKey]: [
          ...cur,
          ...toAdd.map((file) => {
            const match = matchImageToName(file.name, names)
            return {
              kind: 'new' as const,
              localId: uuidv4(),
              file,
              preview: URL.createObjectURL(file),
              associated_name: match.associatedName,
              side: match.side,
            }
          }),
        ],
      }
    })
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []))
    if (fileRef.current) fileRef.current.value = ''
  }

  const { isZoneDragOver, isPageDragOver, zoneProps } = useImageFileDrop({ onFiles: addFiles })

  // Soft remove with a 5s undo window (test-report finding (h)).
  // Mirrors NewVersionPage.removeImage; see that explainer for
  // the full mechanic. Differences here:
  //   - EditImage is a discriminated union (existing | new); the
  //     entryId helper lifts the variant branching out of every
  //     id-equality call site.
  //   - URL revocation only applies to kind:'new' entries; existing
  //     images carry signed URLs from Supabase storage and don't
  //     need a revoke.
  //   - DB deletion for kind:'existing' is still deferred to Save
  //     time via the existing diff-against-original logic. Soft
  //     removal here is purely a local-state operation; if the user
  //     undoes within 5s the entry is back in state and the diff
  //     correctly issues no DB delete.
  function removeImage(key: string) {
    const list = editImagesByOption[activeKey] ?? []
    let foundEntry: EditImage | null = null
    let foundIndex = -1
    for (let i = 0; i < list.length; i++) {
      if (entryId(list[i]) === key) {
        foundEntry = list[i]
        foundIndex = i
        break
      }
    }
    if (!foundEntry) return

    commitPendingRemoval()

    setEditImagesByOption((prev) => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).filter((img) => entryId(img) !== key),
    }))

    const entry = foundEntry
    const targetId = entryId(entry)
    const timerId = setTimeout(() => {
      if (entry.kind === 'new') URL.revokeObjectURL(entry.preview)
      const stash = lastRemovedRef.current
      if (stash && entryId(stash.entry) === targetId) {
        lastRemovedRef.current = null
      }
      setToast((curr) => (curr?.kind === 'undo' ? null : curr))
    }, 5000)

    lastRemovedRef.current = { entry, optionKey: activeKey, index: foundIndex, timerId }
    setToast({ kind: 'undo', text: 'Image removed', onUndo: undoRemove })
  }

  function undoRemove() {
    const stash = lastRemovedRef.current
    if (!stash) return
    clearTimeout(stash.timerId)
    setEditImagesByOption((prev) => {
      const list = [...(prev[stash.optionKey] ?? [])]
      list.splice(stash.index, 0, stash.entry)
      return { ...prev, [stash.optionKey]: list }
    })
    lastRemovedRef.current = null
    setToast(null)
  }

  function commitPendingRemoval() {
    const stash = lastRemovedRef.current
    if (!stash) return
    clearTimeout(stash.timerId)
    if (stash.entry.kind === 'new') URL.revokeObjectURL(stash.entry.preview)
    lastRemovedRef.current = null
  }

  function updateAssociatedName(key: string, associated_name: string | null) {
    setEditImagesByOption(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).map(img => {
        if (img.kind === 'existing' && img.id === key) return { ...img, associated_name }
        if (img.kind === 'new' && img.localId === key) return { ...img, associated_name }
        return img
      }),
    }))
  }

  function updateSide(key: string, side: 'front' | 'back' | null) {
    setEditImagesByOption(prev => ({
      ...prev,
      [activeKey]: (prev[activeKey] ?? []).map(img => {
        if (img.kind === 'existing' && img.id === key) return { ...img, side }
        if (img.kind === 'new' && img.localId === key) return { ...img, side }
        return img
      }),
    }))
  }

  // Chip removal reconciliation. Any image whose associated_name
  // matches a removed chip has its association cleared to null
  // (= shared) so the customer page's grouped rendering doesn't
  // hold a heading for a name that no longer exists. Pure state
  // change; the DB update rides along with the normal Save path
  // which already writes associated_name on both existing-update
  // and new-insert branches.
  function handleNamesChange(next: string[]) {
    const removed = names.filter((n) => !next.includes(n))
    if (removed.length > 0) {
      setEditImagesByOption((prev) => {
        const out: Record<string, EditImage[]> = {}
        for (const [key, list] of Object.entries(prev)) {
          out[key] = list.map((img) =>
            img.associated_name != null && removed.includes(img.associated_name)
              ? { ...img, associated_name: null }
              : img,
          )
        }
        return out
      })
    }
    setNames(next)
  }

  function handleDragStart(index: number) { dragIndexRef.current = index }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    const from = dragIndexRef.current
    if (from === null || from === index) return
    setEditImagesByOption(prev => {
      const cur = [...(prev[activeKey] ?? [])]
      const [item] = cur.splice(from, 1)
      cur.splice(index, 0, item)
      return { ...prev, [activeKey]: cur }
    })
    dragIndexRef.current = index
  }

  function handleDragEnd() { dragIndexRef.current = null }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setSubmitAttempted(true)

    // Locked variant rounds short-circuit even if a programmatic
    // form.requestSubmit() reaches us — the save button is disabled
    // and the form itself doesn't render in this state, but defence
    // in depth.
    if (isVariantRound && isLocked) {
      setError("This variant round has been locked by the customer's selection. Create a new version instead.")
      return
    }

    // ── Variant-round edit save (build-plan item 4) ──────────────────
    // Pre-lock variant-round versions take a separate save path that
    // diffs the loaded state against the editor and applies surgical
    // UPDATE / DELETE / INSERT statements. Mode flips (Single ↔
    // Mixed, Standard ↔ Variant) are forbidden — neither toggle
    // renders in the variant edit form, but the explicit guard here
    // catches any future drift.
    if (isVariantRound && !isLocked) {
      // Validate every variant: non-empty display_name, ≥1 front
      // image (existing kept + new), ≥1 back image when back side
      // is enabled.
      const labelOK = variantEditRows.every(
        (r) => r.display_name.trim().length > 0,
      )
      const imagesOK = variantEditRows.every((r) => {
        const frontKept = r.front.existingImages.filter(
          (img) => !r.front.removedExistingIds.includes(img.id),
        ).length
        const frontCount = frontKept + r.front.newFiles.length
        if (frontCount === 0) return false
        if (!r.back) return true
        const backKept = r.back.existingImages.filter(
          (img) => !r.back!.removedExistingIds.includes(img.id),
        ).length
        const backCount = backKept + r.back.newFiles.length
        return backCount > 0
      })
      if (!labelOK || !imagesOK) {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
        setToast({ kind: 'validation', text: 'Please complete all required fields to save' })
        toastTimerRef.current = setTimeout(
          () => setToast((curr) => (curr?.kind === 'validation' ? null : curr)),
          5000,
        )
        return
      }

      setSubmitting(true)

      // 1. Renames. Only fire UPDATE when the trimmed display_name
      //    actually changed; everything else on proof_round_variants
      //    (code, sort_order) is write-once / not-supported in this
      //    edit form.
      for (const row of variantEditRows) {
        const trimmed = row.display_name.trim()
        if (trimmed === row.originalDisplayName) continue
        const { error: renameErr } = await supabase
          .from('proof_round_variants')
          .update({ display_name: trimmed })
          .eq('id', row.id)
        if (renameErr) {
          setError(`Failed to rename variant: ${renameErr.message}`)
          setSubmitting(false)
          return
        }
      }

      // 2. Per-variant per-side image diffs. Collect the deletes and
      //    the new uploads up front; run them in parallel where
      //    possible to keep the round-trip count low.
      const idsToDelete: string[] = []
      const pathsToDelete: string[] = []
      type NewUpload = {
        file: File
        path: string
        variantId: string
        side: 'front' | 'back'
      }
      const newUploads: NewUpload[] = []
      for (const row of variantEditRows) {
        // Front
        for (const img of row.front.existingImages) {
          if (row.front.removedExistingIds.includes(img.id)) {
            idsToDelete.push(img.id)
            pathsToDelete.push(img.imagePath)
          }
        }
        for (const file of row.front.newFiles) {
          newUploads.push({
            file,
            path: `${proofId}/${uuidv4()}.jpg`,
            variantId: row.id,
            side: 'front',
          })
        }
        // Back: when the designer toggled the back side off, every
        // existing back image is implicitly deleted (the back state
        // is null in that case so the loop below handles only the
        // not-yet-toggled-off rows).
        if (row.back) {
          for (const img of row.back.existingImages) {
            if (row.back.removedExistingIds.includes(img.id)) {
              idsToDelete.push(img.id)
              pathsToDelete.push(img.imagePath)
            }
          }
          for (const file of row.back.newFiles) {
            newUploads.push({
              file,
              path: `${proofId}/${uuidv4()}.jpg`,
              variantId: row.id,
              side: 'back',
            })
          }
        }
      }
      // Back-toggle-off discovery: rows where back was loaded with
      // images but is now null. Those existing rows get fully deleted.
      // We carry the originals in a parallel snapshot via the row's
      // original load — recompute by reading the originals from the
      // variantEditRows collection BEFORE the toggle. Since we
      // didn't snapshot pre-toggle state separately, the only way to
      // detect this is to re-query at save time. For now we fall back
      // to the simpler invariant: when back is null, the toggle
      // handler set existingImages to [] alongside, so the diff loop
      // above already misses nothing of interest. The handler that
      // toggles backFiles to null in NewVersionPage's pattern would
      // need explicit tracking if we later want full delete-on-
      // toggle-off semantics — for v1 the toggle-off path needs a
      // delete pass, which we add by re-reading the version's back
      // images before save.
      const { data: latestVariantImgs } = await supabase
        .from('proof_version_images')
        .select('id, image_path, side, round_variant_id')
        .eq('proof_version_id', versionId)
      const latestByVariantSide = new Map<string, { id: string; image_path: string }[]>()
      for (const img of (latestVariantImgs ?? []) as Array<{
        id: string
        image_path: string
        side: 'front' | 'back' | null
        round_variant_id: string | null
      }>) {
        if (!img.round_variant_id) continue
        const k = `${img.round_variant_id}|${img.side ?? 'front'}`
        const list = latestByVariantSide.get(k) ?? []
        list.push({ id: img.id, image_path: img.image_path })
        latestByVariantSide.set(k, list)
      }
      for (const row of variantEditRows) {
        if (row.back !== null) continue
        const k = `${row.id}|back`
        const orphaned = latestByVariantSide.get(k) ?? []
        for (const img of orphaned) {
          if (idsToDelete.includes(img.id)) continue
          idsToDelete.push(img.id)
          pathsToDelete.push(img.image_path)
        }
      }

      // 3. Delete removed existing rows + their storage paths.
      //    safeRemoveImagePaths matches the standard edit's storage
      //    convention — best-effort, doesn't block on a single failure.
      if (idsToDelete.length > 0) {
        const { error: delErr } = await supabase
          .from('proof_version_images')
          .delete()
          .in('id', idsToDelete)
        if (delErr) {
          setError(`Failed to delete images: ${delErr.message}`)
          setSubmitting(false)
          return
        }
        await safeRemoveImagePaths(pathsToDelete)
      }

      // 4. Upload new files in parallel + insert their rows.
      if (newUploads.length > 0) {
        const uploadResults = await Promise.all(
          newUploads.map(async (u) => {
            const { error: upErr } = await supabase.storage
              .from('proof-images')
              .upload(u.path, u.file, {
                contentType: u.file.type,
                upsert: false,
              })
            return { ...u, error: upErr }
          }),
        )
        const failedUpload = uploadResults.find((r) => r.error)
        if (failedUpload) {
          const successPaths = uploadResults.filter((r) => !r.error).map((r) => r.path)
          if (successPaths.length > 0) {
            await safeRemoveImagePaths(successPaths)
          }
          setError(`Image upload failed: ${failedUpload.error!.message}`)
          setSubmitting(false)
          return
        }
        const inserts = uploadResults.map((u, i) => ({
          proof_version_id: versionId,
          image_path: u.path,
          material_option: null,
          original_filename: u.file.name,
          associated_name: null,
          side: u.side,
          round_variant_id: u.variantId,
          // sort_order: append after the highest existing index for
          // this version. Re-read at save time to avoid clobbering
          // anything that landed concurrently.
          sort_order: 1000 + i,
        }))
        const { error: insErr } = await supabase
          .from('proof_version_images')
          .insert(inserts)
        if (insErr) {
          // Roll back the storage uploads we just did so we don't
          // leave orphan files.
          await safeRemoveImagePaths(uploadResults.map((r) => r.path))
          setError(`Failed to save new images: ${insErr.message}`)
          setSubmitting(false)
          return
        }
      }

      setSubmitting(false)
      // Variant-round save success: show the preview gate instead
      // of navigating straight back. Currency on variant-round
      // versions is null (per-direction-pricing or mixed) so it's
      // omitted from the banner.
      setSavedVersionForPreview({ currency: null })
      return
    }

    if (!isValid) {
      const order: Array<{
        key: keyof typeof validations
        ref: React.RefObject<HTMLElement | null>
      }> = [
        { key: 'material',    ref: materialRef as unknown as React.RefObject<HTMLElement | null> },
        // Layer-colour pickers slot between material/options and ink
        // names in document order (front → core → back). Same order
        // in scroll-to-first-invalid so the focus jump is predictable.
        { key: 'frontColour', ref: frontColourRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'coreColour',  ref: coreColourRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'backColour',  ref: backColourRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'inkNames',    ref: inkNamesRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'images',      ref: imageSectionRef },
      ]
      const first = order.find(o => !validations[o.key])
      first?.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })

      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      setToast({ kind: 'validation', text: 'Please complete all required fields to save' })
      toastTimerRef.current = setTimeout(
        () => setToast((curr) => (curr?.kind === 'validation' ? null : curr)),
        5000,
      )
      return
    }

    // Finalise any pending soft-delete before the network save.
    // Placed after the validation gate so a validation-fail path
    // doesn't pre-empt the 5s undo window. URL revocation only
    // applies to kind:'new' entries; existing entries leave no
    // hygiene work for this hook.
    commitPendingRemoval()

    setSubmitting(true)

    // Upload new images across all finish tabs
    const optionKeys = optionMode ? selectedOptions : ['']
    const newImages = optionKeys.flatMap(fk =>
      (editImagesByOption[fk] ?? [])
        .filter((img): img is Extract<EditImage, { kind: 'new' }> => img.kind === 'new')
        .map(img => ({ img, fk }))
    )

    const uploadResults = await Promise.all(
      newImages.map(async ({ img }) => {
        const path = `${proofId}/${uuidv4()}.jpg`
        const { error: uploadError } = await supabase.storage
          .from('proof-images')
          .upload(path, img.file, { contentType: img.file.type, upsert: false })
        return { localId: img.localId, path, error: uploadError }
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

    const uploadedPathByLocalId = Object.fromEntries(uploadResults.map((r) => [r.localId, r.path]))

    // Determine which original images were removed
    const remainingExistingIds = new Set(
      Object.values(editImagesByOption).flat()
        .filter((img): img is Extract<EditImage, { kind: 'existing' }> => img.kind === 'existing')
        .map(img => img.id)
    )
    const removedIds = [...originalImageIds].filter(id => !remainingExistingIds.has(id))

    let removedPaths: string[] = []
    if (removedIds.length > 0) {
      const { data: removedRows } = await supabase
        .from('proof_version_images')
        .select('image_path')
        .in('id', removedIds)
      removedPaths = (removedRows ?? []).map((r: any) => r.image_path)
    }

    // Update proof_version (including material_options)
    const { error: updateErr } = await supabase
      .from('proof_versions')
      .update({
        material_display: materialDisplay.trim(),
        ink_names: requiresInkNames
          ? inkNamesArray.map(s => s.trim())
          : inkNamesText.split(',').map(s => s.trim()).filter(Boolean),
        change_notes: changeNotes.trim() || null,
        material_options: selectedOptions,
        custom_quote: pricingDisplay === 'custom',
        // The DB trigger recomputes split_name_surcharge_snapshot
        // from the version's material + currency, so swapping
        // material or currency here keeps the snapshot in sync.
        names: names.map((n) => n.trim()).filter(Boolean),
        // Letterpress layer colours (migrations 000133 + 000135).
        // Only stamped when the pickers are visible for this version's
        // material; null otherwise so we never persist a colour against
        // a material that can't expose it.
        front_colour_id: requiresLayerColours ? selectedFrontColourId : null,
        core_colour_id:  requiresLayerColours ? selectedCoreColourId  : null,
        back_colour_id:  requiresLayerColours ? selectedBackColourId  : null,
        // Personalisation (migration 000172). Same eligibility gate
        // as NewVersionPage's standard insert path. Saves false if
        // the gate isn't currently satisfied; this lets a designer
        // untick by switching to a custom quote (the box
        // disappears, the save lands false). !isVariantRound
        // matches NewVersionPage's hard-coded false on the variant-
        // round path — and is enforced at the DB level too
        // (migration 000173 CHECK constraint).
        has_personalisation:
          materialSupportsPersonalisation
          && cardType === 'membership'
          && pricingDisplay !== 'custom'
          && !isVariantRound
          && hasPersonalisation,
      })
      .eq('id', versionId!)

    if (updateErr) {
      setError(`Failed to save: ${updateErr.message}`)
      setSubmitting(false)
      return
    }

    // Delete removed images. Storage object is only actually
    // removed if no other proof_version_images row references the
    // same path — carry-forward from NewVersionPage can leave v1
    // and v2 sharing image_paths, and a blind storage.remove here
    // would nuke the counterpart version's still-referenced file.
    if (removedIds.length > 0) {
      await supabase.from('proof_version_images').delete().in('id', removedIds)
      if (removedPaths.length > 0) {
        await safeRemoveImagePaths(removedPaths)
      }
    }

    // Update sort_order, material_option, associated_name, side on remaining existing images
    await Promise.all(
      optionKeys.flatMap(fk => {
        const optionValue = fk === '' ? null : fk
        return (editImagesByOption[fk] ?? [])
          .map((img, idx) => {
            if (img.kind !== 'existing') return null
            return supabase
              .from('proof_version_images')
              .update({
                sort_order: idx,
                material_option: optionValue,
                associated_name: img.associated_name,
                side: img.side,
              })
              .eq('id', img.id)
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)
      })
    )

    // Insert new images
    const newImageInserts = optionKeys.flatMap(fk => {
      const optionValue = fk === '' ? null : fk
      return (editImagesByOption[fk] ?? [])
        .map((img, idx) => {
          if (img.kind !== 'new') return null
          const path = uploadedPathByLocalId[(img as Extract<EditImage, { kind: 'new' }>).localId]
          if (!path) return null
          return {
            proof_version_id: versionId!,
            image_path: path,
            sort_order: idx,
            material_option: optionValue,
            original_filename: img.file.name,
            associated_name: img.associated_name,
            side: img.side,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    })

    if (newImageInserts.length > 0) {
      const { error: insertErr } = await supabase.from('proof_version_images').insert(newImageInserts)
      if (insertErr) {
        setError(`Failed to save new images: ${insertErr.message}`)
        setSubmitting(false)
        return
      }
    }

    // ── QR codes (migration 000168) ──────────────────────────────
    // Diff qrEntries against originalQrIds:
    //   * Removed (existing id no longer present) → delete row +
    //     safeRemoveImagePaths.
    //   * Kept existing → UPDATE associated_name (the only field
    //     the designer can change on a saved QR; decoded_data and
    //     kind are write-once at upload time).
    //   * New → upload file, INSERT row.
    // Same belt-and-braces pattern as the artwork save above; a
    // failure leaves the proof_versions UPDATE intact but surfaces
    // the error so the designer can retry without recreating
    // everything they kept.
    const remainingExistingQrIds = new Set(
      qrEntries
        .filter((e) => e.source === 'existing')
        .map((e) => e.id),
    )
    const removedQrIds = [...originalQrIds].filter(
      (id) => !remainingExistingQrIds.has(id),
    )

    if (removedQrIds.length > 0) {
      const { data: removedQrRows } = await supabase
        .from('proof_version_images')
        .select('image_path')
        .in('id', removedQrIds)
      const removedQrPaths = (removedQrRows ?? []).map((r: any) => r.image_path)
      await supabase
        .from('proof_version_images')
        .delete()
        .in('id', removedQrIds)
      if (removedQrPaths.length > 0) {
        await safeRemoveImagePaths(removedQrPaths)
      }
    }

    // Update associated_name on kept existing QR rows. Skip if
    // unchanged — but the cost of a no-op UPDATE is low and the
    // diff would need the original associated_name to compare,
    // which we don't keep around. Cheap enough to always write.
    await Promise.all(
      qrEntries
        .filter((e) => e.source === 'existing')
        .map((e) =>
          supabase
            .from('proof_version_images')
            .update({ associated_name: e.associatedName })
            .eq('id', e.id),
        ),
    )

    // Upload + insert new QR rows.
    const newQrEntries = qrEntries.filter((e) => e.source === 'new' && e.file)
    if (newQrEntries.length > 0) {
      const qrUploads = newQrEntries.map((e) => ({
        entry: e,
        file: e.file as File,
        // Path extension follows the artefact: hosted-vCard QRs are
        // generated SVGs; customer-supplied QRs are the dropped
        // JPEG / PNG. Mirrors NewVersionPage so a fresh-create and
        // an edit-add produce paths in the same shape.
        path: `${proofId}/${uuidv4()}.${e.kind === 'hosted_vcard' ? 'svg' : 'jpg'}`,
      }))
      const uploadedQrPaths: string[] = []
      const qrErrors: string[] = []
      await Promise.all(
        qrUploads.map(async (u) => {
          const { error: upErr } = await supabase.storage
            .from('proof-images')
            .upload(u.path, u.file, { contentType: u.file.type || 'image/jpeg' })
          if (upErr) qrErrors.push(`${u.file.name}: ${upErr.message}`)
          else uploadedQrPaths.push(u.path)
        }),
      )
      if (qrErrors.length > 0) {
        if (uploadedQrPaths.length > 0) {
          await supabase.storage.from('proof-images').remove(uploadedQrPaths)
        }
        setError(`Failed to upload QR codes: ${qrErrors.join(' · ')}`)
        setSubmitting(false)
        return
      }
      const pathByEntryId = new Map(qrUploads.map((u) => [u.entry.id, u.path]))
      const qrInserts = newQrEntries.map((entry) => ({
        proof_version_id: versionId!,
        image_path: pathByEntryId.get(entry.id)!,
        material_option: null,
        original_filename: entry.originalFilename,
        associated_name: entry.associatedName,
        side: 'front' as const,
        // Sort the QR rows after the artwork rows. The exact value
        // doesn't matter for QR rendering on the customer page (the
        // panel doesn't use sort_order), so a constant offset is
        // fine.
        sort_order: 1000,
        is_qr_code: true,
        qr_decoded_data: entry.decodedData,
        qr_kind: entry.kind,
        // Migration 000192 — populated iff kind = 'hosted_vcard'.
        // The CHECK constraint rejects mismatched (kind, slug) pairs.
        qr_vcard_slug: entry.kind === 'hosted_vcard' ? entry.vcardSlug ?? null : null,
      }))
      const { error: qrInsertErr } = await supabase
        .from('proof_version_images')
        .insert(qrInserts)
      if (qrInsertErr) {
        await supabase.storage.from('proof-images').remove(uploadedQrPaths)
        setError(`Failed to save QR codes: ${qrInsertErr.message}`)
        setSubmitting(false)
        return
      }
    }

    // Migration 000169 — invalidate qr_confirmed_at on any
    // proof_name_approvals row for this version whenever the QR set
    // changed during this Edit. The customer's prior tick covered v1's
    // QR contents; if any QR was added, removed, or reassigned to a
    // different name, the tick no longer corresponds to what's visible
    // on the version. Nulling the timestamp forces a re-confirmation
    // (the auto-finalize predicate then declines the slot until the
    // customer ticks again on the updated set).
    //
    // Detection covers QR-set mutations AND artwork mutations. A QR
    // confirmation was ticked on top of a specific artwork surface;
    // if either side of that surface changes, the prior tick no
    // longer corresponds to what the customer last saw:
    //   * removedQrIds.length > 0 — QR set shrank
    //   * newQrEntries.length > 0 — QR set grew
    //   * any kept existing QR's associated_name differs from the
    //     load-time snapshot — slot membership shifted even though
    //     the file set is unchanged
    //   * removedIds.length > 0 — an artwork image was deleted
    //   * newImages.length > 0 — a fresh artwork image was added
    //   * any kept existing artwork row's associated_name differs
    //     from the load-time snapshot — artwork moved between slots
    //
    // Cautious-but-safe: nulls qr_confirmed_at across every slot on
    // the version rather than per-slot. Adding/removing a Shared QR
    // affects every named slot's QR set anyway, and per-slot diffing
    // would mostly converge on the same result with more code. The
    // single UPDATE is cheap, so the wider trigger is essentially
    // free.
    const qrAssocChanged = qrEntries.some((entry) => {
      if (entry.source !== 'existing') return false
      const original = originalQrAssocByEntryId[entry.id]
      return original !== entry.associatedName
    })
    const artworkAssocChanged = Object.values(editImagesByOption)
      .flat()
      .some((img) => {
        if (img.kind !== 'existing') return false
        const original = originalArtworkAssocById[img.id]
        if (original === undefined) return false
        return original !== img.associated_name
      })
    const qrSetMutated =
      removedQrIds.length > 0
      || newQrEntries.length > 0
      || qrAssocChanged
      || removedIds.length > 0
      || newImages.length > 0
      || artworkAssocChanged
    if (qrSetMutated) {
      const { error: qrConfirmInvalidateErr } = await supabase
        .from('proof_name_approvals')
        .update({ qr_confirmed_at: null, qr_snapshot: null })
        .eq('proof_version_id', versionId!)
        .not('qr_confirmed_at', 'is', null)
      if (qrConfirmInvalidateErr) {
        // Soft-fail: the QR data has already saved, and the
        // invalidation is belt-and-braces against the customer
        // re-approving on stale ticks. Surface the error so the
        // designer can re-trigger if needed, but don't block the
        // Edit save.
        console.error(
          '[qr-confirm-invalidate] Failed to clear qr_confirmed_at on Edit:',
          qrConfirmInvalidateErr.message,
        )
      }
    }

    // Standard-version save success: show the preview gate. The
    // gate's "Looks good" returns to /proofs/:id (same target as
    // the old immediate navigate); "Go back and edit" clears the
    // gate and the form re-renders with the still-in-state values
    // for further editing.
    setSavedVersionForPreview({ currency })
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-ink" />
      </div>
    )
  }

  // Post-save preview gate. Replaces the form (and the rest of the
  // page chrome — the gate uses fixed inset-0) until the designer
  // confirms what the customer will see. "Go back and edit" clears
  // the gate so the form re-appears with state intact. "Looks
  // good, send proofs to customer" flips previewApproved and the
  // MessageSendPanel branch below renders, matching the new-
  // version flow so the designer can fire a Help Scout reply
  // with the proof URL straight from here. See VersionPreviewGate
  // for the gate rationale; see NewVersionPage for the original
  // MessageSendPanel pattern this mirrors.
  if (savedVersionForPreview && !previewApproved && proofId && versionId) {
    return (
      <VersionPreviewGate
        proofId={proofId}
        versionId={versionId}
        versionNumber={versionNumber}
        currency={savedVersionForPreview.currency}
        confirmLabel="Looks good, send proofs to customer"
        onConfirm={() => setPreviewApproved(true)}
        onEdit={() => setSavedVersionForPreview(null)}
      />
    )
  }

  // Post-preview MessageSendPanel branch. Lifted into EditVersion
  // so an edit can notify the customer the same way a new version
  // does. Template id mirrors NewVersionPage: v1 is the first-
  // proof intro, anything later is a revision. onSent / onSkip
  // both land on the project detail page, same as before.
  if (savedVersionForPreview && previewApproved && proofId && versionId) {
    const tplId: 'first_proof' | 'revision' =
      versionNumber === 1 ? 'first_proof' : 'revision'
    const customerUrl = `${window.location.origin}${customerProofPath(proofId)}`
    const messageContext = {
      first_name: firstName(proofName),
      full_name: proofName,
      company: proofCompany || null,
      version_number: versionNumber,
      url: customerUrl,
      // Designer accounts are deferred; the variable resolves to
      // empty today. Templates currently hardcode "Plasma Design"
      // in the signoff so the empty value is fine.
      designer_first_name: '',
    }
    return (
      <DesignerChrome active="proofs">
      <div className="min-h-dvh bg-canvas">
      <div className="mx-auto max-w-2xl px-4 py-10 pb-32 sm:px-6">
        <div className="mb-8">
          <h1 className="font-display font-medium tracking-[-0.02em] text-ink leading-tight" style={{ fontSize: 'clamp(24px, 4vw, 32px)' }}>
            Version v{versionNumber} saved
          </h1>
          {proofCompany && <p className="mt-1 text-sm text-ink-dim">{proofCompany}</p>}
        </div>
        <MessageSendPanel
          proofId={proofId}
          versionId={versionId}
          versionNumber={versionNumber}
          templateId={tplId}
          context={messageContext}
          hasHelpScoutConversation={!!proofHelpScoutConversationId}
          onSent={() => navigate(`/proofs/${proofId}`)}
          onSkip={() => navigate(`/proofs/${proofId}`)}
        />
      </div>
      </div>
      </DesignerChrome>
    )
  }

  // Cancel + Save pair, defined once and rendered twice (top of
  // the page beside the heading, and again at the bottom of the
  // form below the image-editing section). Both renders emit
  // identical JSX, so disabled state, aria-label swaps, and any
  // future chrome stay in lockstep. The submit button carries
  // form="edit-version-form" so placement outside the <form>
  // element (top row) is as functional as placement inside
  // (bottom row). Mirrors the 66a721a pattern on
  // NewVersionPage — same rationale: the form ends in a dense
  // image-editing grid and the designer shouldn't have to
  // scroll back up to commit.
  const actionRow = (
    <div className="flex items-center gap-3">
      <Link
        to={`/proofs/${proofId}`}
        className="text-sm font-medium text-ink-mute hover:text-ink-soft"
      >
        Cancel
      </Link>
      <button
        type="submit"
        form="edit-version-form"
        disabled={submitting || (isVariantRound && isLocked)}
        aria-label={
          isVariantRound && isLocked
            ? "Save version disabled — variant round locked by customer's selection"
            : submitAttempted && !isValid
              ? 'Save version — some required fields are incomplete'
              : undefined
        }
        className={[
          'rounded px-4 py-2 text-sm font-semibold text-on-ink transition-colors',
          isValid ? 'bg-ink hover:opacity-90' : 'bg-ink/60 hover:bg-ink/75',
          'disabled:cursor-not-allowed disabled:opacity-50',
        ].join(' ')}
      >
        {submitting ? 'Saving…' : 'Save version'}
      </button>
    </div>
  )

  return (
    <DesignerChrome active="proofs">
    <div className="min-h-dvh bg-canvas">
      <PageDropOverlay visible={isPageDragOver} />
      {toast?.kind === 'validation' && (
        <div
          role="status"
          className="fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-full bg-out-soft px-5 py-2.5 text-sm font-medium text-out shadow-lg ring-1 ring-out"
        >
          {toast.text}
        </div>
      )}
      {toast?.kind === 'undo' && (
        <div
          role="status"
          className="fixed left-1/2 top-6 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-on-ink shadow-lg"
        >
          <span>{toast.text}</span>
          <button
            type="button"
            onClick={() => toast.onUndo()}
            className="rounded-full bg-on-ink/15 px-3 py-1 text-xs font-semibold uppercase tracking-wider hover:bg-on-ink/25"
          >
            Undo
          </button>
        </div>
      )}
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">

        {/* Breadcrumb back to Proofs / this project. */}
        <nav className="mb-6 flex items-center gap-1.5 text-[13px] text-ink-mute">
          <Link to="/" className="hover:text-ink">Proofs</Link>
          <span className="text-ink-dim">›</span>
          <Link to={`/proofs/${proofId}`} className="max-w-[24ch] truncate hover:text-ink">{proofName ?? 'Project'}</Link>
          <span className="text-ink-dim">›</span>
          <span className="text-ink">Edit v{versionNumber}</span>
        </nav>

        {/* Page heading + top actions. Cancel + Save pair is
            defined as `actionRow` above the render and emitted
            twice — here next to the heading, and again below
            the image-editing section at the bottom of the form. */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display font-medium tracking-[-0.02em] text-ink leading-tight" style={{ fontSize: 'clamp(24px, 4vw, 32px)' }}>Edit v{versionNumber}</h1>
            {proofCompany && <p className="mt-1 text-sm text-ink-dim">{proofCompany}</p>}
          </div>
          {actionRow}
        </div>

        {/* ── Locked variant-round notice (build-plan step 5.5 / item 4) ──
            Variant rounds become read-only as soon as a customer has
            submitted a "Choose this direction" selection (a
            proof_name_approvals row with name='__shared__'). At that
            point the chosen direction is the load-bearing fact and
            replaying edits over it would be confusing — the designer
            should add a new version on the chosen direction instead.
            Pre-lock variant rounds use the dedicated edit form
            below. */}
        {isVariantRound && isLocked && (
          <div
            role="alert"
            className="mb-6 rounded-xl border border-out bg-out-soft px-5 py-4 text-sm text-out"
          >
            <p className="font-semibold">
              This variant round has been locked by the customer's selection.
            </p>
            <p className="mt-1">
              Create a new version to continue with the chosen direction.
            </p>
          </div>
        )}

        {/* Standard edit form. Hidden on variant rounds entirely —
            variant rounds either render the locked banner above (no
            form at all) or the dedicated variant edit form below. */}
        {!isVariantRound && (
        <form id="edit-version-form" onSubmit={handleSubmit} className="space-y-6">
          <fieldset disabled={false} className="contents">

          {/* Two-column body: spec/setup on the left, proof images +
              QR + change notes on the right. Personalisation, the
              pricing-reference tables and the action row sit
              full-width below. Stacks to one column below lg. */}
          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <div className="space-y-6">

          {/* Pricing display — required choice between standard grid and custom quote.
              Standard is disabled when the saved snapshot carries no
              per-tier prices (5+ ink versions, historical custom
              quotes) so the designer can't flip the version into a
              standard-priced state that has no grid to show.
              The PricingDisplayField rewrite (form polish v2) made
              the component card-less so it can sit inside parent
              cards on the new-version flow's Commercial section.
              On this edit-version surface we wrap it with the
              standalone-card chrome it used to provide internally. */}
          <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-ink-dim">Pricing display</h2>
            <PricingDisplayField
              value={pricingDisplay}
              onChange={setPricingDisplay}
              standardDisabled={snapshotHasNoPrices}
              disabledReason="No standard pricing available for this version. Saved as a custom quote."
            />
          </section>

          {/* Specification */}
          <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-ink-dim">Specification</h2>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">Material display name</label>
              <input
                ref={materialRef}
                type="text"
                value={materialDisplay}
                onChange={(e) => setMaterialDisplay(e.target.value)}
                className={[inputClass, shouldHighlight('material') ? 'border-out focus:border-out focus:ring-out' : ''].join(' ')}
              />
              {shouldHighlight('material') && <p className="mt-1.5 text-xs font-medium text-out">Required</p>}
            </div>

            {/* Option selection — for materials that expose multi-options */}
            {hasOptions && (
              <div className="mb-4">
                <label className="mb-2 block text-sm font-medium text-ink-soft">{optionLabelPlural}</label>
                <div className="flex flex-wrap gap-2">
                  {availableOptions.map(o => {
                    const selected = selectedOptions.includes(o.code)
                    return (
                      <button
                        key={o.code}
                        type="button"
                        onClick={() => toggleOption(o.code)}
                        className={[
                          'rounded px-4 py-1.5 text-sm font-medium ring-1 transition-colors',
                          selected
                            ? 'bg-ink text-on-ink ring-ink'
                            : 'bg-surface text-ink-soft ring-line hover:bg-canvas',
                        ].join(' ')}
                      >
                        {o.display_name}
                      </button>
                    )
                  })}
                </div>
                <p className="mt-1.5 text-xs text-ink-dim">
                  Select which {optionLabelPlural.toLowerCase()} to offer. Each {optionLabelSingular.toLowerCase()} gets its own proof images.
                </p>
              </div>
            )}

            {/* Paper layers — only renders for un-gilded letterpress
                (paper_letterpress). Gilded letterpress hides the
                layered edge behind the gilded edge so no pickers are
                needed. The catalogue is admin-managed at
                /admin/core-colours; all three pickers see only
                active rows (RLS filters at the DB) and pull from
                the same shared list. All three required when visible.
                Grouped under one "Paper layers" heading so the
                designer reads it as one decision. */}
            {requiresLayerColours && (
              <div className="mb-4 rounded-xl bg-canvas p-4 ring-1 ring-line-soft">
                <label className="mb-1 block text-sm font-medium text-ink-soft">Paper layers</label>
                <p className="mb-3 text-xs text-ink-mute">
                  The three Colorplan layers visible at the card's edge. Pick a colour for each.
                </p>
                <div className="space-y-3">
                  <EditLayerColourPicker
                    label="Front"
                    refEl={frontColourRef}
                    selectedId={selectedFrontColourId}
                    onChange={setSelectedFrontColourId}
                    colours={coreColours}
                    invalid={shouldHighlight('frontColour')}
                  />
                  <EditLayerColourPicker
                    label="Core"
                    refEl={coreColourRef}
                    selectedId={selectedCoreColourId}
                    onChange={setSelectedCoreColourId}
                    colours={coreColours}
                    invalid={shouldHighlight('coreColour')}
                  />
                  <EditLayerColourPicker
                    label="Back"
                    refEl={backColourRef}
                    selectedId={selectedBackColourId}
                    onChange={setSelectedBackColourId}
                    colours={coreColours}
                    invalid={shouldHighlight('backColour')}
                  />
                </div>
              </div>
            )}

            {requiresInkNames ? (
              <div ref={inkNamesRef} className="mb-4">
                <label className="mb-1.5 block text-sm font-medium text-ink-soft">Ink names</label>
                <div className="space-y-2">
                  {Array.from({ length: editInkCount }).map((_, i) => {
                    const fieldInvalid = submitAttempted && !inkNameValidities[i]
                    return (
                      <div key={i}>
                        <label className="mb-0.5 block text-xs font-medium text-ink-mute">Ink {i + 1}</label>
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
                            fieldInvalid ? 'border-out focus:border-out focus:ring-out' : '',
                          ].join(' ')}
                        />
                        {fieldInvalid && <p className="mt-1 text-xs font-medium text-out">Required</p>}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div className="mb-4">
                <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                  Ink names <span className="font-normal text-ink-dim">(optional, comma-separated)</span>
                </label>
                <input
                  type="text"
                  value={inkNamesText}
                  onChange={(e) => setInkNamesText(e.target.value)}
                  placeholder="e.g. Pantone 185 C, Metallic Gold"
                  className={inputClass}
                />
              </div>
            )}

            {/* Names on this order — chip input backs
                proof_versions.names. Trigger recomputes the
                surcharge snapshot on save from the version's
                current material + currency. */}
            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                Names on this order <span className="font-normal text-ink-dim">(optional)</span>
              </label>
              <NameChipInput
                names={names}
                onChange={handleNamesChange}
                placeholder="Who is this proof for? Press Enter after each name"
                ariaLabel="Names on this order"
              />
            </div>

            {!isCustomQuote && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-ink-soft">Currency</label>
                <div>
                  <CurrencyField value={currency} onChange={() => {}} disabled />
                  <p className="mt-1.5 text-xs text-ink-dim">Cannot be changed after creation.</p>
                </div>
              </div>
            )}

          </section>

          </div>
          <div className="space-y-6">
          {/* Images */}
          <section ref={imageSectionRef} className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-ink-dim">
              Proof images
              {currentImages.length > 0 && (
                <span className="ml-2 font-normal normal-case text-ink-dim">— drag to reorder</span>
              )}
            </h2>

            {/* Option tabs */}
            {optionMode && selectedOptions.length > 0 && (
              <div className="mb-4 flex gap-0 border-b border-line-soft">
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
                          ? 'border-ink text-ink'
                          : 'border-transparent text-ink-dim hover:text-ink-soft',
                      ].join(' ')}
                    >
                      {f?.display_name ?? fCode}
                      <span className={['ml-1.5 text-xs', isActive ? 'text-ink-dim' : 'text-ink-dim'].join(' ')}>
                        ({(editImagesByOption[fCode] ?? []).length})
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {currentImages.length > 0 && (
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {currentImages.map((entry, index) => {
                  const key = entry.kind === 'existing' ? entry.id : entry.localId
                  const filename = entry.kind === 'existing' ? entry.original_filename : entry.file.name
                  return (
                    <div
                      key={key}
                      draggable
                      onDragStart={() => handleDragStart(index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDragEnd={handleDragEnd}
                      className="group relative cursor-grab rounded-xl border border-line bg-canvas p-2 active:cursor-grabbing"
                    >
                      <img
                        src={entry.preview}
                        alt={filename ?? ''}
                        className="mb-2 aspect-square w-full rounded-lg object-contain"
                      />
                      {/* Per-image recipient + side. Designer can
                          correct after the fact on existing images
                          (customer page grouping updates on save). */}
                      <select
                        value={entry.associated_name ?? ''}
                        onChange={(e) => updateAssociatedName(key, e.target.value || null)}
                        className="select-styled mt-1 w-full rounded border border-line px-2 py-1 text-xs focus:border-brand focus:outline-none"
                        aria-label="Associated name"
                      >
                        <option value="">Shared</option>
                        {names.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <select
                        value={entry.side ?? ''}
                        onChange={(e) => updateSide(key, (e.target.value || null) as 'front' | 'back' | null)}
                        className="select-styled mt-1 w-full rounded border border-line px-2 py-1 text-xs focus:border-brand focus:outline-none"
                        aria-label="Side"
                      >
                        <option value="">—</option>
                        <option value="front">Front</option>
                        <option value="back">Back</option>
                      </select>
                      {filename && (
                        <p className="mt-1 truncate text-[11px] text-ink-dim" title={filename}>
                          {filename}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => removeImage(key)}
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs text-on-ink opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {currentImages.length < MAX_IMAGES && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg"
                  multiple
                  onChange={handleFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  {...zoneProps}
                  className={[
                    'flex w-full items-center justify-center rounded-xl border-2 py-8 text-sm transition-colors',
                    isZoneDragOver
                      ? 'border-solid border-ink bg-canvas text-ink'
                      : shouldHighlight('images')
                        ? 'border-dashed border-out text-out hover:border-out hover:text-out'
                        : 'border-dashed border-line text-ink-dim hover:border-line hover:text-ink-soft',
                  ].join(' ')}
                >
                  {isZoneDragOver
                    ? 'Drop to add images'
                    : currentImages.length === 0
                      ? 'Click or drop to upload JPEG (max 10 MB each)'
                      : `Add more images (${currentImages.length} / ${MAX_IMAGES})`}
                </button>
              </>
            )}

            {fileError && <p className="mt-2 text-sm text-out">{fileError}</p>}
            {fileNote && <p className="mt-2 text-sm text-ink-mute">{fileNote}</p>}
            {shouldHighlight('images') && (
              <p className="mt-2 text-xs font-medium text-out">{imagesHint}</p>
            )}
          </section>

          {/* QR codes (migrations 000168 / 000169).
              Standard-edit-form parity with NewVersionPage. Hidden
              in variant-round mode for v1 — variant-round QR
              rendering on the customer page is deferred to a
              follow-up. */}
          {!isVariantRound && (
            <QrCodeUploadSection
              value={qrEntries}
              onChange={setQrEntries}
              names={names.map((n) => n.trim()).filter(Boolean)}
              disabled={submitting}
            />
          )}

          {/* Change notes */}
          <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-ink-dim">Change notes</h2>
            <textarea
              rows={3}
              placeholder="What changed in this version? Shown to the customer."
              value={changeNotes}
              onChange={(e) => setChangeNotes(e.target.value)}
              className={inputClass}
            />
          </section>

          </div>
          </div>

          {/* Personalisation add-on (migration 000172). Visible only
              when the material supports personalisation AND this is a
              membership card AND it's not a custom quote AND it's
              not a variant round. cardType + isVariantRound aren't
              editable from this page, so the gate either always
              passes or never does for a given version.
              !isVariantRound matches NewVersionPage's hard-coded
              false on the variant-round save path (bug sweep
              consistency fix). */}
          {materialSupportsPersonalisation
            && cardType === 'membership'
            && !isCustomQuote
            && !isVariantRound && (
            <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-ink-dim">Personalisation</h2>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3">
                <input
                  type="checkbox"
                  checked={hasPersonalisation}
                  onChange={(e) => setHasPersonalisation(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer rounded border-line text-ink focus:ring-brand"
                />
                <div>
                  <div className="text-sm font-medium text-ink-soft">
                    Add personalisation
                  </div>
                  <div className="text-xs text-ink-mute">
                    {(() => {
                      // Live rate from personalisation_pricing.
                      // Seed fallbacks (migration 000172) apply only
                      // during the first paint before the row loads.
                      const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£'
                      const rate = personalisationLivePricing?.per_card_rate
                        ?? (currency === 'USD' || currency === 'EUR' ? 0.25 : 0.20)
                      const min = personalisationLivePricing?.min_charge ?? 50
                      return `${symbol}${rate.toFixed(2)} per card with a ${symbol}${min.toFixed(0)} minimum charge.`
                    })()}
                  </div>
                </div>
              </label>
            </section>
          )}

          {/* Pricing — read-only. Hidden when this version is a custom quote. */}
          {!isCustomQuote && pricingSnapshot && (
            <section className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
              <div className="flex items-center justify-between border-b border-line-soft px-6 py-4">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-ink-dim">Pricing</h2>
                <span className="text-xs text-ink-dim">Read-only — locked at creation</span>
              </div>
              <PricingDisplay
                snapshot={pricingSnapshot}
                currency={currency}
                displayQuantities={displayQuantities}
              />
              <div className="border-t border-line-soft px-6 py-3">
                <p className="text-xs text-ink-dim">
                  {currency === 'GBP' ? 'Prices include VAT. ' : ''}
                  {shippingNote}
                </p>
              </div>
            </section>
          )}

          {error && <p className="rounded-lg bg-out-soft px-4 py-3 text-sm text-out">{error}</p>}

          {/* Bottom action row — full-width Cancel + Save below the
              two-column body. Mirrors the top row; same handleSubmit
              path via form="edit-version-form". */}
          <div className="flex justify-end">
            {actionRow}
          </div>

          </fieldset>
        </form>
        )}

        {/* ── Variant-round edit form (build-plan item 4) ────────────
            Renders on pre-lock variant rounds. Mirrors NewVersionPage's
            variant editor structurally, with two key differences:
            * Existing images render as a thumbnail strip (with per-
              image Remove buttons) above the drop zone.
            * Add-direction / reorder / remove-variant controls are
              hidden in v1 — out of scope per the build plan.
            Saving applies a surgical diff: rename UPDATEs,
            removed-existing DELETEs (storage + row), new-file
            UPLOAD + INSERTs. No mode flips — Single ↔ Mixed and
            Standard ↔ Variant are forbidden by hiding the toggles
            here and bailing in handleSubmit if a payload tries to
            change them. */}
        {isVariantRound && !isLocked && (
        <form id="edit-version-form" onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
          <section className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
            <div className="mb-6">
              <h2 className="text-base font-semibold text-ink">Variants</h2>
              <p className="mt-0.5 text-xs text-ink-mute">
                Rename a direction, replace its images per side, or add / remove a back side. The variant ID is fixed at first save and won't change with renames; adding or removing whole directions isn't supported in this version — create a new version instead if the round needs a different shape.
              </p>
            </div>
            <ul className="space-y-4">
              {variantEditRows.map((row, idx) => {
                const labelInvalid = submitAttempted && row.display_name.trim().length === 0
                const frontKept = row.front.existingImages.filter(
                  (img) => !row.front.removedExistingIds.includes(img.id),
                )
                const frontInvalid =
                  submitAttempted && frontKept.length === 0 && row.front.newFiles.length === 0
                const backEnabled = row.back !== null
                const backKept = backEnabled
                  ? row.back!.existingImages.filter(
                      (img) => !row.back!.removedExistingIds.includes(img.id),
                    )
                  : []
                const backInvalid =
                  submitAttempted && backEnabled && backKept.length === 0 && (row.back?.newFiles.length ?? 0) === 0

                function patchRow(patch: Partial<VariantEditRow>) {
                  setVariantEditRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
                }
                function patchSide(side: 'front' | 'back', patch: Partial<VariantEditSide>) {
                  setVariantEditRows((prev) =>
                    prev.map((r, i) => {
                      if (i !== idx) return r
                      if (side === 'front') return { ...r, front: { ...r.front, ...patch } }
                      if (!r.back) return r
                      return { ...r, back: { ...r.back, ...patch } }
                    }),
                  )
                }

                function renderExistingStrip(side: 'front' | 'back', s: VariantEditSide) {
                  const visible = s.existingImages.filter(
                    (img) => !s.removedExistingIds.includes(img.id),
                  )
                  if (visible.length === 0) return null
                  return (
                    <ul className="mb-2 space-y-1.5">
                      {visible.map((img) => (
                        <li
                          key={img.id}
                          className="flex items-center gap-3 rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
                        >
                          {img.signedUrl ? (
                            <img
                              src={img.signedUrl}
                              alt=""
                              aria-hidden="true"
                              className="h-32 w-32 shrink-0 rounded-md border border-line object-cover"
                            />
                          ) : (
                            <div
                              className="h-32 w-32 shrink-0 rounded-md border border-line bg-canvas"
                              aria-hidden="true"
                            />
                          )}
                          <span className="flex-1 truncate" title={img.originalFilename ?? ''}>
                            {img.originalFilename ?? '(unnamed)'}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              patchSide(side, {
                                removedExistingIds: [...s.removedExistingIds, img.id],
                              })
                            }
                            className="ml-2 shrink-0 text-ink-mute hover:text-out"
                            aria-label={`Remove ${img.originalFilename ?? 'image'}`}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                }

                return (
                  <li
                    key={row.id}
                    className="rounded-xl border border-line bg-canvas p-5"
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold text-on-ink">
                        {idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <label className="mb-1.5 block text-sm font-medium text-ink-soft">
                          Direction name
                        </label>
                        <input
                          type="text"
                          value={row.display_name}
                          onChange={(e) => patchRow({ display_name: e.target.value })}
                          className={[
                            'w-full rounded-lg border bg-surface px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2',
                            labelInvalid
                              ? 'border-out focus:border-out focus:ring-out'
                              : 'border-line focus:border-brand focus:ring-brand',
                          ].join(' ')}
                        />
                        {labelInvalid && (
                          <p className="mt-1.5 text-xs font-medium text-out">Required</p>
                        )}

                        <div className="mt-4">
                          {renderExistingStrip('front', row.front)}
                          <VariantDropZone
                            label="Front"
                            files={row.front.newFiles}
                            onAddFiles={(picked) =>
                              patchSide('front', { newFiles: [...row.front.newFiles, ...picked] })
                            }
                            onRemoveFile={(fi) =>
                              patchSide('front', {
                                newFiles: row.front.newFiles.filter((_, fj) => fj !== fi),
                              })
                            }
                            invalid={frontInvalid}
                            invalidText="Add at least one front image, or restore a removed one."
                          />
                        </div>

                        {backEnabled && row.back && (
                          <div className="mt-4">
                            {renderExistingStrip('back', row.back)}
                            <VariantDropZone
                              label="Back"
                              files={row.back.newFiles}
                              onAddFiles={(picked) =>
                                patchSide('back', { newFiles: [...row.back!.newFiles, ...picked] })
                              }
                              onRemoveFile={(fi) =>
                                patchSide('back', {
                                  newFiles: row.back!.newFiles.filter((_, fj) => fj !== fi),
                                })
                              }
                              invalid={backInvalid}
                              invalidText="Add at least one back image, or remove the back side."
                            />
                          </div>
                        )}

                        <div className="mt-3">
                          <button
                            type="button"
                            onClick={() => {
                              if (backEnabled) {
                                // Removing the back side marks every
                                // existing back image as removed (the
                                // save diff will DELETE them) and
                                // discards any queued new files.
                                patchRow({ back: null })
                              } else {
                                patchRow({
                                  back: {
                                    existingImages: [],
                                    removedExistingIds: [],
                                    newFiles: [],
                                  },
                                })
                              }
                            }}
                            className="text-xs font-medium text-ink-soft underline underline-offset-4 hover:text-ink"
                          >
                            {backEnabled ? '− Remove back side' : '+ Add back side'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>

          {error && <p className="rounded-lg bg-out-soft px-4 py-3 text-sm text-out">{error}</p>}
        </form>
        )}
      </div>
    </div>
    </DesignerChrome>
  )
}

const inputClass = 'w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'

// One row of the Paper layers picker block. Mirrors the
// LayerColourPicker helper in NewVersionPage but uses inputClass
// (no separate selectClass exists in EditVersionPage). Pulled out
// so the three layers (Front/Core/Back) share one swatch-+-dropdown
// layout. refEl is forwarded to the wrapping div so the scroll-to-
// first-invalid path can target this layer specifically.
function EditLayerColourPicker({
  label,
  refEl,
  selectedId,
  onChange,
  colours,
  invalid,
}: {
  label: string
  refEl: React.RefObject<HTMLDivElement | null>
  selectedId: string | null
  onChange: (next: string | null) => void
  colours: LetterpressCoreColour[]
  invalid: boolean
}) {
  const picked = selectedId ? colours.find((c) => c.id === selectedId) ?? null : null
  return (
    <div ref={refEl}>
      <div className="grid grid-cols-[60px_1fr] items-center gap-3">
        <label className="text-xs font-medium uppercase tracking-wide text-ink-mute">{label}</label>
        <div className="flex items-center gap-3">
          {picked ? (
            <CoreColourSwatch hex={picked.hex_value} size={28} ariaLabel={`${picked.name} swatch`} />
          ) : (
            <span
              aria-hidden
              className="inline-block h-7 w-7 shrink-0 rounded-md"
              style={{
                backgroundColor: 'transparent',
                boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)',
              }}
            />
          )}
          <select
            value={selectedId ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
            className={['select-styled', inputClass, invalid ? 'border-out focus:border-out focus:ring-out' : ''].join(' ')}
          >
            <option value="">Select a colour…</option>
            {colours.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>
      {invalid && <p className="mt-1.5 text-xs font-medium text-out" style={{ paddingLeft: 72 }}>Required</p>}
    </div>
  )
}
