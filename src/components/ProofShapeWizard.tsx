// ProofShapeWizard — the guided proof-type chooser that replaces the
// old "Standard proof vs Variant round" toggle at the top of the
// version form (structure: docs/proof-type-wizard-structure.md, which
// reworks the question script in docs/proof-type-wizard-spec.md §4).
//
// It is a SINGLE-PAGE PROGRESSIVE-DISCLOSURE wizard, not a paged
// Next/Back flow: only the first unanswered question is shown open;
// answered questions collapse to a compact row with a "Change"
// control; reopening a question via "Change" clears that answer and
// every answer after it.
//
// STRUCTURE (see the structure doc for the rationale). The first
// question is a single three-way that maps 1:1 onto the three shapes,
// phrased by the customer's RELATIONSHIP to the artwork rather than by
// counting it:
//   Q1  Which best describes this proof?
//       • A card for each person   → Recipients      (resolves in one question)
//       • A shared set (no names)  → Set branch (Q2…)
//       • Alternatives to choose   → Selection branch (QS)
// Counting only happens on the Set branch (Q2 "how many layouts"), with
// "layout" defined on the spot so a finish variant of one design can't
// be miscounted as several.
//
// The wizard is a CONTROLLED component. It owns no business state —
// the host page passes the current `answers`, gets `onChange` back,
// and reads the resolved shape via the exported pure helpers below
// (resolveShape / deriveFormState). Those helpers are the SINGLE
// source that maps a resolved shape onto the form's existing mode
// state (isVariantRound, isPerDirectionPricing, cardType,
// hasPersonalisation). Keeping the mapping in one place means the
// Phase 2 `shape` column is a clean drop-in, not a refactor.
//
// Reserved vocabulary (used verbatim in the copy, per the spec):
//   layout          = one design
//   set             = the whole proof
//   batch           = a quantity of identical cards
//   allocated       = tied to a named person, proofed individually
//   personalisation = per-card unique data (member name as variable
//                     data, numbering, IDs, QR)

import { useId, type ReactNode } from 'react'

// ── Answer model ────────────────────────────────────────────────────────────
// One field per question in the script. null = not yet answered. The
// two branches (Set vs Selection) share this object; only the fields
// relevant to the chosen branch are ever populated. The host pages
// treat this type as opaque (they never read individual keys), so the
// key names are an internal concern of this module.
export type WizardAnswers = {
  // Q1 (always): the structural family. Merges the old scope (all/one)
  // and allocated (yes/no) questions, since a pick-one job is never
  // per-named-person — the 2×2 has one empty cell, leaving three options.
  family: 'recipients' | 'set' | 'selection' | null
  // Set Q2: how many layouts in this set?
  layouts: 'one' | 'several' | null
  // Set Q3 (only when several layouts): same material guard.
  sameMaterial: 'yes' | 'no' | null
  // Set Q3 follow-up (only when different materials): split into
  // separate projects, or keep together anyway.
  multiMaterialChoice: 'split' | 'keep' | null
  // Set Q4: card style. Business vs membership; membership is the gate
  // to personalisation. Both styles still emit cardType='membership'
  // in the Phase-1 schema (see deriveFormState) — style only controls
  // whether Q5 is offered and how the resolution reads.
  style: 'business' | 'membership' | null
  // Set Q5 (membership style + material supports it): personalisation.
  personalised: 'yes' | 'no' | null
  // Selection QS: same material or different.
  selectionMaterial: 'same' | 'different' | null
}

export const EMPTY_ANSWERS: WizardAnswers = {
  family: null,
  layouts: null,
  sameMaterial: null,
  multiMaterialChoice: null,
  style: null,
  personalised: null,
  selectionMaterial: null,
}

// ── Resolved shape ────────────────────────────────────────────────────────────
export type ResolvedShape =
  | { kind: 'recipients' }
  | { kind: 'set-single'; style: 'business' | 'membership'; personalised: boolean }
  | { kind: 'set-collection'; style: 'business' | 'membership'; personalised: boolean }
  | { kind: 'selection'; perDirection: boolean }
  | { kind: 'split-guard' } // Q3 "split" chosen — deliberately not a saveable shape

