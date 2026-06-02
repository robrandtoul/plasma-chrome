# Proof-type wizard: chosen structure and wording

Status: implemented on `feat/proof-type-wizard` (PR #227)
Supersedes the question script in `docs/proof-type-wizard-spec.md` section 4. The spec's
*shapes*, *product rules*, and *resolver contract* are unchanged; only the questions a
designer answers, their order, and their wording are reworked.

This document is the rationale. It states the structure, shows the decision tree, lists the
final copy, and explains why it beats the previous six-step version against the brief's
criteria.

---

## 1. What the wizard has to resolve (unchanged)

Four structural shapes plus two sub-flags. These are fixed; the resolver still emits exactly
these:

| Shape | Emitted form state |
|-------|--------------------|
| Recipients | `cardType=business`, names roster |
| Set (single) | `cardType=membership`, empty names, `shape=set_single` |
| Set (collection) | `cardType=membership`, empty names, `shape=set_collection` |
| Selection | `isVariantRound=true` (+ `isPerDirectionPricing=true` on different materials) |

Flavour and add-on, on the **Set** branch only, never on Selection:

- **Card style** business vs membership. Styling does not change price.
- **Personalisation** (per-card unique data). Reachable *only* through the membership style,
  *only* when `materials.supports_personalisation` is true. It affects price.

Reserved vocabulary, used verbatim: **layout** = one design, **set** = the whole proof,
**batch** = a quantity of identical cards, **allocated** = tied to a named person,
**personalisation** = per-card unique data.

---

## 2. The core problem with the previous version

Every ambiguity in the six-step version came from one root cause: **it asked the designer to
count or categorise the artwork ("order everything or pick one", "how many layouts") before it
established what the customer actually does with it.** Counting is where the overloaded words
bite — a single metal card shown in three finishes reads as "several" if you count images, and
"pick one" if you read "choose one option" as choosing a finish.

Concrete failures of the previous script:

1. **Two sequential binary questions to reach Recipients.** Step 1 (all vs one) then Step 2
   (allocated yes/no). Recipients is the bread-and-butter job and it cost two clicks, and the
   link between the two questions was not obvious.
2. **"Order everything ... gets produced".** Step 1's helper used *produced*; the resolution
   labels used *all produced*. We are a free, no-obligation service; that wording was already
   rejected once and had crept back in.
3. **The finish-variant trap.** "How many different layouts" with a bare *One / Several* split
   invites "I have three finish images, so several". Nothing on the question said a finish
   variant is still one layout.
4. **"version" leaking into the copy.** Steps 1 and 3 said "in this version", which collides
   with the internal notion of proof versions / variant rounds.

---

## 3. The chosen structure: describe the relationship, do not count

The fix is to lead with **one question about the customer's relationship to what is shown**,
phrased behaviourally, and only descend into counting once we are safely on the Set branch with
the count word pinned down.

The three structural shapes are mutually exclusive and the designer already knows which one they
are doing. They differ on two behavioural axes:

- **keep-all vs pick-one** — separates Selection from {Recipients, Set}
- **per-named-person vs shared/no-names** — separates Recipients from Set

That is a 2×2 with one empty cell (a pick-one job is never "per named person"), so **three real
options**. The previous version asked these two axes as two sequential binary questions; we merge
them into a single three-way first question that maps 1:1 onto the three shapes.

### Decision tree

```
Q1  Which best describes this proof?
├─ A card for each person ........................ RECIPIENTS        (done — 1 question)
├─ A shared set (no names) ....................... → Q2 (Set branch)
└─ Alternatives to choose from ................... → QS (Selection branch)

Set branch
  Q2  How many layouts are in this set?
  ├─ One layout .................................. SET (single) → Q4
  └─ Several layouts ............................. → Q3
      Q3  Are all the layouts on the same material?
      ├─ Yes, one material ....................... SET (collection) → Q4
      └─ No, different materials ................. → split / keep guard
            [Split into separate projects] ....... terminal guidance, not saveable
            [Keep together anyway] ............... SET (collection) → Q4
  Q4  What style of card is this?               (asked for every Set)
  ├─ Business card ............................... personalisation not offered
  └─ Membership card ............................. → Q5 (if material supports it)
      Q5  Does every card carry its own unique details?   (membership + material supports)
      ├─ Yes, every card is unique ............... personalisation ON
      └─ No, every card is identical ............. personalisation OFF

Selection branch
  QS  Are the alternatives all on the same material?
  ├─ Same material ............................... SELECTION
  └─ Different materials ......................... SELECTION (per-direction pricing)
```

### Question count per case (lower is better)

| Case | Shape | Questions | Previous |
|------|-------|-----------|----------|
| Card per person | Recipients | **1** | 2 |
| Alternatives, same material | Selection | **2** | 2 |
| Alternatives, different materials | Selection (pdp) | **2** | 2 |
| One shared design, business | Set (single) | **3** | 4 |
| One shared design, membership, +/- personalisation | Set (single) | 3–4 | 5 |
| Several shared designs, same material, business | Set (collection) | 4 | 5 |
| Several shared designs, membership, personalised | Set (collection) | 5–6 | 6 |

Recipients halves (2 → 1). Selection holds at 2. Every Set path loses a question because the
old Step 1 (all vs one) and Step 2 (allocated) are now one question.

---

## 4. Final wording

### Q1 — always asked (three options, stacked)

> **Which best describes this proof?**
> *Note:* A run of cards that share one design, with only a name or number changing, is a
> shared set, not a card for each person.

- **A card for each person** — Each named person has their own card with their own details,
  proofed one by one. The customer wants them all.
- **A shared set (no names)** — No card is tied to a named person. The customer wants every
  design you show, whether that is one design or several.
- **Alternatives to choose from** — You show alternative designs and the customer picks the one
  they want. The rest are set aside.

The note is the one piece of routing guidance carried over from the old Step 2: it keeps a
numbered / membership run (one shared template, a name or number as variable data) out of
Recipients. It deliberately does not use the word *personalisation* — that word only appears at
Q5.

### Set branch

**Q2 — How many layouts are in this set?**
> *Note:* A layout is one design. The same design shown in different finishes, colours, or
> materials is still one layout.

- **One layout** — A single design.
- **Several layouts** — Two or more different designs, all kept together. Each layout after the
  first adds a tooling charge.

The note sits above the options, so it is read before the choice is made — this is the direct
fix for the finish-variant trap.

**Q3 — Are all the layouts on the same material?** *(only when "Several layouts")*

- **Yes, one material**
- **No, different materials** — Each material is normally quoted and proofed as its own project,
  so it prices correctly.

Choosing "different materials" reveals the guard:

> A set uses one material. Different materials are normally split into separate projects so each
> one prices correctly.
> [Split into separate projects] [Keep together anyway]

"Split" shows terminal guidance and does not resolve to a saveable shape:

> Create each material as its own project from the new-project screen, so each one prices and
> proofs correctly. This proof can't continue as a single set.

**Q4 — What style of card is this?** *(asked for every Set)*

- **Business card** — A standard card design. Every card is identical.
- **Membership card** — A membership-style card. You can switch on personalisation so each card
  carries its own details.

**Q5 — Does every card carry its own unique details, such as a member name, sequential number,
or unique QR code?** *(membership style only, and only once a material that supports
personalisation is chosen in Specification)*

- **Yes, every card is unique** — Priced per card, with a minimum charge, on top of the base
  price.
- **No, every card is identical**

If the style is Membership but no material has been chosen yet, the step shows: *"Choose a
material in Specification below to set personalisation."* If the chosen material does not support
personalisation, Q5 is never shown and personalisation stays off.

### Selection branch

**QS — Are the alternatives all on the same material?**

- **Same material** — Every alternative is the same material. Only the design differs.
- **Different materials** — Each alternative is on a different material, so each is priced on its
  own.

### Resolution labels (display only)

Shown in the running-resolution banner. Reworded to drop *produced*:

- Recipients → "A separate card for each named person"
- Set single, business → "One shared design, no individual names"
- Set single, membership → "One membership card" (+ ", personalised per card")
- Set collection, business → "Several shared designs, all kept together"
- Set collection, membership → "Several membership cards, all kept together" (+ ", personalised
  per card")
- Selection → "Alternative designs for the customer to choose from"
- Selection (pdp) → "Alternative designs on different materials, customer chooses one"

---

## 5. Why this beats the previous version, against the brief's criteria

- **Fewest questions for common cases.** Recipients is one click; Selection is two. The Set
  paths each drop a question. (§3 table.)
- **Every question unambiguous in isolation.** Q1 is behavioural ("what does the customer do
  with this"), not a count, so it does not depend on plural/singular framing. The only count
  question (Q2) carries an inline definition of *layout* that names the finish-variant case
  explicitly.
- **No question re-asks a determined fact.** Merging all-vs-one and allocated into Q1 removes the
  one place the old flow split a single decision across two questions. Everything after Q1 is new
  information.
- **Pluralisation ambiguity eliminated.** "Several" only ever appears at Q2, under a note that
  pins what counts as a layout. A single card with three finishes lands on "One layout"; a
  pick-one job never reaches Q2 at all.
- **Tone.** No *produced*, no *goes ahead*, no *order*. The customer "wants" / "picks" / "keeps";
  nothing implies the job is committed. British English, no em dashes, no exclamation marks.

### Structures considered and rejected

- **Keep the spec's scope-first two-step (all/one, then allocated), reword only.** Safe and
  closest to the spec, but leaves Recipients at two questions and keeps two sequential binary
  questions whose relationship is not obvious. Rejected: it tidies the symptoms but not the
  root (counting/relationship asked in the wrong order).
- **Recipients-gate first** ("Is this a card for each named person?" yes → done). Gets
  Recipients to one question too, but pushes Selection to three and makes the subtle *allocated*
  question the very first thing every designer sees, with no framing. The three-way Q1 gets
  Recipients to one question *and* keeps Selection at two, with a cleaner opener.
- **Count-first** ("how many designs?" then branch). Already tried and rejected for this work:
  "design" is overloaded across finish-variant / layout / alternative, so counting up front is
  exactly where the ambiguity lives. The chosen structure only counts once, deep on the Set
  branch, with *layout* defined on the spot.

---

## 6. Implementation notes (contract preserved)

- The wizard stays a single-page progressive-disclosure, controlled component. It owns no
  business state; it calls `onChange` with the next answers and the host page resolves the shape.
- Internal answer keys were restructured (`family` replaces `scope` + `allocated`;
  `selectionMaterial` replaces `pickMaterial`; `style` is now `business | membership`). The two
  version pages treat `WizardAnswers` as opaque and never read individual keys, so this is
  contained to `ProofShapeWizard.tsx`.
- The exported resolvers are unchanged in signature and output: `resolveShape`,
  `deriveFormState`, `dbShape`, `resolvedShapeLabel`, `deriveAnswersFromVersion`,
  `deriveAnswersFromShape`, `isWizardResolved`, `EMPTY_ANSWERS`, `WizardAnswers`. Each shape
  still emits the same `{shape, cardType, isVariantRound, isPerDirectionPricing, personalisation}`.
- `deriveAnswersFromVersion` still reconstructs answers for the read-only Edit view and the
  seed-from-prior path. A variant-round prior is still seeded by NewVersionPage as Set (single)
  with `cardType=membership` (it passes `shape: 'set_single'`); the carry picker is untouched.
- The "Change" / unresolve path still clears flags via the host page's plain setters
  (`deriveFormState` returns null → NewVersionPage's plain-setter branch). The wizard never
  triggers `handleCardTypeChange` or a `window.confirm` itself, so the renderer-freeze fix holds.
- Personalisation stays material-gated: Q5 only appears on membership style once a material that
  supports personalisation is chosen, so personalisation can never be reached outside
  membership + `supports_personalisation`.
- EditVersionPage renders the wizard `disabled` (read-only); the shape is locked at creation.
