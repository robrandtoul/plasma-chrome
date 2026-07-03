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

Add-on, on the **Set** branch only, never on Selection:

- **Personalisation** (per-card unique data). It is the single material-gated Set question:
  shown once a material is chosen, only when `materials.supports_personalisation` is true. It
  affects price. (The earlier "business vs membership card style" step was removed, see §6: a
  non-personalised membership card and a business card resolved to an identical proof, so the
  step asked a question that changed nothing.)

A **kept-together multi-material Set (collection)** forces a custom quote: the single-material
price grid can't price a set that spans materials, so the customer page hides pricing and the
designer quotes manually. This reuses the existing `custom_quote` mechanism, no schema change.

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
├─ Cards showing each person's own contact details  RECIPIENTS   (resolves in one question)
├─ Cards with no personal contact details ........ → Q2 (Set branch)
└─ Alternatives to choose from ................... → QS (Selection branch)

Set branch
  Q2  How many layouts are in this set?
  ├─ One layout .................................. SET (single)
  └─ Several layouts ............................. → Q3
      Q3  Are all the layouts on the same material?
      ├─ Yes, one material ....................... SET (collection)
      └─ No, different materials ................. → split / keep guard
            [Split into separate projects] ....... terminal guidance, not saveable
            [Keep together anyway] ............... SET (collection), forces a custom quote
  Personalisation  (the single Set add-on; material-gated)
  ├─ material supports personalisation → ask "Does every card carry its own unique details?"
  │     ├─ Yes, every card is unique ............. personalisation ON
  │     └─ No, every card is identical ........... personalisation OFF
  └─ material doesn't support it (or none chosen yet) → not asked, personalisation OFF

Selection branch
  QS  Are the alternatives all on the same material?
  ├─ Same material ............................... SELECTION
  └─ Different materials ......................... → QS2 (customer-intent guard, July 2026)
      QS2  Will they pick one, or might they order both?
      ├─ They'll pick one, prices can wait ....... SELECTION (per-direction pricing)
      ├─ They've asked for a price on each ....... terminal guidance: a project per material
      └─ Might order both, or unsure ............. terminal guidance: a project per material