// Map answers → resolved shape, or null while the path is incomplete.
// `materialSupportsPersonalisation` and `materialChosen` gate Q5:
// a membership Set on a material that supports personalisation is only
// "resolved" once Q5 is answered; on a material that does not support
// it, Q5 is skipped and personalisation is forced off.
export function resolveShape(
  a: WizardAnswers,
  opts: { materialChosen: boolean; materialSupportsPersonalisation: boolean },
): ResolvedShape | null {
  if (a.family === 'recipients') return { kind: 'recipients' }

  if (a.family === 'selection') {
    if (a.selectionMaterial === 'same') return { kind: 'selection', perDirection: false }
    if (a.selectionMaterial === 'different') return { kind: 'selection', perDirection: true }
    return null
  }

  if (a.family !== 'set') return null

  // Set branch. Determine single vs collection.
  let collection: boolean
  if (a.layouts === 'one') {
    collection = false
  } else if (a.layouts === 'several') {
    if (a.sameMaterial === 'no') {
      if (a.multiMaterialChoice === 'split') return { kind: 'split-guard' }
      if (a.multiMaterialChoice !== 'keep') return null
    } else if (a.sameMaterial !== 'yes') {
      return null
    }
    collection = true
  } else {
    return null
  }

  // Q4 — card style.
  if (a.style == null) return null

  // Q5 — personalisation, only on membership style.
  let personalised = false
  if (a.style === 'membership') {
    if (opts.materialChosen && opts.materialSupportsPersonalisation) {
      // Q5 is required to resolve.
      if (a.personalised === 'yes') personalised = true
      else if (a.personalised === 'no') personalised = false
      else return null
    } else {
      // Material not chosen yet, or doesn't support personalisation —
      // Q5 is never shown and personalisation stays off.
      personalised = false
    }
  }

  return collection
    ? { kind: 'set-collection', style: a.style, personalised }
    : { kind: 'set-single', style: a.style, personalised }
}

// The single mapping from a resolved shape onto the form's existing
// mode state. Returns null for shapes that should not drive the form
// (incomplete, or the split guard). Phase 2 adds the `shape` column;
// it slots in here without touching any call site.
export type FormModeState = {
  isVariantRound: boolean
  isPerDirectionPricing: boolean
  cardType: 'business' | 'membership'
  hasPersonalisation: boolean
}

export function deriveFormState(shape: ResolvedShape | null): FormModeState | null {
  if (!shape) return null
  switch (shape.kind) {
    case 'recipients':
      return { isVariantRound: false, isPerDirectionPricing: false, cardType: 'business', hasPersonalisation: false }
    case 'set-single':
    case 'set-collection':
      // The no-name shared-design shape is membership-with-empty-names
      // in the current schema. Business vs membership STYLE both land
      // on cardType='membership' today; only personalisation differs.
      // The Phase 2 shape column will disambiguate them.
      return { isVariantRound: false, isPerDirectionPricing: false, cardType: 'membership', hasPersonalisation: shape.personalised }
    case 'selection':
      return { isVariantRound: true, isPerDirectionPricing: shape.perDirection, cardType: 'business', hasPersonalisation: false }
    case 'split-guard':
      return null
  }
}

// The DB value for proof_versions.shape (000210). The wizard's resolved
// shape is the single source; this is the one place the kind maps to the
// stored string, so the save paths never re-derive it. Returns null for
// the split guard and incomplete paths (which never save).
export function dbShape(
  shape: ResolvedShape | null,
): 'recipients' | 'set_single' | 'set_collection' | 'selection' | null {
  if (!shape) return null
  switch (shape.kind) {
    case 'recipients':
      return 'recipients'
    case 'set-single':
      return 'set_single'
    case 'set-collection':
      return 'set_collection'
    case 'selection':
      return 'selection'
    case 'split-guard':
      return null
  }
}

// Plain-English resolution for the running-resolution banner. Base
// phrase per shape, with ", personalised per card" appended only on the
// membership variants when personalisation is on. Display only — no
// commitment language ("produced" / "goes ahead") per the tone rules.
export function resolvedShapeLabel(shape: ResolvedShape | null): string | null {
  if (!shape) return null
  switch (shape.kind) {
    case 'recipients':
      return 'A separate card for each named person'
    case 'set-single':
    case 'set-collection': {
      const membership = shape.style === 'membership'
      let base: string
      if (shape.kind === 'set-single') {
        base = membership ? 'One membership card' : 'One shared design, no individual names'
      } else {
        base = membership
          ? 'Several membership cards, all kept together'
          : 'Several shared designs, all kept together'
      }
      // Personalisation is membership-only; append the per-card note.
      return membership && shape.personalised ? `${base}, personalised per card` : base
    }
    case 'selection':
      return shape.perDirection
        ? 'Alternative designs on different materials, customer chooses one'
        : 'Alternative designs for the customer to choose from'
    case 'split-guard':
      return null
  }
}

