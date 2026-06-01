// ProofShapeWizard — the guided proof-type chooser that replaces the
// old "Standard proof vs Variant round" toggle at the top of the
// version form (spec: docs/proof-type-wizard-spec.md, section 4).
//
// It is a SINGLE-PAGE PROGRESSIVE-DISCLOSURE wizard, not a paged
// Next/Back flow: only the first unanswered question is shown open;
// answered questions collapse to a compact row with a "Change"
// control; reopening a question via "Change" clears that answer and
// every answer after it. Changing the first question resets the
// whole trunk.
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
// two trunks (receive-all vs pick-one) share this object; only the
// fields relevant to the chosen trunk are ever populated.
export type WizardAnswers = {
  // Step 1 (always): ordering all vs picking one.
  scope: 'all' | 'one' | null
  // Receive-all Step 2: is each batch allocated to a named person?
  allocated: 'yes' | 'no' | null
  // Receive-all Step 3: how many layouts in this set?
  layouts: 'one' | 'several' | null
  // Receive-all Step 4 (only when several layouts): same material?
  sameMaterial: 'yes' | 'no' | null
  // Receive-all Step 4 follow-up (only when different materials):
  // split into separate projects, or keep together anyway.
  multiMaterialChoice: 'split' | 'keep' | null
  // Receive-all Step 5 (Set branch): card style.
  style: 'standard' | 'membership' | null
  // Receive-all Step 6 (membership + material supports it):
  // personalisation on/off.
  personalised: 'yes' | 'no' | null
  // Pick-one Step 2: same material or different.
  pickMaterial: 'same' | 'different' | null
}

export const EMPTY_ANSWERS: WizardAnswers = {
  scope: null,
  allocated: null,
  layouts: null,
  sameMaterial: null,
  multiMaterialChoice: null,
  style: null,
  personalised: null,
  pickMaterial: null,
}

// ── Resolved shape ────────────────────────────────────────────────────────────
export type ResolvedShape =
  | { kind: 'recipients' }
  | { kind: 'set-single'; style: 'standard' | 'membership'; personalised: boolean }
  | { kind: 'set-collection'; style: 'standard' | 'membership'; personalised: boolean }
  | { kind: 'selection'; perDirection: boolean }
  | { kind: 'split-guard' } // Step 4 "split" chosen — deliberately not a saveable shape

