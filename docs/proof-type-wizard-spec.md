# Spec: Proof-type wizard and the "Set" shape

Status: draft for review (decisions in section 9 resolved)
Author: Rob + Claude (Cowork)
Audience: Claude Code (implementer) and Rob (non-coder owner)
Repo: `/Users/robrandtoul/proof-viewer/`

---

## 1. Background and problem

When a designer creates a project or adds a version, they currently choose between two paths:

- **Standard proof** — assumes the material is decided and work is sequential.
- **Variant round** — presents several alternatives and the customer picks one.

In practice the team needs to express far more than two intents, and they keep cramming
them into the nearest-fitting path. The clearest example: four similar informational cards,
same material, no names, customer wants to order **all four**. The only place to give each
layout a free-form title is the variant round, so designers reach for it, and inherit its
"pick one" behaviour, which is exactly wrong for that job.

We enumerated the real intents:

1. Single design for one person
2. Cards for several people (same material)
3. Single design for a project, no names
4. Several designs for a project, no names (same material) — the case above
5. Cards for several people, different materials
6. Membership card, no name
7. A series of membership cards, no name (gold / silver / bronze)
8. Variants of a design on the same material (choose one)
9. Variants of a design on different materials (choose one)

## 2. Goal and non-goals

**Goal.** Replace the blunt "Standard vs Variant round" entry point with a short guided
wizard that asks at most three questions and routes the designer to the correct shape, so
the misrouting stops at source. Introduce the one shape that has no home today ("Set"), and
make personalisation a clean add-on reached through the membership flavour.

**Non-goals.**

- No change to how variant rounds or standard per-recipient proofs already behave.
- No new pricing model. The economics we need already exist (see sections 5 and 6).
- Not trying to support "several people on different materials" as a single project — that
  is deliberately steered to separate projects.

## 3. The three shapes

All nine intents collapse onto three structural shapes, plus a flavour and an add-on.

- **Recipients** — customer receives all; each person gets bespoke, individually-proofed
  artwork. This is today's standard per-recipient proof, unchanged. Covers 1 and 2.
- **Set** — customer receives all; no individually-proofed names; one material; one or more
  layouts. A single layout is a "set of one"; several layouts add a tooling charge per extra
  layout. This is the new shape (built as a separate workflow, see section 7). Covers 3, 4,
  6, 7.
- **Selection** — customer picks one option. This is today's variant round, unchanged. Same
  material gives one pricing grid; different materials use per-direction pricing. Covers 8
  and 9.

The flavour and the add-on:

- **Membership** is a flavour of the **Set** shape (so always a no-name, receive-all card),
  available as single or collection. Choosing membership declares the card has no
  individually-proofed names and **enables the personalisation checkbox**. Membership styling
  itself does not change the price; personalisation does. Covers 6 and 7.
- **Personalisation** (per-card unique data: a member name as variable data, sequential
  numbering, member IDs, a unique QR per card) is a priced add-on. It is a **no-name concern**
  and is reached **only through the membership flavour**. It never appears on Recipients or on
  the Selection trunk.

A proof carries a single material, so several people who each need a different material can't
share one proof — they are naturally separate projects, one proof per material. Case 5
(several people, different materials) therefore routes to **Recipients** like any other named
job; there is deliberately **no material question on the Recipients branch**, because that
would tax the common single-material case for a split that the one-material-per-proof rule
already forces. The same-material **guard** is needed only on the Set branch (Step 4), where
several no-name layouts could otherwise be crammed onto one proof across materials.

### Case-to-shape map

| # | Intent | Shape | Flavour / flags |
|---|--------|-------|-----------------|
| 1 | Single design for a person | Recipients | one name |
| 2 | Cards for several people, same material | Recipients | many names |
| 3 | Single design, project, no names | Set (single) | standard style |
| 4 | Several designs, project, no names, same material | Set (collection) | per-layout tooling |
| 5 | Several people, different materials | Recipients | one proof per material — separate projects (no Recipients-branch guard) |
| 6 | Membership card, no name | Set (single) | membership; personalisation optional |
| 7 | Membership series (gold/silver/bronze) | Set (collection) | membership; personalisation optional |
| 8 | Variants, same material, choose one | Selection | — |
| 9 | Variants, different materials, choose one | Selection | per-direction pricing |

Personalisation can switch **on** only on cases 6 and 7 (membership), and only when the
material supports it.

## 4. The wizard

A short branching wizard sits in front of all paths and replaces the current two-button
choice. Vocabulary is fixed and consistent throughout:

- **layout** = one design.
- **set** = the whole proof.
- **batch** = a quantity of identical cards.
- **allocated** = tied to a named person, proofed individually.
- **personalisation** = per-card unique data (member name as variable data, numbering, IDs,
  QR). Reserved word; it appears only at the personalisation step.

### Question script (final wording)

**Step 1, always asked.**
"Is the customer ordering all of the designs shown, or picking one to move forward with?"

- *Ordering all of them* — "Everything in this proof gets produced." → receive-all trunk
- *Picking one* — "You're presenting alternatives and they'll choose a single one to go ahead with." → pick-one trunk

#### Receive-all trunk

**Step 2.** "Is each batch of cards allocated to a specific named person?"

- *Yes, a batch per person* — "You'll proof a separate batch for each person. Choose this for bespoke, per-person artwork." → **Recipients**
- *No, not allocated to a person* — "Names and numbers, if any, are added as variable data, not proofed per person." → Step 3

> Routing note: a high-volume run where every batch shares one template and only a name or
> number changes is **not** Recipients. It belongs on the Set branch with membership +
> personalisation (you approve one template plus the data rule, you do not proof each batch).
> Step 2 is framed around whether each batch is **allocated** to a person and proofed
> separately, not around whether names appear on the card, to keep these apart.

**Step 3.** "How many different layouts are in this set?"

- *One layout* — "A single design, produced as one run." → **Set (single)**
- *Several layouts* — "More than one design produced together, like a set of informational cards or a gold / silver / bronze series. Each layout after the first adds a tooling charge." → **Set (collection)**

**Step 4, shown when there's more than one layout.** "Are they all on the same material?"

- *Yes, same material* → continue
- *No, different materials* — "These are normally quoted and proofed as separate projects so each material prices correctly. Want to split them?" → [Split into separate projects] [Keep together anyway]

**Step 5, the card style (Set branch only).** "What style of card is this?"

- *Standard* — "A plain card with no per-card variation." → personalisation not offered
- *Membership* — "A membership-style card. No individual names are entered here, and you can switch on personalisation." → enables Step 6

**Step 6, shown only when style is Membership and the material supports it.** "Does every card carry its own unique details, such as a member name, sequential number, or unique QR code?"

- *Yes, every card is unique* — "Priced per card with a minimum charge, added on top of the base price." → personalisation on
- *No, every card is identical* → personalisation off

#### Pick-one trunk

**Step 2.** "Are the options all on the same material?"

- *Same material* — "Every alternative is the same stock; only the design differs." → **Selection**
- *Different materials* — "The alternatives are on different stocks, so each is priced on its own." → **Selection (per-direction pricing)**

### Wording rationale (keep these intact)

- Step 2 asks whether each "batch of cards is allocated to a named person", deliberately
  avoiding "personalised", so that word only ever means the Step 6 add-on. The routing note
  keeps membership/numbered runs (shared template, variable data) out of Recipients.
- Step 3 says "layouts in this set", not "different designs", so it reads as one job with
  several faces, not several projects.
- Every per-person option says "batch", so "one" can't be misread as a quantity of cards.
- Reserved vocabulary throughout: **layout** = one design, **set** = the whole proof,
  **batch** = a quantity of identical cards, **allocated** = tied to a named person,
  **personalisation** = per-card unique data. These exact terms must be used in the UI copy.

### Front-end behaviour (UX)

The wizard is **single page with progressive disclosure**, not a paged Next/Back flow.
With only two or three questions, branching, and heavy repeated use by the same designers,
progressive reveal is faster and lets an earlier answer be changed with the downstream
questions updating live.

- **Folded into the version form as its opening section.** The wizard replaces the current
  "Standard vs Variant round" choice at the top of the new/edit version form. The rest of the
  form (Specification, Proof images, Change notes, Pricing) continues below and adapts to the
  resolved shape. It is one continuous page led by the shape decision, not a separate modal
  that hands off.
- **One question at a time.** Only the first question shows initially. Answering it collapses
  that question to a compact row showing the chosen value, with a "Change" control, and reveals
  the next relevant question below.
- **Revisit clears downstream.** Reopening an earlier answer via "Change" clears that answer and
  every answer after it, then re-reveals from that point. Changing Step 1 (all vs one) resets
  the whole trunk.
- **Material gating is handled naturally.** The same-material guard and the membership and
  personalisation questions only become answerable once the material is chosen (in
  Specification), because personalisation depends on the material's `supports_personalisation`.
  Progressive reveal accommodates "this question appears once the material is set" without the
  awkwardness a rigid paged wizard would have. If a membership card is on a material that does
  not support personalisation, the personalisation question is simply never shown.