// True once the wizard resolves to a concrete, saveable shape. The
// split guard and incomplete paths are not saveable.
export function isWizardResolved(shape: ResolvedShape | null): boolean {
  return shape != null && shape.kind !== 'split-guard'
}

// Best-effort reverse mapping for v2+ creation and edit, where the
// shape isn't stored yet (Phase 1) and must be inferred from existing
// fields. Pre-Phase-2 every existing proof is genuinely one of these:
// variant round → Selection, membership → Set (single, style inferred
// from personalisation), business → Recipients.
export function deriveAnswersFromShape(input: {
  isVariantRound: boolean
  isPerDirectionPricing: boolean
  cardType: 'business' | 'membership'
  hasPersonalisation: boolean
}): WizardAnswers {
  const base = { ...EMPTY_ANSWERS }
  if (input.isVariantRound) {
    return { ...base, family: 'selection', selectionMaterial: input.isPerDirectionPricing ? 'different' : 'same' }
  }
  if (input.cardType === 'membership') {
    return {
      ...base,
      family: 'set',
      layouts: 'one',
      style: input.hasPersonalisation ? 'membership' : 'business',
      personalised: input.hasPersonalisation ? 'yes' : 'no',
    }
  }
  // business + standard proof → Recipients.
  return { ...base, family: 'recipients' }
}

// Seed the wizard from a loaded version, preferring the persisted shape
// column (000210) over the flags. shape is authoritative for the
// STRUCTURE (it's the only thing that tells set_single and set_collection
// apart — flags can't), while has_personalisation / is_per_direction_pricing
// fill in the sub-details. Falls back to the flags-only mapping when
// shape is null (legacy rows the 000211 backfill didn't cover, e.g.
// membership-with-tier-names). Used by both pages when loading an
// existing version, fixing the bug where a collection mis-seeded as
// set_single because the flags are identical.
export function deriveAnswersFromVersion(input: {
  shape: string | null
  isVariantRound: boolean
  isPerDirectionPricing: boolean
  cardType: 'business' | 'membership'
  hasPersonalisation: boolean
}): WizardAnswers {
  const base = { ...EMPTY_ANSWERS }
  // Style can only be inferred from personalisation in Phase 1 (the
  // schema has no style column): a plain membership card and a plain
  // business-style set both read as 'business' here. That's harmless —
  // style only drives the label + the Q5 gate, not the emitted cardType.
  const style = input.hasPersonalisation ? ('membership' as const) : ('business' as const)
  const personalised = input.hasPersonalisation ? ('yes' as const) : ('no' as const)
  switch (input.shape) {
    case 'recipients':
      return { ...base, family: 'recipients' }
    case 'set_single':
      return { ...base, family: 'set', layouts: 'one', style, personalised }
    case 'set_collection':
      return { ...base, family: 'set', layouts: 'several', sameMaterial: 'yes', style, personalised }
    case 'selection':
      return { ...base, family: 'selection', selectionMaterial: input.isPerDirectionPricing ? 'different' : 'same' }
    default:
      // Null / unknown shape — fall back to the flags-only mapping.
      return deriveAnswersFromShape({
        isVariantRound: input.isVariantRound,
        isPerDirectionPricing: input.isPerDirectionPricing,
        cardType: input.cardType,
        hasPersonalisation: input.hasPersonalisation,
      })
  }
}

// ── Presentational pieces ────────────────────────────────────────────────────

type Option<V extends string> = { value: V; label: string; sub?: string }

