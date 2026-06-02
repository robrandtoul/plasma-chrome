import { useEffect, useState, useRef, Fragment, type ChangeEvent, type CSSProperties } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { deriveCodes } from '../lib/variantSlug'
import { VariantDropZone } from '../components/VariantDropZone'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import { pluralLabel, variantLabel } from '../lib/labels'
import { PricingDisplayField, type PricingDisplayValue } from '../components/PricingDisplayField'
import { CurrencyField } from '../components/CurrencyField'
import NameChipInput from '../components/NameChipInput'
import { matchImageToName } from '../lib/matchImageToName'
import { useImageFileDrop } from '../lib/useImageFileDrop'
import { PageDropOverlay } from '../components/PageDropOverlay'
import MessageSendPanel from '../components/MessageSendPanel'
import VersionPreviewGate from '../components/VersionPreviewGate'
import { firstName } from '../lib/firstName'
import { customerProofPath } from '../lib/customerProofUrl'
import { DesignerChrome } from '../design'
import { QrCodeUploadSection, type QrEntry } from '../components/QrCodeUploadSection'
import type { QrKind } from '../lib/qrCodes'
import type { Currency, LetterpressCoreColour, ProofNameApproval } from '../lib/types'
import { usePersonalisationPricing } from '../lib/quote/usePersonalisationPricing'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import { computeQrArtworkChangedSlots, isQrSlotFlagged, resolveQrEffectiveKeep } from '../lib/qrCarryForward'
import { CoreColourSwatch } from '../components/CoreColourSwatch'
import { LAYER_COLOUR_MATERIAL_CODES } from '../lib/letterpress'
import {
  ProofShapeWizard,
  EMPTY_ANSWERS,
  resolveShape,
  deriveFormState,
  deriveAnswersFromVersion,
  isWizardResolved,
  dbShape,
  type WizardAnswers,
} from '../components/ProofShapeWizard'
import {
  LayoutsEditor,
  makeEmptyLayoutRow,
  layoutRowImageCount,
  type LayoutEditRow,
} from '../components/LayoutsEditor'

interface Material {
  id: string
  // Stable code used to gate the core-colour picker; without it
  // the form has nothing to key on (display_name is admin-editable).
  code: string
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
  // Personalisation eligibility (migration 000172). Combined with
  // card_type='membership' to decide whether the version form shows
  // the "Add personalisation" checkbox at all.
  supports_personalisation: boolean
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

// Toast variant carrying optional Undo affordance. Used by both
// the existing validation-fail flow (rose pill, no action) and
// the soft-delete-with-Undo flow on Remove (slate pill with
// inline Undo button). Both auto-dismiss at 5s; the undo path's
// timer also commits the removal (revokes blob URL).
type Toast =
  | { kind: 'validation'; text: string }
  | { kind: 'undo'; text: string; onUndo: () => void }

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
  // Variant-round source signal (migrations 000138/000139). Non-null
  // only when the predecessor version was a variant round — that
  // variant's id, used by the carry-from-variant picker to scope
  // v1Carry.images down to one direction. Null on standard-proof
  // predecessors.
  round_variant_id: string | null
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
  // Letterpress layer colours (migrations 000133 + 000135). Null on
  // any version where the version-level material isn't in
  // LAYER_COLOUR_MATERIAL_CODES, or where the colour ids were never
  // set (legacy pre-000133 letterpress versions, per-direction-
  // pricing variant rounds). Drives the CarriedPill on the Paper
  // layers section so the designer can see at a glance whether each
  // layer is inherited unchanged or has been touched.
  frontColourId: string | null
  coreColourId: string | null
  backColourId: string | null
}

// Sentinel value carryVariantSelection takes when the designer
// clicks the "Start fresh" chip on the picker. Used in place of a
// real proof_round_variants.id so the same state slot serves both
// "advance from variant X" and "drop every carry and upload fresh".
// Chosen with double underscores so it can never collide with a
// real UUID. Read by handleCarryVariantChange (empties v1Carry.images
// when selected) and the picker render (different chip styling +
// hint copy).
const START_FRESH_SENTINEL = '__start_fresh__'

// Variant-round source metadata. Populated only when v(N-1) was a
// variant round; drives the "Continuing from which direction?" picker
// at the top of the Proof Images section. When the source isn't a
// variant round these fields stay at their empty defaults and the
// picker is never rendered.
interface SourceVariant {
  id: string
  code: string
  display_name: string
  sort_order: number
}

// Everything the UI + save path needs to decide carry-forward
// outcomes. Null when creating v1 (no prior version to carry from);
// the form falls back to the existing flat image UI in that case.
interface V1CarryContext {
  versionId: string
  versionNumber: number
  names: string[]
  materialOptions: string[]   // codes — '' represents "no-option" equivalent on v2
  // Filtered to the currently-selected source variant when the
  // predecessor was a variant round. Equal to allImages on standard-
  // proof predecessors. Every downstream consumer — slot derivation,
  // slotStillValid filter, save-path carriedInserts — reads this
  // field, so the picker change handler updates it (via
  // setV1Carry) and the rest of the form stays the same.
  images: V1Image[]
  // Unfiltered v(N-1) image set. Kept alongside the filtered set so
  // the picker change handler can re-filter without re-running the
  // network fetch. Equal to images on standard-proof predecessors.
  allImages: V1Image[]
  approvalsByName: Record<string, ProofNameApproval>  // keyed by recipient name OR SHARED_APPROVAL_KEY
  // Migration 000169 — v1's QR rows kept around so the approval
  // carry-forward block can decide whether to preserve
  // qr_confirmed_at per slot. Each entry carries the recipient
  // assignment and the decoded payload; comparison against v2's
  // qrEntries is multiset-byte-equality on decoded_data within
  // the slot's coordinates.
  //
  // Filtered to the currently-selected source variant when the
  // predecessor was a variant round (mirrors `images` above).
  // Equal to allQrRows on standard-proof predecessors.
  qrRows: { id: string; associated_name: string | null; decoded_data: string }[]
  // Unfiltered v(N-1) QR row set, retained so the picker change
  // handler can re-filter without re-running the network fetch.
  // Carries round_variant_id so re-filtering is one filter call.
  // Equal to qrRows on standard-proof predecessors.
  allQrRows: {
    id: string
    associated_name: string | null
    decoded_data: string
    round_variant_id: string | null
  }[]
  // Pre-fetched QrEntry shapes for every v(N-1) QR row across
  // variants. Picker change re-seeds qrEntries from this cache so
  // the designer doesn't wait on a fresh signed-URL fetch round-
  // trip. Signed URLs expire after an hour — same horizon the
  // initial load uses, no worse on picker change.
  allQrEntries: QrEntry[]
  // Variant-round predecessor flag. True iff v(N-1).is_variant_round
  // — gates the picker UI and the filter in handleCarryVariantChange.
  sourceIsVariantRound: boolean
  // Variants that existed on v(N-1) when it was a variant round.
  // Empty array on standard-proof predecessors. Sort order matches
  // v(N-1)'s row order so the picker reads left-to-right as the
  // customer saw it.
  sourceVariants: SourceVariant[]
  // Customer's locked variant choice on v(N-1), if any. Populated
  // from the most recent proof_events row with round_variant_id set
  // (variant rounds always travel as request_changes, so the
  // event_type filter matches the lock semantics from migration
  // 000139). Null when no customer selection has landed yet — the
  // common case during your hybrid email-feedback rollout where
  // direction decisions happen off-platform. Drives the picker's
  // default selection: customer pick wins, falls back to first
  // variant in sort order.
  customerLockedVariantId: string | null
}

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg']
const MAX_IMAGES = 12

