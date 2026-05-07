export type Currency = 'GBP' | 'EUR' | 'USD'

export type ProofStatus = 'in_progress' | 'approved' | 'dormant' | 'abandoned'

// Top-level mode for a proof version (migration 000086). Business
// is the standard split-name workflow (names are recipient
// people). Membership covers "one design for everyone" (empty
// names) and "tier variants" (names holds the variant labels —
// Bronze/Silver/Gold, etc.) via the same names[] column.
// Customer-facing UI doesn't need to distinguish — group
// rendering reads associated_name only — so this type is
// designer-side only.
export type CardType = 'business' | 'membership'

export interface PublicProof {
  id: string
  customer_name: string
  company: string | null
  created_at: string
  status: ProofStatus
  approved_at: string | null
  abandoned_at: string | null
  // Help Scout conversation id — exposed on public_proofs by
  // migration 000089. Used on the customer page to render a
  // small "PL · {id}" reference badge in the masthead/footer
  // so the customer has something short to quote back when
  // they reply. Null for proofs created via the override
  // flow (designer set helpscout_override_reason instead of
  // linking a conversation, per migration 000067) — render
  // paths hide the badge when null rather than falling back.
  helpscout_conversation_id: string | null
  // Customer's disclaimer acknowledgement timestamp (migration
  // 000091 + 000092). Null when the customer hasn't ticked
  // "I've read this" yet. Written once per proof (not per
  // version) — the terms apply to the Plasma↔customer
  // relationship, not to each revision. The audit columns
  // (ip / ua / by_name) stay on the base table and are
  // designer-only.
  disclaimer_acknowledged_at: string | null
}

// One entry per variant exposed on a proof version.
// Single-variant materials have one entry; thickness materials may have several.
export interface PricingVariant {
  variant_id: string
  display: string
  prices: Record<string, number> // quantity string → total price in major currency units
}

export interface PricingSnapshot {
  variants: PricingVariant[]
}

// One entry in materials.key_features (migration 000100). Curated
// per-material on the customer About section as a numbered editorial
// list. title is the bolded lead; body is the supporting line beneath.
export interface KeyFeature {
  title: string
  body: string
}