function QuestionBlock<V extends string>({
  legend,
  name,
  options,
  selected,
  onSelect,
  disabled,
  note,
  footnote,
  cols = 2,
}: {
  legend: string
  name: string
  options: ReadonlyArray<Option<V>>
  selected: V | null
  onSelect: (v: V) => void
  disabled?: boolean
  note?: ReactNode
  footnote?: ReactNode
  // 2 = side-by-side binary choices (default); 1 = full-width stacked
  // cards, used for the three-way Q1 where the descriptions are longer.
  cols?: 1 | 2
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{legend}</p>
      {note && <div className="mt-1 text-xs text-ink-mute">{note}</div>}
      <fieldset
        className={['mt-3 grid gap-3', cols === 2 ? 'sm:grid-cols-2' : ''].join(' ')}
        disabled={disabled}
      >
        <legend className="sr-only">{legend}</legend>
        {options.map((opt) => {
          const isSelected = selected === opt.value
          return (
            <label
              key={opt.value}
              className={[
                'rounded border px-4 py-3 transition-colors',
                'focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-1',
                disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                isSelected
                  ? 'border-ink bg-ink text-on-ink'
                  : 'border-line bg-surface text-ink-soft hover:border-ink/40',
              ].join(' ')}
            >
              <input
                type="radio"
                name={name}
                value={opt.value}
                checked={isSelected}
                disabled={disabled}
                onChange={() => onSelect(opt.value)}
                className="sr-only"
              />
              <div className="text-sm font-semibold">{opt.label}</div>
              {opt.sub && (
                <div className={['mt-1 text-xs', isSelected ? 'text-on-ink/80' : 'text-ink-mute'].join(' ')}>
                  {opt.sub}
                </div>
              )}
            </label>
          )
        })}
      </fieldset>
      {footnote && <div className="mt-2 text-xs text-ink-mute">{footnote}</div>}
    </div>
  )
}

function AnsweredRow({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: string
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-line bg-canvas px-4 py-2.5">
      <div className="min-w-0">
        <span className="text-xs text-ink-mute">{label}</span>
        <span className="ml-2 text-sm font-medium text-ink">{value}</span>
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={onChange}
          className="shrink-0 text-xs font-medium text-ink-soft underline underline-offset-4 hover:text-ink"
        >
          Change
        </button>
      )}
    </div>
  )
}

// ── The wizard ────────────────────────────────────────────────────────────────