```

There is no longer a card-style step. Both Set shapes emit `cardType=membership` regardless,
so a "business vs membership" question changed nothing except whether personalisation was
offered; personalisation is now asked directly (material-gated), one step earlier in every
membership-style job.

### Question count per case (lower is better)

| Case | Shape | Questions | Original 6-step |
|------|-------|-----------|-----------------|
| Card per person | Recipients | **1** | 2 |
| Alternatives (same or different material) | Selection | **2** | 2 |
| One shared design, material without personalisation | Set (single) | **2** | 4 |
| One shared design, personalised | Set (single) | **3** | 5 |
| Several shared designs, same material | Set (collection) | **3** | 5 |
| Several shared designs, same material, personalised | Set (collection) | **4** | 6 |
| Several shared designs, kept together (different materials) | Set (collection) | **4**, forced custom quote | — |

Recipients is one click. Selection is two. Every Set path is shorter again now the card-style
step is gone: a one-layout job on a material that doesn't offer personalisation is just two
questions (which best describes this, then how many layouts).

---

## 4. Final wording

### Q1 — always asked (three options, stacked)

> **Which best describes this proof?**

- **Cards showing each person's own contact details** — Each named person has their own cards
  with their own details. *(Relabelled July 2026 from "A batch of cards for one or more people"
  so the first two options are mirror images around the personal-contact-details axis.)*
- **Cards with no personal contact details** — No card shows an individual's contact details.
  This can be one design or several.
- **Alternatives to choose from** — You show alternative designs side by side and the customer
  picks the one they want. The rest are set aside. *("side by side" added July 2026: it is the
  wizard-level defence against reading a sequential replacement (gold rejected, steel next) as
  "alternatives" — that case is a new version, not a Selection.)*

Q1 no longer carries an explanatory note. The labels themselves now carry the distinction that
used to need one: a card showing a person's own contact details is per-recipient, while a card
with no personal contact details is a shared set, even when a name or number is printed on it (a
numbered pass, a membership card). So a numbered or membership run lands on the shared-set option
without a separate routing note.

### Set branch

**Q2 — How many layouts are in this set?**
> *Note:* A layout is one design. The same design shown in different finishes is still one
> layout.

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

"Keep together anyway" proceeds as a Set (collection), but because it spans materials the
single-material grid can't price it, so the version is forced onto a custom quote: the
PricingDisplayField locks to Custom (with a one-line reason) and the customer page hides
pricing. See §6 for the wiring.

**Personalisation — Does every card carry its own unique details, such as a member name,
sequential number, or unique QR code?** *(the single Set add-on; asked once a material is chosen
in Specification, and only if that material supports personalisation)*

- **Yes, every card is unique** — Priced per card, with a minimum charge, on top of the base
  price.
- **No, every card is identical**

Before a material is chosen the step shows: *"Choose a material in Specification below to set
personalisation."* If the chosen material does not support personalisation, the question is never
shown and personalisation stays off.

### Selection branch

**QS — Are the alternatives all on the same material?**

- **Same material** — Every alternative is the same material. Only the design differs. Pricing
  shows as normal.
- **Different materials** — The page won't show pricing when the alternatives span materials, so
  you'd quote in the thread. *(Reworded July 2026: the previous "each is priced on its own" read
  as though the page would show a price per direction, when per-direction pricing actually hides
  the pricing card entirely.)*

**QS2 — Will they pick one, or might they order both?** *(only when "Different materials";
added July 2026, see §8)*

> *Note (above the options):* Alternatives on different materials don't show pricing on the
> page. Only keep them together when you know the customer is choosing and prices can wait.

- **They'll pick one, prices can wait** — One page, both directions, no pricing. Quote in the
  thread if asked. → resolves as Selection (per-direction pricing), exactly the pre-QS2 shape.
- **They've asked for a price on each** — Split into a project per material, so every link shows
  its own price. → terminal guidance (reuses the split-guard kind), with a link to the
  new-project screen.
- **They might order both, or I'm not sure** — Split into a project per material. It's right
  whichever way they go. → terminal guidance, plus the suggested one-line question to send the
  customer ("Happy to show you both. Are you looking to choose between the two, or thinking of
  ordering both?") with a copy-to-clipboard control.

### Resolution labels (display only)

Shown in the running-resolution banner. Reworded to drop *produced*:

- Recipients → "A separate card for each named person"
- Set single, not personalised → "One shared design, no individual names"
- Set single, personalised → "One shared design, personalised per card"
- Set collection, not personalised → "Several shared designs, all kept together"
- Set collection, personalised → "Several shared designs, all kept together, personalised per card"
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
- The `style` answer key (business vs membership) was removed along with its question. The
  ResolvedShape `set-single` / `set-collection` variants no longer carry `style`, and
  `set-collection` gained a `multiMaterial` flag (true on the keep-together path). The two
  version pages treat `WizardAnswers` as opaque and never read individual keys, so this stays
  contained to `ProofShapeWizard.tsx`.
- The exported resolvers keep their signatures. `deriveFormState` gains one output field,
  `forceCustomQuote` (true only for a kept-together multi-material collection); every other
  emitted value is unchanged, and Recipients / Selection / Set single / Set collection emit the
  same `{shape, cardType, isVariantRound, isPerDirectionPricing, personalisation}` as before.
  `resolveShape`, `dbShape`, `resolvedShapeLabel`, `deriveAnswersFromVersion`,
  `deriveAnswersFromShape`, `isWizardResolved`, `EMPTY_ANSWERS`, `WizardAnswers` are otherwise
  as before.
- Keep-together custom quote (NewVersionPage): `deriveFormState(...).forceCustomQuote` drives
  two things, both reusing the existing `custom_quote` mechanism. `handleWizardChange` sets the
  pricing display to Custom when it is true, and the PricingDisplayField is passed
  `standardDisabled` + a reason so the grid can't be re-selected. Save then writes
  `custom_quote = true` through the existing `isCustomQuote` path, and the customer page hides
  pricing. No schema change.
- `deriveAnswersFromVersion` still reconstructs answers for the read-only Edit view and the
  seed-from-prior path. A variant-round prior is still seeded by NewVersionPage as Set (single)
  with `cardType=membership` (it passes `shape: 'set_single'`); the carry picker is untouched. A
  set_collection seeds as same-material, since the keep-together override is UI-only, not stored.
- The "Change" / unresolve path still clears flags via the host page's plain setters
  (`deriveFormState` returns null → NewVersionPage's plain-setter branch). The wizard never
  triggers `handleCardTypeChange` or a `window.confirm` itself, so the renderer-freeze fix holds.
- Personalisation stays material-gated: the question only appears once a material that supports
  personalisation is chosen, so personalisation can never be reached outside
  `supports_personalisation`. With the style step gone it is offered for any Set on a supporting
  material, not only a "membership-styled" one.
- EditVersionPage renders the wizard `disabled` (read-only); the shape is locked at creation.

---

## 7. Worked-example tooltips

Every selectable option carries a small info affordance (an "i" icon beside the option) that
reveals a one-line, Plasma-specific worked example. Two registers, kept distinct: the option's
**helper text** says what the option *means* at a glance; the **tooltip** shows a real job where
you would pick it. The tooltip never restates the helper.

The copy is data-driven: a single `SCENARIOS` map at the top of `ProofShapeWizard.tsx`, keyed by
question + option, co-located with the option definitions. Editing or adding a scenario is a
one-line change in that one place. It is hardcoded in the component, exactly like the helper
text, with no admin editor and no schema.

### The scenarios (option -> example)

Each line ends with the path it walks through the decision tree (section 3), confirming it
resolves to the option it sits on.

**Q1 — which best describes this proof?**

- *A batch of cards for one or more people* — "A law firm wants a batch of cards for each
  partner, each showing that partner's own name, title, and direct line." → per-named-person,
  individually proofed = **Recipients**.
- *Cards with no personal contact details* — "A clinic's set of reference cards, ECG, blood pressure, dosage. A
  gym's identical membership cards. Neither is tied to a named person and the customer intends to
  order every card shown, so both belong here." → no names, customer keeps them all = **Set**
  branch. (The "intends to order" wording is Rob's approved exception to the no-commitment rule.)
- *Alternatives to choose from* — "A startup wants to see three different design directions for
  their card, then pick the one they like best and set the rest aside." → pick one, rest dropped
  = **Selection** branch.

**Q2 — how many layouts are in this set?**

- *One layout* — "A coffee shop wants a single loyalty card design, the same card for every
  customer. One design, so one layout." → one design = **Set (single)**.
- *Several layouts* — "A clinic wants four different information cards, for booking, aftercare,
  opening hours, and contact, all kept together as one set." → several different designs, kept
  together → Q3.

**Q3 — are all the layouts on the same material?**

- *Yes, one material* — "The clinic's four reference cards, booking, aftercare, hours, and
  contact, all on the same brushed steel. Different designs, one material, so they stay together
  and are priced the same." → several layouts, one material = **Set (collection)**.
- *No, different materials* — "A restaurant group wants a walnut menu card, an acrylic table
  card, and a copper loyalty card, each on its own material." → several layouts on different
  materials → the split / keep guard.

**The different-materials guard**

- *Split into separate projects* — "Those walnut, acrylic, and copper cards each price
  differently, so you split them into three projects, one per material, each priced correctly." →
  the recommended route; ends as separate single-material projects (not a saveable single set).
- *Keep together anyway* — "The customer wants to see the walnut and acrylic cards together as one
  set, so you keep them in one proof. The page won't show pricing, so you'll quote it manually." →
  the override; proceeds as **Set (collection)** and forces a custom quote.

**Personalisation — does every card carry its own unique details?**

- *Yes, every card is unique* — "A members club wants each card to carry the member's name, a
  sequential number, and a unique QR code, so no two cards are the same." → per-card data =
  **personalisation on**. (One template plus a data rule, not a card proofed per person, so this
  is Set, never Recipients.)
- *No, every card is identical* — "A festival wants 2,000 identical passes, all the same design,
  with no member names or numbers." → no per-card data = **personalisation off**.

**Selection QS — are the alternatives all on the same material?**

- *Same material* — "A bar wants to see two different designs for their loyalty card, both on the
  same matte black metal, then pick the one they prefer." → alternatives on one material =
  **Selection**.
- *Different materials* — "A client wants to see their card on walnut next to the same design on
  brushed steel, then pick one and set the other aside. The page won't show pricing, so you'll
  quote each option manually." → alternatives on different materials = **→ QS2** (Pick-one-and-drop,
  so it is Selection, not a finish/material option dimension.)

**Selection QS2 — will they pick one, or might they order both?** *(July 2026)*

- *They'll pick one, prices can wait* — "A bar wants to see two directions, one on walnut, one on
  steel, and will pick their favourite. Prices can wait until they've chosen a direction." →
  **Selection (per-direction pricing)**.
- *They've asked for a price on each* — "The customer has asked to see matte black metal and
  satin black plastic with a price on each. Two projects, two links, each pricing correctly." →
  terminal split guidance.
- *They might order both, or I'm not sure* — "The thread mentions quantities against both
  materials, so they may order both. Two projects are right whichever way it goes; abandon
  anything they drop." → terminal split guidance.

### Affordance behaviour

- **Trigger.** A small `Info` icon (lucide, 14px in a 20px hit area, muted so it stays
  subordinate to the label), rendered as an absolutely-positioned *sibling* of the option's
  `<label>`, never a child. Clicking it can therefore never select the option; clicking anywhere
  else on the card still selects it.
- **Reveal** on hover, on keyboard focus, and on tap (a tap pins it open on touch, where there is
  no hover).
- **Dismiss** on mouse-out, on blur, on Escape (which also returns focus out of the trigger so it
  does not immediately reopen), on outside click, and on scroll or resize.
- **Accessibility.** The trigger is a real `<button>` (keyboard reachable, focus-visible ring),
  labelled `Example: <option>`, with `aria-describedby` pointing at the popover while it is open.
  The popover has `role="tooltip"`. The trigger stays interactive even when the option radios are
  disabled (the read-only edit view), so selection-disabling lives on each `<input>`, not on the
  `<fieldset>`.
- **Positioning.** The popover is portaled to `<body>` so the option card can never clip it, is
  placed below the icon (flipping above when there is no room), and is clamped to the viewport
  with a 12px margin so it stays readable on a narrow screen. It never shifts page layout.

---

## 8. July 2026 revision: customer-intent guard (QS2) + copy rewords

Prompted by two real incidents in the week of 29 June 2026: a designer put two
compare-alternatives materials into one project as v1/v2 (so the customer only ever saw the
latest version), and separately created a whole new project for a rejected-design revision that
should have been a v2. The root gap: the Selection branch quietly resolved a different-materials
answer with no warning that the page would show no pricing, while the equivalent Set-branch
situation had an explicit split/keep guard.

Changes, all contained in `ProofShapeWizard.tsx` (UI-only; nothing persisted, no schema):

1. **QS2, the customer-intent guard.** Choosing "Different materials" on the Selection branch now
   asks *"Will they pick one, or might they order both?"* Only *"They'll pick one, prices can
   wait"* resolves (to the same per-direction Selection as before). *"They've asked for a price
   on each"* and *"They might order both, or I'm not sure"* both show terminal split guidance —
   a project per material is correct whichever way those cases go — reusing the existing
   `split-guard` ResolvedShape kind so no downstream mapping gained a case. The answer key
   (`selectionIntent`) is UI-only, like `multiMaterialChoice`. Both reverse-derivation functions
   seed `selectionIntent: 'pick'` for a per-direction version, so persisted selections still
   reconstruct as resolved (regression-tested).
2. **Q1 rewords.** First option relabelled "Cards showing each person's own contact details"
   (mirror image of option 2); "side by side" added to the Alternatives helper so a sequential
   replacement isn't read as alternatives.
3. **QS rewords.** "Same material" now says pricing shows as normal; "Different materials" now
   states the page won't show pricing (the old "each is priced on its own" implied the
   opposite).
4. **Dead-end links.** Every terminal split guidance box (Set and Selection) now links to
   `/proofs/new`; the "unsure" box also shows a suggested one-line question for the customer
   with a copy-to-clipboard control (`ASK_CUSTOMER_QUESTION`).

Tests: `pnpm test:wizard` (`src/components/ProofShapeWizard.test.ts`) covers every resolution
path, the form-state/DB mappings, and the reconstruct-as-resolved regressions.