export interface PublicProofVersion {
  id: string
  proof_id: string
  version_number: number
  material_id: string
  material_display: string
  ink_names: string[]
  currency: Currency
  pricing_snapshot: PricingSnapshot
  shipping_note: string
  change_notes: string | null
  is_current: boolean
  created_at: string
  material_options: string[]
  // ── Display list + quote bounds (migrations 000095 / 000096) ─────────────
  // display_quantities drives the single curated pricing table
  // on the customer page. Null means no curation, page falls
  // back to the first 10 tiers ascending from the pricing
  // snapshot. Replaces the 000012 featured_quantities and the
  // 000093 expanded_quantities two-column model.
  //
  // quote_min_quantity / quote_max_quantity bound the customer-
  // facing quantity lookup input. Null on either side means
  // unbounded on that side. Evaluated before snapshot-range
  // fallbacks, so the designer can suppress quoting for small
  // or large runs independently of whether a snapshot tier
  // exists for that quantity.
  display_quantities: number[] | null
  quote_min_quantity: number | null
  quote_max_quantity: number | null
  // ── Key features (migration 000100) ───────────────────────────────────────
  // Curated list of title/body pairs surfaced on the customer
  // proof page's About section as a numbered editorial list
  // (01-04). Supersedes the flat string[] shape from migration
  // 000099. Null or empty means no curation; the render block
  // hides cleanly (kicker + rule still render as section chrome).
  key_features: KeyFeature[] | null
  material_disclaimer: string | null
  /** Paragraph-style text shown in the customer-facing "About [Material]" block. */
  material_description: string | null
  /** Public URL of the material's icon image. */
  material_icon_url: string | null
  option_label: string | null
  custom_quote: boolean
  // ── Supersession (migration 000068) ───────────────────────────────────────
  // Null while this version is chronologically-latest for its proof.
  // Stamped to the next version's created_at when a newer sibling
  // lands. Phase 2's customer page will render a "newer version
  // available" banner when this field is populated.
  //
  // approved_while_superseded is deliberately NOT exposed here —
  // it's a designer/audit field and stays off the customer-facing
  // view.
  superseded_at?: string | null
  // ── Split-name tooling (migration 000070) ─────────────────────────────────
  // Named recipients for this proof (e.g. directors on a metal
  // split-name order). Captured per-version. Empty array = no
  // named recipients.
  names: string[]
  // Per-extra-name tooling surcharge in this version's currency,
  // snapshotted at insert/update time from the version's material.
  // Null when the material has no configured surcharge for the
  // chosen currency (carbon CNC, some paper).
  split_name_surcharge_snapshot: number | null
  // ── Per-name approvals (migration 000087) ────────────────────────────────
  // Every proof_name_approvals row for this version, aggregated
  // into a jsonb array on the view. Empty array when nothing's
  // been approved yet — never null (coalesce on the SQL side).
  // Customer page uses this to render partial-approval UI: a
  // muted roll-up banner + per-group "Approved" / "Approved from
  // v{n}" pills when carry-forward is in play. Actor identity
  // fields (actor_name / actor_ip / actor_ua) stay off the view
  // — designer-only audit concern.
  approvals: Array<{
    name: string
    state: 'approved' | 'changes_requested'
    carried_from_version_id: string | null
  }>
  // ── Card type (migration 000090 — customer-side view) ─────────────────────
  // Was a designer-only concept while the customer page rendered
  // identical chrome for both modes (see f70b551). Now surfaced
  // to the customer view because the Proofs-section count
  // subtext copy-switches / hides based on this value.
  card_type: CardType
  // ── Variant subset (migration 000118) ─────────────────────────────────────
  // Variant IDs the designer chose to offer on this version's pricing
  // grid. Null = "no curation captured" — the customer page falls
  // through to showing every active variant of the material (the post-
  // Phase-2 default). uuid[] = explicit subset, possibly empty (custom-
  // quote versions). Pre-Phase-2 rows backfilled by 000118 from the
  // snapshot's variant_ids; new rows written directly by NewVersionPage.
  displayed_variant_ids: string[] | null
  // ── Phase 2.5 customer approval flow (migrations 000116, 000119, 000120, 000121) ───
  // Latest event per (proof_version_id, recipient name) pair — one
  // entry for each recipient who has acted on this version, plus
  // optionally one entry with name=null for "whole-version" events
  // on membership / single-design proofs. Empty array (never null)
  // when no events exist for the version. Computed in
  // public_proof_versions via DISTINCT ON … ORDER BY created_at DESC,
  // so a recipient who requested changes and later approved shows
  // only the most recent state here. helpscout_thread_id is null
  // when an event was recorded but the HS notification leg failed.
  latest_events_by_name: ProofEventState[]
  // Global gate. False (default) hides the action buttons entirely
  // and keeps the customer page in its read-only Phase 1 shape.
  // Same value on every row — denormalised at the view layer to
  // avoid a separate anon-readable surface on settings.
  approvals_enabled: boolean
  // ── Letterpress layer colours (migrations 000133 + 000135) ────────────────
  // Three-layer Colorplan construction visible at the card edge of
  // un-gilded letterpress. core_* is the middle layer (000133),
  // front_* and back_* are the top and bottom layers (000135). All
  // three pull from the shared letterpress_core_colours catalogue
  // via left joins, so non-letterpress and gilded versions return
  // null across the board. Customer page composes them into a
  // single LayeredConstructionPanel that renders only when all
  // three pairs are populated.
  core_colour_name: string | null
  core_colour_hex: string | null
  front_colour_name: string | null
  front_colour_hex: string | null
  back_colour_name: string | null
  back_colour_hex: string | null
  // ── Variant rounds (migrations 000138 + 000139) ─────────────────────────
  // is_variant_round flips the customer-page render branch from the
  // standard per-recipient bands to the side-by-side variant
  // comparison grid (step 4). round_variants is the ordered list of
  // parallel variants on the round; empty array on every standard
  // version and empty until step 5's upload UI starts writing rows
  // even on variant-round versions.
  is_variant_round: boolean
  round_variants: RoundVariant[]
  // ── Mixed materials sub-mode (migration 000142) ──────────────────────────
  // Only true when is_variant_round is also true. Each variant
  // carries its own material; pricing is handled out-of-band, so
  // the customer page hides the pricing card, Specification, and
  // About-material sections. Implies material_id, currency, and
  // material_options are all null/empty on the version row.
  is_mixed_materials: boolean
}

// One parallel design alternative on a variant-round proof_version
// (migration 000138). Designer-managed via the upload UI in step 5.
// code is slug-derived from display_name on first save and is write-
// once by application convention so proof_events.round_variant_id
// references stay stable across designer renames.
export interface RoundVariant {
  id: string
  code: string
  display_name: string
  sort_order: number
}

// Catalogue row for the letterpress core colour palette
// (migration 000133). Admin reads include inactive entries; the
// designer-side picker filters to is_active=true only. hex_value
// is validated by a CHECK constraint to a 6-digit hex string with
// leading hash.
export interface LetterpressCoreColour {
  id: string
  name: string
  hex_value: string
  is_active: boolean
  sort_order: number
}