- **Running resolution.** Once the path is complete, a resolved banner states the shape (e.g.
  "Set · collection · membership · numbered") and the form's Continue/Save becomes available.
- **Accessibility.** Keyboard-navigable option controls, visible focus rings, and a
  screen-reader summary of the current state. No reliance on hover-only affordances.

## 5. Personalisation (the add-on)

Personalisation is a priced capability layered onto the Set shape. Rules, reflecting the
resolved decisions:

- **No-name concern.** Personalisation only applies where there are no individually-proofed
  names. It therefore lives on the Set branch only, never on Recipients.
- **Reached through membership.** The personalisation checkbox (Step 6) is enabled by choosing
  the Membership style (Step 5), and only when the chosen material's `supports_personalisation`
  capability is true. Consequence to confirm acceptable: a numbered card that is **not**
  membership-styled is not offered personalisation through the wizard. This matches all nine
  real cases (numbering only appears on the membership cases, 6 and 7).
- **Never on Selection.** Personalisation and the pick-one trunk are mutually exclusive, and
  the database already enforces this (the check constraint blocking `is_variant_round` together
  with `has_personalisation`). The wizard simply never reaches Step 6 on that trunk.
- **Pricing stacks.** It is an independent line on top of the shape's base price. A numbered
  gold / silver / bronze series is Set (collection) **plus** personalisation: base volume
  price, plus per-layout tooling, plus the per-card personalisation rate, plus the minimum
  charge. The quote compiler already treats collection/split-name tooling and the
  personalisation surcharge as separate summed lines; the customer pricing card needs to render
  both lines at once for membership Set jobs.
- **It is the alternative to Recipients.** With Recipients you proof a card per person. With
  personalisation you approve one template plus the data rule and do **not** proof cards
  individually. The Step 2 routing note enforces this.

## 6. The "Set" shape (the new build)

Set is the only shape without a home today. It is built as a **separate third workflow**
(decision, section 7), though it should reuse existing helper logic rather than reimplement it.

- **Set (single)** — one layout, no names. This already works today as a standard proof with
  everything in the shared slot; the workflow should produce the same end state.
- **Set (collection)** — the genuinely missing capability: several titled layouts, all
  ordered, one material, a tooling charge per extra layout.

What Set (collection) needs, and what it reuses:

- **Layout titles.** Each layout carries a free-form title (e.g. "ECG card", "Infarction
  card"). Store these in a **dedicated field** (decision, section 9, item 1), not by
  overloading the `names` array. This keeps "names" meaning named recipients only.
- **Approval semantics.** Approve-each, not pick-one. Reuse the per-recipient finalisation
  logic: the proof flips to approved once every required slot (here, every layout) is approved.
  The customer approves every layout, no forced choice.
- **Pricing.** "Charge for the total volume, then add tooling per extra layout" is
  mathematically identical to the existing split-name surcharge, `(count - 1) x per-item
  tooling`. Reuse the existing tooling-surcharge calculation and the customer-page tooling card,
  driven by the layout count instead of the name count, and the customer-facing noun changes
  from "name" to "layout".
- **Images.** One layout's artwork maps to one slot, exactly as one person's artwork maps to
  one slot in Recipients.
- **Customer-facing copy.** On Set jobs the axis label is "Layouts", not "Names" / "Names on
  card", and the per-name framing copy is adjusted.

## 7. Build approach (decided)

**Decision: Set is built as a separate third workflow** alongside standard proof and variant
round (Option B from the prior discussion). The designer sees three clean choices, and the new
workflow is its own path rather than a hidden mode inside the standard proof.

Guidance for Code: a separate workflow does not mean reimplementing everything. Reuse the
shared helpers wherever sensible, in particular the tooling-surcharge calculation, the
approve-each finalisation, and the slot/image handling, rather than duplicating them. The
separation is about a clear, distinct designer-facing path and a clean version shape, not about
forking the pricing or approval engines.

## 8. Likely data-model touch points

Proposed, to be confirmed against source. Do **not** trust the migration summary in
`CLAUDE.md` for current state; `ls supabase/migrations/0001*` and `pnpm db:status` are
authoritative, and pick the next migration number from the directory, never from the doc.

- A field on `proof_versions` recording the resolved shape (Recipients, Set-single,
  Set-collection, Selection), so the customer page and the designer UI can branch.
- A **dedicated** field for Set layout titles (decision: do not reuse `names`).
- `card_type` already exists and carries the membership flavour; `has_personalisation` already
  exists and is the personalisation flag. Both reused as-is; the wizard sets them.
- The multi-material guard (Step 4) is UI-only; no schema needed, and it lives only on the Set
  branch. Case 5 (several people, different materials) hits no guard — it is simply one
  single-material Recipients proof per material, each created through the existing new-project
  flow.
- Any `public_*` view that is dropped and recreated must **re-state its grants** afterwards
  (`REVOKE SELECT ... FROM anon, public` and `GRANT SELECT ... TO authenticated`). This has
  bitten the repo before; the drop silently wipes grants with no error.
- New tables, if any, default to authenticated CRUD via `ALTER DEFAULT PRIVILEGES`; if a new
  table should be read-only for authenticated, follow the `CREATE TABLE` with an explicit
  `REVOKE INSERT, UPDATE, DELETE`.

## 9. Decisions (resolved) and residual confirmations

Resolved with Rob:

1. **Layout titles storage** — dedicated field on `proof_versions` (not the `names` array).
2. **Set build approach** — separate third workflow (section 7).
3. **Personalisation scope** — a no-name concern; lives on the Set branch only, never on
   Recipients.
4. **Membership behaviour** — switching to Membership removes the need to provide a person's
   name for the card and enables the personalisation checkbox. Membership is therefore a
   flavour of Set, not a path of its own, and is the gateway to personalisation.

One thing to confirm before build (low stakes): item 3 + 4 together mean a numbered card that
is **not** membership-styled cannot be offered personalisation through the wizard. That fits all
nine current cases. Flag only if a non-membership numbered card is a real future need.

## 10. Delivery: worktree and Netlify preview

Rob's requirement: build on a separate worktree so it can be tested as a Netlify preview
deploy, with the live production build unaffected.

**Frontend isolation works cleanly.**

- Code creates a feature branch and works on it (it runs in its own worktree under
  `.claude/worktrees/`). Note: a worktree created from the Cowork sandbox records a sandbox
  path, and the Cowork file tools write to the **main** worktree, not Code's worktree, so let
  **Code** own the branch and the file changes, and have Rob drive git from his Terminal.
- Open a PR. Netlify produces a **Deploy Preview** for the PR at its own URL; `main`
  (production) is untouched. Rob tests the wizard on the preview URL.
- Netlify status is silent on GitHub for this repo, so don't poll commit status; confirm the
  preview is live by checking the bundle on the preview URL.
- Use explicit paths with `git add` (never `git add -A`), commit in plain-English steps, and
  push only when Rob says so.

**Database is the catch, and the spec is built around it.**

There is a single Supabase project behind both production and any Netlify preview. A preview
deploy uses the production Supabase URL, so **migrations cannot be "preview only"** — any
migration pushed with `pnpm db:push:confirm` / `--include-all` hits the production database
immediately, before the PR merges. To keep production genuinely unaffected while Rob tests:

- **Sequence the work frontend-first.** Build and test the wizard UI and routing on the
  preview against the **existing** schema as far as possible.
- **Make every migration additive and backward-compatible.** New nullable columns, new tables,
  new flags that default to the current behaviour. Nothing that drops or repurposes a column
  the live customer page or designer dashboard reads. Additive migrations are inert until the
  new UI uses them, so they can land without changing production behaviour.
- **Hold destructive or behaviour-changing schema changes until merge**, or gate new behaviour
  behind the new shape field so existing proofs are untouched.
- Run `pnpm db:diff` before any push, and push via `pnpm db:push:confirm` (it bails if more
  than one migration is pending and asks for explicit confirmation).

If full isolation of schema changes is ever needed, that's a separate piece of work (a staging
Supabase project with its own branch env vars) and out of scope here.

## 11. Suggested build order

1. Build the wizard UI and routing against the current schema; ship to the preview for Rob to
   click through. No schema changes yet.
2. Add the additive migration(s): the shape field on `proof_versions` and the dedicated
   layout-titles field. Wire Set (single) to land correctly (mostly already works).
3. Build Set (collection) as the new workflow: layout titles, approve-each, per-layout tooling
   reuse, customer-page relabelling.
4. Wire the Membership style (Step 5) and the personalisation checkbox (Step 6), and confirm
   the pricing lines stack on membership Set jobs.
5. Build verify (`npm run build`) for clean types and bundle; click-test each of the nine cases
   on the preview before merge.