export default function NewVersionPage() {
  const { id: proofId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [proofName, setProofName] = useState('')
  const [proofCompany, setProofCompany] = useState('')
  // Linked Help Scout conversation id, populated by the chrome
  // query above. Null means the proof was never linked to a HS
  // thread; the post-save MessageSendPanel reads this flag to
  // decide between rendering the editor or the no-conversation
  // continue-only path.
  const [proofHelpScoutConversationId, setProofHelpScoutConversationId] =
    useState<string | null>(null)
  // Just-saved version, used to swap out the form for the
  // MessageSendPanel after a successful save. Null while the form is
  // editable; non-null after handleSubmit's insert returns. Replaces
  // the previous immediate navigate(`/proofs/${proofId}`).
  const [savedVersion, setSavedVersion] = useState<{ id: string; number: number } | null>(null)
  // Preview gate state. After save the designer first sees
  // VersionPreviewGate (an iframe of the customer page with a
  // banner of action buttons); only after clicking "Looks good"
  // does this flip true and the MessageSendPanel takes over. The
  // gate exists to stop the "save → send → next job" reflex from
  // shipping a layout bug to the customer. Ephemeral by design,
  // no DB column. See VersionPreviewGate.tsx for the rationale.
  const [previewApproved, setPreviewApproved] = useState(false)
  const [materials, setMaterials] = useState<Material[]>([])
  const [selectedMaterialId, setSelectedMaterialId] = useState('')
  const [variants, setVariants] = useState<Variant[]>([])
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([])
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [variantTiers, setVariantTiers] = useState<Record<string, PriceTierRow[]>>({})
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
  // Flag set at inheritance-load time when v(N-1) was a variant round.
  // Variant rounds carry material_options=[], so the inherited stash above
  // stays null and the options-loading effect would otherwise fall through
  // to its base-option default (e.g. Black Walnut on wood). That silent
  // default never matches the direction the designer is actually carrying
  // forward via the variant picker, leading to a "Bamboo image stamped as
  // Black Walnut" bug at save time. When this ref is true the options
  // effect skips the base-option fallback and leaves selectedOptions empty,
  // forcing the designer to tick the species explicitly via the existing
  // validation path. Cleared once the effect consumes it.
  const inheritedSourceIsVariantRoundRef = useRef(false)
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
  // Personalisation add-on for membership cards (migration 000172).
  // Gated on selectedMaterial.supports_personalisation && cardType ===
  // 'membership'. False on v1 by default; carried from v(N-1) on
  // inheritance. The field is hidden entirely when the gate isn't
  // satisfied, so a flipped state value sticks around but is ignored.
  const [hasPersonalisation, setHasPersonalisation] = useState(false)
  // Live per-currency rate + min charge for the checkbox helper
  // text. Reads from personalisation_pricing every (re)mount so an
  // admin rate edit propagates to the designer-facing helper
  // without code redeploy. Null while loading or before currency
  // picked; the helper falls back to a sensible placeholder in
  // that window via personalisationHelperText().
  const { pricing: personalisationPricing } = usePersonalisationPricing(currency)
  // Migration 000168. QR codes uploaded for this version. On v1
  // creation this starts empty; on v(N>1) creation the v1-carry
  // loader (~line 740) seeds it from v(N-1)'s is_qr_code rows so
  // the designer sees the prior QRs alongside the artwork carry
  // cards. Each entry carries its file (new) or imagePath (existing)
  // plus jsQR-decoded contents + recipient assignment. The save
  // flow uploads new files, then inserts proof_version_images rows
  // with is_qr_code = true; existing entries re-use v1's image_path
  // unless the designer has unkept them via the Keep toggle.
  const [qrEntries, setQrEntries] = useState<QrEntry[]>([])
  // Designer's explicit Keep choices for existing QR entries on
  // this new-version form. Keyed by entry id (which mirrors the
  // v1 proof_version_images row id for source='existing'). Absent
  // entries fall back to the auto-rule: keep=true unless the QR's
  // slot has artwork changes, in which case keep=false to force a
  // deliberate re-verify. Once the designer touches the toggle the
  // map records their choice and the auto-rule stops overriding it.
  // See artworkChangedSlots derivation in render and the displayQrEntries
  // memo a few lines below.
  const [qrKeepOverrides, setQrKeepOverrides] = useState<Record<string, boolean>>({})
  const [pricingDisplay, setPricingDisplay] = useState<PricingDisplayValue | null>(null)
  const [availableOptions, setAvailableOptions] = useState<MaterialOption[]>([])
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [imagesByOption, setImagesByOption] = useState<Record<string, ImageEntry[]>>({ '': [] })
  const [activeImageOption, setActiveImageOption] = useState('')
  // Letterpress layer colours (migrations 000133 + 000135). Catalogue
  // is loaded once on mount; the three pickers (front/core/back) only
  // render when the selected material is in LAYER_COLOUR_MATERIAL_CODES
  // (today: paper_letterpress). All three null = no selection;
  // each is required individually when the pickers are visible,
  // ignored on save otherwise. They share a single catalogue —
  // front/core/back is purely a per-version slot, the choices are
  // drawn from the same Colorplan range.
  const [coreColours, setCoreColours] = useState<LetterpressCoreColour[]>([])
  const [selectedFrontColourId, setSelectedFrontColourId] = useState<string | null>(null)
  const [selectedCoreColourId, setSelectedCoreColourId] = useState<string | null>(null)
  const [selectedBackColourId, setSelectedBackColourId] = useState<string | null>(null)

  // ── Shape B carry-forward state ──────────────────────────────────────────
  // v1Carry is null when creating v1 or when the form can't find an
  // is_current prior version. The render path and save path both
  // key off this — null → legacy flat UI, non-null → grouped UI
  // with Keep toggles and carry semantics.
  const [v1Carry, setV1Carry] = useState<V1CarryContext | null>(null)
  // Designer's current pick from the "Continuing from which direction?"
  // picker rendered at the top of Proof Images when v(N-1) was a
  // variant round. Defaulted on load to the customer's locked
  // selection (if any) or the first variant in sort order; the
  // picker handler updates this state and re-filters v1Carry.images.
  // Always null when v(N-1) is a standard proof — the picker doesn't
  // render and no downstream consumer reads this value on that path.
  const [carryVariantSelection, setCarryVariantSelection] = useState<string | null>(null)
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
  const [toast, setToast] = useState<Toast | null>(null)

  // ── Variant rounds (build-plan step 5) ──────────────────────────────────
  // isVariantRound flips the form between standard mode (per-recipient
  // image buckets, names roster, sidedness/shared) and variant-round
  // mode (a small N-row variant editor with one image bucket per
  // variant). Default false; the toggle sits at the top of the form,
  // above the Pricing display section.
  //
  // variantRows is the editor's working state. `key` is a client-side
  // identifier used to keep React renders stable across rename/reorder
  // — replaced by the DB-assigned proof_round_variants.id on save.
  // `display_name` feeds into deriveCodes (slug + dedup) at save time.
  // `files` is the queued upload set for this variant; each File becomes
  // a proof_version_images row with round_variant_id pointing at the
  // saved variant.
  const [isVariantRound, setIsVariantRound] = useState(false)
  // Per-direction pricing sub-mode (migration 000142, renamed 000144).
  // Only meaningful when isVariantRound is also true. Each direction
  // is priced individually rather than sharing one tier across the
  // round, so the form hides the version-level material / currency /
  // pricing / variant-tier / ink-names sections. Flipping back to
  // shared-pricing restores them. State is preserved across mode
  // flips so a designer can switch without losing their config.
  const [isPerDirectionPricing, setIsPerDirectionPricing] = useState(false)
  // Per-variant sides. frontFiles is always present (every variant
  // has a Front side). backFiles is null when the designer hasn't
  // opted into a Back side; an empty array when they've added the
  // Back drop zone but haven't uploaded yet (validation forces them
  // to either upload or remove the zone before save).
  type VariantDraftRow = {
    key: string
    display_name: string
    frontFiles: File[]
    backFiles: File[] | null
  }
  const [variantRows, setVariantRows] = useState<VariantDraftRow[]>([])
  const variantEditorRef = useRef<HTMLDivElement>(null)

  // ── Proof-type wizard (docs/proof-type-wizard-spec.md) ───────────────────
  // The wizard's answers are the single source that resolves a proof
  // shape and drives the existing mode state (isVariantRound,
  // isPerDirectionPricing, cardType, hasPersonalisation) via
  // handleWizardChange below. On v1 creation it starts blank so the
  // designer routes the proof; on v2+ creation it's seeded from the
  // inherited shape so a continuation doesn't force re-answering.
  const [wizardAnswers, setWizardAnswers] = useState<WizardAnswers>(EMPTY_ANSWERS)

  // ── Set (collection) layouts (Phase 2) ───────────────────────────────────
  // One row per titled layout in a Set (collection). `title` is the
  // customer-facing layout heading; `files` is that layout's queued
  // image set (each File becomes a proof_version_images row with
  // layout_id pointing at the saved proof_layouts row). `key` is a
  // stable client-side id for React. Seeded with two empty rows when the
  // wizard first resolves to set_collection (mirrors the variantRows
  // seeding); preserved across shape flips so a designer can switch back
  // without losing their config. Only persisted on the set_collection
  // save path.
  const [layoutRows, setLayoutRows] = useState<LayoutEditRow[]>([])
  const layoutEditorRef = useRef<HTMLDivElement>(null)
  // Prior-version layout approvals, keyed by the PRIOR proof_layouts.id,
  // loaded when continuing a collection on a new version. Drives the
  // carry-forward decision at save time (see the collection save branch).
  // Each entry mirrors the proof_name_approvals shape we carry.
  const [priorLayoutApprovals, setPriorLayoutApprovals] = useState<
    Record<string, { state: string; actor_name: string; qr_confirmed_at: string | null }>
  >({})

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
  const optionsRef          = useRef<HTMLDivElement>(null)
  const inkNamesRef         = useRef<HTMLDivElement>(null)
  const namesRef            = useRef<HTMLDivElement>(null)
  const frontColourRef      = useRef<HTMLDivElement>(null)
  const coreColourRef       = useRef<HTMLDivElement>(null)
  const backColourRef       = useRef<HTMLDivElement>(null)
  const toastTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stash for undo-after-Remove. Holds the removed entry plus the
  // option key + array index it was at, so undoRemove() can splice
  // it back into its original slot. The timerId fires at 5s and
  // commits the removal (revokes the blob URL, clears the stash).
  // Cleared on undo (timer cancelled), on a second Remove (previous
  // commits early via commitPendingRemoval), at handleSubmit (URL
  // hygiene), and on unmount (prevents URL leak on navigation).
  const lastRemovedRef = useRef<{
    entry: ImageEntry
    optionKey: string
    index: number
    timerId: ReturnType<typeof setTimeout>
  } | null>(null)
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

  // Commit any pending soft-delete on unmount so the blob URL
  // doesn't leak across page navigations. See removeImage for
  // the soft-delete + 5s commit mechanic.
  useEffect(() => {
    return () => {
      commitPendingRemoval()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!proofId) return

    let cancelled = false

    async function load() {
      // Customer name + company for the page chrome, plus the linked
      // Help Scout conversation id so the post-save MessageSendPanel
      // (Ship 2 of intervention 3) knows whether to render the
      // editor or fall back to the no-conversation path. Fires in
      // parallel; not ordering-sensitive.
      void supabase.from('proofs').select('helpscout_conversation_id, contacts(full_name, companies(name))').eq('id', proofId!).single()
        .then(({ data }) => {
          if (cancelled) return
          const row = data as any
          const c = row?.contacts
          if (c) {
            setProofName(c.full_name ?? '')
            setProofCompany(c.companies?.name ?? '')
          }
          setProofHelpScoutConversationId(row?.helpscout_conversation_id ?? null)
        })

      // Materials for the picker. Filtered to active + published +
      // non-archived by default. Inheritance below prepends an
      // archived material back in if the prior version used one,
      // so the designer can continue with it.
      const materialsPromise = supabase
        .from('materials')
        .select('id, code, display_name, requires_ink_names, option_label, display_quantities, multi_variant, archived_at, supports_personalisation')
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
        .select('id, version_number, currency, material_id, displayed_variant_ids, names, ink_names, material_options, card_type, custom_quote, core_colour_id, front_colour_id, back_colour_id, is_variant_round, is_per_direction_pricing, has_personalisation, shape')
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
        // Per migration 000142/000144 the per-direction-pricing variant
        // round leaves currency + material_id NULL; the previous
        // designer-form contract that they're always strings is
        // therefore unsafe to assume. Typed as string | null below
        // so the inheritance branch can short-circuit before stomping
        // the form with nulls.
        currency: string | null
        material_id: string | null
        displayed_variant_ids: string[] | null
        names: string[] | null
        ink_names: string[] | null
        material_options: string[] | null
        card_type: 'business' | 'membership'
        custom_quote: boolean
        core_colour_id: string | null
        front_colour_id: string | null
        back_colour_id: string | null
        is_variant_round: boolean | null
        is_per_direction_pricing: boolean | null
        has_personalisation: boolean | null
        shape: string | null
      } | null

      if (inherited) {
        // Names chip-list — previously pulled from "latest created"
        // in a separate query; now folded into this one so it
        // tracks the same is_current version as the other fields.
        const inheritedNames = Array.isArray(inherited.names) ? inherited.names : []
        if (inheritedNames.length > 0) {
          setNames(inheritedNames)
        }

        // Per-direction-pricing variant rounds carry NULL currency +
        // material_id (000142/000144). Inheriting those nulls into a
        // form that types both as required strings shows a confusing
        // empty state to the designer ("where did the currency go?")
        // and forces them to re-pick before save validation passes.
        // Skip the inheritance for both fields when v(N-1) was per-
        // direction-pricing; the settings-defaults fetch downstream
        // will hydrate the currency from the admin-configured default.
        const inheritStandardPricing = !inherited.is_per_direction_pricing
        if (inheritStandardPricing && inherited.currency) {
          // Currency — always inheritable from a standard-pricing
          // source version.
          setCurrency(inherited.currency as Currency)
          currencyInherited = true
        }

        // Material — if the inherited material is archived, it
        // won't appear in the filtered list above. Fetch it
        // unfiltered and prepend so the picker can still show it
        // as the selected value. Skipped entirely for per-direction-
        // pricing rounds since material_id is NULL there.
        if (inheritStandardPricing && inherited.material_id) {
          const inMain = materialsList.some((m) => m.id === inherited.material_id)
          if (!inMain) {
            const { data: archivedMatData } = await supabase
              .from('materials')
              .select('id, code, display_name, requires_ink_names, option_label, display_quantities, multi_variant, archived_at, supports_personalisation')
              .eq('id', inherited.material_id)
              .maybeSingle()
            if (!cancelled && archivedMatData) {
              materialsList = [archivedMatData as Material, ...materialsList]
              setInheritedMaterialArchived(true)
            }
          }
          setMaterials(materialsList)
          setSelectedMaterialId(inherited.material_id)
        } else {
          setMaterials(materialsList)
        }

        // Variants — stash in a ref for the variants-loading
        // effect to consume once the material's variants finish
        // loading. Without this, the material-effect's auto-select
        // would stomp the inherited IDs before they could be
        // applied. Source flipped to displayed_variant_ids in
        // migration 000118; legacy rows pre-dating the column
        // were backfilled from the snapshot.
        const variantIds = Array.isArray(inherited.displayed_variant_ids)
          ? inherited.displayed_variant_ids
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
        // Stash the variant-round source flag so the options effect
        // can skip its base-option fallback when v(N-1) was a variant
        // round. See the ref declaration for the rationale.
        if (inherited.is_variant_round === true) {
          inheritedSourceIsVariantRoundRef.current = true
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

        // Letterpress layer colours (migrations 000133 + 000135).
        // Carry forward the prior version's three choices. The
        // visible-only-on-letterpress gating in the validations
        // object means non-null values stick around safely if the
        // designer keeps the same material, and are ignored on save
        // if they switch away (handleMaterialChange clears them).
        if (inherited.front_colour_id) {
          setSelectedFrontColourId(inherited.front_colour_id)
        }
        if (inherited.core_colour_id) {
          setSelectedCoreColourId(inherited.core_colour_id)
        }
        if (inherited.back_colour_id) {
          setSelectedBackColourId(inherited.back_colour_id)
        }

        // Stash partial snapshot values; sidedness + shared get
        // derived from v1's images in the image-loading block
        // below, where the snapshot is finalised and committed to
        // state.
        //
        // Gated on inheritStandardPricing for the same reason the
        // currency/material setters are: a per-direction-pricing
        // parent has NULL material_id and NULL currency (000142 /
        // 000144), so the snapshot's non-nullable scalar fields
        // can't be populated honestly. Skipping the snapshot
        // entirely on per-direction-pricing parents means v2 from
        // a variant-round v1 renders without carry-forward
        // ribbons, which is the right call: there is nothing
        // standard-pricing-shaped to carry forward.
        if (inheritStandardPricing && inherited.material_id && inherited.currency) {
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
            frontColourId: inherited.front_colour_id,
            coreColourId: inherited.core_colour_id,
            backColourId: inherited.back_colour_id,
          }
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
        // When the predecessor is a variant round we also load its
        // variant catalogue and the most recent customer selection
        // (if any). Both feed the "Continuing from which direction?"
        // picker rendered at the top of the Proof Images section
        // below. Predecessors that are NOT variant rounds skip the
        // variant fetch (Supabase still returns success on an empty
        // result, but the round-trip is unnecessary) and the lock
        // fetch (round_variant_id is null on every standard event).
        const isVariantRoundSource = inherited.is_variant_round === true
        const [imagesResult, approvalsResult, variantsResult, lockResult] = await Promise.all([
          supabase
            .from('proof_version_images')
            .select('id, image_path, original_filename, associated_name, material_option, side, sort_order, is_qr_code, qr_decoded_data, qr_kind, qr_vcard_slug, round_variant_id')
            .eq('proof_version_id', inherited.id)
            .order('sort_order'),
          supabase
            .from('proof_name_approvals')
            .select('*')
            .eq('proof_version_id', inherited.id),
          isVariantRoundSource
            ? supabase
                .from('proof_round_variants')
                .select('id, code, display_name, sort_order')
                .eq('proof_version_id', inherited.id)
                .order('sort_order')
            : Promise.resolve({ data: [], error: null }),
          isVariantRoundSource
            ? supabase
                .from('proof_events')
                .select('round_variant_id')
                .eq('proof_version_id', inherited.id)
                .eq('event_type', 'request_changes')
                .not('round_variant_id', 'is', null)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ])
        if (cancelled) return

        // Migration 000168 — split QR rows out of the artwork
        // carry-forward path before building V1Image previews. The
        // QR rows seed qrEntries directly with source='existing'
        // so the designer sees v1's QRs in the QR section and
        // can keep / remove / add. On save, kept existing entries
        // insert new proof_version_images rows referencing v1's
        // image_path (the safeRemove logic on delete already
        // accounts for multi-version reuse).
        const allImageRows = (imagesResult.data ?? []) as {
          id: string
          image_path: string
          original_filename: string | null
          associated_name: string | null
          material_option: string | null
          side: 'front' | 'back' | null
          sort_order: number
          is_qr_code: boolean | null
          qr_decoded_data: string | null
          qr_kind: QrKind | null
          qr_vcard_slug: string | null
          round_variant_id: string | null
        }[]
        const imageRows = allImageRows.filter((r) => r.is_qr_code !== true)
        const qrRows = allImageRows.filter((r) => r.is_qr_code === true)

        const allImagesWithUrls: V1Image[] = await Promise.all(
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
              round_variant_id: r.round_variant_id,
            }
          }),
        )

        // Variant-round predecessor: decide which variant's images
        // the form should carry by default. Customer's locked
        // selection wins (the customer already declared a direction
        // — the form just confirms it). Without a lock, fall back
        // to the first variant in sort order; the designer can flip
        // the picker if they're advancing a different direction
        // chosen off-platform (the common case during the email-
        // feedback rollout). Filtered to the selected variant's
        // images before any shape derivation runs, so sidedness /
        // shared inference sees only the chosen direction.
        const sourceVariants = (variantsResult.data ?? []) as SourceVariant[]
        const customerLockedVariantId =
          (lockResult.data as { round_variant_id: string | null } | null)?.round_variant_id ?? null
        const defaultCarryVariantId = isVariantRoundSource
          ? (customerLockedVariantId ?? sourceVariants[0]?.id ?? null)
          : null
        const imagesWithUrls: V1Image[] = isVariantRoundSource && defaultCarryVariantId
          ? allImagesWithUrls.filter((img) => img.round_variant_id === defaultCarryVariantId)
          : allImagesWithUrls
        if (isVariantRoundSource) {
          setCarryVariantSelection(defaultCarryVariantId)
        }

        // Seed the QR section with v1's QR rows as 'existing'
        // entries. The designer can keep / remove / add from this
        // baseline; carry-forward of qr_confirmed_at on the
        // associated approvals is gated below on decoded-data
        // byte-identity per slot (migration 000169's contract).
        //
        // Signed URLs are pre-fetched here for EVERY v(N-1) QR row
        // (across all source variants), then filtered to the
        // picked variant for the initial qrEntries state. The
        // unfiltered set goes into v1Carry.allQrEntries so a
        // picker change can re-seed synchronously without a fresh
        // network round-trip. Same logic as images / allImages.
        const allV1QrEntries: QrEntry[] = await Promise.all(
          qrRows.map(async (r) => {
            const { data: urlData } = await supabase.storage
              .from('proof-images')
              .createSignedUrl(r.image_path, 3600)
            return {
              id: r.id,
              source: 'existing' as const,
              imagePath: r.image_path,
              signedUrl: urlData?.signedUrl ?? '',
              decodedData: r.qr_decoded_data ?? '',
              kind: (r.qr_kind ?? 'text') as QrKind,
              associatedName: r.associated_name,
              originalFilename: r.original_filename,
              // Migration 000192: carry the slug forward so the
              // save path can write it on the new row's INSERT, and
              // so the customer page renders the live contact
              // fields via the same slug v1 was confirmed against.
              vcardSlug: r.qr_vcard_slug ?? undefined,
            }
          }),
        )
        // Map v1 QR row id → its round_variant_id. Used both for
        // the initial filter below and as the lookup the picker
        // change handler runs to re-scope qrEntries.
        const qrRowVariantById = new Map<string, string | null>(
          qrRows.map((r) => [r.id, r.round_variant_id ?? null]),
        )
        const v1QrEntries: QrEntry[] = isVariantRoundSource && defaultCarryVariantId
          ? allV1QrEntries.filter(
              (e) => qrRowVariantById.get(e.id) === defaultCarryVariantId,
            )
          : allV1QrEntries
        setQrEntries(v1QrEntries)
        if (cancelled) return

        const approvalsByName: Record<string, ProofNameApproval> = {}
        for (const a of (approvalsResult.data ?? []) as ProofNameApproval[]) {
          approvalsByName[a.name] = a
        }

        const keepDefaults: Record<string, boolean> = {}
        for (const img of imagesWithUrls) keepDefaults[img.v1RowId] = true

        // Mirror the images/allImages split for QR rows: qrRows is
        // the picked-variant subset that the byte-identity check
        // reads; allQrRows holds the full set so picker changes can
        // re-filter without a fresh fetch. Standard-proof
        // predecessors collapse the two onto the same data.
        const allV1QrRows = qrRows.map((r) => ({
          id: r.id,
          associated_name: r.associated_name,
          decoded_data: r.qr_decoded_data ?? '',
          round_variant_id: r.round_variant_id ?? null,
        }))
        const filteredV1QrRows = isVariantRoundSource && defaultCarryVariantId
          ? allV1QrRows.filter((r) => r.round_variant_id === defaultCarryVariantId)
          : allV1QrRows
        setV1Carry({
          versionId: inherited.id,
          versionNumber: inherited.version_number,
          names: Array.isArray(inherited.names) ? inherited.names : [],
          materialOptions: Array.isArray(inherited.material_options) ? inherited.material_options : [],
          images: imagesWithUrls,
          allImages: allImagesWithUrls,
          approvalsByName,
          qrRows: filteredV1QrRows,
          allQrRows: allV1QrRows,
          allQrEntries: allV1QrEntries,
          sourceIsVariantRound: isVariantRoundSource,
          sourceVariants,
          customerLockedVariantId,
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
        // A variant-round prior continues as a single, no-name design —
        // Set (single), whose canonical mapping is card_type='membership'
        // with empty names. Force membership on that path so the no-name
        // shape validates (the names roster is hidden on a Set) and
        // persists as a consistent set_single; otherwise keep the
        // inherited card type.
        setCardType(isVariantRoundSource ? 'membership' : inherited.card_type)
        // Personalisation flag carries across version bumps. The
        // form gate (material + cardType + !isVariantRound) still
        // applies on render, so an inherited true will visually
        // disappear if the new version flips cardType to business,
        // swaps to a material that doesn't support personalisation,
        // or flips into variant-round mode. The persisted value
        // remains until save resolves the gate. Inheriting from a
        // variant-round source is impossible at the DB level
        // (000173 CHECK), so the gate only matters when the new
        // version itself flips to variant-round.
        setHasPersonalisation(
          !!inherited.has_personalisation && !isVariantRoundSource,
        )
        // Seed the proof-type wizard from the inherited version, using
        // the persisted shape column (000210) when present so a
        // collection seeds as a collection rather than mis-seeding as
        // set_single (the flags can't tell them apart). v(N) of a
        // variant round continues the one chosen direction as a single
        // no-name design (setIsVariantRound is never re-asserted on this
        // page; the "Continuing from which direction?" carry picker picks
        // the direction), so seed it as Set (single) — accurate and
        // data-consistent, resolving to "A single business card design"
        // — rather than letting the flags fall through to recipients /
        // "Order everything".
        const seedShape = isVariantRoundSource ? 'set_single' : inherited.shape
        setWizardAnswers(
          deriveAnswersFromVersion({
            shape: seedShape,
            isVariantRound: false,
            isPerDirectionPricing: false,
            cardType: isVariantRoundSource ? 'membership' : inherited.card_type,
            hasPersonalisation: !!inherited.has_personalisation && !isVariantRoundSource,
          }),
        )

        // Continuing a Set (collection) on a new version: seed the
        // Layouts editor from the prior version's layouts + their images
        // (carried by path), and load the prior per-layout approvals so
        // the save path can decide carry-forward. Each row remembers the
        // PRIOR proof_layouts.id (lineage) + its title + its image-id set
        // — the three things the carry-forward "unchanged" test compares.
        if (seedShape === 'set_collection') {
          const [priorLayoutsRes, priorImagesRes, priorApprovalsRes] = await Promise.all([
            supabase
              .from('proof_layouts')
              .select('id, title, sort_order')
              .eq('proof_version_id', inherited.id)
              .order('sort_order'),
            supabase
              .from('proof_version_images')
              .select('id, image_path, original_filename, layout_id, sort_order')
              .eq('proof_version_id', inherited.id)
              .eq('is_qr_code', false)
              .order('sort_order'),
            supabase
              .from('proof_name_approvals')
              .select('name, state, actor_name, qr_confirmed_at')
              .eq('proof_version_id', inherited.id),
          ])
          const priorLayouts = (priorLayoutsRes.data ?? []) as Array<{ id: string; title: string; sort_order: number }>
          const priorImages = (priorImagesRes.data ?? []) as Array<{
            id: string; image_path: string; original_filename: string | null; layout_id: string | null
          }>
          const carriedRows: LayoutEditRow[] = []
          for (const l of priorLayouts) {
            const imgs = priorImages.filter((im) => im.layout_id === l.id)
            const existingImages = await Promise.all(
              imgs.map(async (im) => {
                const { data } = await supabase.storage
                  .from('proof-images')
                  .createSignedUrl(im.image_path, 3600)
                return {
                  id: im.id,
                  imagePath: im.image_path,
                  signedUrl: data?.signedUrl ?? '',
                  originalFilename: im.original_filename,
                }
              }),
            )
            carriedRows.push({
              key: l.id,
              sourceLayoutId: l.id,
              title: l.title,
              sourceTitle: l.title,
              sourceImageIds: imgs.map((im) => im.id),
              existingImages,
              removedExistingIds: [],
              newFiles: [],
            })
          }
          if (carriedRows.length > 0) setLayoutRows(carriedRows)
          const approvalsMap: Record<
            string,
            { state: string; actor_name: string; qr_confirmed_at: string | null }
          > = {}
          for (const a of (priorApprovalsRes.data ?? []) as Array<{
            name: string; state: string; actor_name: string; qr_confirmed_at: string | null
          }>) {
            approvalsMap[a.name] = {
              state: a.state,
              actor_name: a.actor_name,
              qr_confirmed_at: a.qr_confirmed_at ?? null,
            }
          }
          setPriorLayoutApprovals(approvalsMap)
        }
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

  // Letterpress core colour catalogue (migration 000133). Loaded
  // once on mount and reused by the picker. RLS already filters to
  // active rows for designers, so no client-side is_active filter
  // needed here. Sort order matches the admin-set sort_order with a
  // name tiebreak.
  useEffect(() => {
    let cancelled = false
    supabase
      .from('letterpress_core_colours')
      .select('id, name, hex_value, is_active, sort_order')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .then(({ data }) => {
        if (cancelled) return
        setCoreColours((data ?? []) as LetterpressCoreColour[])
      })
    return () => { cancelled = true }
  }, [])

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
          // Variant-round predecessors don't carry an option signal —
          // a v1 variant round comparing 5 wood species exposes nothing
          // about which species v2 is for. Falling through to the base
          // option here silently picks Black Walnut while the variant
          // picker shows whatever direction the designer chose to carry,
          // and on save the carry image gets stamped with the base
          // code (see the stampedFirstOption path lower down). Leave
          // selectedOptions empty so the option-picker validation
          // surfaces it as a required choice the designer has to make.
          // Cleared after consumption so a subsequent material swap on
          // the same form still gets the friendly base-option default.
          if (inheritedSourceIsVariantRoundRef.current) {
            inheritedSourceIsVariantRoundRef.current = false
            setSelectedOptions([])
            setActiveImageOption('')
            setImagesByOption({})
            // Auto-expand the form when v(N-1) was a variant round.
            // The summary card alone can't surface the empty option
            // chips, and asking the designer to click Edit details to
            // discover that an option needs picking is friction with
            // no upside — the form already knows it's invalid the
            // moment this branch fires. Mirrors the Start-fresh
            // handler's auto-expand for the same reason.
            setFormExpanded(true)
          } else {
            const base = options.find((o) => o.is_base) ?? options[0]
            setSelectedOptions([base.code])
            setActiveImageOption(base.code)
            setImagesByOption({ [base.code]: [] })
          }
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
  // Smart-replace on v2+ flows: when a file resolves to a slot that
  // already has a v1 carry image, the file queues as a replacement
  // on that v1 row instead of being added as a fresh entry. First
  // file in the batch matching a given v1 row claims it; subsequent
  // files matching the same v1 row in the same batch fall through
  // to the fresh-entry path on the same slot (multi-image-per-slot
  // is a valid state the cell builder already renders).
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

    // Duplicate detection across both fresh entries and queued
    // replacements on the active option. Signature is name + size,
    // robust enough for accidental re-drags of the same Finder
    // selection without needing to read file bytes. Smart-replace
    // can route a previously-dropped file into replacementByV1RowId
    // instead of imagesByOption, so the dedup pool spans both
    // surfaces; without this, a re-drop of the same file in the
    // same session would silently overwrite a queued replacement
    // (or land as a duplicate fresh entry alongside it).
    // Skipped duplicates surface in fileNote, never in fileError
    // (the designer's intent is benign).
    const freshSignatures = (imagesByOption[optionCode] ?? []).map(
      (e) => `${e.file.name}|${e.file.size}`,
    )
    const replacementSignatures = v1Carry
      ? v1Carry.images
          .filter((img) => (img.material_option ?? '') === optionCode)
          .map((img) => replacementByV1RowId[img.v1RowId])
          .filter((r): r is NonNullable<typeof r> => !!r)
          .map((r) => `${r.file.name}|${r.file.size}`)
      : []
    const existingSignatures = new Set([...freshSignatures, ...replacementSignatures])
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
      if (effectiveShared) {
        // Shared front collapses to a single shared identity;
        // back stays per-identity. `effectiveShared` matches the
        // slot universe rule (shared collapses to per-name when
        // names.length === 1), so this resolver doesn't suggest a
        // SHARED slot the cell builder won't render.
        return identity == null ? ['front'] : (names.includes(identity) ? ['back'] : [])
      }
      // Two-sided + not shared (or shared collapsing for the 1-name
      // case): per-identity on both sides.
      return identity == null ? [] : (names.includes(identity) ? ['front', 'back'] : [])
    }

    // Per-batch alternator for hintless files where the chosen
    // identity has both sides available. Resets per drop so two
    // consecutive single-file drops both start front. The
    // alternator only ticks when pickSideFor enters the both-
    // sides-no-hint branch, so a batch of single-side-only files
    // does not desync the rhythm for later both-sides-available
    // files.
    let nextHintlessSide: 'front' | 'back' = 'front'
    function alternateSide(): 'front' | 'back' {
      const s = nextHintlessSide
      nextHintlessSide = nextHintlessSide === 'front' ? 'back' : 'front'
      return s
    }

    // Claim tally for the both-sides-no-hint branch of pickSideFor.
    // Records every (identity, side) that the resolver should treat
    // as already taken: fresh entries dropped on this option in
    // earlier batches, plus every file resolved by earlier
    // iterations of the current batch. When exactly one side of
    // the chosen identity is taken, the unclaimed side wins and
    // the alternator's tick is discarded. Stops a hint-driven
    // Front.jpg from making a sibling hintless file double up on
    // the same slot, and stops a second drop from piling onto a
    // slot the first drop already filled.
    //
    // v1 carries do not seed the set: smart-replace continues to
    // behave as today (a hintless file can resolve to a v1-occupied
    // slot and queue a replacement).
    const claimedSlots = new Set<string>()
    const claimKey = (id: string | null, s: 'front' | 'back') =>
      `${id ?? '__shared__'}|${s}`
    // Seed from prior-batch fresh entries on the active option.
    // Entries with a null side (legacy data) are skipped — they
    // can't be unambiguously bucketed and shouldn't pre-block a
    // side. Replacement queues for v1 rows are deliberately not
    // seeded (see scope note above).
    for (const entry of imagesByOption[optionCode] ?? []) {
      if (entry.side != null) {
        claimedSlots.add(claimKey(entry.associated_name, entry.side))
      }
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
    if (isMembershipSingle || (sidedness === 'two-sided' && effectiveShared)) {
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
        // Both sides available, no hint. Tick the alternator
        // unconditionally so the front/back rhythm stays in sync
        // across the batch. Then check the in-batch claim tally:
        // if exactly one side of this identity is already taken
        // by an earlier file, take the free side instead. If both
        // or neither are taken, the alternator's tick wins.
        const tick = alternateSide()
        const frontTaken = claimedSlots.has(claimKey(identity, 'front'))
        const backTaken = claimedSlots.has(claimKey(identity, 'back'))
        if (frontTaken && !backTaken) return 'back'
        if (backTaken && !frontTaken) return 'front'
        return tick
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
      // towards a front-supporting identity. Two-pass: prefer a
      // candidate whose hinted slot is not already claimed by an
      // earlier file in this batch, then fall back to any
      // candidate that supports the hint so a hint can still
      // resolve when every candidate slot is claimed.
      if (heuristicSide != null) {
        for (const candidate of fallbackOrder) {
          const sides = availableSidesForIdentity(candidate)
          if (sides.length === 0) continue
          if (!sides.includes(heuristicSide)) continue
          if (!claimedSlots.has(claimKey(candidate, heuristicSide))) {
            return { identity: candidate, side: heuristicSide }
          }
        }
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

    // Smart-replace lookup. Returns the v1 image at the given
    // (identity, side) on the active option, or undefined if no v1
    // image lives there. Normalises material_option ?? '' (matches
    // the active-option convention used in imagesByOption keys) and
    // side ?? 'front' (back-compat for pre-migration v1 data with
    // null sides). Identity comparison is direct because both this
    // file's resolved identity and V1Image.associated_name use the
    // same null-means-shared convention.
    function findV1CarryAt(identity: string | null, side: 'front' | 'back'): V1Image | undefined {
      if (!v1Carry) return undefined
      return v1Carry.images.find((img) =>
        (img.material_option ?? '') === optionCode &&
        img.associated_name === identity &&
        (img.side ?? 'front') === side,
      )
    }

    const newEntries: ImageEntry[] = []
    const replacementsToQueue: { v1RowId: string; file: File }[] = []
    const orphanFilenames: string[] = []
    // First-wins claim set per batch. A v1 row can only be replaced
    // once per drop event; subsequent files in the same batch that
    // resolve to the same v1-occupied slot fall through to fresh-
    // entry placement on that slot (multi-image-per-slot is fine).
    // Cross-batch behaviour stays "last-wins" because a fresh drop
    // event re-runs the lookup and overwrites the previous queued
    // replacement (matches CarryCard's per-card drop semantics).
    const claimedV1RowIds = new Set<string>()

    // Hint-first scheduling. Files whose filename surfaces a side
    // hint (Front/Back token, or one-sided mode where every file
    // is implicitly front-hinted) are processed before hintless
    // files so their slot claims seed claimedSlots before the
    // alternator runs for hintless files. Without this, a hintless
    // name-matched file (e.g. "DavidFindel.jpg") can pick the same
    // side the alternator points at, then a later hint-bearing
    // file (e.g. "Front.jpg") with no name match falls through to
    // the same (identity, side) — replacing one v1 carry while
    // leaving the other unfilled and stamping a duplicate fresh
    // card on the already-claimed slot. resolveSlot still re-runs
    // matchImageToName once per file; the partition pass only
    // reads .side and discards the rest.
    const hintedFirst: File[] = []
    const hintless: File[] = []
    for (const file of dedupedOk) {
      const sideHint = sidedness === 'one-sided'
        ? 'front'
        : matchImageToName(file.name, names).side
      if (sideHint != null) hintedFirst.push(file)
      else hintless.push(file)
    }
    const orderedFiles = [...hintedFirst, ...hintless]

    for (const file of orderedFiles) {
      const slot = resolveSlot(file)
      if (slot == null) {
        orphanFilenames.push(file.name)
        continue
      }
      claimedSlots.add(claimKey(slot.identity, slot.side))

      const v1Match = findV1CarryAt(slot.identity, slot.side)
      if (v1Match && !claimedV1RowIds.has(v1Match.v1RowId)) {
        claimedV1RowIds.add(v1Match.v1RowId)
        replacementsToQueue.push({ v1RowId: v1Match.v1RowId, file })
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

    // Commit replacements. handleReplacementUpload owns the queue
    // mutation and the keepByV1RowId flip-off; revoking the prior
    // preview here mirrors handleReplacementDrop. Reads from a
    // closure snapshot of replacementByV1RowId, but each iteration
    // calls the setter which queues correctly even if the same v1
    // row appears more than once across separate drop events
    // (within one event the claim set forbids repeats).
    for (const r of replacementsToQueue) {
      const existing = replacementByV1RowId[r.v1RowId]
      if (existing) URL.revokeObjectURL(existing.preview)
      handleReplacementUpload(r.v1RowId, r.file)
    }

    // Append fresh entries.
    if (accepted.length > 0) {
      setImagesByOption((prev) => ({
        ...prev,
        [optionCode]: [...(prev[optionCode] ?? []), ...accepted],
      }))
    }

    // fileNote assembly. Two layers:
    //   1. Success clause (when at least one file landed): one of
    //      three branches based on the fresh/replacement split.
    //   2. Trailing rejection clauses (cap overflow, type/size,
    //      duplicates) appended in order.
    // Surface rule: replacement-bearing batches always show the
    // note (the action is informative even with no rejections).
    // Fresh-only batches keep the existing "show only when there's
    // something else to report" suppression — the cards appearing
    // already communicate the success. Duplicate-only batches
    // (every file dedup'd) show the duplicate clause standalone so
    // a re-drop doesn't appear silently ignored.
    const freshAdded = accepted.length
    const replaced = replacementsToQueue.length
    const totalLanded = freshAdded + replaced
    const v1VersionLabel = v1Carry ? `v${v1Carry.versionNumber}` : 'v1'
    const noteParts: string[] = []
    if (totalLanded > 0) {
      if (freshAdded > 0 && replaced > 0) {
        noteParts.push(`Added ${totalLanded}: ${freshAdded} new, ${replaced} replacing ${v1VersionLabel}.`)
      } else if (replaced > 0) {
        noteParts.push(`Replaced ${replaced} ${v1VersionLabel} image${replaced === 1 ? '' : 's'}.`)
      } else {
        noteParts.push(`Added ${freshAdded}.`)
      }
    }
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
    // Show conditions:
    //   * Anything replaced — always show.
    //   * Anything else to report alongside the bare success — show.
    //   * Nothing landed but there are duplicates / rejections — show
    //     so the designer sees why the drop produced no visible cards.
    //   * Bare fresh-only success with no rejections — suppress.
    const shouldShowNote =
      replaced > 0 ||
      (totalLanded > 0 && noteParts.length > 1) ||
      (totalLanded === 0 && noteParts.length > 0)
    if (shouldShowNote) setFileNote(noteParts.join(' '))
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

  // Soft remove with a 5s undo window (test-report finding (h)).
  //
  // The Remove button on FreshImageCard sits at the bottom-right
  // of each tile, near where the user expects "Save version" to
  // sit on the sticky bar. A misclick can silently drop an
  // uploaded image. Soft-delete + Undo toast forgives that.
  //
  // Mechanic:
  //   1. Find the entry across option tabs (each ImageEntry was
  //      stamped with a specific option at drop time, so a walk
  //      is necessary — the active-tab-only approach was wrong
  //      under the per-slot layout where multiple tabs may hold
  //      entries).
  //   2. If a prior Undo is still pending, commit it now — revokes
  //      the prior entry's URL and clears the stash. Prevents
  //      stash leak on rapid back-to-back Removes.
  //   3. Drop the entry from imagesByOption (visual feedback is
  //      instant) but DO NOT revoke its blob URL yet. The URL
  //      stays alive in the stash for potential Undo.
  //   4. Stash the entry + its origin (option key, array index)
  //      so undoRemove can splice it back at the same position.
  //   5. Schedule a 5s timer that revokes the URL, clears the
  //      stash, and dismisses the toast (only if the toast is
  //      still the undo toast — the functional setter guards
  //      against a validation toast overwriting it mid-window).
  //   6. Show the slate Undo toast with the recovery action.
  function removeImage(localId: string) {
    let foundEntry: ImageEntry | null = null
    let foundKey = ''
    let foundIndex = -1
    for (const [key, list] of Object.entries(imagesByOption)) {
      const idx = list.findIndex((e) => e.localId === localId)
      if (idx >= 0) {
        foundEntry = list[idx]
        foundKey = key
        foundIndex = idx
        break
      }
    }
    if (!foundEntry) return

    commitPendingRemoval()

    setImagesByOption((prev) => ({
      ...prev,
      [foundKey]: (prev[foundKey] ?? []).filter((e) => e.localId !== localId),
    }))

    const entry = foundEntry
    const timerId = setTimeout(() => {
      URL.revokeObjectURL(entry.preview)
      if (lastRemovedRef.current?.entry.localId === entry.localId) {
        lastRemovedRef.current = null
      }
      setToast((curr) => (curr?.kind === 'undo' ? null : curr))
    }, 5000)

    lastRemovedRef.current = { entry, optionKey: foundKey, index: foundIndex, timerId }
    setToast({ kind: 'undo', text: 'Image removed', onUndo: undoRemove })
  }

  // Splice the stashed entry back into its original slot and
  // dismiss the toast. No-op if the stash is empty (e.g. user
  // double-clicked Undo, or the 5s timer already fired).
  function undoRemove() {
    const stash = lastRemovedRef.current
    if (!stash) return
    clearTimeout(stash.timerId)
    setImagesByOption((prev) => {
      const list = [...(prev[stash.optionKey] ?? [])]
      list.splice(stash.index, 0, stash.entry)
      return { ...prev, [stash.optionKey]: list }
    })
    lastRemovedRef.current = null
    setToast(null)
  }

  // Finalise any pending removal early. Called by:
  //   - removeImage (when a second Remove arrives within 5s)
  //   - handleSubmit (URL hygiene before save)
  //   - useEffect cleanup on unmount (prevents URL leak)
  function commitPendingRemoval() {
    const stash = lastRemovedRef.current
    if (!stash) return
    clearTimeout(stash.timerId)
    URL.revokeObjectURL(stash.entry.preview)
    lastRemovedRef.current = null
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
    const removedSet = new Set(removed)
    // Compute the slot universe under the proposed names list and
    // route every fresh entry through it. Three transformations land
    // on the new (assoc, side) coordinate that best matches each
    // entry's current identity, in priority order:
    //
    //   1. Removed-name re-stamp — an entry tagged with a name that
    //      no longer exists collapses to `null` (the shared identity)
    //      first. Earlier code only did this; everything below is the
    //      symmetry that closes the gaps.
    //
    //   2. SHARED-collapse re-stamp — an entry sitting in a slot whose
    //      SHARED-side just disappeared (names ≤1 in shared=true; flips
    //      effectiveShared from true→false) gets re-stamped to the new
    //      first name so it lands in a real per-name slot.
    //
    //   3. SHARED-expand re-stamp — an entry tagged with a name on a
    //      side that just COLLAPSED into SHARED (names crossed from
    //      ≤1 to ≥2 in shared=true; effectiveShared flips false→true)
    //      gets re-stamped to null. Mirror of (2) in the opposite
    //      direction — closes the orphan path where Rob's per-name
    //      front upload silently vanishes when the designer adds Sue.
    //
    // Any entry that still doesn't fit the new slot universe after the
    // three transformations is dropped (with preview URL revoked).
    // Slot universe with names=[] in business mode is genuinely empty
    // and uploads can't be preserved — silent drop matches the cell
    // builder's "no slot, no render" behaviour and keeps the chip
    // input fast (no confirm dialog mid-typing).
    const prevEffectiveShared = shared && names.length !== 1
    const nextEffectiveShared = shared && next.length !== 1
    const effectiveSharedChanged = prevEffectiveShared !== nextEffectiveShared
    // Cardtype × names=[] is also a shape boundary, since
    // membership-single (membership + names=[]) flips to/from
    // ordinary per-name shapes as names crosses 0. Captured here
    // for symmetry; in practice the boundary cases are subsumed
    // by removed.length > 0 or effectiveSharedChanged.
    const prevIsMembershipSingle = cardType === 'membership' && names.length === 0
    const newIsMembershipSingle = cardType === 'membership' && next.length === 0
    const membershipSingleChanged = prevIsMembershipSingle !== newIsMembershipSingle
    const newHasSharedForSide = (side: 'front' | 'back'): boolean => {
      if (newIsMembershipSingle) return true
      return sidedness === 'two-sided' && nextEffectiveShared && side === 'front'
    }
    const newSlotStillValid = (assoc: string | null, side: 'front' | 'back' | null): boolean => {
      const s: 'front' | 'back' = side ?? 'front'
      if (s === 'back' && sidedness === 'one-sided') return false
      if (newIsMembershipSingle) return assoc == null
      const isSharedSlotForSide = sidedness === 'two-sided' && nextEffectiveShared && s === 'front'
      if (isSharedSlotForSide) return assoc == null
      return assoc != null && next.includes(assoc)
    }
    if (removed.length > 0 || effectiveSharedChanged || membershipSingleChanged) {
      // Fresh images: walk the priority chain, drop the leftovers.
      // `dropped` carries entries that fall out so their preview
      // blob URLs get revoked outside the state update (revoking
      // inside the updater would fire twice under StrictMode).
      const dropped: ImageEntry[] = []
      setImagesByOption((prev) => {
        const out: Record<string, typeof prev[string]> = {}
        for (const [key, list] of Object.entries(prev)) {
          const kept: ImageEntry[] = []
          for (const img of list) {
            const side: 'front' | 'back' = (img.side ?? 'front') as 'front' | 'back'
            let nextAssoc: string | null = img.associated_name
            // (1) Removed-name → null.
            if (nextAssoc != null && removedSet.has(nextAssoc)) {
              nextAssoc = null
            }
            // (2) Landed at null but the new shape has no SHARED slot
            //     for this side — re-stamp to the first new name.
            if (nextAssoc == null && !newHasSharedForSide(side) && next.length > 0) {
              nextAssoc = next[0]
            }
            // (3) Landed at per-name but the new shape now has SHARED
            //     for this side — collapse to null.
            if (nextAssoc != null && newHasSharedForSide(side)) {
              nextAssoc = null
            }
            if (!newSlotStillValid(nextAssoc, side)) {
              dropped.push(img)
              continue
            }
            kept.push(nextAssoc !== img.associated_name ? { ...img, associated_name: nextAssoc } : img)
          }
          out[key] = kept
        }
        return out
      })
      if (dropped.length > 0) {
        for (const entry of dropped) URL.revokeObjectURL(entry.preview)
      }

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
      if (v1Carry && removed.length > 0) {
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

  // Re-scope the carry-forward to a different source variant. Called
  // by the picker rendered at the top of the Proof Images section
  // when v(N-1) was a variant round.
  //
  // Re-filters v1Carry.images down to the newly-chosen variant's
  // images (the unfiltered set lives in v1Carry.allImages, populated
  // once at load time). Keep state is reset to true for every image
  // in the new variant — same default as the initial load. Any
  // pending replacement files for the previous variant's images get
  // cleaned up so we don't leak blob URLs or carry stale designer
  // input across direction flips.
  //
  // Shape inheritance (sidedness / shared) is NOT re-derived here.
  // If the previous variant was 2-sided and the new variant is 1-
  // sided, the form's sidedness control stays at 2-sided and the
  // designer can flip it manually if needed. Re-deriving silently
  // would risk stomping on whatever shape choices the designer has
  // already made — picker changes are conceptually about scope, not
  // structure.
  //
  // No-op when the predecessor wasn't a variant round; the picker
  // doesn't render on that path so this handler shouldn't be
  // called.
  function handleCarryVariantChange(nextVariantId: string) {
    if (!v1Carry || !v1Carry.sourceIsVariantRound) return
    if (nextVariantId === carryVariantSelection) return
    // Start fresh: drop every carry, leave the slots empty so the
    // designer can upload entirely new artwork. The sentinel value
    // is also what the downstream consumers (render, validation,
    // save) see — but they all short-circuit on an empty
    // v1Carry.images regardless, so the sentinel itself only
    // matters for the picker's chip-selection styling and the
    // hint copy below.
    const refiltered =
      nextVariantId === START_FRESH_SENTINEL
        ? []
        : v1Carry.allImages.filter((img) => img.round_variant_id === nextVariantId)
    const previousVariantImages = v1Carry.images
    const refilteredIds = new Set(refiltered.map((i) => i.v1RowId))
    const orphaned = previousVariantImages.filter((img) => !refilteredIds.has(img.v1RowId))

    // Mirror the image re-scope for QR rows: filter v1Carry.qrRows
    // (byte-identity source) down to the picked variant, and re-
    // seed qrEntries from the pre-fetched allQrEntries cache. The
    // 'new' QR entries the designer added in this session survive
    // the flip; only 'existing' entries get re-scoped to the new
    // variant. qrKeepOverrides are pruned to keys still present
    // in the re-seeded entries so a stale override doesn't bleed
    // across direction changes.
    const refilteredQrRows =
      nextVariantId === START_FRESH_SENTINEL
        ? []
        : v1Carry.allQrRows.filter((r) => r.round_variant_id === nextVariantId)
    const newVariantExistingIds = new Set(refilteredQrRows.map((r) => r.id))
    const newVariantExistingEntries = v1Carry.allQrEntries.filter((e) =>
      newVariantExistingIds.has(e.id),
    )
    const refilteredQrEntries: QrEntry[] = [
      ...newVariantExistingEntries,
      ...qrEntries.filter((e) => e.source === 'new'),
    ]
    const survivingQrIds = new Set(refilteredQrEntries.map((e) => e.id))
    setCarryVariantSelection(nextVariantId)
    setV1Carry({ ...v1Carry, images: refiltered, qrRows: refilteredQrRows })
    const nextKeep: Record<string, boolean> = {}
    for (const img of refiltered) nextKeep[img.v1RowId] = true
    setKeepByV1RowId(nextKeep)
    setQrEntries(refilteredQrEntries)
    setQrKeepOverrides((prev) => {
      const out: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (survivingQrIds.has(k)) out[k] = v
      }
      return out
    })
    cleanupReplacementsFor(orphaned)
    // Shape state per picker selection.
    //
    // Start fresh: reset shared=false so the slot universe behaves
    // predictably — per-name front + per-name back once a name lands,
    // 0 slots until then (the inherited shared=true from the variant
    // round would otherwise produce a single shared-front slot with
    // nowhere for the back to sit, even though sidedness carried as
    // two-sided). Also auto-expand the form so the designer can see
    // the required fields they now need to fill in.
    //
    // Leaving Start fresh (sentinel → real variant): restore
    // shared=true so variant-round images can land in a SHARED slot
    // on 0-name shapes (without it, the null-assoc carry has nowhere
    // to render). For 1-name shapes the slot universe collapses
    // shared to per-name via effectiveShared and the carry filter
    // re-maps null-assoc images to the first name; the value of
    // `shared` doesn't matter there. For 2+-name shapes, shared=true
    // gives SHARED front + per-name backs.
    //
    // Real variant → different real variant: leave `shared` alone.
    // Whatever the designer picked earlier (toggled off manually,
    // or kept at the inherited value) stays — picker changes are
    // scope, not structure. Forcing shared=true here would stomp on
    // any explicit toggle the designer made between flips.
    if (nextVariantId === START_FRESH_SENTINEL) {
      // Match handleSharedChange's ON→OFF fresh-orphan cleanup,
      // silently — Start fresh is itself the designer's "discard
      // everything from this carry context" gesture, so prompting
      // again with a confirm here would be a second nag for one
      // intent. Any front upload they made into the SHARED slot
      // (assoc=null) before clicking Start fresh would orphan once
      // shared flips to false, since the new slot universe is per-
      // name and the null-assoc entry has no slot to land in. The
      // cell builder hides them from view; without this cleanup
      // they'd silently persist in imagesByOption and get written
      // through freshInserts on save.
      if (shared) {
        const vanishingFresh: ImageEntry[] = []
        for (const list of Object.values(imagesByOption)) {
          for (const entry of list) {
            if ((entry.side ?? 'front') !== 'front') continue
            if (entry.associated_name == null) vanishingFresh.push(entry)
          }
        }
        if (vanishingFresh.length > 0) {
          const idsToDrop = new Set(vanishingFresh.map((e) => e.localId))
          for (const entry of vanishingFresh) URL.revokeObjectURL(entry.preview)
          setImagesByOption((prev) => {
            const out: Record<string, ImageEntry[]> = {}
            for (const [key, list] of Object.entries(prev)) {
              out[key] = list.filter((e) => !idsToDrop.has(e.localId))
            }
            return out
          })
        }
      }
      setShared(false)
      setFormExpanded(true)
    } else if (carryVariantSelection === START_FRESH_SENTINEL) {
      // Mirror of the Start-fresh cleanup above, opposite direction.
      // Going sentinel → real variant flips shared from false → true.
      // For 2+-name shapes that brings SHARED-front into effect, so
      // any per-name front fresh upload the designer made during the
      // Start-fresh phase (e.g. added Rob and Sue, uploaded Rob front)
      // would orphan once SHARED-front takes over. Silent drop to
      // match the entry-into-Start-fresh path; the picker click is
      // itself the designer's directional choice, not a sub-action
      // worth prompting on.
      //
      // 1-name shapes leave effectiveShared collapsed (per-name)
      // even with shared=true, so no orphan path fires there. 0-name
      // shapes have no per-name entries to lose. Only the 2+-name
      // branch needs the cleanup.
      const nextEffectiveShared = names.length !== 1 && names.length > 0
      if (sidedness === 'two-sided' && nextEffectiveShared) {
        const vanishingFresh: ImageEntry[] = []
        for (const list of Object.values(imagesByOption)) {
          for (const entry of list) {
            if ((entry.side ?? 'front') !== 'front') continue
            if (entry.associated_name != null) vanishingFresh.push(entry)
          }
        }
        if (vanishingFresh.length > 0) {
          const idsToDrop = new Set(vanishingFresh.map((e) => e.localId))
          for (const entry of vanishingFresh) URL.revokeObjectURL(entry.preview)
          setImagesByOption((prev) => {
            const out: Record<string, ImageEntry[]> = {}
            for (const [key, list] of Object.entries(prev)) {
              out[key] = list.filter((e) => !idsToDrop.has(e.localId))
            }
            return out
          })
        }
      }
      setShared(true)
    }
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
      // the prompt — non-approved carries are silently dropped.
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
    //   ON→OFF: shared-front images vanish (front slot universe
    //           collapses to per-name).
    //   OFF→ON: per-name front images vanish (front slot universe
    //           collapses to a single shared slot).
    // Back-side images are unaffected either way.
    //
    // Both v1 carries AND designer-uploaded fresh entries are at
    // risk when the front slot universe collapses; the cleanup
    // mirrors handleSidednessChange's two-bucket pattern so the
    // designer doesn't accidentally save an orphan front image
    // that the cell builder is hiding from view.
    const vanishingV1 = v1Carry
      ? v1Carry.images.filter((i) => {
          if ((i.side ?? 'front') !== 'front') return false
          return next ? i.associated_name != null : i.associated_name == null
        })
      : []
    const vanishingFresh: { optionCode: string; entry: ImageEntry }[] = []
    for (const [optionCode, list] of Object.entries(imagesByOption)) {
      for (const entry of list) {
        if ((entry.side ?? 'front') !== 'front') continue
        const wouldOrphan = next
          ? entry.associated_name != null
          : entry.associated_name == null
        if (wouldOrphan) vanishingFresh.push({ optionCode, entry })
      }
    }
    // Unified confirm — same shape handleSidednessChange uses.
    // Prompts whenever any approved-v1 image OR any fresh upload
    // is at risk, so the designer sees the full impact of the
    // toggle before losing work.
    if (vanishingV1.length > 0 || vanishingFresh.length > 0) {
      const v1ApprovedCount = vanishingV1.filter((i) => {
        const key = i.associated_name ?? SHARED_APPROVAL_KEY
        return v1Carry?.approvalsByName[key]?.state === 'approved'
      }).length
      if (v1ApprovedCount > 0 || vanishingFresh.length > 0) {
        const carriedLabel = v1ApprovedCount === 1 ? '1 carried image' : `${v1ApprovedCount} carried images`
        const uploadedLabel = vanishingFresh.length === 1 ? '1 uploaded image' : `${vanishingFresh.length} uploaded images`
        const proceed = window.confirm(
          `Toggling shared ${next ? 'on' : 'off'} will discard ${carriedLabel} and ${uploadedLabel}. Continue?`,
        )
        if (!proceed) return
      }
    }
    cleanupReplacementsFor(vanishingV1)
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
    setShared(next)
  }

  function handleCardTypeChange(next: 'business' | 'membership') {
    if (next === cardType) return
    // Card type flipping affects the slot universe only when
    // names[] transitions between empty and non-empty. Under the
    // new tiered-membership model, cardType no longer changes
    // the shape when names has ≥1 entries — both modes produce
    // identical per-identity slots, differing only in UI copy
    // and validation relaxation. So vanishing images are computed
    // against the proposed (cardType=next) slot universe using the
    // same rule as save-path slotStillValid.
    //
    // Both v1 carries AND designer-uploaded fresh entries are at
    // risk when names=[] and the flip moves between
    // "single shared slot per side" (membership-single) and the
    // shared/sidedness-derived business-side shape. Cleanup mirrors
    // handleSidednessChange / handleSharedChange's two-bucket
    // pattern so fresh entries don't silently persist as orphans
    // in imagesByOption past the flip.
    const proposedMembershipSingle = next === 'membership' && names.length === 0
    const wouldOrphan = (assocName: string | null, side: 'front' | 'back' | null): boolean => {
      const normalizedSide: 'front' | 'back' = side ?? 'front'
      if (normalizedSide === 'back' && sidedness === 'one-sided') return true
      if (proposedMembershipSingle) {
        // Only a single Shared slot per side exists; per-identity
        // images orphan.
        return assocName != null
      }
      const isSharedSlotForSide =
        sidedness === 'two-sided' && effectiveShared && normalizedSide === 'front'
      if (isSharedSlotForSide) return assocName != null
      if (assocName == null) return true
      return !names.includes(assocName)
    }
    const vanishingV1: V1Image[] = v1Carry
      ? v1Carry.images.filter((img) => wouldOrphan(img.associated_name, img.side))
      : []
    const vanishingFresh: { optionCode: string; entry: ImageEntry }[] = []
    for (const [optionCode, list] of Object.entries(imagesByOption)) {
      for (const entry of list) {
        if (wouldOrphan(entry.associated_name, entry.side)) {
          vanishingFresh.push({ optionCode, entry })
        }
      }
    }
    if (vanishingV1.length > 0 || vanishingFresh.length > 0) {
      const v1ApprovedCount = vanishingV1.filter((i) => {
        const key = i.associated_name ?? SHARED_APPROVAL_KEY
        return v1Carry?.approvalsByName[key]?.state === 'approved'
      }).length
      if (v1ApprovedCount > 0 || vanishingFresh.length > 0) {
        const carriedLabel = v1ApprovedCount === 1 ? '1 carried image' : `${v1ApprovedCount} carried images`
        const uploadedLabel = vanishingFresh.length === 1 ? '1 uploaded image' : `${vanishingFresh.length} uploaded images`
        const proceed = window.confirm(
          `Switching to ${next} will discard ${carriedLabel} and ${uploadedLabel}. Continue?`,
        )
        if (!proceed) return
      }
    }
    cleanupReplacementsFor(vanishingV1)
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
    setCardType(next)
    // Names + shared state are intentionally preserved across the
    // flip. When flipping to membership the chip input just re-
    // labels to "Variants (optional)" — the chips and their
    // meanings carry through. Save path writes the preserved
    // names verbatim; the mode only affects validation + UI
    // copy, never the saved payload.
  }

  // Flip variant-round mode and run the side-effects the old Round-
  // mode radio used to do inline: seed two empty variant rows on the
  // first entry into variant mode, and clear any pending QR state
  // (the QR section is hidden in variant rounds, and a stale entry
  // would silently re-emerge — and leak its object URL — on a flip
  // back to a standard proof).
  function applyVariantRoundMode(next: boolean) {
    setIsVariantRound(next)
    if (next && variantRows.length === 0) {
      setVariantRows([
        { key: uuidv4(), display_name: '', frontFiles: [], backFiles: null },
        { key: uuidv4(), display_name: '', frontFiles: [], backFiles: null },
      ])
    }
    if (next) {
      setQrEntries((prev) => {
        for (const e of prev) {
          if (e.source === 'new' && e.previewUrl) URL.revokeObjectURL(e.previewUrl)
        }
        return []
      })
      setQrKeepOverrides({})
    }
  }

  // Single point where the wizard's resolved shape drives the form's
  // existing mode state. Keeping the mapping here (and in
  // deriveFormState) means the Phase 2 `shape` column drops in without
  // a refactor. Routes the cardType flip through handleCardTypeChange
  // so its approval-orphan guard still fires, and clears recipient
  // names when entering the no-name Set branch so they can't persist
  // invisibly past the switch.
  function handleWizardChange(next: WizardAnswers) {
    setWizardAnswers(next)
    const shape = resolveShape(next, {
      materialChosen: !!selectedMaterialId,
      materialSupportsPersonalisation: !!selectedMaterial?.supports_personalisation,
    })
    // When the shape is unresolved (e.g. the designer reopened Step 1
    // via Change), reset the wizard-derived mode flags to their
    // defaults rather than leaving the last resolved state stale — so
    // the form doesn't hold ghost membership/personalised flags until
    // it re-resolves. Save is already gated on wizardResolved, so this
    // is purely UI cleanliness. Material selection is deliberately left
    // alone: material is orthogonal to shape and must persist across
    // wizard changes (letterpress + its layer panel stay put).
    // Seed two empty layout rows the first time the wizard resolves to a
    // Set (collection), so the layout editor renders with something to
    // fill in (mirrors the variantRows seeding). Preserved on later
    // changes so the designer's config survives flips.
    if (shape?.kind === 'set-collection' && layoutRows.length === 0) {
      setLayoutRows([makeEmptyLayoutRow(), makeEmptyLayoutRow()])
    }

    const fs = deriveFormState(shape)
    if (!fs) {
      // Unresolved — a wizard step was reopened (e.g. "Change" on
      // Step 1). Clear the wizard-derived flags with PLAIN setters; do
      // NOT route the card-type reset through handleCardTypeChange. That
      // is a user-intent handler with a destructive-image window.confirm
      // + cleanup, and firing it as a side effect of reopening a step
      // popped a spurious confirm (and froze the page) on
      // membership-cardType priors (set_single / set_collection, and —
      // since cd924fa — variant-round continuations). Save is gated on
      // wizardResolved, so a plain reset is sufficient; the resolved
      // branch below re-runs handleCardTypeChange when the designer
      // re-answers and commits a real shape.
      if (isVariantRound) applyVariantRoundMode(false)
      setIsPerDirectionPricing(false)
      if (cardType !== 'business') setCardType('business')
      setHasPersonalisation(false)
      return
    }
    if (fs.isVariantRound !== isVariantRound) applyVariantRoundMode(fs.isVariantRound)
    setIsPerDirectionPricing(fs.isPerDirectionPricing)
    if (fs.cardType !== cardType) {
      const enteringSet = fs.cardType === 'membership' && cardType === 'business'
      handleCardTypeChange(fs.cardType)
      if (enteringSet) setNames([])
    }
    setHasPersonalisation(fs.hasPersonalisation)
    // A kept-together multi-material Set (collection) can't be priced by
    // the single-material grid, so force the version onto a custom quote.
    // The PricingDisplayField is also locked to Custom while this path is
    // active (standardDisabled below), so this won't fight a switch-back.
    if (fs.forceCustomQuote && pricingDisplay !== 'custom') setPricingDisplay('custom')
  }

  function toggleVariant(variantId: string) {
    setSelectedVariantIds((prev) =>
      prev.includes(variantId) ? prev.filter((id) => id !== variantId) : [...prev, variantId]
    )
    // Per-field carried/edited derivation compares the current
    // selection against the snapshot — no manual flag clear needed.
  }

  // When a new version lands on an already-approved proof, the new
  // (unapproved) version becomes current, so the proof shouldn't keep
  // reading 'approved' (the customer would see an approve action on an
  // "approved" proof). Flip it back to in_progress and clear approved_at.
  // The `.eq('status', 'approved')` guard makes this a no-op for any
  // other status (in_progress / dormant / abandoned). This is NOT a
  // Reopen: the prior version's proof_name_approvals rows are left
  // untouched as history; only the parent proof's status is reset, so
  // the new current version is approved afresh by the customer (and the
  // maybe_finalize trigger flips the proof back to approved once every
  // slot on the new version is approved).
  async function resetApprovedProofToInProgress() {
    const { error } = await supabase
      .from('proofs')
      .update({ status: 'in_progress', approved_at: null })
      .eq('id', proofId!)
      .eq('status', 'approved')
    if (error) {
      // Non-fatal: the version saved. Log and proceed — worst case the
      // designer reopens manually.
      console.error('[NewVersionPage] reset approved→in_progress failed', error)
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setSubmitAttempted(true)

    // Block save until the proof-type wizard resolves to a concrete,
    // persistable shape (the split guard and incomplete paths don't
    // save). Belt-and-braces on top of the disabled Save button.
    if (!isWizardResolved(wizardShape)) {
      setFormExpanded(true)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      setToast({ kind: 'validation', text: 'Answer the proof-type questions to continue.' })
      toastTimerRef.current = setTimeout(
        () => setToast((curr) => (curr?.kind === 'validation' ? null : curr)),
        5000,
      )
      return
    }

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
        // Options chips (Finish / Species) sit between the commercial
        // fields and the layer-colour pickers in document order.
        { key: 'options',        ref: optionsRef as unknown as React.RefObject<HTMLElement | null> },
        // Layer-colour pickers slot between options/finishes and
        // ink names in document order (front → core → back). Same
        // order in scroll-to-first-invalid so the focus jump is
        // predictable.
        { key: 'frontColour',    ref: frontColourRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'coreColour',     ref: coreColourRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'backColour',     ref: backColourRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'inkNames',       ref: inkNamesRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'names',          ref: namesRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'images',         ref: imageSectionRef },
        // Variant-round validation refs. All three target the same
        // editor surface; whichever field fails first scrolls there.
        { key: 'variantsCount',  ref: variantEditorRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'variantsLabels', ref: variantEditorRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'variantsImages', ref: variantEditorRef as unknown as React.RefObject<HTMLElement | null> },
        // Set (collection) layout editor — all three target the same
        // editor surface, whichever fails first scrolls there.
        { key: 'layoutsCount',   ref: layoutEditorRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'layoutsTitles',  ref: layoutEditorRef as unknown as React.RefObject<HTMLElement | null> },
        { key: 'layoutsImages',  ref: layoutEditorRef as unknown as React.RefObject<HTMLElement | null> },
      ]
      const first = order.find(o => !validations[o.key])
      // Defer the scroll until React has committed the
      // setFormExpanded(true) state above. Without this, when the
      // form was collapsed in summary view the target field hadn't
      // mounted yet — the ref's current was null and the scroll was
      // a no-op. A double-rAF (commit → layout → next frame) is the
      // belt-and-braces way to make sure the DOM has the new node.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          first?.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
      })

      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      setToast({ kind: 'validation', text: 'Please complete all required fields to save' })
      toastTimerRef.current = setTimeout(
        () => setToast((curr) => (curr?.kind === 'validation' ? null : curr)),
        5000,
      )
      return
    }

    // Button is still a submit-type, so narrow defensively even though
    // isValid guarantees these values. Per-direction-pricing variant
    // rounds hide the Commercial section entirely, so pricingDisplay
    // legitimately stays null on that branch — the variant-round save
    // path below doesn't read it. Skip the narrow in that case so the
    // save isn't silently dropped.
    if (!isPerDirectionRound && pricingDisplay === null) return

    // Finalise any pending soft-delete before the network save.
    // Placed after the validation gate so a validation-fail path
    // doesn't pre-empt the 5s undo window. Entry is already absent
    // from state; this is just blob URL hygiene at the natural
    // commit point of the form.
    commitPendingRemoval()

    setSubmitting(true)

    // ── Variant-round save path (build-plan step 5G) ──────────────────
    // Three sequential writes: proof_versions (is_variant_round=true,
    // names=[], material_options=[]) → proof_round_variants → image
    // uploads + proof_version_images. FK constraints require this
    // order. Save-time enforcement of the empty arrays is belt-and-
    // braces on top of the trigger from migration 000138.
    if (isVariantRound) {
      // Per-direction-pricing variant rounds (000142, renamed 000144)
      // drop the version-level material / currency / ink-names / colour
      // / variant-tier payload — every direction is priced individually
      // out-of-band. material_display stays a non-null text column, so
      // we write a sentinel instead of selecting one material; the
      // customer page never reads it on this branch (hero docket is
      // hidden too).
      const material = isPerDirectionPricing
        ? null
        : materials.find((m) => m.id === selectedMaterialId)!
      const currencyForInsert: Currency | null = isPerDirectionPricing
        ? null
        : (currency ?? 'GBP')
      const parsedInkNames: string[] = isPerDirectionPricing
        ? []
        : requiresInkNames
          ? inkNamesArray.slice(0, inkCount).map((s) => s.trim())
          : inkNamesText.split(',').map((s) => s.trim()).filter(Boolean)

      // 1. Insert the version row.
      const { data: versionData, error: versionErr } = await supabase
        .from('proof_versions')
        .insert({
          proof_id: proofId,
          material_id: isPerDirectionPricing ? null : selectedMaterialId,
          material_display: material?.display_name ?? 'Per-direction pricing',
          ink_names: parsedInkNames,
          currency: currencyForInsert,
          displayed_variant_ids: isPerDirectionPricing ? [] : selectedVariantIds,
          change_notes: changeNotes.trim() || null,
          // Variant rounds are single-bucket-only — material_options
          // and names must both be empty (build-plan step 5E + the
          // 000138 trigger). Per-direction pricing adds the same
          // constraint via the 000142 trigger (renamed 000144).
          // Forced regardless of any state from a prior mode flip.
          material_options: [],
          custom_quote: isPerDirectionPricing ? false : isCustomQuote,
          names: [],
          card_type: cardType,
          cloned_from_version_id: v1Carry?.versionId ?? null,
          front_colour_id: isPerDirectionPricing ? null : (requiresLayerColours ? selectedFrontColourId : null),
          core_colour_id:  isPerDirectionPricing ? null : (requiresLayerColours ? selectedCoreColourId  : null),
          back_colour_id:  isPerDirectionPricing ? null : (requiresLayerColours ? selectedBackColourId  : null),
          is_variant_round: true,
          is_per_direction_pricing: isPerDirectionPricing,
          // Personalisation is a membership-card concept on the
          // standard pricing grid. Variant rounds carry parallel
          // designs (often via per-direction pricing), so
          // personalisation is unconditionally false on this path.
          has_personalisation: false,
          // Resolved proof-type-wizard shape (000210). A variant round
          // always resolves to 'selection'; the wizard is the single
          // source, so we write its mapping rather than re-deriving.
          shape: dbShape(wizardShape),
        })
        .select('id, version_number')
        .single()

      if (versionErr || !versionData) {
        setError(`Failed to save version: ${versionErr?.message ?? 'Unknown error'}`)
        setSubmitting(false)
        return
      }

      // 2. Insert proof_round_variants. Codes derived from display_name
      //    via slugify + dedup walk; on collision the second row gets
      //    a -2 suffix so the unique-violation never reaches the user.
      const codes = deriveCodes(variantRows)
      const variantInserts = variantRows.map((row, idx) => ({
        proof_version_id: versionData.id,
        code: codes[idx],
        display_name: row.display_name.trim(),
        sort_order: idx,
      }))
      const { data: insertedVariants, error: variantErr } = await supabase
        .from('proof_round_variants')
        .insert(variantInserts)
        .select('id, code, sort_order')
        .order('sort_order')
      if (variantErr || !insertedVariants) {
        await supabase.from('proof_versions').delete().eq('id', versionData.id)
        setError(`Failed to save variants: ${variantErr?.message ?? 'Unknown error'}`)
        setSubmitting(false)
        return
      }

      // Map sort_order → DB id for image-row attribution.
      const variantIdByOrder = new Map<number, string>()
      for (const v of insertedVariants as Array<{ id: string; sort_order: number }>) {
        variantIdByOrder.set(v.sort_order, v.id)
      }

      // 3. Upload all variant files in parallel. Each file carries
      //    its variantId + side so the proof_version_images insert
      //    below can stamp side='front' / 'back' correctly. Per-
      //    variant 2-sided support: frontFiles always present;
      //    backFiles is null when the designer didn't add a back
      //    side to that variant.
      type Upload = {
        variantId: string
        side: 'front' | 'back'
        file: File
        path: string
      }
      const uploadQueue: Upload[] = []
      variantRows.forEach((row, idx) => {
        const variantId = variantIdByOrder.get(idx)
        if (!variantId) return
        for (const file of row.frontFiles) {
          uploadQueue.push({
            variantId,
            side: 'front',
            file,
            path: `${proofId}/${uuidv4()}.jpg`,
          })
        }
        for (const file of row.backFiles ?? []) {
          uploadQueue.push({
            variantId,
            side: 'back',
            file,
            path: `${proofId}/${uuidv4()}.jpg`,
          })
        }
      })

      const uploadResults = await Promise.all(
        uploadQueue.map(async (u) => {
          const { error: upErr } = await supabase.storage
            .from('proof-images')
            .upload(u.path, u.file, { contentType: u.file.type, upsert: false })
          return { ...u, error: upErr }
        }),
      )
      const failedUpload = uploadResults.find((r) => r.error)
      if (failedUpload) {
        const successPaths = uploadResults.filter((r) => !r.error).map((r) => r.path)
        if (successPaths.length > 0) {
          await supabase.storage.from('proof-images').remove(successPaths)
        }
        // Roll back the variants + version so we don't leave an
        // image-less variant round behind. ON DELETE CASCADE on
        // proof_round_variants takes the variants down with the
        // version delete.
        await supabase.from('proof_versions').delete().eq('id', versionData.id)
        setError(`Image upload failed: ${failedUpload.error!.message}`)
        setSubmitting(false)
        return
      }

      // 4. Insert proof_version_images. associated_name is null on
      //    every variant-round image (000138 trigger enforces). side
      //    carries 'front' / 'back' per the per-variant 2-sided
      //    support; the customer page filters by side to render
      //    Front + Back clusters within each variant card.
      const imageInserts = uploadResults.map((u, i) => ({
        proof_version_id: versionData.id,
        image_path: u.path,
        material_option: null,
        original_filename: u.file.name,
        associated_name: null,
        side: u.side,
        round_variant_id: u.variantId,
        sort_order: i,
      }))
      const { error: imgInsertErr } = await supabase
        .from('proof_version_images')
        .insert(imageInserts)
      if (imgInsertErr) {
        await supabase.storage.from('proof-images').remove(uploadResults.map((r) => r.path))
        await supabase.from('proof_versions').delete().eq('id', versionData.id)
        setError(`Failed to save images: ${imgInsertErr.message}`)
        setSubmitting(false)
        return
      }

      // Mirror the standard save path's audit hook (the call at
      // ~2532). Without this, variant-round version creates were
      // silent in the audit log and "who added this round" had to
      // be reconstructed from proof_events. Metadata captures the
      // shape signals that distinguish this row from a standard
      // version.added entry: is_variant_round (always true on
      // this branch), is_per_direction_pricing (sub-mode), and
      // variant_count (round size).
      void logAudit({
        action: 'version.added',
        targetType: 'version',
        targetId: versionData.id,
        targetLabel: `${proofName || 'project'} — variant round`,
        metadata: {
          proof_id: proofId,
          is_variant_round: true,
          is_per_direction_pricing: isPerDirectionPricing,
          variant_count: variantRows.length,
        },
      })

      // Reset an approved parent proof now this new version is current.
      await resetApprovedProofToInProgress()

      // Success — reuse the standard post-save flow. Setting
      // savedVersion triggers the existing summary card render.
      setSavedVersion({
        id: versionData.id,
        number: versionData.version_number,
      })
      setSubmitting(false)
      return
    }

    // ── Set (collection) save path (Phase 2) ─────────────────────────
    // Priced like a standard proof (material / currency / options) but
    // no-name (names=[]), plus proof_layouts rows and per-layout images
    // (layout_id). Mirrors the variant-round path's
    // insert → children → uploads → images shape, with the same
    // roll-back-on-failure ordering. Carry-forward of layout approvals
    // for a *new version of an existing collection* is handled with the
    // edit/continue machinery in a later step; this path covers creating
    // a collection.
    if (isSetCollectionShape) {
      const material = materials.find((m) => m.id === selectedMaterialId)!
      const parsedInkNames: string[] = requiresInkNames
        ? inkNamesArray.slice(0, inkCount).map((s) => s.trim())
        : inkNamesText.split(',').map((s) => s.trim()).filter(Boolean)
      const currencyForInsert: Currency = currency ?? 'GBP'

      // 1. Insert the version row. Collections are no-name (names=[]),
      //    card_type membership, shape='set_collection'. Personalisation
      //    uses the same eligibility gate as the standard path.
      const { data: versionData, error: versionErr } = await supabase
        .from('proof_versions')
        .insert({
          proof_id: proofId,
          material_id: selectedMaterialId,
          material_display: material.display_name,
          ink_names: parsedInkNames,
          currency: currencyForInsert,
          displayed_variant_ids: selectedVariantIds,
          change_notes: changeNotes.trim() || null,
          material_options: selectedOptions,
          custom_quote: isCustomQuote,
          names: [],
          card_type: cardType,
          cloned_from_version_id: v1Carry?.versionId ?? null,
          front_colour_id: requiresLayerColours ? selectedFrontColourId : null,
          core_colour_id:  requiresLayerColours ? selectedCoreColourId  : null,
          back_colour_id:  requiresLayerColours ? selectedBackColourId  : null,
          is_variant_round: false,
          is_per_direction_pricing: false,
          has_personalisation:
            material.supports_personalisation
            && cardType === 'membership'
            && !isCustomQuote
            && hasPersonalisation,
          shape: dbShape(wizardShape),
        })
        .select('id, version_number')
        .single()

      if (versionErr || !versionData) {
        setError(`Failed to save version: ${versionErr?.message ?? 'Unknown error'}`)
        setSubmitting(false)
        return
      }

      // 2. Insert proof_layouts. sort_order follows the editor order;
      //    titles trimmed (validation already enforced non-empty).
      const layoutInserts = layoutRows.map((row, idx) => ({
        proof_version_id: versionData.id,
        title: row.title.trim(),
        sort_order: idx,
      }))
      const { data: insertedLayouts, error: layoutErr } = await supabase
        .from('proof_layouts')
        .insert(layoutInserts)
        .select('id, sort_order')
        .order('sort_order')
      if (layoutErr || !insertedLayouts) {
        // ON DELETE CASCADE on proof_layouts removes any inserted rows
        // with the version.
        await supabase.from('proof_versions').delete().eq('id', versionData.id)
        setError(`Failed to save layouts: ${layoutErr?.message ?? 'Unknown error'}`)
        setSubmitting(false)
        return
      }

      // Map sort_order → DB layout id for image attribution.
      const layoutIdByOrder = new Map<number, string>()
      for (const l of insertedLayouts as Array<{ id: string; sort_order: number }>) {
        layoutIdByOrder.set(l.sort_order, l.id)
      }

      // 3. Build the image rows in editor order, two sources per layout:
      //    carried existing images (reuse the prior image_path, no
      //    re-upload — set when continuing a collection on a new version)
      //    and queued new files (uploaded here). Both land as
      //    proof_version_images stamped with the new layout's id.
      const stampedOption = selectedOptions[0] ?? null
      type ImgSpec =
        | { kind: 'existing'; layoutId: string; path: string; filename: string | null }
        | { kind: 'new'; layoutId: string; queueIndex: number; filename: string }
      const imgSpecs: ImgSpec[] = []
      const uploadQueue: { file: File; path: string }[] = []
      layoutRows.forEach((row, idx) => {
        const layoutId = layoutIdByOrder.get(idx)
        if (!layoutId) return
        for (const ex of row.existingImages) {
          imgSpecs.push({ kind: 'existing', layoutId, path: ex.imagePath, filename: ex.originalFilename })
        }
        for (const file of row.newFiles) {
          imgSpecs.push({ kind: 'new', layoutId, queueIndex: uploadQueue.length, filename: file.name })
          uploadQueue.push({ file, path: `${proofId}/${uuidv4()}.jpg` })
        }
      })

      const uploadResults = await Promise.all(
        uploadQueue.map(async (u) => {
          const { error: upErr } = await supabase.storage
            .from('proof-images')
            .upload(u.path, u.file, { contentType: u.file.type, upsert: false })
          return { ...u, error: upErr }
        }),
      )
      const failedUpload = uploadResults.find((r) => r.error)
      if (failedUpload) {
        const successPaths = uploadResults.filter((r) => !r.error).map((r) => r.path)
        if (successPaths.length > 0) {
          await supabase.storage.from('proof-images').remove(successPaths)
        }
        await supabase.from('proof_versions').delete().eq('id', versionData.id)
        setError(`Image upload failed: ${failedUpload.error!.message}`)
        setSubmitting(false)
        return
      }

      // 4. Insert proof_version_images. layout_id set; associated_name
      //    and round_variant_id null (a collection image isn't
      //    per-recipient or per-variant — the 000138 trigger permits
      //    this on a non-variant-round version). material_option carries
      //    the single chosen option (or null); side is 'front' —
      //    collections are one image bucket per layout. Carried existing
      //    images reuse their prior image_path (no re-upload).
      const imageInserts = imgSpecs.map((spec, i) => ({
        proof_version_id: versionData.id,
        image_path: spec.kind === 'existing' ? spec.path : uploadResults[spec.queueIndex].path,
        material_option: stampedOption,
        original_filename: spec.filename,
        associated_name: null,
        side: 'front' as const,
        round_variant_id: null,
        layout_id: spec.layoutId,
        sort_order: i,
      }))
      if (imageInserts.length > 0) {
        const { error: imgInsertErr } = await supabase
          .from('proof_version_images')
          .insert(imageInserts)
        if (imgInsertErr) {
          // Only the freshly-uploaded paths are this version's to remove;
          // carried paths are shared with the prior version.
          await supabase.storage.from('proof-images').remove(uploadResults.map((r) => r.path))
          await supabase.from('proof_versions').delete().eq('id', versionData.id)
          setError(`Failed to save images: ${imgInsertErr.message}`)
          setSubmitting(false)
          return
        }
      }

      // 5. Carry-forward per-layout approvals (continuing a collection on
      //    a new version). A prior approval carries to the new layout
      //    ONLY when the layout is unchanged from the one it was seeded
      //    from: same source layout (id lineage in row.sourceLayoutId,
      //    never title/order), same title, and the same existing-image
      //    set with no new files added. Renamed / re-imaged / added
      //    layouts start unapproved; a removed layout simply isn't here.
      const carriedLayoutApprovals = layoutRows
        .map((row, idx) => {
          const newLayoutId = layoutIdByOrder.get(idx)
          if (!newLayoutId || !row.sourceLayoutId) return null
          const prior = priorLayoutApprovals[row.sourceLayoutId]
          if (!prior || prior.state !== 'approved') return null
          const titleUnchanged = row.title.trim() === row.sourceTitle.trim()
          const keptIds = row.existingImages.map((e) => e.id)
          const sourceIds = row.sourceImageIds
          const imagesUnchanged =
            row.newFiles.length === 0 &&
            keptIds.length === sourceIds.length &&
            sourceIds.every((id) => keptIds.includes(id))
          if (!titleUnchanged || !imagesUnchanged) return null
          return {
            proof_version_id: versionData.id,
            name: newLayoutId,
            state: 'approved' as const,
            change_request: null,
            actor_name: prior.actor_name,
            actor_ip: null,
            actor_ua: null,
            updated_at: new Date().toISOString(),
            carried_from_version_id: v1Carry?.versionId ?? null,
            // Collections carry no QRs (the QR section is hidden on the
            // collection form), so these are always null.
            qr_confirmed_at: prior.qr_confirmed_at,
            qr_snapshot: null,
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
      if (carriedLayoutApprovals.length > 0) {
        const { error: carryErr } = await supabase
          .from('proof_name_approvals')
          .insert(carriedLayoutApprovals)
        if (carryErr) {
          // Non-fatal: the version + layouts + images are saved. A failed
          // approval carry just means the customer re-approves those
          // layouts — log and proceed rather than roll back real work.
          console.error('[NewVersionPage] layout approval carry failed', carryErr)
        }
      }

      void logAudit({
        action: 'version.added',
        targetType: 'version',
        targetId: versionData.id,
        targetLabel: `${proofName || 'project'} — set (collection)`,
        metadata: {
          proof_id: proofId,
          shape: 'set_collection',
          layout_count: layoutRows.length,
          carried_layout_approvals: carriedLayoutApprovals.length,
          has_personalisation:
            material.supports_personalisation
            && cardType === 'membership'
            && !isCustomQuote
            && hasPersonalisation,
        },
      })

      // Reset an approved parent proof now this new version is current.
      await resetApprovedProofToInProgress()

      setSavedVersion({ id: versionData.id, number: versionData.version_number })
      setSubmitting(false)
      return
    }

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
        sidedness === 'two-sided' && effectiveShared && normalizedSide === 'front'
      if (isSharedSlotForSide) return assocName == null
      return assocName != null && v2Names.has(assocName)
    }

    // Variant-round carries arrive with associated_name=null (the
    // shared-design convention) and the form re-maps them onto the
    // first v(N) name when the active shape has no SHARED slot for
    // the side. Render, save-stamp, and validation-count all read
    // through effectiveAssocForVariantRoundCarry — the save filter
    // has to use the same effective identity or it would drop
    // legitimately re-mapped carries that the rest of the form
    // counted as present. Standard-proof carries pass through with
    // their original assoc (the helper short-circuits).
    const carrySlotStillValid = (img: V1Image): boolean => {
      const liveAssoc = effectiveAssocForVariantRoundCarry(
        (img.side ?? 'front') as 'front' | 'back',
        img.associated_name,
      )
      return slotStillValid(liveAssoc, img.side)
    }

    // Option-universe guard. The render-side carry grid only shows a
    // v1 image when its material_option matches one of v2's option
    // tabs (see the carryCellsBySlot filter in the image section).
    // Without the equivalent check here, a carry whose finish no
    // longer exists on v2, e.g. a steel "Natural" image when v2 is
    // gun metal (which has no finish options at all), stays hidden
    // in the form but is still written into v2 on save, producing
    // ghost images on the customer page. Mirror the render filter:
    // the carry is in v2's option universe iff its option code is
    // one of the selected tabs, or it's a variant-round carry (null
    // option) the save path stamps onto the first selected tab.
    const carryOptionStillValid = (img: V1Image): boolean => {
      const imgOption = img.material_option ?? ''
      if (optionKeys.includes(imgOption)) return true
      const firstSelectedOption = selectedOptions[0] ?? ''
      return (
        v1Carry?.sourceIsVariantRound === true &&
        img.material_option == null &&
        firstSelectedOption !== ''
      )
    }

    const carriedV1Rows = v1Carry
      ? v1Carry.images.filter(
          (img) =>
            (keepByV1RowId[img.v1RowId] ?? true) &&
            !replacementByV1RowId[img.v1RowId] &&
            carrySlotStillValid(img) &&
            carryOptionStillValid(img),
        )
      : []
    const replacementEntries = v1Carry
      ? v1Carry.images
          .filter(
            (img) =>
              !!replacementByV1RowId[img.v1RowId] &&
              carrySlotStillValid(img) &&
              carryOptionStillValid(img),
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

    // Pricing snapshot deliberately omitted — customer page reads
    // live pricing from public_price_tiers since Phase 2. The
    // pricing_snapshot column is retained for historical proofs
    // created before this commit.
    //
    // displayed_variant_ids carries the designer's variant subset
    // (migration 000118). Empty array is fine for custom-quote
    // versions where no grid is rendered; non-empty captures
    // exactly which variants the customer should see priced.

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
        displayed_variant_ids: selectedVariantIds,
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
        // Letterpress layer colours (migrations 000133 + 000135).
        // Only stamped when the pickers were visible — non-
        // letterpress saves are unconditionally null so we never
        // persist a colour against a material that can't expose it.
        front_colour_id: requiresLayerColours ? selectedFrontColourId : null,
        core_colour_id:  requiresLayerColours ? selectedCoreColourId  : null,
        back_colour_id:  requiresLayerColours ? selectedBackColourId  : null,
        // Personalisation (migration 000172). Persisted only when the
        // eligibility gate is satisfied at save time. Hiding the
        // checkbox on a non-membership / non-supporting material then
        // flipping back leaves stale state in hasPersonalisation; the
        // gate here means a save lands as false unless the form
        // currently shows the box ticked.
        has_personalisation:
          material.supports_personalisation
          && cardType === 'membership'
          && !isCustomQuote
          && hasPersonalisation,
        // Resolved proof-type-wizard shape (000210). This path handles
        // recipients and set_single; the wizard is the single source so
        // we write its mapping rather than re-deriving from flags.
        shape: dbShape(wizardShape),
      })
      .select('id, version_number')
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
    // Stamp variant-round carries with the first selected option so
    // the DB row lands inside v(N)'s option universe instead of as
    // a null orphan. Mirrors the render filter above which renders
    // these carries inside the first tab's slot grid. Standard-proof
    // carries pass through unchanged — img.material_option is
    // already a valid option code (or null on a v(N-1) without
    // option tabs, in which case v(N) also has no tabs and null is
    // the right answer).
    const stampedFirstOption = selectedOptions[0] ?? null
    const isVariantRoundCarrySource = v1Carry?.sourceIsVariantRound === true
    const carriedInserts = carriedV1Rows.map((img) => {
      const stampedOption =
        isVariantRoundCarrySource && img.material_option == null && stampedFirstOption
          ? stampedFirstOption
          : img.material_option
      // Re-stamp variant-round null-assoc carries to the first v2
      // name when the active shape has no SHARED slot for the side.
      // Matches the carry render filter's identity mapping so the
      // persisted row lands in the same slot the designer saw.
      // Standard-proof carries pass through unchanged.
      const stampedSide = (img.side ?? 'front') as 'front' | 'back'
      const stampedAssoc = effectiveAssocForVariantRoundCarry(stampedSide, img.associated_name)
      return {
        proof_version_id: versionData.id,
        image_path: img.file_path,
        material_option: stampedOption,
        original_filename: img.original_filename,
        associated_name: stampedAssoc,
        side: stampedSide,
      }
    })

    // uploadedPaths is laid out as [replacements..., fresh...];
    // slice accordingly to assign paths to the right inserts.
    const replacementPaths = uploadedPaths.slice(0, replacementEntries.length)
    const freshPaths = uploadedPaths.slice(replacementEntries.length)

    const replacementInserts = replacementEntries.map((r, i) => {
      // Same variant-round option stamp as carriedInserts above.
      // If the designer dropped a new file onto a variant-round
      // carry's slot, the replacement should land in the same
      // first-tab slot the underlying carry would have occupied.
      const stampedOption =
        isVariantRoundCarrySource && r.v1Img.material_option == null && stampedFirstOption
          ? stampedFirstOption
          : r.v1Img.material_option
      // Same variant-round assoc re-stamp as carriedInserts: null
      // assoc on a variant-round carry maps to the first v2 name
      // when the active shape has no SHARED slot for the side.
      const stampedSide = (r.v1Img.side ?? 'front') as 'front' | 'back'
      const stampedAssoc = effectiveAssocForVariantRoundCarry(stampedSide, r.v1Img.associated_name)
      return {
        proof_version_id: versionData.id,
        image_path: replacementPaths[i],
        material_option: stampedOption,
        original_filename: r.file.name,
        associated_name: stampedAssoc,
        // Replacement inherits the v1 row's slot (same associated_name,
        // same side). Null-side v1 rows normalise to 'front' — same
        // back-compat rule as carriedInserts.
        side: stampedSide,
      }
    })

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

    // ── QR code uploads + inserts (migration 000168) ───────────────
    // New QR entries get a storage path each; existing entries
    // (v1-carried) re-use their previous image_path UNLESS the
    // designer has unkept them via the QR section's Keep toggle.
    // Unkeeping is the save-time mechanism that maps Bill's
    // changed-artwork-on-v2 to "drop Bill's stale QR", whether the
    // designer flipped the toggle explicitly or accepted the
    // auto-rule that flagged the slot. proof_version_images rows
    // are inserted with is_qr_code = true and the decoded payload
    // alongside. Sort order continues from where the artwork rows
    // ended so the customer-page filter on is_qr_code stays clean.
    //
    // Filtering identity matches the displayQrEntries derivation
    // in the render body — same artworkChangedSlots set fed from
    // the same helper so save and UI agree exactly. New entries
    // are always kept (designer added them deliberately on this
    // version); the auto-rule only governs existing entries.
    const invalidV1RowIdsForSave = v1Carry
      ? new Set(
          v1Carry.images
            .filter((img) => !carryOptionStillValid(img))
            .map((img) => img.v1RowId),
        )
      : undefined
    const artworkChangedSlotsForSave = computeQrArtworkChangedSlots(
      v1Carry,
      keepByV1RowId,
      replacementByV1RowId,
      imagesByOption,
      names.map((n) => n.trim()).filter(Boolean),
      invalidV1RowIdsForSave,
    )
    const isQrEntryKept = (entry: QrEntry): boolean => {
      if (entry.source !== 'existing') return true
      return resolveQrEffectiveKeep(
        entry.id,
        entry.associatedName,
        qrKeepOverrides,
        artworkChangedSlotsForSave,
      )
    }
    const keptQrEntries = qrEntries.filter(isQrEntryKept)

    const qrUploadedPaths: string[] = []
    if (keptQrEntries.length > 0) {
      const qrUploadQueue = keptQrEntries
        .filter((e) => e.source === 'new' && e.file)
        .map((e) => ({
          entry: e,
          file: e.file as File,
          // Path extension matches the artefact: hosted-vCard QRs
          // are SVGs generated client-side; uploaded customer QRs
          // are the raw JPEG / PNG the designer dropped. The
          // storage bucket is content-type-agnostic, but a wrong
          // extension would mis-route any downstream tooling that
          // inspects path suffixes.
          path: `${proofId}/${uuidv4()}.${e.kind === 'hosted_vcard' ? 'svg' : 'jpg'}`,
        }))

      const qrUploadErrors: string[] = []
      await Promise.all(
        qrUploadQueue.map(async (u) => {
          const { error: upErr } = await supabase.storage
            .from('proof-images')
            .upload(u.path, u.file, { contentType: u.file.type || 'image/jpeg' })
          if (upErr) qrUploadErrors.push(`${u.file.name}: ${upErr.message}`)
          else qrUploadedPaths.push(u.path)
        }),
      )
      if (qrUploadErrors.length > 0) {
        await supabase.from('proof_versions').delete().eq('id', versionData.id)
        await supabase.storage.from('proof-images').remove([...uploadedPaths, ...qrUploadedPaths])
        setError(`Failed to upload QR codes: ${qrUploadErrors.join(' · ')}`)
        setSubmitting(false)
        return
      }

      const pathByEntryId = new Map(qrUploadQueue.map((u) => [u.entry.id, u.path]))
      const qrInserts = keptQrEntries.map((entry, i) => ({
        proof_version_id: versionData.id,
        image_path:
          entry.source === 'new'
            ? pathByEntryId.get(entry.id)!
            : (entry.imagePath as string),
        // QRs aren't scoped to a material option; leave null so
        // they render in every option tab on the customer page.
        material_option: null,
        original_filename: entry.originalFilename,
        associated_name: entry.associatedName,
        // Single-sided artefact. Stamping 'front' keeps the row
        // valid against the non-null side constraint without
        // claiming a back surface that doesn't exist.
        side: 'front' as const,
        sort_order: imageInserts.length + i,
        // Migration 000168 — the CHECK constraint requires all
        // three to land together on an is_qr_code row. Migration
        // 000192 then layers `qr_vcard_slug` on top: populated iff
        // qr_kind = 'hosted_vcard', null on every other QR kind.
        is_qr_code: true,
        qr_decoded_data: entry.decodedData,
        qr_kind: entry.kind,
        qr_vcard_slug: entry.kind === 'hosted_vcard' ? entry.vcardSlug ?? null : null,
      }))

      const { error: qrInsertErr } = await supabase
        .from('proof_version_images')
        .insert(qrInserts)
      if (qrInsertErr) {
        await supabase.from('proof_versions').delete().eq('id', versionData.id)
        await supabase.storage.from('proof-images').remove([...uploadedPaths, ...qrUploadedPaths])
        setError(`Failed to save QR codes: ${qrInsertErr.message}`)
        setSubmitting(false)
        return
      }
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
          qr_confirmed_at: string | null
          // Migration 000194 — carries with qr_confirmed_at on the
          // same byte-identity gate: if the slot's QR set didn't
          // change, the snapshot taken on v1 still describes what was
          // approved on v2. Different multiset nulls the snapshot
          // alongside the timestamp; customer re-ticks on v2 and the
          // edge function captures a fresh snapshot at that point.
          qr_snapshot: ProofNameApproval['qr_snapshot']
        }[] = []

        // Migration 000169 — slot's QR decoded-data multiset on v1
        // and v2. qr_confirmed_at only carries when the two sets
        // are byte-identical, otherwise the customer has to
        // re-tick on v2. Coordinates match the DB predicate:
        // __shared__ on a split-name version excludes itself (the
        // sentinel isn't a gated slot); a named slot collects own
        // QRs plus shared QRs; __shared__ on a names-empty version
        // collects every QR.
        const v1HasNames = v1Carry.names.length > 0
        const v2HasNames = names.filter((n) => n.trim().length > 0).length > 0
        const slotQrSet = (
          rows: Array<{ associated_name: string | null; decoded_data: string }>,
          slotName: string,
          hasNames: boolean,
        ): string[] => {
          if (slotName === SHARED_APPROVAL_KEY) {
            return hasNames ? [] : rows.map((r) => r.decoded_data).sort()
          }
          return rows
            .filter(
              (r) => r.associated_name === slotName || r.associated_name == null,
            )
            .map((r) => r.decoded_data)
            .sort()
        }
        // Use keptQrEntries (computed above), not qrEntries —
        // entries the designer unkept aren't actually being inserted
        // on v2, so they must not count in v2's QR multiset. If we
        // compared against the full list, an unkept-but-still-in-form
        // entry could spuriously balance v1's set and cause
        // qr_confirmed_at to carry for a QR that's no longer on the
        // version. Belt-and-braces: even when keptQrEntries differs
        // from qrEntries, the underlying approval-carry guard
        // (allCarried below) already fails for any slot whose artwork
        // changed, so qr_confirmed_at on those slots never reaches
        // this comparison anyway. The filter here keeps the
        // byte-identity check honest on the surviving slots where
        // artwork was unchanged but the designer chose to drop a QR.
        const v2QrRowsForCompare = keptQrEntries.map((e) => ({
          associated_name: e.associatedName,
          decoded_data: e.decodedData,
        }))

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
              carrySlotStillValid(img) &&
              carryOptionStillValid(img),
          )
          if (!allCarried) continue

          // No new images for this slot. Fresh allEntries with
          // associated_name matching this slot would break
          // identity.
          const anyFreshForSlot = allEntries.some(
            ({ entry }) => entry.associated_name === assocFilter,
          )
          if (anyFreshForSlot) continue

          // Note on QR auto-unkeep interaction: the allCarried +
          // anyFreshForSlot gates above are the same predicates that
          // feed computeQrArtworkChangedSlots. So any slot whose
          // artwork has changed in v2 is filtered out here BEFORE we
          // reach the byte-identity check below, which means the
          // structural belt against "Bill's artwork changed but his
          // qr_confirmed_at still carried" is already in place — no
          // explicit "if artworkChanged then null qr_confirmed_at"
          // line is needed. The byte-identity check below is the
          // remaining safety, governing slots whose artwork was
          // unchanged but whose QR multiset shifted.

          // Migration 000169 — preserve qr_confirmed_at only when
          // the slot's QR set is byte-identical between v1 and v2.
          // Both sets empty also carries (no QRs on either side =
          // nothing to re-verify). Anything else nulls the
          // timestamp; the customer has to re-tick on v2.
          const v1Set = slotQrSet(v1Carry.qrRows, nameKey, v1HasNames)
          const v2Set = slotQrSet(v2QrRowsForCompare, nameKey, v2HasNames)
          const qrSetsMatch =
            v1Set.length === v2Set.length &&
            v1Set.every((s, idx) => s === v2Set[idx])

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
            qr_confirmed_at: qrSetsMatch
              ? v1Approval.qr_confirmed_at
              : null,
            qr_snapshot: qrSetsMatch
              ? v1Approval.qr_snapshot
              : null,
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

    // Reset an approved parent proof now this new version is current.
    await resetApprovedProofToInProgress()

    // Hand off to the MessageSendPanel. The render branch below
    // detects savedVersion and swaps the form for the panel; on
    // send (or skip) the panel calls back to navigate.
    setSavedVersion({
      id: versionData.id,
      number: (versionData as { version_number: number }).version_number,
    })
    setSubmitting(false)
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
  // Letterpress layer colours (migrations 000133 + 000135) — front,
  // core, and back are all required when the selected material is in
  // the un-gilded letterpress set. The gilded SKU is a separate
  // material code, so checking the code is the same thing as
  // "letterpress AND gilding not selected".
  const requiresLayerColours = !!selectedMaterial && LAYER_COLOUR_MATERIAL_CODES.has(selectedMaterial.code)

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

  // ── Shared semantics refinement ────────────────────────────────
  // The `shared` toggle's stored value can be `true` even in shapes
  // where the concept doesn't apply (single recipient — sharing with
  // whom?). The toggle UI itself is only rendered for 2+ names (see
  // line ~4433), so designers can't see or change the value in the
  // single-name case; it remains at whatever was inherited from
  // v(N-1). To keep the slot universe and the UI in agreement,
  // `effectiveShared` collapses to false when there's exactly one
  // name: a 1-name shape always renders per-name slots, regardless
  // of what `shared` is set to. The 0-name and 2+-name cases keep
  // the stored value, since both are shapes where the SHARED slot
  // is meaningfully distinct from per-name slots.
  const effectiveShared = shared && names.length !== 1

  // Variant-round v1 images carry forward with associated_name=null
  // (the variant-round convention — each direction is one shared
  // design). When v(N) is a standard proof with names but no SHARED
  // slot in the active shape, the null pattern doesn't match any
  // per-name slot and the carry would orphan. This helper re-maps
  // the carry's effective associated_name to the first v(N) name
  // when a SHARED slot isn't available for the requested side, so
  // the image lands in a real slot rather than being filtered out
  // of the cell builder. Used by both the carry render filter and
  // the save-path stamp so render and persisted state agree.
  function effectiveAssocForVariantRoundCarry(
    side: 'front' | 'back',
    originalAssoc: string | null,
  ): string | null {
    if (originalAssoc != null) return originalAssoc
    if (!v1Carry?.sourceIsVariantRound) return originalAssoc
    const isMembershipSingleSlot = cardType === 'membership' && names.length === 0
    const hasSharedSlotForSide =
      isMembershipSingleSlot ||
      (sidedness === 'two-sided' && effectiveShared && side === 'front')
    if (hasSharedSlotForSide) return null
    return names.length > 0 ? names[0] : null
  }

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
      sidedness === 'two-sided' && effectiveShared && side === 'front'
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
    // Variant-round carry option fallback. Mirror the render filter
    // logic at the slot grid: a v1 image from a variant-round
    // predecessor arrives with material_option=null, and we treat
    // those as belonging to the first tab in selectedOptions. The
    // validation has to use the same rule, otherwise the Save
    // button stays disabled with "Select at least one image" even
    // though the carry is visibly populated in the slot. The save
    // path itself stamps the same option onto these rows so the
    // DB lands consistent with what the form counted.
    const isVariantRoundCarrySource = v1Carry.sourceIsVariantRound === true
    const firstSelectedOption = selectedOptions[0] ?? ''
    const carryKeptOrReplaced = v1Carry.images.filter((img) => {
      const imgOption = img.material_option ?? ''
      const matchesActiveTab = imgOption === optionCode
      const matchesViaVariantRound =
        isVariantRoundCarrySource &&
        img.material_option == null &&
        optionCode === firstSelectedOption &&
        firstSelectedOption !== ''
      if (!matchesActiveTab && !matchesViaVariantRound) return false
      // Mirror the cell builder's identity re-mapping for variant-
      // round null-assoc carries — the image's actual associated_name
      // is null but the cell builder may have routed it into a per-
      // name slot when no SHARED slot exists for the side. Validation
      // has to use the same effective identity, otherwise the Save
      // button stays disabled with "Add an image for Rob front" even
      // though the carry is visibly populated in Rob's slot.
      const imgSide = (img.side ?? 'front') as 'front' | 'back'
      const effectiveImgAssoc = effectiveAssocForVariantRoundCarry(imgSide, img.associated_name)
      if (effectiveImgAssoc !== identity) return false
      if (imgSide !== side) return false
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

  // Variant-round validations (build-plan step 5F). When isVariantRound
  // is on, the standard `images` and `names` checks become irrelevant —
  // the bucket UI they validate isn't rendered — so they short-circuit
  // to true and the variant-specific checks take over.
  const variantsCountValid = !isVariantRound || variantRows.length >= 2
  const variantsLabelsValid =
    !isVariantRound ||
    variantRows.every((v) => v.display_name.trim().length > 0)
  // Front images are always required. Back images are optional, but
  // an empty back drop zone (backFiles === [] rather than null) is
  // an in-between state — the designer toggled it on but uploaded
  // nothing. Force them to either upload or remove the zone.
  const variantsImagesValid =
    !isVariantRound ||
    variantRows.every(
      (v) =>
        v.frontFiles.length > 0 &&
        (v.backFiles === null || v.backFiles.length > 0),
    )

  // Per-direction-pricing variant rounds (000142, renamed 000144)
  // skip every version-level material/pricing decision — the variant
  // editor is the only thing that matters. The flag is effective only
  // when isVariantRound is also true; otherwise false (the sub-toggle
  // is hidden in the standard-proof branch).
  const isPerDirectionRound = isVariantRound && isPerDirectionPricing

  // ── Wizard-resolved shape (drives render conditionals + Save gate) ────────
  const wizardShape = resolveShape(wizardAnswers, {
    materialChosen: !!selectedMaterialId,
    materialSupportsPersonalisation: !!selectedMaterial?.supports_personalisation,
  })
  // The proof must route to a concrete shape before it can save.
  const wizardResolved = isWizardResolved(wizardShape)
  // Recipients is the only shape that keeps the per-name roster; every
  // other shape is no-name (Set) or single-bucket (Selection).
  const isRecipientsShape = wizardShape?.kind === 'recipients'
  // Set (collection): images come from the per-layout editor, not the
  // standard slot grid, and the layout-specific validations below apply.
  const isSetCollectionShape = wizardShape?.kind === 'set-collection'
  // A kept-together multi-material collection forces a custom quote (the
  // single-material grid can't price it). Surfaced via deriveFormState and
  // applied by locking the PricingDisplayField to Custom (below) and by
  // setPricingDisplay('custom') in handleWizardChange.
  const wizardForcesCustomQuote = deriveFormState(wizardShape)?.forceCustomQuote ?? false

  // Set (collection) validations: 2+ layouts, each with a non-empty
  // title and at least one image. Short-circuit to true on every other
  // shape so they never gate non-collection saves.
  const layoutsCountValid  = !isSetCollectionShape || layoutRows.length >= 2
  const layoutsTitlesValid = !isSetCollectionShape || layoutRows.every((r) => r.title.trim().length > 0)
  const layoutsImagesValid = !isSetCollectionShape || layoutRows.every((r) => layoutRowImageCount(r) > 0)

  const validations = {
    // Standard per-slot image grid is replaced by the per-layout editor
    // on a collection, so it short-circuits here (layouts* keys cover it).
    images:         (isVariantRound || isSetCollectionShape) ? true : everySlotHasImage,
    pricingDisplay: isPerDirectionRound ? true : pricingDisplay !== null,
    material:       isPerDirectionRound ? true : !!selectedMaterialId,
    variant:        isPerDirectionRound ? true : (!variantRequired || selectedVariantIds.length > 0),
    currency:       isPerDirectionRound ? true : (isCustomQuote || currency !== null),
    inkNames:       isPerDirectionRound ? true : (!requiresInkNames || (inkCount > 0 && inkNameValidities.every(Boolean))),
    names:          isVariantRound ? true : namesValid,
    // Options — required when the material exposes an option dimension
    // (finish on metals, species on wood, etc.) and we're saving a
    // standard proof. Variant-round + per-direction-pricing rounds
    // hide the option picker entirely so they short-circuit to true.
    // Standard v1 creation (no carry) defaults to the base option via
    // the material-loading effect so this validation passes silently
    // there too; the case it actually catches is "v(N-1) was a variant
    // round and the designer hasn't picked a species yet for v(N)".
    options:        (isVariantRound || isPerDirectionRound || !hasOptions) ? true : selectedOptions.length > 0,
    frontColour:    isPerDirectionRound ? true : (!requiresLayerColours || selectedFrontColourId !== null),
    coreColour:     isPerDirectionRound ? true : (!requiresLayerColours || selectedCoreColourId !== null),
    backColour:     isPerDirectionRound ? true : (!requiresLayerColours || selectedBackColourId !== null),
    variantsCount:  variantsCountValid,
    variantsLabels: variantsLabelsValid,
    variantsImages: variantsImagesValid,
    layoutsCount:   layoutsCountValid,
    layoutsTitles:  layoutsTitlesValid,
    layoutsImages:  layoutsImagesValid,
  } as const
  const isValid = Object.values(validations).every(Boolean)
  // Rose-tint a field whenever its validation fails, regardless of
  // whether the designer has clicked Save yet. The previous gate
  // (`submitAttempted && !validations[k]`) hid the tint until the
  // first save click, but the Save button is disabled while invalid
  // — so the click never fires and the tint never appears. The
  // designer was left guessing what was missing. Always-on tints
  // are louder on first load (v1 creation lights up every required-
  // but-empty field) but resolve the "why is Save greyed out"
  // discoverability problem cleanly: tints clear as fields are
  // filled, so the form acts as its own progress indicator.
  const shouldHighlight = (k: keyof typeof validations) => !validations[k]

  // The form can save once the proof is routed to a concrete, persistable
  // shape AND all required fields are valid. Set (collection) is no longer
  // excluded — its layouts* validations above gate it instead (Phase 2).
  const canSave = isValid && wizardResolved

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
    // Drop all three layer-colour selections when leaving a material
    // that wants them. Keeps state honest so the designer never
    // carries stale colours into a non-letterpress save (where they'd
    // be sent to the DB and stored against a non-letterpress version).
    if (next && !LAYER_COLOUR_MATERIAL_CODES.has(next.code)) {
      setSelectedFrontColourId(null)
      setSelectedCoreColourId(null)
      setSelectedBackColourId(null)
    }
  }

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
    // Letterpress layer colours. Each layer is independently
    // tracked: the snapshot captures v(N-1)'s value and the carry
    // pill reflects whether the current selection matches. The
    // pickers only render when the version-level material is in
    // LAYER_COLOUR_MATERIAL_CODES, so the pills only ever appear in
    // a context where the value is meaningful.
    frontColour: {
      isCarried: inh !== null && inh.frontColourId !== null,
      isEdited: inh !== null && inh.frontColourId !== null && inh.frontColourId !== selectedFrontColourId,
    },
    coreColour: {
      isCarried: inh !== null && inh.coreColourId !== null,
      isEdited: inh !== null && inh.coreColourId !== null && inh.coreColourId !== selectedCoreColourId,
    },
    backColour: {
      isCarried: inh !== null && inh.backColourId !== null,
      isEdited: inh !== null && inh.backColourId !== null && inh.backColourId !== selectedBackColourId,
    },
  }

  // ── QR carry-forward derivations ─────────────────────────────────
  // displayQrEntries decorates each existing QR entry with effective
  // `keep` + `artworkChanged` flags driven by the artwork carry state.
  // The qrEntries / qrKeepOverrides state pair remains the source of
  // truth; displayQrEntries is rebuilt every render. Effective keep =
  // designer override (qrKeepOverrides) if set, otherwise the
  // auto-rule (keep=true unless the entry's slot is in
  // artworkChangedSlots). Both inputs feed handleSubmit through the
  // same helper, so save-time filtering can't drift from the UI.
  // Mirror the save-path carryOptionStillValid guard so the render-
  // side amber notice + auto-unkeep fires when a v1 image's option no
  // longer maps to v2's selected tabs. Same predicate as in
  // handleSubmit; kept inline here to avoid lifting closure state.
  const renderOptionKeys = optionMode ? selectedOptions : ['']
  const invalidV1RowIds = v1Carry
    ? new Set(
        v1Carry.images
          .filter((img) => {
            const imgOption = img.material_option ?? ''
            if (renderOptionKeys.includes(imgOption)) return false
            const firstSelectedOption = selectedOptions[0] ?? ''
            return !(
              v1Carry.sourceIsVariantRound === true &&
              img.material_option == null &&
              firstSelectedOption !== ''
            )
          })
          .map((img) => img.v1RowId),
      )
    : undefined
  const artworkChangedSlots = computeQrArtworkChangedSlots(
    v1Carry,
    keepByV1RowId,
    replacementByV1RowId,
    imagesByOption,
    names.map((n) => n.trim()).filter(Boolean),
    invalidV1RowIds,
  )

  const displayQrEntries: QrEntry[] = qrEntries.map((entry) => {
    if (entry.source !== 'existing') return entry
    // Surface-membership flag: a shared QR (assoc=null) sits on
    // every printed card, so any change anywhere flags it; a named
    // QR sits on that recipient's card, which carries both the
    // recipient's own artwork AND the shared artwork, so either
    // type of change flags it. See isQrSlotFlagged for the full
    // rule.
    const artworkChanged = isQrSlotFlagged(entry.associatedName, artworkChangedSlots)
    const effectiveKeep = resolveQrEffectiveKeep(
      entry.id,
      entry.associatedName,
      qrKeepOverrides,
      artworkChangedSlots,
    )
    return { ...entry, keep: effectiveKeep, artworkChanged }
  })

  function handleQrKeepChange(entryId: string, keep: boolean) {
    setQrKeepOverrides((prev) => ({ ...prev, [entryId]: keep }))
  }

  return (
    <DesignerChrome active="proofs">
    <div className="min-h-dvh bg-canvas">
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
      {/* Page-wide drag overlay. Activates while the designer drags
          a file from outside the browser onto any part of the page.
          Drops are routed via useImageFileDrop's window listeners
          to addFilesBatch, which auto-distributes across slots in
          the active option tab. Per-cell zones (CarryCard,
          EmptySlot) intercept their own drops via stopPropagation
          first, so the overlay never double-fires for a precise
          drop. */}
      <PageDropOverlay visible={isPageDragOver} />
      <div className="mx-auto max-w-6xl px-4 py-10 pb-32 sm:px-6">

        {/* Breadcrumb back to Proofs / this project. */}
        <nav className="mb-6 flex items-center gap-1.5 text-[13px] text-ink-mute">
          <Link to="/" className="hover:text-ink">Proofs</Link>
          <span className="text-ink-dim">›</span>
          <Link to={`/proofs/${proofId}`} className="max-w-[24ch] truncate hover:text-ink">{proofName ?? 'Project'}</Link>
          <span className="text-ink-dim">›</span>
          <span className="text-ink">{savedVersion ? `v${savedVersion.number}` : 'Add version'}</span>
        </nav>

        {/* Page heading. Cancel + Save live in the sticky bottom
            action bar (see end of return) so they're reachable
            from any scroll position on the long-form layout. */}
        <div className="mb-8">
          <h1 className="font-display font-medium tracking-[-0.02em] text-ink leading-tight" style={{ fontSize: 'clamp(24px, 4vw, 32px)' }}>
            {savedVersion ? `Version v${savedVersion.number} saved` : 'Add version'}
          </h1>
          {proofCompany && <p className="mt-1 text-sm text-ink-dim">{proofCompany}</p>}
        </div>

        {savedVersion && !previewApproved && (
          // Post-save preview gate. The designer sees the customer
          // page rendered in an iframe with a banner of action
          // buttons; only after they tick "Looks good" does the
          // MessageSendPanel below take over. "Go back and edit"
          // hops them to the edit-version route for this just-
          // saved version. See VersionPreviewGate.tsx for the
          // wider rationale.
          <VersionPreviewGate
            proofId={proofId!}
            versionId={savedVersion.id}
            versionNumber={savedVersion.number}
            currency={currency}
            confirmLabel="Looks good, send proofs to customer"
            onConfirm={() => setPreviewApproved(true)}
            onEdit={() => navigate(`/proofs/${proofId}/versions/${savedVersion.id}/edit`)}
          />
        )}

        {savedVersion && previewApproved && (() => {
          // Post-save MessageSendPanel branch. Replaces the form
          // until the designer either sends a reply or skips. Both
          // paths navigate to the project detail page.
          const tplId: 'first_proof' | 'revision' =
            savedVersion.number === 1 ? 'first_proof' : 'revision'
          const customerUrl = `${window.location.origin}${customerProofPath(proofId!)}`
          const messageContext = {
            first_name: firstName(proofName),
            full_name: proofName,
            company: proofCompany || null,
            version_number: savedVersion.number,
            url: customerUrl,
            // Designer accounts are deferred; the variable resolves
            // to empty today. Templates currently hardcode "Plasma
            // Design" in the signoff so the empty value is fine.
            designer_first_name: '',
          }
          return (
            <MessageSendPanel
              proofId={proofId!}
              versionId={savedVersion.id}
              versionNumber={savedVersion.number}
              templateId={tplId}
              context={messageContext}
              hasHelpScoutConversation={!!proofHelpScoutConversationId}
              onSent={() => navigate(`/proofs/${proofId}`)}
              onSkip={() => navigate(`/proofs/${proofId}`)}
            />
          )
        })()}

        <form id="new-version-form" onSubmit={handleSubmit} className={savedVersion ? 'hidden' : 'space-y-6'}>

          {/* Two-column layout: spec/setup sections on the left,
              proof images + QR + change notes on the right. The wide
              per-variant pricing-reference tables stay full-width
              below the grid. Stacks to one column below lg. */}
          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <div className="space-y-6">

          {/* Carry-forward summary card — only renders on v2+ when
              there's an inheritance source. Labelled name-value
              rows show what this version inherits from v(N-1),
              update live as the designer edits in expanded mode.
              Warnings (archived material, currency mismatch)
              render inside the card so they're visible even when
              the form below is collapsed. "Edit details" expands
              the form for the rest of the page lifecycle (no
              re-collapse). */}
          {inheritedVersionNumber !== null && !(isVariantRound && isPerDirectionPricing) && (() => {
            // Per-direction-pricing variant rounds (000142, renamed
            // 000144) inherit nothing useful — material_id and
            // currency are forced null, pricing UI is hidden, and
            // the per-side image grid is a brand-new shape. Hiding
            // the docket entirely keeps the form layout clean above
            // the variant editor.
            //
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
            //   * Pricing — always rendered on v2+ (pricingDisplay
            //     is always set on inheritance load). "Standard"
            //     or "Custom quote".
            //   * Inks — only when material requires ink names AND
            //     at least one ink name is filled in.
            //   * Names — only when names list is non-empty.
            //   * Approved on v{N} — only when at least one name
            //     has an 'approved' state on v1 AND that name is
            //     still in current v2 names. Excludes the shared
            //     sentinel; shared-side approval surfaces in the
            //     Images row's approved count instead.
            //   * Sides — always rendered. "1" / "2 (shared front)" /
            //     "2" depending on sidedness + shared.
            //   * Images — only when v1Carry has at least one
            //     image. Static count of v1Carry as loaded; does
            //     not react to Keep / Replace state.
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
            // Pricing display — always inherited on v2+, never null.
            // Reads from current state so the row updates live if
            // the designer flips the field in expanded mode.
            rows.push({
              label: 'Pricing',
              value: pricingDisplay === 'custom' ? 'Custom quote' : 'Standard',
            })
            if (summaryMaterial?.requires_ink_names && inkNames.length > 0) {
              rows.push({ label: 'Inks', value: formatJoinedList(inkNames) })
            }
            if (names.length > 0) {
              rows.push({ label: 'Names', value: formatJoinedList(names) })
            }
            // Approved-on-v{N} row. Reads v1's per-name approval
            // table loaded into v1Carry.approvalsByName. The shared
            // sentinel is filtered out (the brief asks for names
            // only; shared-side approval surfaces in the Images
            // row below). Names dropped on v2 in expanded mode are
            // filtered out so a removed chip does not surface as a
            // ghost approval.
            const approvedNames = v1Carry
              ? Object.entries(v1Carry.approvalsByName)
                  .filter(([key, a]) => key !== SHARED_APPROVAL_KEY && a.state === 'approved')
                  .map(([name]) => name)
                  .filter((n) => names.includes(n))
              : []
            if (approvedNames.length > 0) {
              rows.push({
                label: `Approved on v${inheritedVersionNumber}`,
                value: formatJoinedList(approvedNames),
              })
            }
            const sidesValue = sidedness === 'one-sided'
              ? '1'
              : (shared ? '2 (shared front)' : '2')
            rows.push({ label: 'Sides', value: sidesValue })
            // Images composition — static count of v1Carry as
            // loaded. Approved count uses the same identity-key
            // pattern used by the cell builder's stateBucketFor:
            // each image's identity is associated_name (or the
            // shared sentinel when null), and the per-name
            // approval state is read off v1Carry.approvalsByName.
            // Three format branches: bare carried count, partial
            // approved count, "all approved" when every image is
            // covered.
            if (v1Carry && v1Carry.images.length > 0) {
              const total = v1Carry.images.length
              const approvedCount = v1Carry.images.filter((img) => {
                const key = img.associated_name ?? SHARED_APPROVAL_KEY
                return v1Carry.approvalsByName[key]?.state === 'approved'
              }).length
              const value =
                approvedCount === 0
                  ? `${total} carried`
                  : approvedCount === total
                    ? `${total} carried, all approved`
                    : `${total} carried, ${approvedCount} approved`
              rows.push({ label: 'Images', value })
            }
            if (cardType === 'membership') {
              rows.push({ label: 'Card type', value: 'Membership' })
            }

            return (
              <section className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-widest text-ink-dim">
                  Carried from v{inheritedVersionNumber}
                </h3>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
                  {rows.map(({ label, value }) => (
                    <Fragment key={label}>
                      <dt className="text-right text-sm font-medium text-ink-mute">{label}:</dt>
                      <dd className="text-sm text-ink">{value}</dd>
                    </Fragment>
                  ))}
                </dl>
                {inheritedMaterialArchived && (
                  <p className="mt-3 text-sm text-low">
                    The material has been archived. Edit details to pick a current one, or keep this for continuity.
                  </p>
                )}
                {/* Missing-required items list — surfaces validation
                    gaps in the collapsed summary so the designer doesn't
                    have to open Edit details to discover them. Reads
                    the same `missingFieldItems` data the Save tooltip
                    uses, just rendered as bullets so each item is its
                    own scannable line. Hidden once everything validates. */}
                {!isValid && (() => {
                  const items = missingFieldItems(validations, optionLabelSingular)
                  if (items.length === 0) return null
                  return (
                    <ul className="mt-3 list-disc space-y-1 pl-5 text-sm font-medium text-out">
                      {items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )
                })()}
                {!formExpanded && (
                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setFormExpanded(true)}
                      className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
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
          {/* ── Proof type (the wizard) ──────────────────────────────
              Replaces the old Round-mode toggle. A single-page,
              progressive-disclosure wizard whose resolved shape is the
              single source that drives isVariantRound /
              isPerDirectionPricing / cardType / hasPersonalisation via
              handleWizardChange. The rest of the form below adapts to
              the resolved shape (per docs/proof-type-wizard-spec.md). */}
          <ProofShapeWizard
            answers={wizardAnswers}
            onChange={handleWizardChange}
            materialChosen={!!selectedMaterialId}
            materialSupportsPersonalisation={!!selectedMaterial?.supports_personalisation}
            personalisationHelper={personalisationHelperText(currency, personalisationPricing)}
          />

          {/* Pricing display — required choice between standard grid and custom quote */}
          {/* Commercial — pricing display + currency. The two
              monetary decisions live together at the top of the
              form, before the physical card decisions in
              Specification. Hides Currency in custom-quote mode
              (no price grid means no currency to denominate).

              Per-direction-pricing variant rounds (000142, renamed 000144) hide the whole
              Commercial card — pricing is per-variant and handled
              out-of-band, so there's no version-level currency
              decision to make. */}
          {!isPerDirectionRound && (
          <section className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
            <div className="mb-7">
              <h3 className="text-base font-semibold text-ink">Commercial</h3>
              <p className="mt-0.5 text-xs text-ink-mute">Currency and how customers see pricing.</p>
            </div>

            <div className="mb-8">
              <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-ink-soft">
                <span>Pricing display</span>
                {carry.pricingDisplay.isCarried && inheritedVersionNumber != null && (
                  <CarriedPill edited={carry.pricingDisplay.isEdited} versionNumber={inheritedVersionNumber} />
                )}
              </label>
              <div style={carriedFieldStyle(carry.pricingDisplay.isCarried, carry.pricingDisplay.isEdited)}>
                <PricingDisplayField
                  value={pricingDisplay}
                  onChange={setPricingDisplay}
                  invalid={shouldHighlight('pricingDisplay')}
                  forwardRef={pricingDisplayRef}
                  tone={chipTone(carry.pricingDisplay.isCarried, carry.pricingDisplay.isEdited)}
                  standardDisabled={wizardForcesCustomQuote}
                  disabledReason={
                    wizardForcesCustomQuote
                      ? "This set spans more than one material, so the price grid can't price it. The customer page hides pricing and you quote it manually."
                      : undefined
                  }
                />
              </div>
            </div>

            {/* Currency — hidden in custom-quote mode (no grid, no
                currency to denominate). Same shape as the previous
                standalone Currency block, just relocated into the
                Commercial card. */}
            {!isCustomQuote && (
              <div ref={currencyRef}>
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-ink-soft">
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
                    tone={chipTone(carry.currency.isCarried, carry.currency.isEdited)}
                  />
                  {shouldHighlight('currency') && (
                    <p className="mt-1.5 text-xs font-medium text-out">Required</p>
                  )}
                </div>
              </div>
            )}
          </section>
          )}

          {/* Specification — physical card decisions. Split into
              Design (material, finish, ink names) and Layout
              (names, sides, splits) sub-sections under their own
              bold sans-serif headers.

              Per-direction-pricing variant rounds (000142, renamed 000144) hide the whole
              Specification card — every per-direction material is
              decided out-of-band. The variant editor below carries
              the design info for each direction. */}
          {!isPerDirectionRound && (
          <section className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
            <div className="mb-7">
              <h3 className="text-base font-semibold text-ink">Design</h3>
              <p className="mt-0.5 text-xs text-ink-mute">Material and finish.</p>
            </div>

            <div className="mb-8">
              <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-ink-soft">
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
                  className={[selectClass, shouldHighlight('material') ? 'border-out focus:border-out focus:ring-out' : ''].join(' ')}
                >
                  <option value="">Select a material…</option>
                  {materials.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </select>
                {shouldHighlight('material') && <p className="mt-1.5 text-xs font-medium text-out">Required</p>}
                {inheritedMaterialArchived && inheritedVersionNumber != null && (
                  <p className="mt-1.5 rounded-md bg-low-soft px-3 py-2 text-xs text-low ring-1 ring-low">
                    The material used in v{inheritedVersionNumber} has been archived. Pick a current material or keep this one.
                  </p>
                )}
              </div>
            </div>

            {variantRequired && variants.length > 0 && variantType !== 'default' && (
              <div ref={variantRef} className="mb-8">
                <label className="mb-2.5 flex flex-wrap items-center gap-2 text-sm font-medium text-ink-soft">
                  <span>{variantLabel(variantType)}</span>
                  {carry.variants.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.variants.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>

                <div style={carriedFieldStyle(carry.variants.isCarried, carry.variants.isEdited)}>
                  {isMultiVariant ? (
                    <div className={[
                      'flex flex-wrap gap-2 rounded-lg',
                      shouldHighlight('variant') ? 'p-2 ring-1 ring-out' : '',
                    ].join(' ')}>
                      {variants.map((v) => {
                        const checked = selectedVariantIds.includes(v.id)
                        return (
                          <button key={v.id} type="button" onClick={() => toggleVariant(v.id)}
                            className={[
                              'rounded px-5 py-2 text-sm font-medium transition-colors',
                              checked
                                ? ''
                                : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                            ].join(' ')}
                            style={checked ? selectedChipStyle(carry.variants.isCarried, carry.variants.isEdited) : undefined}>
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
                      className={[selectClass, shouldHighlight('variant') ? 'border-out focus:border-out focus:ring-out' : ''].join(' ')}
                    >
                      <option value="">Select…</option>
                      {variants.map((v) => <option key={v.id} value={v.id}>{v.display_name}</option>)}
                    </select>
                  )}
                  {/* Customer-perspective explanation of what
                      ticking variants does. Replaces the previous
                      "Tick every option you want the customer to
                      see." which implied the wrong mental model
                      (tick-as-approval rather than tick-as-column).
                      Only renders for multi-variant materials —
                      single-variant select shows nothing extra. */}
                  {isMultiVariant && (
                    <p className="mt-1.5 text-xs text-ink-mute">
                      Customer sees a column for each {variantLabel(variantType).toLowerCase()} you tick.
                    </p>
                  )}
                  {shouldHighlight('variant') && <p className="mt-1.5 text-xs font-medium text-out">Required</p>}
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
                    <p className="mt-1.5 rounded-md bg-low-soft px-3 py-2 text-xs text-low ring-1 ring-low">
                      This ink count has no standard pricing, saving as a custom quote. Price and quantity will be agreed separately.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Option selection — for materials that expose multi-options
                (finishes on metals, species on wood, etc.) */}
            {hasOptions && (
              <div ref={optionsRef} className="mb-8">
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-ink-soft">
                  <span>{optionLabelPlural}</span>
                  {carry.options.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.options.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>
                <div
                  className={shouldHighlight('options') ? 'rounded-xl p-2 ring-1 ring-out' : ''}
                  style={carriedFieldStyle(carry.options.isCarried, carry.options.isEdited)}
                >
                  <div className="flex flex-wrap gap-2">
                    {availableOptions.map(o => {
                      const selected = selectedOptions.includes(o.code)
                      return (
                        <button
                          key={o.code}
                          type="button"
                          onClick={() => toggleOption(o.code)}
                          className={[
                            'rounded px-5 py-2 text-sm font-medium transition-colors',
                            selected
                              ? ''
                              : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                          ].join(' ')}
                          style={selected ? selectedChipStyle(carry.options.isCarried, carry.options.isEdited) : undefined}
                        >
                          {o.display_name}
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-1.5 text-xs text-ink-mute">
                    Each {optionLabelSingular.toLowerCase()} becomes a tab on the customer's view, with its own proof images and pricing.
                  </p>
                  {shouldHighlight('options') && (
                    <p className="mt-1.5 text-xs font-medium text-out">
                      {v1Carry?.sourceIsVariantRound
                        ? `Pick the ${optionLabelSingular.toLowerCase()} this version is for.`
                        : `Pick at least one ${optionLabelSingular.toLowerCase()}.`}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Paper layers — only renders for un-gilded letterpress
                (paper_letterpress). Gilded letterpress hides the
                layered edge behind the gilded edge so no pickers
                are needed. The catalogue is admin-managed at
                /admin/core-colours; all three pickers see only
                active rows (RLS filters at the DB) and pull from
                the same shared list. All three required when
                visible. Grouped under one "Paper layers" heading
                so the designer reads it as one decision rather
                than three independent fields. */}
            {requiresLayerColours && (
              <div className="mb-8 rounded-xl bg-canvas p-4 ring-1 ring-line-soft">
                <label className="mb-1 flex items-center gap-2 text-sm font-medium text-ink-soft">
                  <span>Paper layers</span>
                </label>
                <p className="mb-3 text-xs text-ink-mute">
                  The three Colorplan layers visible at the card's edge. Pick a colour for each.
                </p>
                <div className="space-y-3">
                  <LayerColourPicker
                    label="Front"
                    refEl={frontColourRef}
                    selectedId={selectedFrontColourId}
                    onChange={setSelectedFrontColourId}
                    colours={coreColours}
                    invalid={shouldHighlight('frontColour')}
                    carriedFromVersionNumber={carry.frontColour.isCarried ? inheritedVersionNumber : null}
                    isEdited={carry.frontColour.isEdited}
                  />
                  <LayerColourPicker
                    label="Core"
                    refEl={coreColourRef}
                    selectedId={selectedCoreColourId}
                    onChange={setSelectedCoreColourId}
                    colours={coreColours}
                    invalid={shouldHighlight('coreColour')}
                    carriedFromVersionNumber={carry.coreColour.isCarried ? inheritedVersionNumber : null}
                    isEdited={carry.coreColour.isEdited}
                  />
                  <LayerColourPicker
                    label="Back"
                    refEl={backColourRef}
                    selectedId={selectedBackColourId}
                    onChange={setSelectedBackColourId}
                    colours={coreColours}
                    invalid={shouldHighlight('backColour')}
                    carriedFromVersionNumber={carry.backColour.isCarried ? inheritedVersionNumber : null}
                    isEdited={carry.backColour.isEdited}
                  />
                </div>
              </div>
            )}

            {requiresInkNames ? (
              <div ref={inkNamesRef} className="mb-8">
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-ink-soft">
                  <span>Ink names</span>
                  {carry.inkNames.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.inkNames.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>
                <div style={carriedFieldStyle(carry.inkNames.isCarried, carry.inkNames.isEdited)}>
                  {inkCount === 0 ? (
                    <p className="text-sm text-ink-dim">Select a variant to enter ink names.</p>
                  ) : (
                    <div className="space-y-2">
                      {Array.from({ length: inkCount }).map((_, i) => {
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
                  )}
                </div>
              </div>
            ) : (
              <div className="mb-8">
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-ink-soft">
                  <span>Ink names</span>
                  {carry.inkNames.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.inkNames.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>
                <div style={carriedFieldStyle(carry.inkNames.isCarried, carry.inkNames.isEdited)}>
                  <input type="text" placeholder="e.g. Pantone 185 C, Metallic Gold" value={inkNamesText}
                    onChange={(e) => setInkNamesText(e.target.value)} className={inputClass} />
                  <p className="mt-1.5 text-xs text-ink-mute">Optional. Comma-separated.</p>
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
                convention is always 'front' in Business.
                Currency lives in the Commercial card above; this
                card holds the physical layout decisions only.

                Variant rounds (build-plan step 5) hide the entire
                Layout sub-section — names + sidedness + shared
                don't apply when the customer is comparing parallel
                directions. The variant editor below replaces the
                image bucket too. State is preserved across mode
                flips so a designer can switch back without losing
                their layout config. */}
            {!isVariantRound && !isSetCollectionShape && (<>
            <div className="mt-10 mb-7">
              <h3 className="text-base font-semibold text-ink">Layout</h3>
              <p className="mt-0.5 text-xs text-ink-mute">Names, sides, and how the card splits.</p>
            </div>

            {/* Card type is no longer a standalone control here — the
                proof-type wizard at the top of the form governs it
                (business = Recipients, membership = the Set branch) via
                handleCardTypeChange. See ProofShapeWizard. */}

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
            {/* Names roster shows only on the Recipients shape — every
                other shape resolved by the wizard is no-name (Set) or
                single-bucket (Selection). Set (collection) layout titles
                live in the wizard's dedicated editor, not here, so the
                names array keeps meaning "named recipients" only. */}
            {isRecipientsShape && (
            <div ref={namesRef} className="mb-8">
              <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-ink-soft">
                <span>Names on this order</span>
                {carry.names.isCarried && inheritedVersionNumber != null && (
                  <CarriedPill edited={carry.names.isEdited} versionNumber={inheritedVersionNumber} />
                )}
              </label>
              <div style={carriedFieldStyle(carry.names.isCarried, carry.names.isEdited)}>
                <NameChipInput
                  names={names}
                  onChange={handleNamesChange}
                  placeholder="Who is this proof for? Press Enter after each name"
                  ariaLabel="Names on this order"
                />
                {shouldHighlight('names') && (
                  <p className="mt-1.5 text-xs font-medium text-out">
                    Add at least one name.
                  </p>
                )}
              </div>
            </div>
            )}

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
                <label className="mb-2.5 flex items-center gap-2 text-sm font-medium text-ink-soft">
                  <span>Sidedness</span>
                  {carry.sidedness.isCarried && inheritedVersionNumber != null && (
                    <CarriedPill edited={carry.sidedness.isEdited} versionNumber={inheritedVersionNumber} />
                  )}
                </label>
                <div style={carriedFieldStyle(carry.sidedness.isCarried, carry.sidedness.isEdited)}>
                  <fieldset className="inline-flex rounded border border-line bg-surface p-0.5">
                    <legend className="sr-only">Sidedness</legend>
                    {(['one-sided', 'two-sided'] as const).map((opt) => {
                      const selected = sidedness === opt
                      return (
                        <label
                          key={opt}
                          className={[
                            'cursor-pointer rounded px-5 py-2 text-sm font-semibold transition-colors',
                            'focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-1',
                            selected ? '' : 'text-ink-mute hover:text-ink',
                          ].join(' ')}
                          style={selected ? selectedChipStyle(carry.sidedness.isCarried, carry.sidedness.isEdited) : undefined}
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
                  <div className="flex items-center justify-between rounded border border-line bg-surface px-4 py-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium text-ink-soft">
                        <span>Shared</span>
                        {carry.shared.isCarried && inheritedVersionNumber != null && (
                          <CarriedPill edited={carry.shared.isEdited} versionNumber={inheritedVersionNumber} />
                        )}
                      </div>
                      <div className="text-xs text-ink-mute">
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
                        shared ? 'bg-ink' : 'bg-line',
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'inline-block h-5 w-5 translate-y-0.5 transform rounded-full bg-surface transition-transform',
                          shared ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
                        ].join(' ')}
                      />
                    </button>
                  </div>
                </div>
              )}
            </div>
            </>)}

            {/* Personalisation is no longer a standalone checkbox here.
                The proof-type wizard's Step 6 governs hasPersonalisation
                (membership style + a material that supports it). The
                same gate — supports_personalisation, membership,
                !custom-quote, !variant-round — is enforced in the wizard
                and at the DB level (000173 CHECK). */}

          </section>
          )}
          </>
          )}
          </div>
          {/* Right column — the image/drop surface for whichever shape
              is active (Variants editor / Layouts editor / standard
              Proof images), then QR (standard only), then Change notes.
              The three editing surfaces are mutually exclusive by shape,
              so exactly one renders. */}
          <div className="space-y-6">

          {/* ── Variant editor (build-plan step 5C) ──────────────────
              Variant rounds replace the per-recipient image bucket
              with one bucket per parallel variant. Each row carries
              a customer-facing display_name (rendered as the variant
              card heading on the customer page) and a queued file
              set (becomes proof_version_images rows on save, each
              with round_variant_id pointing at this variant's id).
              Order in this list maps to proof_round_variants.sort_order
              and drives the customer-page comparison-grid order. */}
          {isVariantRound && (
            <section
              ref={variantEditorRef}
              className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line"
            >
              <div className="mb-6">
                <h2 className="text-base font-semibold text-ink">Variants</h2>
                <p className="mt-0.5 text-xs text-ink-mute">
                  Each row is a parallel direction. The customer compares them side-by-side and picks one. Names show on the customer page exactly as typed; the variant ID is fixed when you first save and won't change with renames.
                </p>
              </div>
              <ul className="space-y-4">
                {variantRows.map((row, idx) => {
                  const placeholder =
                    idx === 0 ? 'e.g. Charcoal' : idx === 1 ? 'e.g. Ivory' : ''
                  const labelInvalid =
                    submitAttempted && row.display_name.trim().length === 0
                  const frontInvalid = submitAttempted && row.frontFiles.length === 0
                  const backEnabled = row.backFiles !== null
                  const backInvalid =
                    submitAttempted && backEnabled && (row.backFiles?.length ?? 0) === 0

                  function updateRow(patch: Partial<VariantDraftRow>) {
                    setVariantRows((prev) =>
                      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
                    )
                  }

                  return (
                    <li
                      key={row.key}
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
                            placeholder={placeholder}
                            onChange={(e) => updateRow({ display_name: e.target.value })}
                            className={[
                              'w-full rounded border bg-surface px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2',
                              labelInvalid
                                ? 'border-out focus:border-out focus:ring-out'
                                : 'border-line focus:border-brand focus:ring-brand',
                            ].join(' ')}
                          />
                          {labelInvalid && (
                            <p className="mt-1.5 text-xs font-medium text-out">Required</p>
                          )}

                          {/* Front drop zone — always visible. */}
                          <div className="mt-4">
                            <VariantDropZone
                              label="Front"
                              files={row.frontFiles}
                              onAddFiles={(picked) =>
                                updateRow({ frontFiles: [...row.frontFiles, ...picked] })
                              }
                              onRemoveFile={(fi) =>
                                updateRow({
                                  frontFiles: row.frontFiles.filter((_, fj) => fj !== fi),
                                })
                              }
                              invalid={frontInvalid}
                              invalidText="Add at least one image for this direction."
                            />
                          </div>

                          {/* Back drop zone — opt-in per variant. The
                              "+ Add back side" button reveals the
                              second VariantDropZone; "Remove back side"
                              clears any uploaded back files for this
                              direction. */}
                          {backEnabled && (
                            <div className="mt-4">
                              <VariantDropZone
                                label="Back"
                                files={row.backFiles ?? []}
                                onAddFiles={(picked) =>
                                  updateRow({
                                    backFiles: [...(row.backFiles ?? []), ...picked],
                                  })
                                }
                                onRemoveFile={(fi) =>
                                  updateRow({
                                    backFiles: (row.backFiles ?? []).filter(
                                      (_, fj) => fj !== fi,
                                    ),
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
                              onClick={() =>
                                updateRow({
                                  backFiles: backEnabled ? null : [],
                                })
                              }
                              className="text-xs font-medium text-ink-soft underline underline-offset-4 hover:text-ink"
                            >
                              {backEnabled ? '− Remove back side' : '+ Add back side'}
                            </button>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setVariantRows((prev) => {
                                if (idx === 0) return prev
                                const next = [...prev]
                                ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
                                return next
                              })
                            }
                            disabled={idx === 0}
                            className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink-soft hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label="Move up"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setVariantRows((prev) => {
                                if (idx === prev.length - 1) return prev
                                const next = [...prev]
                                ;[next[idx + 1], next[idx]] = [next[idx], next[idx + 1]]
                                return next
                              })
                            }
                            disabled={idx === variantRows.length - 1}
                            className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink-soft hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label="Move down"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setVariantRows((prev) => prev.filter((_, i) => i !== idx))
                            }
                            disabled={variantRows.length <= 2}
                            className="rounded border border-out bg-surface px-2 py-1 text-xs text-out hover:bg-out-soft disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label={`Remove direction ${idx + 1}`}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
              <div className="mt-4 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() =>
                    setVariantRows((prev) => [
                      ...prev,
                      { key: uuidv4(), display_name: '', frontFiles: [], backFiles: null },
                    ])
                  }
                  className="rounded border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft shadow-sm hover:border-line"
                >
                  + Add direction
                </button>
                {(shouldHighlight('variantsCount') ||
                  shouldHighlight('variantsLabels') ||
                  shouldHighlight('variantsImages')) && (
                  <p className="text-xs font-medium text-out">
                    {!variantsCountValid
                      ? 'Add at least 2 directions.'
                      : !variantsLabelsValid
                        ? 'Every direction needs a name.'
                        : 'Every direction needs at least one image.'}
                  </p>
                )}
              </div>
            </section>
          )}

          {/* ── Set (collection) layouts editor (Phase 2) ─────────────
              Shared with EditVersionPage. One titled layout per row, each
              with its own images. On save each row becomes a proof_layouts
              row plus proof_version_images stamped with that layout's id.
              The standard Layout sub-section, the per-slot image grid, and
              the QR section are all hidden on this shape; this editor
              replaces them. */}
          {isSetCollectionShape && (
            <LayoutsEditor
              rows={layoutRows}
              onChange={setLayoutRows}
              submitAttempted={submitAttempted}
              editorRef={layoutEditorRef}
              countInvalid={shouldHighlight('layoutsCount')}
              titlesInvalid={shouldHighlight('layoutsTitles')}
              imagesInvalid={shouldHighlight('layoutsImages')}
            />
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
              coordinate.

              Hidden on variant rounds (build-plan step 5) — the
              variant editor above handles image attribution there. */}
          {!isVariantRound && !isSetCollectionShape && (
          <section ref={imageSectionRef} className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-ink-dim">
              {v1Carry ? `Proof images, carrying from v${v1Carry.versionNumber}` : 'Proof images'}
            </h2>

            {/* Variant-round carry picker. Renders only when v(N-1)
                was a variant round AND has at least one variant on
                file. Lets the designer pick which direction the new
                version continues from — the customer's locked choice
                is preselected when available, otherwise the first
                variant in sort order wins. Changing the picker re-
                filters v1Carry.images so only the chosen variant's
                images appear in the carry slots below; the others
                stay in the DB on v(N-1) as audit trail and don't
                propagate forward.

                Hybrid email-feedback note: the customer-locked id
                is null while you're still routing direction decisions
                off-platform. The "Default — please confirm" hint
                under the picker is the form's nudge to verify the
                pre-pick before saving, since the DB has no signal
                about which direction was agreed by email. */}
            {v1Carry && v1Carry.sourceIsVariantRound && v1Carry.sourceVariants.length > 0 && (
              <div className="mb-6 rounded-xl border border-low bg-low-soft px-4 py-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-low">
                    Continuing from which direction?
                  </p>
                  <p className="text-xs text-low">
                    v{v1Carry.versionNumber} was a variant round — only the chosen direction&apos;s images carry across.
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {v1Carry.sourceVariants.map((variant) => {
                    const isSelected = variant.id === carryVariantSelection
                    const isCustomerLocked = variant.id === v1Carry.customerLockedVariantId
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => handleCarryVariantChange(variant.id)}
                        className={[
                          'inline-flex items-center gap-1.5 rounded border px-3.5 py-1.5 text-sm font-medium transition-colors',
                          isSelected
                            ? 'border-low bg-low text-on-ink shadow-sm'
                            : 'border-low bg-surface text-low hover:border-low hover:bg-low-soft',
                        ].join(' ')}
                      >
                        <span>{variant.display_name}</span>
                        {isCustomerLocked && (
                          <span
                            className={[
                              'rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                              isSelected ? 'bg-on-ink/20 text-on-ink' : 'bg-in-stock-soft text-in-stock',
                            ].join(' ')}
                          >
                            Customer pick
                          </span>
                        )}
                      </button>
                    )
                  })}
                  {/* Start fresh chip. Sits at the end of the row in a
                      grey, dashed-border style so it doesn't read as a
                      third variant — visually distinct from the amber
                      variant chips. Click it when the customer asked
                      to go in a completely different direction (e.g.
                      switching materials entirely) and none of v(N-1)'s
                      variant artwork should follow. v1Carry.images
                      flips to [] in the change handler and every carry
                      slot below empties out; the designer uploads from
                      scratch. The amber container around the picker
                      stays — the form still wants the designer to
                      acknowledge that v(N-1) WAS a variant round,
                      even when none of it carries forward. */}
                  {(() => {
                    const isSelected = carryVariantSelection === START_FRESH_SENTINEL
                    return (
                      <button
                        type="button"
                        onClick={() => handleCarryVariantChange(START_FRESH_SENTINEL)}
                        className={[
                          'inline-flex items-center gap-1.5 rounded border px-3.5 py-1.5 text-sm font-medium transition-colors',
                          isSelected
                            ? 'border-ink bg-ink text-on-ink shadow-sm'
                            : 'border-dashed border-line bg-transparent text-ink-soft hover:border-ink hover:bg-canvas',
                        ].join(' ')}
                      >
                        Start fresh
                      </button>
                    )
                  })()}
                </div>
                {carryVariantSelection === START_FRESH_SENTINEL ? (
                  <p className="mt-2.5 text-xs text-low">
                    Starting from scratch — no images from v{v1Carry.versionNumber} carry across. Every slot below is empty; upload new artwork for this version.
                  </p>
                ) : v1Carry.customerLockedVariantId == null && (
                  <p className="mt-2.5 text-xs text-low">
                    No customer selection on file — defaulted to <strong>{v1Carry.sourceVariants[0]?.display_name}</strong>. Switch above if the agreed direction was different, or pick <strong>Start fresh</strong> if none of v{v1Carry.versionNumber}&apos;s artwork should carry across.
                  </p>
                )}
                {/* "Picked a direction but no slot for it yet" notice.
                    Fires when the carry has images but the active shape
                    has no slot universe — typically business + 0 names
                    + non-shared sidedness, where adding a recipient
                    name is the missing step. Without this, the slot
                    grid below renders empty and the designer has no
                    signal that their carry needs a name to surface. */}
                {carryVariantSelection !== START_FRESH_SENTINEL &&
                  v1Carry.images.length > 0 &&
                  !hasAnySlot && (
                  <p className="mt-2.5 text-xs text-low">
                    Add a recipient name below to see your carry images from this direction.
                  </p>
                )}
              </div>
            )}

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
                    background: 'var(--c-brand-50)',
                    boxShadow: 'inset 0 0 0 1.5px var(--c-brand)',
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
                      'flex flex-col items-center justify-center rounded border-2 border-dashed px-6 py-7 text-center transition-colors',
                      dropDisabled
                        ? 'cursor-not-allowed border-line bg-canvas text-ink-dim'
                        : isDragActive
                          ? 'cursor-copy border-transparent text-ink'
                          : 'cursor-pointer border-line bg-canvas text-ink-soft hover:border-line hover:bg-canvas',
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
                        <p className="mt-1 text-xs text-ink-dim">
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
                  sidedness === 'two-sided' && effectiveShared && side === 'front'
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
                // Variant-round carries arrive with material_option=null
                // because the parent variant round had no option tabs.
                // When v(N) turns option mode on, those carries don't
                // match any tab code via the equality check below, so
                // they'd vanish from the slot grid entirely — which is
                // what we saw when testing the picker (carry slot
                // empty even after picking a variant). The designer has
                // already declared a continuing direction via the
                // picker; the stamp-to-tab decision collapses to "the
                // first tab the designer enabled", since variant
                // rounds don't carry an option signal forward. The
                // save path below mirrors this rule so the row lands
                // in the DB with a real option code instead of another
                // null orphan.
                const firstSelectedOption = selectedOptions[0] ?? ''
                const isVariantRoundCarry = v1Carry.sourceIsVariantRound === true
                for (const img of v1Carry.images) {
                  const imgOption = img.material_option ?? ''
                  const matchesActiveTab = imgOption === activeCode
                  const matchesViaVariantRound =
                    isVariantRoundCarry &&
                    img.material_option == null &&
                    activeCode === firstSelectedOption &&
                    firstSelectedOption !== ''
                  if (!matchesActiveTab && !matchesViaVariantRound) continue
                  const side = img.side ?? 'front'
                  // Variant-round carries arrive with associated_name=null
                  // (the variant-round shared-design convention). When
                  // v(N) has names but no SHARED slot for this side, the
                  // helper re-maps the carry to the first name's slot so
                  // it renders rather than orphaning. Standard-proof
                  // carries are passed through untouched.
                  const effectiveAssoc = effectiveAssocForVariantRoundCarry(side, img.associated_name)
                  const identity = effectiveAssoc ?? SHARED_APPROVAL_KEY
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
                  // Approval lookup keys off the v1 image's ORIGINAL
                  // associated_name (the key v1's approvals were
                  // recorded against), not the re-mapped slot identity.
                  const nameKey = cell.img.associated_name ?? SHARED_APPROVAL_KEY
                  const approval = v1Carry?.approvalsByName[nameKey]
                  const keep = keepByV1RowId[cell.img.v1RowId] ?? true
                  const replacement = replacementByV1RowId[cell.img.v1RowId]
                  // The card's name label reflects the SLOT identity
                  // (cell.identity), not the image's original
                  // associated_name. Variant-round carries arrive with
                  // associated_name=null but the cell builder may have
                  // re-mapped them into a per-name slot when no SHARED
                  // slot exists for the side — so reading the image's
                  // own associated_name would mis-label the card as
                  // "Shared" even though it's sitting in Rob's slot.
                  const slotName = cell.identity === SHARED_APPROVAL_KEY ? null : cell.identity
                  return (
                    <CarryCard
                      key={`carry-${cell.img.v1RowId}`}
                      img={cell.img}
                      nameLabel={showLabel ? slotName : undefined}
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
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {sortedCells.map((cell, i) => renderCell(cell, labels[i]))}
                  </div>
                )
              }

              const openLabels = computeLabelVisibility(openCells)
              const approvedLabels = computeLabelVisibility(approvedCells)
              return (
                <>
                  <p className="mb-3 mt-2 text-xs font-medium uppercase tracking-wide text-ink-mute">
                    Open
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {openCells.map((cell, i) => renderCell(cell, openLabels[i]))}
                  </div>
                  <p className="mb-3 mt-8 text-xs font-medium uppercase tracking-wide text-ink-mute">
                    Previously approved
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                <p className="mt-4 border-t border-line-soft pt-4 text-xs text-ink-mute">
                  v{v1Carry.versionNumber} had images on {dropped.join(', ')}, these won't carry since v2 doesn't offer {dropped.length === 1 ? 'that option' : 'those options'}.
                </p>
              )
            })()}

            {fileError && <p className="mt-2 text-sm text-out">{fileError}</p>}
            {fileNote && <p className="mt-2 text-sm text-ink-mute">{fileNote}</p>}
            {shouldHighlight('images') && (
              <p className="mt-2 text-xs font-medium text-out">{imagesHint}</p>
            )}
          </section>
          )}

          {/* The previous bottom-of-form action row mirror was
              dropped in form polish v2; the sticky action bar
              below the form (rendered outside the form's flex
              column) replaces both this mirror and the top-right
              placement. */}

          {/* QR codes (migrations 000168 / 000169).
              Hidden in variant-round mode for v1 — variant-round
              QR rendering on the customer page is deferred to a
              follow-up. The schema supports per-variant QRs via
              round_variant_id, so adding this back is purely a UI
              concern. */}
          {!isVariantRound && !isSetCollectionShape && (
            <QrCodeUploadSection
              // displayQrEntries decorates each existing entry with
              // the page-derived effective keep + artworkChanged
              // flags. qrEntries (the underlying source of truth)
              // doesn't carry those — they're per-render
              // derivations driven by the artwork carry state.
              value={displayQrEntries}
              // The section's onChange path (associated-name
              // changes, Remove) hands back the displayQrEntries
              // shape with keep + artworkChanged still set. Strip
              // them on the way into qrEntries so the source of
              // truth doesn't accumulate stale derived fields. The
              // Keep toggle has its own dedicated path
              // (onKeepChange) and never round-trips through here.
              onChange={(next) =>
                setQrEntries(
                  next.map(({ keep: _k, artworkChanged: _a, ...rest }) => rest),
                )
              }
              names={names.map((n) => n.trim()).filter(Boolean)}
              disabled={submitting}
              onKeepChange={handleQrKeepChange}
            />
          )}

          {/* Change notes */}
          <section className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-ink-dim">Change notes</h2>
            <textarea rows={3} placeholder="What changed in this version? Shown to the customer."
              value={changeNotes} onChange={(e) => setChangeNotes(e.target.value)} className={inputClass} />
          </section>
          </div>
          </div>


          {error && <p className="rounded-lg bg-out-soft px-4 py-3 text-sm text-out">{error}</p>}

        </form>
      </div>

      {/* Sticky bottom action bar. Replaces both the previous
          top-right placement and the bottom-of-form mirror so
          Cancel + Save are always reachable on long-form scrolls.
          Aligned to the form's max-w-2xl content column for visual
          consistency with the cards above; subtle white background
          with backdrop blur reads as a separate layer over the
          form. Hidden on the post-save MessageSendPanel branch
          since the panel owns its own action chrome (Send / Skip).
          The form's wrapper carries pb-32 so the last form
          content scrolls clear of this bar. */}
      {!savedVersion && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <Link
              to={`/proofs/${proofId}`}
              className="text-sm font-medium text-ink-mute hover:text-ink-soft"
            >
              Cancel
            </Link>
            <button
              type="submit"
              form="new-version-form"
              disabled={submitting || !canSave}
              title={
                !wizardResolved
                  ? 'Answer the proof-type questions to continue.'
                  : !isValid
                    ? missingFieldsHint(validations, optionLabelSingular)
                    : undefined
              }
              aria-label={!canSave ? 'Save version, not yet available' : undefined}
              className={[
                'rounded px-4 py-2 text-sm font-semibold text-on-ink transition-colors',
                canSave ? 'bg-ink hover:opacity-90' : 'bg-ink/60',
                'disabled:cursor-not-allowed disabled:opacity-50',
              ].join(' ')}
            >
              {submitting ? 'Uploading and saving…' : 'Save version'}
            </button>
          </div>
        </div>
      )}
    </div>
    </DesignerChrome>
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
// Helper text for the personalisation checkbox. Pulls live values
// from personalisation_pricing so an admin rate edit propagates
// here too — bug sweep finding: the previous hardcoded strings
// silently drifted if an admin ever changed the rate.
// `pricing` is null briefly while the row loads or when the form
// has no currency selected; in that window we fall back to the
// seed values from migration 000172 so the helper is never empty.
function personalisationHelperText(
  currency: Currency | null,
  pricing: { per_card_rate: number; min_charge: number } | null,
): string {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£'
  // Seed fallbacks match migration 000172 — only relevant before
  // pricing loads. After load these never apply.
  const rate = pricing?.per_card_rate ?? (currency === 'USD' || currency === 'EUR' ? 0.25 : 0.20)
  const min = pricing?.min_charge ?? 50
  // Trim trailing zeros on the rate so 0.20 reads as "0.20" but
  // 0.255 reads as "0.255". Two-dp default matches Plasma's
  // existing price typography on the customer page.
  const rateStr = rate.toFixed(2)
  const minStr = min.toFixed(0)
  return `${symbol}${rateStr} per card with a ${symbol}${minStr} minimum charge.`
}

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
// Per-item missing-field copy. One entry per failing validation,
// already prefixed with the right verb ("Select" for pickers,
// "Add" for entries) so call sites can render the items individually
// (e.g. as a bullet list in the summary card) or combine them into a
// single sentence (Save-button tooltip / aria-label).
//
// The "option" dimension is renamed per the active material's
// option_label so the copy mirrors the field label the designer sees
// ("Species" on wood, "Finish" on metals, etc.). Defaults to the
// generic "option" when no material is selected (the material picker
// is itself one of the missing fields in that case).
function missingFieldItems(
  validations: Record<string, boolean>,
  optionLabelSingular: string = 'option',
): string[] {
  const optionWord = optionLabelSingular.toLowerCase()
  const optionArticle = /^[aeiou]/i.test(optionWord) ? 'an' : 'a'
  const items: string[] = []
  if (!validations.pricingDisplay) items.push('Select a pricing display')
  if (!validations.currency) items.push('Select a currency')
  if (!validations.material) items.push('Select a material')
  if (!validations.variant) items.push('Select a variant')
  if (!validations.options) items.push(`Select ${optionArticle} ${optionWord}`)
  if (!validations.frontColour) items.push('Select a front colour')
  if (!validations.coreColour) items.push('Select a core colour')
  if (!validations.backColour) items.push('Select a back colour')
  if (!validations.inkNames) items.push('Add ink names')
  if (!validations.names) items.push('Add at least one name')
  if (!validations.images) items.push('Add at least one image')
  if (!validations.variantsCount) items.push('Add two or more variant directions')
  if (!validations.variantsLabels) items.push('Name each variant direction')
  if (!validations.variantsImages) items.push('Add at least one image per variant direction')
  if (!validations.layoutsCount) items.push('Add at least 2 layouts')
  if (!validations.layoutsTitles) items.push('Give every layout a title')
  if (!validations.layoutsImages) items.push('Add at least one image to every layout')
  return items
}

// Single-sentence form for the Save button's title tooltip and
// aria-label. Joins each item with a period + space ("Select a
// species. Add at least one name.") so the tooltip reads as flowing
// instructions rather than a stacked list (which the tooltip wouldn't
// render anyway).
function missingFieldsHint(
  validations: Record<string, boolean>,
  optionLabelSingular: string = 'option',
): string {
  const items = missingFieldItems(validations, optionLabelSingular)
  if (items.length === 0) return 'Some required fields are incomplete.'
  return items.map((s) => `${s}.`).join(' ')
}

const inputClass = 'w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'
const selectClass = 'select-styled w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand bg-surface'

// One row of the Paper layers picker block. Pulled out as a helper
// so the three layers (Front/Core/Back) share the same swatch-+-
// dropdown layout without three near-identical copies of the JSX.
// refEl is forwarded to the wrapping div so the scroll-to-first-
// invalid path can target this layer specifically.
function LayerColourPicker({
  label,
  refEl,
  selectedId,
  onChange,
  colours,
  invalid,
  carriedFromVersionNumber,
  isEdited,
}: {
  label: string
  refEl: React.RefObject<HTMLDivElement | null>
  selectedId: string | null
  onChange: (next: string | null) => void
  colours: LetterpressCoreColour[]
  invalid: boolean
  // Migrations 000133 / 000135 carry indicators. Null = field is
  // not carried (v1 creation, or v(N-1) had no layer-colour value
  // for this slot). Non-null = render the CarriedPill next to the
  // layer label so designers can see which colours are inherited
  // and which they've changed.
  carriedFromVersionNumber: number | null
  isEdited: boolean
}) {
  const picked = selectedId ? colours.find((c) => c.id === selectedId) ?? null : null
  return (
    <div ref={refEl}>
      <div className="grid grid-cols-[60px_1fr] items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-mute">
          <span>{label}</span>
          {carriedFromVersionNumber !== null && (
            <CarriedPill edited={isEdited} versionNumber={carriedFromVersionNumber} />
          )}
        </label>
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
            className={[selectClass, invalid ? 'border-out focus:border-out focus:ring-out' : ''].join(' ')}
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
        style={{ background: 'var(--c-low-soft)', color: 'var(--c-low)', padding: '2px 8px' }}
      >
        edited
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center rounded-full text-[11px] font-medium"
      style={{ background: 'var(--c-line-soft)', color: 'var(--c-ink-mute)', padding: '2px 8px' }}
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
    // Carried-but-unchanged is neutral ("as before") — a transparent
    // rule reserves the geometry so nothing shifts. Only a change from
    // the prior version lights up amber. Coral is reserved for the
    // selected-value indicator, not for "carried".
    //
    // The edited marker is the full-strength amber left rule; the
    // background fill is softened toward the canvas (~40% strength) so
    // it tints the field without overpowering it — and so the amber
    // selected chip/segment inside (which uses full bg-low-soft) still
    // reads clearly rather than blending into the wrapper.
    borderLeft: edited ? '4px solid var(--c-low)' : '4px solid transparent',
    background: edited ? 'color-mix(in srgb, var(--c-low-soft) 40%, var(--c-bg))' : 'transparent',
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
  background: 'var(--c-brand-50)',
  color: 'var(--c-brand)',
  boxShadow: 'inset 0 0 0 1.5px var(--c-brand)',
}

// Same shape as the violet hybrid above, retinted amber for the
// edited state. Picked at the call site by passing the field's
// carry.X.isEdited so that an edited carried field's selected
// chip / segmented button matches the field's amber border, tint
// and pill instead of leaving a violet active selection inside
// an amber wrapper.
const hybridChipEditedSelectedStyle: CSSProperties = {
  background: 'var(--c-low-soft)',
  color: 'var(--c-low)',
  boxShadow: 'inset 0 0 0 1.5px var(--c-low)',
}

// Neutral selected state for a carried-but-unchanged field. An ink
// outline reads clearly as "selected" without coral, so coral stays
// reserved for fresh (non-carried) selections rather than implying
// "unchanged".
const hybridChipNeutralSelectedStyle: CSSProperties = {
  background: 'var(--c-canvas)',
  color: 'var(--c-ink)',
  boxShadow: 'inset 0 0 0 1.5px var(--c-ink)',
}

// Three-state selected tone for carried fields:
//   fresh (not carried)   -> brand/coral  (just the "selected" look)
//   carried & unchanged   -> neutral      ("as before")
//   carried & changed     -> low/amber    (flags the edit)
function chipTone(carried: boolean, edited: boolean): 'brand' | 'neutral' | 'low' {
  if (!carried) return 'brand'
  return edited ? 'low' : 'neutral'
}
function selectedChipStyle(carried: boolean, edited: boolean): CSSProperties {
  const tone = chipTone(carried, edited)
  if (tone === 'low') return hybridChipEditedSelectedStyle
  if (tone === 'neutral') return hybridChipNeutralSelectedStyle
  return hybridChipSelectedStyle
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
          ? 'bg-low-soft ring-1 ring-low'
          : approval?.state === 'approved'
            ? 'bg-in-stock-soft ring-1 ring-in-stock'
            : 'bg-canvas ring-1 ring-line',
        dragOver ? 'ring-2 ring-brand ring-offset-1' : '',
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
              <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-medium text-ink-mute">
                Shared
              </span>
            ) : (
              <span
                className="truncate text-sm font-medium text-ink-soft"
                title={nameLabel}
              >
                {nameLabel}
              </span>
            )
          )}
          {sideLabel != null && (
            <span className="rounded-full bg-line-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-mute">
              {sideLabel === 'front' ? 'Front' : 'Back'}
            </span>
          )}
          {approval?.state === 'changes_requested' && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-low-soft px-2 py-0.5 text-xs font-medium text-low ring-1 ring-low">
              v{v1VersionNumber} changes requested
            </span>
          )}
        </div>
      )}
      <img
        src={replacement?.preview ?? img.preview}
        alt={displayLabel}
        className={[
          'aspect-[16/10] w-full rounded-lg object-cover transition-opacity',
          showGhosted ? 'opacity-40' : '',
        ].join(' ')}
      />
      <p
        className={[
          'mt-2 truncate text-xs font-normal',
          hasReplacement ? 'text-ink-mute' : 'text-ink-dim',
        ].join(' ')}
        title={displayLabel}
      >
        {displayLabel}
      </p>
      {hasReplacement && (
        <div className="mt-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-low">
            Replacing with
          </p>
          <p
            className="truncate text-xs text-low"
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
            effectiveKeepOn ? 'bg-ink' : 'bg-line',
            hasReplacement ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-4 w-4 transform rounded-full bg-surface transition-transform',
              effectiveKeepOn ? 'translate-x-[1.125rem] translate-y-0.5' : 'translate-x-0.5 translate-y-0.5',
            ].join(' ')}
          />
        </button>
        {hasReplacement ? (
          <button
            type="button"
            onClick={onReplacementClear}
            className="shrink-0 text-xs font-medium text-low underline-offset-2 hover:text-low hover:underline"
          >
            Undo
          </button>
        ) : (
          <label
            className={[
              'shrink-0 cursor-pointer text-xs font-medium underline-offset-2 hover:underline',
              showGhosted ? 'text-ink-dim hover:text-ink-soft' : 'text-ink-mute hover:text-ink',
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
    <div className="rounded-xl bg-canvas p-2.5 ring-1 ring-line transition-all">
      {(nameLabel !== undefined || sideLabel != null) && (
        <div className="mb-2 flex items-center gap-2">
          {nameLabel !== undefined && (
            nameLabel == null ? (
              <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-medium text-ink-mute">
                Shared
              </span>
            ) : (
              <span
                className="truncate text-sm font-medium text-ink-soft"
                title={nameLabel}
              >
                {nameLabel}
              </span>
            )
          )}
          {sideLabel != null && (
            <span className="rounded-full bg-line-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-mute">
              {sideLabel === 'front' ? 'Front' : 'Back'}
            </span>
          )}
        </div>
      )}
      <img
        src={entry.preview}
        alt={entry.file.name}
        className="aspect-[16/10] w-full rounded-lg object-cover"
      />
      <p className="mt-2 truncate text-xs text-ink-dim" title={entry.file.name}>
        {entry.file.name}
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        {twoSided ? (
          <button
            type="button"
            onClick={onFlipSide}
            className="shrink-0 text-xs font-medium text-ink-mute underline-offset-2 hover:text-ink hover:underline"
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
          className="shrink-0 text-xs font-medium text-ink-mute underline-offset-2 hover:text-ink hover:underline"
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
        'flex cursor-pointer flex-col rounded border-2 border-dashed p-2.5 transition-all',
        dragOver
          ? 'border-brand bg-brand-50 ring-2 ring-brand ring-offset-1'
          : 'border-line bg-canvas hover:border-line hover:bg-canvas',
      ].join(' ')}
    >
      {(nameLabel !== undefined || sideLabel != null) && (
        <div className="mb-2 flex items-center gap-2">
          {nameLabel !== undefined && (
            nameLabel == null ? (
              <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-medium text-ink-mute">
                Shared
              </span>
            ) : (
              <span
                className="truncate text-sm font-medium text-ink-soft"
                title={nameLabel}
              >
                {nameLabel}
              </span>
            )
          )}
          {sideLabel != null && (
            <span className="rounded-full bg-line-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-mute">
              {sideLabel === 'front' ? 'Front' : 'Back'}
            </span>
          )}
        </div>
      )}
      <div
        className={[
          'flex aspect-[16/10] w-full items-center justify-center rounded-lg text-center text-xs',
          dragOver ? 'text-brand' : 'text-ink-dim',
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