export function ProofShapeWizard({
  answers,
  onChange,
  materialChosen,
  materialSupportsPersonalisation,
  disabled = false,
}: {
  answers: WizardAnswers
  onChange: (next: WizardAnswers) => void
  // Whether a material has been chosen in the Specification section
  // below. Q5's material-dependent behaviour reveals once set.
  materialChosen: boolean
  // The chosen material's supports_personalisation capability. When
  // false, Q5 is never shown (spec section 5).
  materialSupportsPersonalisation: boolean
  // Live per-card rate / minimum-charge helper. Kept in the prop type so
  // callers (NewVersionPage) can still pass it, but no longer rendered —
  // Q5 is labels-only.
  personalisationHelper?: string
  // On the edit page the shape is locked at creation, so the wizard
  // renders read-only (collapsed rows, no Change controls).
  disabled?: boolean
}) {
  const summaryId = useId()
  const shape = resolveShape(answers, { materialChosen, materialSupportsPersonalisation })
  const label = resolvedShapeLabel(shape)

  // Patch helper. Each setter pairs its patch with a "clear everything
  // downstream" object so a revisit never leaves stale state below it.
  function set(patch: Partial<WizardAnswers>) {
    onChange({ ...answers, ...patch })
  }

  // Clearing helpers, ordered by the question pipeline.
  const clearAfterFamily = { layouts: null, sameMaterial: null, multiMaterialChoice: null, style: null, personalised: null, selectionMaterial: null } as const
  const clearAfterLayouts = { sameMaterial: null, multiMaterialChoice: null, style: null, personalised: null } as const
  const clearAfterSameMaterial = { multiMaterialChoice: null, style: null, personalised: null } as const
  const clearAfterStyle = { personalised: null } as const

  const isSet = answers.family === 'set'
  const isSelection = answers.family === 'selection'

  const isSeveral = answers.layouts === 'several'
  const splitChosen = isSeveral && answers.sameMaterial === 'no' && answers.multiMaterialChoice === 'split'
  const keptTogether = isSeveral && answers.sameMaterial === 'no' && answers.multiMaterialChoice === 'keep'
  // Does the Set branch proceed to Q4 (card style)?
  const reachesStyle =
    isSet &&
    (answers.layouts === 'one' || (isSeveral && (answers.sameMaterial === 'yes' || keptTogether)))

  // Human-readable value for the collapsed Q1 row.
  const familyValue =
    answers.family === 'recipients'
      ? 'A card for each person'
      : answers.family === 'set'
        ? 'A shared set (no names)'
        : 'Alternatives to choose from'

  return (
    <section className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
      <div className="mb-5">
        <h3 className="text-base font-semibold text-ink">Proof type</h3>
        <p className="mt-0.5 text-xs text-ink-mute">
          A question or two sets up the right shape for this proof.
        </p>
      </div>

      {/* Screen-reader running summary of the current resolution. */}
      <p id={summaryId} className="sr-only" aria-live="polite">
        {label ? `Resolved proof type: ${label}.` : 'Proof type not yet resolved.'}
      </p>

      <div className="space-y-3">
        {/* ── Q1 — always asked. Three-way: the structural family. ───── */}
        {answers.family == null ? (
          <QuestionBlock
            legend="Which best describes this proof?"
            name="wizard-family"
            cols={1}
            selected={answers.family}
            disabled={disabled}
            onSelect={(v: 'recipients' | 'set' | 'selection') => set({ family: v, ...clearAfterFamily })}
            note="A run of cards that share one design, with only a name or number changing, is a shared set, not a card for each person."
            options={[
              {
                value: 'recipients',
                label: 'A card for each person',
                sub: 'Each named person has their own card with their own details, proofed one by one. The customer wants them all.',
              },
              {
                value: 'set',
                label: 'A shared set (no names)',
                sub: 'No card is tied to a named person. The customer wants every design you show, whether that is one design or several.',
              },
              {
                value: 'selection',
                label: 'Alternatives to choose from',
                sub: 'You show alternative designs and the customer picks the one they want. The rest are set aside.',
              },
            ]}
          />
        ) : (
          <AnsweredRow
            label="This proof is"
            value={familyValue}
            disabled={disabled}
            onChange={() => set({ family: null, ...clearAfterFamily })}
          />
        )}

        {/* ── Set branch ────────────────────────────────────────────── */}
        {isSet && (
          <>
            {/* Q2 — how many layouts? */}
            {answers.layouts == null ? (
              <QuestionBlock
                legend="How many layouts are in this set?"
                name="wizard-layouts"
                selected={answers.layouts}
                disabled={disabled}
                onSelect={(v: 'one' | 'several') => set({ layouts: v, ...clearAfterLayouts })}
                note="A layout is one design. The same design shown in different finishes, colours, or materials is still one layout."
                options={[
                  { value: 'one', label: 'One layout', sub: 'A single design.' },
                  {
                    value: 'several',
                    label: 'Several layouts',
                    sub: 'Two or more different designs, all kept together. Each layout after the first adds a tooling charge.',
                  },
                ]}
              />
            ) : (
              <AnsweredRow
                label="Layouts"
                value={answers.layouts === 'one' ? 'One layout' : 'Several layouts'}
                disabled={disabled}
                onChange={() => set({ layouts: null, ...clearAfterLayouts })}
              />
            )}

            {/* Q3 — same material? (only when several layouts) */}
            {isSeveral && (
              answers.sameMaterial == null ? (
                <QuestionBlock
                  legend="Are all the layouts on the same material?"
                  name="wizard-same-material"
                  selected={answers.sameMaterial}
                  disabled={disabled}
                  onSelect={(v: 'yes' | 'no') => set({ sameMaterial: v, ...clearAfterSameMaterial })}
                  options={[
                    { value: 'yes', label: 'Yes, one material' },
                    {
                      value: 'no',
                      label: 'No, different materials',
                      sub: 'Each material is normally quoted and proofed as its own project, so it prices correctly.',
                    },
                  ]}
                />
              ) : (
                <AnsweredRow
                  label="Material"
                  value={answers.sameMaterial === 'yes' ? 'Yes, one material' : 'No, different materials'}
                  disabled={disabled}
                  onChange={() => set({ sameMaterial: null, ...clearAfterSameMaterial })}
                />
              )
            )}

            {/* Q3 follow-up — split vs keep together */}
            {isSeveral && answers.sameMaterial === 'no' && (
              answers.multiMaterialChoice == null ? (
                <div className="rounded border border-line bg-canvas px-4 py-3">
                  <p className="text-sm text-ink-soft">
                    A set uses one material. Different materials are normally split into separate
                    projects so each one prices correctly.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => set({ multiMaterialChoice: 'split', style: null, personalised: null })}
                      className="rounded border border-ink bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-60"
                    >
                      Split into separate projects
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => set({ multiMaterialChoice: 'keep', style: null, personalised: null })}
                      className="rounded border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink-soft hover:border-ink/40 disabled:opacity-60"
                    >
                      Keep together anyway
                    </button>
                  </div>
                </div>
              ) : (
                <AnsweredRow
                  label="Different materials"
                  value={answers.multiMaterialChoice === 'split' ? 'Split into separate projects' : 'Keep together anyway'}
                  disabled={disabled}
                  onChange={() => set({ multiMaterialChoice: null, style: null, personalised: null })}
                />
              )
            )}

            {/* Split guard — terminal guidance, no saveable shape */}
            {splitChosen && (
              <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Create each material as its own project from the new-project screen, so each one
                prices and proofs correctly. This proof can't continue as a single set.
              </div>
            )}

            {/* Q4 — card style (every Set) */}
            {reachesStyle && (
              answers.style == null ? (
                <QuestionBlock
                  legend="What style of card is this?"
                  name="wizard-style"
                  selected={answers.style}
                  disabled={disabled}
                  onSelect={(v: 'business' | 'membership') => set({ style: v, ...clearAfterStyle })}
                  options={[
                    { value: 'business', label: 'Business card', sub: 'A standard card design. Every card is identical.' },
                    {
                      value: 'membership',
                      label: 'Membership card',
                      sub: 'A membership-style card. You can switch on personalisation so each card carries its own details.',
                    },
                  ]}
                />
              ) : (
                <AnsweredRow
                  label="Card style"
                  value={answers.style === 'business' ? 'Business card' : 'Membership card'}
                  disabled={disabled}
                  onChange={() => set({ style: null, ...clearAfterStyle })}
                />
              )
            )}

            {/* Q5 — personalisation. Only on membership style, only once
                a material is chosen and supports it. */}
            {reachesStyle && answers.style === 'membership' && (
              !materialChosen ? (
                <div className="rounded border border-line bg-canvas px-4 py-3 text-xs text-ink-mute">
                  Choose a material in Specification below to set personalisation.
                </div>
              ) : materialSupportsPersonalisation ? (
                answers.personalised == null ? (
                  <QuestionBlock
                    legend="Does every card carry its own unique details, such as a member name, sequential number, or unique QR code?"
                    name="wizard-personalised"
                    selected={answers.personalised}
                    disabled={disabled}
                    onSelect={(v: 'yes' | 'no') => set({ personalised: v })}
                    options={[
                      { value: 'yes', label: 'Yes, every card is unique', sub: 'Priced per card, with a minimum charge, on top of the base price.' },
                      { value: 'no', label: 'No, every card is identical' },
                    ]}
                  />
                ) : (
                  <AnsweredRow
                    label="Personalisation"
                    value={answers.personalised === 'yes' ? 'Yes, every card is unique' : 'No, every card is identical'}
                    disabled={disabled}
                    onChange={() => set({ personalised: null })}
                  />
                )
              ) : null
            )}

            {/* The per-layout title + image editor for a Set
                (collection) lives in the version form below (it owns
                the image uploads), not in the wizard — the wizard
                only resolves the shape. */}
          </>
        )}

        {/* ── Selection branch ──────────────────────────────────────── */}
        {isSelection && (
          answers.selectionMaterial == null ? (
            <QuestionBlock
              legend="Are the alternatives all on the same material?"
              name="wizard-selection-material"
              selected={answers.selectionMaterial}
              disabled={disabled}
              onSelect={(v: 'same' | 'different') => set({ selectionMaterial: v })}
              options={[
                { value: 'same', label: 'Same material', sub: 'Every alternative is the same material. Only the design differs.' },
                { value: 'different', label: 'Different materials', sub: 'Each alternative is on a different material, so each is priced on its own.' },
              ]}
            />
          ) : (
            <AnsweredRow
              label="Alternatives"
              value={answers.selectionMaterial === 'same' ? 'Same material' : 'Different materials'}
              disabled={disabled}
              onChange={() => set({ selectionMaterial: null })}
            />
          )
        )}
      </div>

      {/* Running resolution banner */}
      {label && (
        <div className="mt-5 flex items-center gap-2 rounded border border-line bg-canvas px-4 py-3">
          <span className="text-xs font-medium text-ink-mute">Resolved as</span>
          <span className="text-sm font-semibold text-ink">{label}</span>
        </div>
      )}
    </section>
  )
}