// Map answers → resolved shape, or null while the path is incomplete.
// `materialSupportsPersonalisation` and `materialChosen` gate Step 6:
// a membership Set on a material that supports personalisation is only
// "resolved" once Step 6 is answered; on a material that does not
// support it, Step 6 is skipped and personalisation is forced off.
export function resolveShape(
  a: WizardAnswers,
  opts: { materialChosen: boolean; materialSupportsPersonalisation: boolean },
): ResolvedShape | null {
  if (a.scope === 'one') {
    if (a.pickMaterial === 'same') return { kind: 'selection', perDirection: false }
    if (a.pickMaterial === 'different') return { kind: 'selection', perDirection: true }
    return null
  }
  if (a.scope !== 'all') return null

  // Receive-all trunk.
  if (a.allocated === 'yes') return { kind: 'recipients' }
  if (a.allocated !== 'no') return null

  // Not allocated → Set branch. Determine single vs collection.
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

  // Step 5 — card style.
  if (a.style == null) return null

  // Step 6 — personalisation, only on membership style.
  let personalised = false
  if (a.style === 'membership') {
    if (opts.materialChosen && opts.materialSupportsPersonalisation) {
      // Step 6 is required to resolve.
      if (a.personalised === 'yes') personalised = true
      else if (a.personalised === 'no') personalised = false
      else return null
    } else {
      // Material not chosen yet, or doesn't support personalisation —
      // Step 6 is never shown and personalisation stays off.
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
      // in the current schema. Standard vs membership STYLE both land
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
// membership variants when personalisation is on.
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
        base = membership ? 'A single membership card' : 'A single business card design'
      } else {
        base = membership
          ? 'Several membership cards, all produced'
          : 'Several business card designs, all produced'
      }
      // Personalisation is membership-only; append the per-card note.
      return membership && shape.personalised ? `${base}, personalised per card` : base
    }
    case 'selection':
      return shape.perDirection
        ? 'Design options on different materials, customer picks one'
        : 'Design options for the customer to choose from'
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
    return { ...base, scope: 'one', pickMaterial: input.isPerDirectionPricing ? 'different' : 'same' }
  }
  if (input.cardType === 'membership') {
    return {
      ...base,
      scope: 'all',
      allocated: 'no',
      layouts: 'one',
      style: input.hasPersonalisation ? 'membership' : 'standard',
      personalised: input.hasPersonalisation ? 'yes' : 'no',
    }
  }
  // business + standard proof → Recipients.
  return { ...base, scope: 'all', allocated: 'yes' }
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
  const style = input.hasPersonalisation ? ('membership' as const) : ('standard' as const)
  const personalised = input.hasPersonalisation ? ('yes' as const) : ('no' as const)
  switch (input.shape) {
    case 'recipients':
      return { ...base, scope: 'all', allocated: 'yes' }
    case 'set_single':
      return { ...base, scope: 'all', allocated: 'no', layouts: 'one', style, personalised }
    case 'set_collection':
      return { ...base, scope: 'all', allocated: 'no', layouts: 'several', sameMaterial: 'yes', style, personalised }
    case 'selection':
      return { ...base, scope: 'one', pickMaterial: input.isPerDirectionPricing ? 'different' : 'same' }
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
}: {
  legend: string
  name: string
  options: ReadonlyArray<Option<V>>
  selected: V | null
  onSelect: (v: V) => void
  disabled?: boolean
  note?: ReactNode
  footnote?: ReactNode
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{legend}</p>
      {note && <div className="mt-1 text-xs text-ink-mute">{note}</div>}
      <fieldset className="mt-3 grid gap-3 sm:grid-cols-2" disabled={disabled}>
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
  // below. Step 4/5/6's material-dependent behaviour reveals once set.
  materialChosen: boolean
  // The chosen material's supports_personalisation capability. When
  // false, Step 6 is never shown (spec section 5).
  materialSupportsPersonalisation: boolean
  // Live per-card rate / minimum-charge helper. Kept in the prop type so
  // callers (NewVersionPage) can still pass it, but no longer rendered —
  // Step 6 is labels-only.
  personalisationHelper?: string
  // On the edit page the shape is locked at creation, so the wizard
  // renders read-only (collapsed rows, no Change controls).
  disabled?: boolean
}) {
  const summaryId = useId()
  const shape = resolveShape(answers, { materialChosen, materialSupportsPersonalisation })
  const label = resolvedShapeLabel(shape)

  // Patch helper that clears every answer downstream of the one being
  // set, so a revisit never leaves stale state below it.
  function set(patch: Partial<WizardAnswers>) {
    onChange({ ...answers, ...patch })
  }

  // Clearing helpers, ordered by the question pipeline.
  const clearFromScope = { allocated: null, layouts: null, sameMaterial: null, multiMaterialChoice: null, style: null, personalised: null, pickMaterial: null } as const
  const clearFromAllocated = { layouts: null, sameMaterial: null, multiMaterialChoice: null, style: null, personalised: null } as const
  const clearFromLayouts = { sameMaterial: null, multiMaterialChoice: null, style: null, personalised: null } as const
  const clearFromSameMaterial = { multiMaterialChoice: null, style: null, personalised: null } as const
  const clearFromStyle = { personalised: null } as const

  const isAll = answers.scope === 'all'
  const isOne = answers.scope === 'one'

  // Whether the Set branch (single or collection) is reached.
  const onSetBranch = isAll && answers.allocated === 'no'
  const isSeveral = answers.layouts === 'several'
  const splitChosen = isSeveral && answers.sameMaterial === 'no' && answers.multiMaterialChoice === 'split'
  const keptTogether = isSeveral && answers.sameMaterial === 'no' && answers.multiMaterialChoice === 'keep'
  // Does the Set branch proceed to Step 5 (card style)?
  const reachesStyle =
    onSetBranch &&
    (answers.layouts === 'one' || (isSeveral && (answers.sameMaterial === 'yes' || keptTogether)))

  return (
    <section className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
      <div className="mb-5">
        <h3 className="text-base font-semibold text-ink">Proof type</h3>
        <p className="mt-0.5 text-xs text-ink-mute">
          A few quick questions set up the right shape for this proof.
        </p>
      </div>

      {/* Screen-reader running summary of the current resolution. */}
      <p id={summaryId} className="sr-only" aria-live="polite">
        {label ? `Resolved proof type: ${label}.` : 'Proof type not yet resolved.'}
      </p>

      <div className="space-y-3">
        {/* ── Step 1 — always asked ─────────────────────────────────── */}
        {answers.scope == null ? (
          <QuestionBlock
            legend="Will the customer order everything in this version, or choose one option from it?"
            name="wizard-scope"
            selected={answers.scope}
            disabled={disabled}
            onSelect={(v: 'all' | 'one') => set({ scope: v, ...clearFromScope })}
            options={[
              { value: 'all', label: 'Order everything', sub: 'If approved, everything in this version gets produced.' },
              { value: 'one', label: 'Choose one option', sub: "You're presenting alternatives and they pick a single one to move forward with." },
            ]}
          />
        ) : (
          <AnsweredRow
            label="Ordering"
            value={answers.scope === 'all' ? 'Order everything' : 'Choose one option'}
            disabled={disabled}
            onChange={() => set({ scope: null, ...clearFromScope })}
          />
        )}

        {/* ── Receive-all trunk ─────────────────────────────────────── */}
        {isAll && (
          <>
            {/* Step 2 — allocated to a named person? */}
            {answers.allocated == null ? (
              <QuestionBlock
                legend="Will each batch of cards be allocated to a specific named person?"
                name="wizard-allocated"
                selected={answers.allocated}
                disabled={disabled}
                onSelect={(v: 'yes' | 'no') => set({ allocated: v, ...clearFromAllocated })}
                options={[
                  { value: 'yes', label: 'Yes, a batch per person', sub: "You'll upload proofs for each person." },
                  { value: 'no', label: 'No, not for a named person', sub: "The cards aren't intended for a specific person." },
                ]}
              />
            ) : (
              <AnsweredRow
                label="Allocated"
                value={answers.allocated === 'yes' ? 'Yes, a batch per person' : 'No, not for a named person'}
                disabled={disabled}
                onChange={() => set({ allocated: null, ...clearFromAllocated })}
              />
            )}

            {/* Set branch (not allocated) */}
            {answers.allocated === 'no' && (
              <>
                {/* Step 3 — how many layouts? */}
                {answers.layouts == null ? (
                  <QuestionBlock
                    legend="How many different layouts are in this version?"
                    name="wizard-layouts"
                    selected={answers.layouts}
                    disabled={disabled}
                    onSelect={(v: 'one' | 'several') => set({ layouts: v, ...clearFromLayouts })}
                    options={[
                      { value: 'one', label: 'One layout', sub: 'A single design.' },
                      { value: 'several', label: 'Several layouts', sub: 'More than one layout. Each layout after the first adds a tooling charge.' },
                    ]}
                  />
                ) : (
                  <AnsweredRow
                    label="Layouts"
                    value={answers.layouts === 'one' ? 'One layout' : 'Several layouts'}
                    disabled={disabled}
                    onChange={() => set({ layouts: null, ...clearFromLayouts })}
                  />
                )}

                {/* Step 4 — same material? (only when several layouts) */}
                {isSeveral && (
                  answers.sameMaterial == null ? (
                    <QuestionBlock
                      legend="Are they all on the same material?"
                      name="wizard-same-material"
                      selected={answers.sameMaterial}
                      disabled={disabled}
                      onSelect={(v: 'yes' | 'no') => set({ sameMaterial: v, ...clearFromSameMaterial })}
                      options={[
                        { value: 'yes', label: 'Yes, same material' },
                        { value: 'no', label: 'No, different materials', sub: 'These are normally quoted and proofed as separate projects so each material prices correctly. Want to split them?' },
                      ]}
                    />
                  ) : (
                    <AnsweredRow
                      label="Material"
                      value={answers.sameMaterial === 'yes' ? 'Yes, same material' : 'No, different materials'}
                      disabled={disabled}
                      onChange={() => set({ sameMaterial: null, ...clearFromSameMaterial })}
                    />
                  )
                )}

                {/* Step 4 follow-up — split vs keep together */}
                {isSeveral && answers.sameMaterial === 'no' && (
                  answers.multiMaterialChoice == null ? (
                    <div className="rounded border border-line bg-canvas px-4 py-3">
                      <p className="text-sm text-ink-soft">
                        These are normally quoted and proofed as separate projects so each material
                        prices correctly. Want to split them?
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

                {/* Step 5 — card style (Set branch only) */}
                {reachesStyle && (
                  answers.style == null ? (
                    <QuestionBlock
                      legend="What style of card is this?"
                      name="wizard-style"
                      selected={answers.style}
                      disabled={disabled}
                      onSelect={(v: 'standard' | 'membership') => set({ style: v, ...clearFromStyle })}
                      options={[
                        { value: 'standard', label: 'Business card', sub: "A conventional business card displaying the holder's details." },
                        { value: 'membership', label: 'Membership card', sub: 'A membership-style card. No names are entered, and you can switch on per-card personalisation.' },
                      ]}
                    />
                  ) : (
                    <AnsweredRow
                      label="Card style"
                      value={answers.style === 'standard' ? 'Business card' : 'Membership card'}
                      disabled={disabled}
                      onChange={() => set({ style: null, ...clearFromStyle })}
                    />
                  )
                )}

                {/* Step 6 — personalisation. Only on membership style,
                    only once a material is chosen and supports it. */}
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
                          { value: 'yes', label: 'Yes, every card is unique.' },
                          { value: 'no', label: 'No, every card is identical.' },
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
          </>
        )}

        {/* ── Pick-one trunk ────────────────────────────────────────── */}
        {isOne && (
          answers.pickMaterial == null ? (
            <QuestionBlock
              legend="Are the options to be presented all on the same material?"
              name="wizard-pick-material"
              selected={answers.pickMaterial}
              disabled={disabled}
              onSelect={(v: 'same' | 'different') => set({ pickMaterial: v })}
              options={[
                { value: 'same', label: 'Same material', sub: 'Every alternative is the same material; only the design differs.' },
                { value: 'different', label: 'Different materials', sub: 'The alternatives are on different materials, so each is priced on its own.' },
              ]}
            />
          ) : (
            <AnsweredRow
              label="Options material"
              value={answers.pickMaterial === 'same' ? 'Same material' : 'Different materials'}
              disabled={disabled}
              onChange={() => set({ pickMaterial: null })}
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