// One entry in PublicProofVersion.latest_events_by_name. Mirrors
// the proof_events row shape for the customer-visible columns;
// name maps to the recipient (null = whole-version). The shape is
// the public contract for the customer page's per-recipient render.
export interface ProofEventState {
  name: string | null
  event_type: 'approve' | 'request_changes' | 'designer_override_approve'
  actor_name: string
  comment: string | null
  created_at: string
  helpscout_thread_id: string | null
  // Migration 000125 added this column to proof_name_approvals'
  // projection but deliberately deferred extending the per-event
  // projection. Migration 000139 closes that gap so step 4's
  // variant-round render branch can read the active option code
  // alongside the chosen variant id. Null on events recorded
  // before 000124 or on versions with no option dimension.
  material_option_code: string | null
  // Migration 000139. Variant the customer chose at action time on
  // a variant-round version. Null on standard-version events.
  round_variant_id: string | null
}

export interface PublicMaterialOption {
  id: string
  material_id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
}

export interface PublicMaterialOptionSurcharge {
  id: string
  material_option_id: string
  currency: Currency
  quantity: number
  surcharge: number
}

// ── Live pricing (Phase 2, migration 000117) ───────────────────────────────
// public_price_tiers + public_material_variants together replace the
// pricing_snapshot read on the customer page. material_variants is
// authenticated-only at the table level (000010); the parallel public
// view exposes only the columns the customer page needs to label
// variant columns in the pricing grid.
export interface PublicPriceTier {
  id: string
  material_variant_id: string
  currency: Currency
  quantity: number
  total_price: number
  unit_price: number
}

export interface PublicMaterialVariant {
  id: string
  material_id: string
  display_name: string
  variant_type: 'thickness' | 'ink_count' | 'finish' | 'default'
  sort_order: number
}

export interface SiteSettings {
  global_disclaimer: string | null
}

// Sentinel value stored in proof_name_approvals.name when the row
// represents approval of the Shared images section rather than a
// named recipient. Reserved — must never appear as a real recipient
// name. UI renders it as "Shared", never as the raw string. Using a
// sentinel rather than a separate column avoids a schema change and
// keeps the (proof_version_id, name) unique constraint working as-is
// for both per-name and shared rows.
export const SHARED_APPROVAL_KEY = '__shared__'

// Per-recipient approval record. One row per (proof_version, name) pair
// in proof_name_approvals (migration 000076). name is plain text,
// matches one of the strings in the parent version's names[] snapshot
// OR the SHARED_APPROVAL_KEY sentinel for the Shared images section.
// Not FK'd — historical approvals outlive any post-hoc chip-list
// edits. actor_ip / actor_ua / change_request are nullable for the
// same reasons the DB columns are.
export type ProofNameApproval = {
  id: string
  proof_version_id: string
  name: string
  state: 'approved' | 'changes_requested'
  change_request: string | null
  actor_name: string
  actor_ip: string | null
  actor_ua: string | null
  created_at: string
  updated_at: string
  // Provenance pointer for carry-forward rows (migration 000083).
  // Non-null only when the row was written by NewVersionPage's
  // carry-forward branch; stamped to the source version's id at
  // INSERT time and preserved across state-change UPDATEs. Cleared
  // to null by the FK ON DELETE SET NULL if the source version is
  // later deleted; UI resolves it to a version_number via the
  // already-loaded versions array and silently skips the "Carried
  // from vN" pill when the pointer is null or unresolvable.
  carried_from_version_id: string | null
  // ── Designer override audit (migration 000129) ──────────────────────────
  // Non-null only when this row was flipped to state='approved' by a
  // designer "Mark as approved" override on top of an existing
  // changes_requested row. The three fields are written together in
  // ProofDetailPage.handleApprove and never separately. CHECK on
  // overridden_from_state restricts values to 'changes_requested';
  // widen alongside ProofNameApproval.state if new pre-approval
  // states are introduced.
  overridden_from_state: 'changes_requested' | null
  overridden_by_user_id: string | null
  overridden_at: string | null
}

export interface ProofVersionImage {
  id: string
  proof_version_id: string
  image_path: string
  sort_order: number
  material_option: string | null
  original_filename: string | null
  // ── Name + side association (migration 000071) ───────────────────────────
  // associated_name: null = shared across all names for this version.
  // side: null = not labelled / not applicable.
  associated_name: string | null
  side: 'front' | 'back' | null
  // ── Variant rounds (migrations 000138 + 000139) ──────────────────────────
  // Variant this image belongs to on a variant-round version.
  // Non-null on every image of a variant-round version; null on
  // every image of a standard version. Step 4 filters the per-
  // variant image grid by this id.
  round_variant_id: string | null
  // Resolved client-side — not a DB column.
  signed_url?: string
}

export interface AppSettings {
  id: number
  disclaimer_html: string
  updated_at: string
}
