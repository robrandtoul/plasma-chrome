# Proof annotation — viability assessment & proposal

**Status:** proposal for Rob + the design team. Nothing built.
**Date:** 2026-07-26.
**Question asked:** can we (a) annotate a proof before sending it to a customer, and (b) let the customer annotate the proof when requesting changes?
**Interface sketch:** https://claude.ai/code/artifact/b6db1c87-5226-4933-b111-aa4a384637d1 — four interactive screens using the real `design-tokens.css` palette. Card artwork is hand-drawn in the Atari Corp fixture's style; no customer artwork.

---

## 1. Verdict

**Both are viable, and the hard part is easier than it looks.** The coordinate maths this needs is two lines and requires no schema change to the image tables (§5). The real cost sits in three places: a gesture conflict in the zoom/pan viewer, a transform-wrapper refactor, and the fact that **the designer-side proof page currently renders no proof images at all** — so "designer sees the customer's pins" is a surface that has to be built from scratch.

Three recommendations, in order of confidence:

1. **Build designer callouts first, customer pins second.** Same renderer, same table, but the designer side is authenticated, staff-trainable, desktop-first and lower-risk. It proves the whole stack on a friendly audience before anything is exposed to customers.
2. **Pins, not drawing.** 57% of change requests are submitted from a phone (§2). The box/arrow/pen markup canvas we already have (`ScreenshotAnnotator`) is a desktop-mouse tool and must not become the customer path. A customer taps to drop a numbered pin and types a line; they do not draw.
3. **Annotation stays optional, forever.** 35% of change requests are pure contact-data edits where pointing at the card adds nothing. If placing a pin ever becomes a required step, this feature makes the most common change request *slower*.

There is also a cheaper adjacent win that annotation does **not** address, covering roughly a third of the volume — see §9. I'd argue it deserves consideration alongside this, not after it.

---

## 2. What the data says

Grounded in live data, not assumption. 116 change requests carrying a note since 8 June 2026 (≈16/week), against 157 approvals.

**Change requests are phone-first.**

| Surface | Phone | Desktop |
| --- | --- | --- |
| All proof views (60d, non-bot) | **67%** (1,486) | 33% (726) |
| `request_changes` submissions | **57%** (66) | 43% (50) |
| `approve` submissions | 51% (80) | 49% (77) |

This is the single most design-shaping number in the assessment.

**Only about a third of change requests are genuinely spatial.** Keyword classification across all 116 notes (categories overlap):

| Shape of request | Share | Would a pin help? |
| --- | --- | --- |
| Names a visual element ("the logo", "the QR", "the border", "the cutout") | 55% (64) | **Yes** — lets them point instead of describe |
| Contains positional language ("move", "align", "spacing", "corner", "too big") | 36% (42) | **Yes** — strongest case |
| Add/change contact data (phone, email, address, website) | 35% (41) | **No** — the note *is* the payload |
| Recorded which side they were looking at | 12% (14) | — |

Average note length is 156 characters. These are short, specific asks.

**Worked examples from live notes.** The case for annotation:

- *"would it be possible to adjust our logo (the "@" in the bottom-right corner) so that it fits entirely on the card? At the moment, part of it is cut off"* — the customer spent a clause describing a location.
- *"Move everyting a touch away from the edge"* — the only positional anchor is `side='back'`.
- *"Spacing between Auctions and Private Sales, can you make this even?"*
- *"line up the phone numbers with the addresses"*
- *"can the details in the back be placed on the bottom left corner of the card please?"*

The case against making it mandatory:

- *"Add phone number +1 (514) 512-3177"* — four near-identical notes in one batch, one per recipient.
- *"Not co founder / Co-owner"*
- *"hello can i have .co.uk on the end of my email please?"*

**Iteration churn is real but concentrated.** Of 71 proofs that received a change request, 50 needed only one. The other 21 (30%) took 2+ rounds and average 3.5–8 versions. Annotation should be judged on whether it moves that tail, not the average.

**"Which image" is rarely the ambiguity.** 79% of recent versions have only 1–2 artwork images (front/back). Multi-image ambiguity is a minority case (multi-recipient rosters, option tabs, variant rounds) — so precise *placement* matters more than image *identification*. That said, `side` is null on 88% of change requests today, which is a cheap gap to close as a by-product.

---

## 3. What exists today (verified against source)

**The customer change-request flow.** `/p/:id` → `src/pages/CustomerProofPage.tsx` (5,372 lines) → `src/components/ActionPanel.tsx`, a docked panel shared by approve and request-changes. The only content field is one `<textarea>`. Submission goes to the `proof-action` edge function, which writes a `proof_events` row and mirrors the note onto `proof_name_approvals.change_request`, then posts a plain-text note plus a staff confirmation reply to Help Scout.

`side` is captured implicitly — whichever face was open in the zoom view — and is `null` when the panel is opened from the overview. It is deliberately designer-only: migration 000196's own comment says *"The customer page's display of change requests is untouched."*

**What the designer sees.** On `/proofs/:id`: a summary line, the note text, and behind a "View details" toggle an audit panel with actor, timestamp, side, IP/UA and the Help Scout thread id. On the dashboard timeline: neither the note nor the side — `dashboard_latest_events` doesn't select them.

**Critically: the designer proof page renders no proof images.** The Names rollup where change requests appear has no image display at all. `ProofDetailView` (the zoom/pan lightbox) is used only by the customer page.

**Prior art.** `src/components/ScreenshotAnnotator.tsx` (283 lines, native Canvas 2D, zero libraries) is a complete touch-capable box/arrow/pen markup tool — but it **flattens to PNG and discards the vector data**, so markup is neither re-editable nor toggleable, and re-opening re-flattens on top. It is used in exactly one place, the staff feedback modal. Its `toCanvasPoint` (lines 132–138) is a correct display→natural pixel conversion and is directly reusable.

There is **no** persisted-coordinate model anywhere in the repo, no percentage-positioned overlay, no marker component, and no drawing dependency in `package.json`.

**Related but not this.** `proofs.proof_feedback` (000279) is decline-reason telemetry, not positional feedback.

---

## 4. The design

One concept, one table, one renderer, two authors.

- **Pin** — a coordinate-anchored comment on one proof image. Renders as a small numbered dot.
- **Callout** — a designer-authored pin shown to the customer. Same row, `author_kind='designer'`.

Numbered dots plus a list beside the image, not freehand marks. That choice does the heavy lifting: it works with a thumb, it degrades to plain text for Help Scout, it gives the designer a checklist, and it survives into the next version.

### Phase 0 — the change-request checklist (no annotation at all)

**Added after the designers reported the pain is split evenly (Rob, 2026-07-26) between customers struggling to explain *where* and designers struggling to track *what was asked*.**

The second half doesn't need annotation. It needs the prose we already have, broken into things you can tick off. On the designer's side of a change request, each ask becomes a checkable item; the proof shows *2 of 3 done*.

Why this leads:

- **It needs none of the expensive machinery** — no coordinate model, no overlay, no transform wrapper, no gesture work, no anon write path, no customer behaviour change. It is a table and a list.
- **It works on every change request ever received**, including the 35% of contact-data edits where a pin adds nothing and the 116 already in the database.
- **It addresses half the stated pain on its own**, so it has standalone value even if the pin work is never done.
- **It feeds something that already exists** — the `request_changes_no_version` needs-attention rule currently knows only "a change was requested and no new version exists". Items make that granular.
- **Pins land in it for free later.** A Phase 2 customer pin *is* a checklist item that happens to carry coordinates. Build the list first and pins populate it rather than duplicating it.

Who splits the prose into items: the designer, when they pick the work up. That is already the act of comprehension they perform mentally — this just writes it down. (An obvious later refinement: the AI draft pipeline already reads Help Scout threads, so proposing the item split from the note is a natural extension. Deliberately out of scope for now.)

### Phase 1 — designer callouts (authenticated)

The designer drops numbered pins on a version's images and writes a line against each. **Confirmed intent (Rob, 2026-07-26): these are for the customer to read, not an internal designer hand-off.**

That makes presentation the binding constraint, not a detail — see §4.1. The short version: **the artwork the customer is presented with is never drawn on.** Callouts live beside the card, and markers appear only once the customer has deliberately opened a card to inspect it closely.

Why this before customer pins:
- No anon write path, no new abuse surface, no rate limiting.
- Staff can be shown how it works; customers can't.
- It validates the overlay, the coordinate model and the renderer on desktop before touching the customer flow.
- Immediate standalone value: it turns the existing prose change-notes field into anchored callouts. "Moved the logo and changed the phone number" becomes two dots on the artwork.

Genuine uses the designers described, in rough value order: *what changed since the last version*; explaining a constraint ("the cutout can't come closer to the edge than this"); flagging a decision needing sign-off ("we've abbreviated here because the full name won't fit at this size").

### Phase 2 — customer pins on a change request (anon)

In the change-request panel, an optional **"Point at it"** action. The customer taps the artwork, a numbered pin drops, they type one line. Pins ride along with the existing `request_changes` submission.

Non-negotiables:
- The note box stays primary and sufficient. Zero pins remains a complete, valid change request.
- Tap-to-place must be an explicit mode, not an ambient tap — the image already consumes clean taps as double-tap-to-zoom candidates.
- Drop-then-drag-to-nudge, because thumbs are imprecise. The pin needs to be *near* the thing, not on the pixel.
- Copy has to make clear they're pointing, not editing artwork, and that a pin is not a mark that will be printed.

The designer then sees pins as items in the Phase 0 checklist, now anchored to a place on the artwork — which is where the missing designer-side image surface has to be built. If Phase 0 shipped first, this phase adds coordinates to a list that already works rather than introducing the list and the geometry at once.

**Help Scout degrades gracefully.** The note is plain text with no attachment path, so pins become a numbered list, which is *better* than today's prose blob:

```
Changes requested by Luke.

1. (front) part of the @ is cut off
2. (back)  move everything away from the edge

"General note text…"
```

### Phase 3 — carry-forward to the next version

Items and pins from v(N) carry onto v(N+1), so the customer can see "you asked for four things — here they are, all four". Phase 0 gives the designer the list; this closes the loop back to the customer, which is what turns a tick-off into a reason not to have a third round.

Sequencing note: the original draft put tick-off here as the payoff. With the pain reported as evenly split, the tick-off half is promoted to Phase 0 and shipped first without annotation. What remains at Phase 3 is only the *carry-forward* — showing the customer their answered list.

### 4.1 The presentation rule — no squiggles on the card

The proof is a sales artefact. It is the moment the customer decides they want the card, and the known funnel leak is *opened, never decided* (~56% per the conversion baseline). Anything that makes the artwork look marked-up, unfinished or caveated works directly against that. So the constraint is stronger than "off by default":

**1. The overview never shows markers. Ever.** That is the presentation surface. No dots, no outlines, no badges on the artwork.

**2. Callouts render beside the card, not on it.** A quiet strip below the artwork listing each callout. Collapsed, each is a single line of text. That strip is the only thing that appears on the presentation surface, and it carries no marks.

**Decided (Rob, 2026-07-26): the strip stays on the overview.** The alternative — notes existing only inside the zoom view — was considered and rejected. A note nobody can see hasn't been made.

**Copy: name the designer.** The label uses their first name — *"A note from Rob"*, *"2 notes from Rob"* — not *"A note from your designer"*, which reads as an institutional caveat. A named person who made something is an asset on a premium product; an anonymous system note invites suspicion. Cheap to do: the pin row already denormalises `author_name` (the `feedback_items` / `announcements` / `team_messages` pattern), written by the authenticated designer at creation, so nothing joins `profiles` and `public_get_customer_proof` needs no designer field. The only thing reaching the customer is a first name they already see signing Help Scout replies.

**3. Each callout brings its own visual context via a cropped detail, not an overlay.** Expanding a callout shows a small zoomed crop of the region it refers to, beside the text. The customer sees *what* is being discussed without the full card being annotated. This is cheap — a `background-image` on the signed URL with `background-size: {zoom}%` and `background-position: {x}% {y}%` crops to the pin with no canvas, no stored crop, and no extra columns. Percentage background-position also clamps sensibly at the edges for free.

**4. Markers appear only inside the zoom/detail view.** Overview is for admiring; detail is for scrutinising. A customer who has pinch-zoomed into a card has already opted into inspection, and that is the one place a numbered dot on the artwork is appropriate. "View on the card" on a callout opens the detail view at that spot.

**4a. Markers sit exactly on their anchor.** ⚠ This reverses an earlier decision in this document, and the reversal is the instructive part.

Building the sketch, a dot placed where the note pointed landed on top of the word "Founder", so this section originally said markers should be *displaced* slightly from their anchor. That shipped, and it was wrong in two ways that only showed up in use (reported by Rob within minutes of first trying it):

- **In the authoring view the dot appeared away from the designer's own click** — 4% of the card's width, about 17px, visibly to the right. Placing a pin has to be what-you-see-is-what-you-get.
- Worse, a designer would **compensate by aiming off-target**, storing a coordinate that pointed at the wrong thing. A cosmetic nudge quietly corrupting the data.
- And a displaced dot **points at nothing precisely**, which is the entire job.

The problem it was solving is real, but it belongs to whoever places the pin: put it beside the detail, not on top of it. If covering ever becomes a genuine complaint, the answer is a translucent or smaller dot — not moving it. The geometry test now asserts a click round-trips to a marker on the same spot, so this cannot regress silently.

Net effect: at no point is the image the customer is being sold drawn on. The annotation is a *pointer into* the artwork, never a mark *on* it.

This is also the decisive argument against the flatten-to-PNG model we already have in `ScreenshotAnnotator`: flattened squiggles are permanent and unavoidable, and would appear on the presentation image by construction. Structured pins are precisely what *allows* a pristine presentation.

### 4.2 The behavioural risk nobody has raised yet

Pointing at something draws attention to it. A callout can flag a detail the customer would never otherwise have noticed — and now they are looking at it, wondering whether it is a problem. Used carelessly this manufactures change requests instead of preventing them.

Suggested house guideline, worth agreeing with the designers before build: **explain what they will notice anyway; don't volunteer what they wouldn't.**

- Good: *"The logo is slightly smaller than your file — that's the minimum size the engraving holds cleanly."* Pre-empts a change request that was coming.
- Bad: pre-emptively defending a kerning choice nobody asked about.

Used well this is the strategic upside: a designer explaining a considered constraint reads as expertise and pre-answers the question that would otherwise become a round-trip or a stall. Used badly it reads as apologising for the work. That's a copy-and-training matter more than a code one, but it decides whether the feature helps or hurts.

**One consequence to accept:** because callouts are opt-in to read, a customer may not read them. The designer must not treat "I put a callout on it" as having told the customer — the callout is not a record of disclosure. If something genuinely must be acknowledged, that belongs in the approval flow (which already has a disclaimer tick), not in a callout.

---

## 5. The coordinate model — why this is cheap

Store **normalised 0–1 fractions of the image box**. No pixels, no natural dimensions, no migration on `proof_version_images`.

This works because of how the images are already styled. In the zoom viewer the `<img>` is `max-h-full max-w-full object-contain` with width and height both **auto** (`ProofDetailView.tsx:399`). For a replaced element with auto dimensions and both max constraints, CSS fits it preserving aspect ratio — so the element box *is* the painted image, and `object-contain` letterboxes nothing. The component's own comment confirms it: the letterbox space "around the object-contain image acts as the backdrop", i.e. it lies outside the element. Thumbnails (`w-full object-contain`, height auto) behave the same way.

So capture is:

```ts
const r = img.getBoundingClientRect()
const x = (e.clientX - r.left) / r.width   // 0–1
const y = (e.clientY - r.top)  / r.height  // 0–1
```

And because `getBoundingClientRect()` reports the **post-transform** rect, that formula is correct at any zoom or pan with no inverse-transform maths. Rendering is `left: x*100%`, `top: y*100%` inside a wrapper sharing the image's transform, with the marker counter-scaled by `1/scale` so dots don't balloon at 4×.

One agent report claimed letterbox inversion and `naturalWidth` ratio maths would be needed here. That would only be true if the image were sized `w-full h-full object-contain`. It isn't — verified at source.

### Sketch

```
proofs.proof_pins_annotations          -- name TBD; avoid colliding with proof_pins (dashboard pins)
  id                     uuid pk
  proof_version_id       uuid not null → proof_versions(id) on delete cascade
  proof_version_image_id uuid null     → proof_version_images(id) on delete cascade
  side                   text null     check (side in ('front','back'))
  associated_name        text null     -- which recipient's card
  x, y                   numeric not null check (between 0 and 1)
  body                   text
  author_kind            text not null check (author_kind in ('designer','customer'))
  created_by             uuid null     → profiles(id)   -- designer only
  author_name            text null     -- display name, denormalised (house pattern).
                                       -- Customer: the name they typed. Designer: their FIRST
                                       -- name, stamped at creation — this is what makes the
                                       -- "A note from Rob" label work with no profiles join
                                       -- and no designer field on the anon RPC.
  proof_event_id         uuid null     → proof_events(id)  -- ties a pin to its change request
  resolved_at            timestamptz null   -- Phase 3
  resolved_by            uuid null     → profiles(id)
  created_at             timestamptz not null default now()
```

`proof_version_image_id` is available client-side already (`GridImage.id` is a real image id), which is strictly better provenance than `side` and makes `side` derivable.

Grants follow the house rules: full CRUD to `authenticated`, `ALL` to `service_role`, **nothing to `anon`** — customer writes go through the `proof-action` edge function; customer reads are appended to `public_get_customer_proof`. Note the 000176 footgun: `ALTER DEFAULT PRIVILEGES` means a new table is born with authenticated CRUD, so anything intended to be narrower needs an explicit `REVOKE`.

---

## 6. Where the real cost is

Ranked by risk, not size.

1. **Gesture contention in `ProofDetailView`** *(the fiddly one)*. The `<img>` owns `onPointerDown/Move/Up/Cancel` with `touchAction:'none'`, and a clean tap is already meaningful — it's a double-tap-to-zoom candidate. Tap-to-place has to be threaded into that state machine and lose to double-tap. An explicit "add a pin" mode toggle sidesteps most of this, and is the better mobile UX anyway.
2. **Transform-wrapper refactor.** Pins must be children of the same transform as the image, so the bare `<img>` gains a wrapper. That changes what `getBoundingClientRect()` on `imgRef` returns, and `clampTranslate` derives `baseW = rect.width / scale` from it — so the existing pan-clamping maths needs re-verification, not just re-reading.
3. **Backdrop-click-to-close will fight the overlay.** The viewer closes on `e.target === e.currentTarget`, and the bottom caption stack uses `pointer-events-none` specifically so taps fall through. An overlay layer risks swallowing those closes and blocking the `z-10` chevrons.
4. **The designer-side image surface doesn't exist.** This is the largest *new build* in Phase 2 and is easy to under-scope: the Names rollup renders no images, so showing pins means introducing an image surface there (or reusing `ProofDetailView`, which is customer-page-only today).
5. **`proof-action` has no typed request body** — validation is ~60 lines of hand-rolled `typeof` narrowing. A pins array needs bounds/cardinality/length validation in that same style, plus a decision on whether pins are a second insert (and if so, preserving the existing guarantee that the customer's intent is captured even when a downstream write fails).
6. **`CustomerProofPage.tsx` is 5,372 lines** with ~a dozen sibling `useState` hooks for the action panel. Pin state is another cross-cutting slice through `openActionPanel` / `submitAction` / `closeActionPanel`.
7. **Dashboard timeline can't show pins** without a `dashboard_latest_events` view change. Probably out of scope — but worth knowing it's a view change, not a display tweak.

Rough scale: Phase 1 is comparable to the team-sharing feature (one migration, one new component, a handful of touched files). Phase 2 is larger and carries the mobile-testing burden. Phase 3 is the smallest and delivers the most workflow value.

---

## 7. Risks

| Risk | Handling |
| --- | --- |
| **Phone precision** — 57% of change requests come from a phone | Pins, not drawing. Drop-then-nudge. Generous hit target. Proximity is enough; the note carries the meaning |
| **Friction on the 35% who just want a phone number fixed** | Annotation is never required. Note box stays primary and sufficient |
| **Approvals get slower** — 157 approvals vs 116 change requests; approval is the more common action and the funnel's fragile point | Pins appear only in the change-request flow, never on the approve path |
| **Customer thinks they're editing artwork, or that marks will print** | Copy, and visual language that reads as "sticky note", not "drawing on the card" |
| **Designer callouts clutter the proof** *(Rob's stated concern, and the one most likely to sink this)* | The presentation rule in §4.1: overview never marked, callouts beside the card, cropped detail instead of overlay, markers only inside the zoom view. Not a default to be flipped — a structural rule |
| **Callouts draw attention to things and manufacture change requests** | §4.2 guideline: explain what they'll notice anyway; don't volunteer what they wouldn't. Copy and training, not code |
| **A callout is mistaken for a record of having told the customer** | It isn't one — it's opt-in to read. Anything that must be acknowledged belongs in the approval disclaimer tick |
| **Anon abuse** — free text from an unauthenticated visitor | Same exposure class as the existing note field, so no new category of risk. Still needs length caps, a pin-count cap, and rate limiting in the edge function |
| **More structure, no less ambiguity** — a pin with a vague note is still vague | Phase 3 tick-off is the real measure. Judge on the 2+ round tail (30% of change-requested proofs), not on feel |

---

## 8. What I would deliberately not build

- **Freehand drawing, boxes or arrows for customers.** Wrong tool for the majority device. (Designer-side, on desktop, it's arguable later.)
- **Reusing `ScreenshotAnnotator` as-is for proofs.** Its flatten-to-PNG model destroys exactly what makes this valuable: structure, toggling, carry-forward, tick-off. Borrow its coordinate maths and pointer patterns, not its model.
- **A flattened annotated image as the primary artefact.** It creates a new image that could be mistaken for artwork, and it's burned into a snapshot of the version the designer is already replacing. A numbered list is better for Help Scout and free.
- **Threaded replies on a pin.** That's a conversation, and the conversation already lives in Help Scout.
- **Pins on perspective-distorted photos of physical cards.** `qrRebuild.ts` documents a rejected projective-homography approach that managed ~54% on angled photos. Don't re-litigate it.

---

## 9. The adjacent win annotation does not address

35% of change requests are contact-data edits — "add this phone number", "co-owner not co-founder", "add .co.uk to my email". These are the requests where the designer reads prose and retypes a phone number, with transcription risk, often several near-identical ones in a batch (four in one recent case).

A pin does not help. A **structured "correct my details" path** — per recipient, pre-filled with current values, submitting a diff — would plausibly remove more designer time than annotation, for less work, and would hand the artwork sanity check machine-readable customer intent instead of prose.

I'm flagging it rather than folding it in: it's a different feature and it's the designers' call whether it competes for the same slot. If the underlying goal is "fewer change-request round-trips", it belongs in the same conversation.

---

## 10. Open questions

**Settled so far (Rob, 2026-07-26):** callouts are customer-facing, not an internal hand-off (§4). The callout strip stays on the overview rather than living only inside the zoom view (§4.1). The strip is labelled with the designer's first name (§4.1).

1. ~~**Which pain is primary?**~~ **Answered (the designers, via Rob, 2026-07-26): split evenly.** This is what added Phase 0 — the designer-tracking half turns out not to need annotation, so it leads and ships alone.
2. **Do designers actually want to annotate the sent proof, or annotate "what changed"?** The second is narrower and more valuable, and would shape Phase 1's UI toward version-diff callouts.
3. ~~**Should designer callouts be visible to customers at all**, or are they internal notes for the next designer?~~ **Answered (Rob, 2026-07-26): customer-visible.** Internal designer hand-off is not the intent. This raises the presentation stakes considerably — hence §4.1 and §4.2.
4. ~~**What would count as success?**~~ **Resolved by not setting a target (Rob, 2026-07-26)** — see §11. Deliberately no KPI; instrument it instead.
5. **Does anything need to reach Help Scout beyond the numbered list?** Assumed no.

---

## 11. Measurement — an instrument, not a target

Rob declined to set a success number, on the grounds that designers would likely reach for callouts only when they're struggling to explain something, and that guessing how customers will use pins is guesswork. Both are right, and both have consequences worth stating plainly.

**Our volume cannot produce a clean answer.** At ~16 change requests a week, with selective designer use, even a genuinely large effect would take many months to separate from noise — and the 2+ round tail is only ~21 proofs across the whole period analysed. Any dashboard claiming to prove this feature worked would be false rigour. Say so now, so nobody builds one.

**So do not judge it by adoption.** Selective use is the *expected* shape, not failure. A metric like "% of proofs carrying a callout" would look bad by design and would invite killing something that is working exactly as intended. This is the single most important thing to write down, because it is the mistake that gets made six months later by someone reading a chart.

**Instrument it instead, and follow the house pattern.** This codebase already has the right habit — AI drafts ran in `shadow`, nudges ran in `dry_run`, the artwork check ran in `shadow` before `live`. The equivalent here is cheap counters and a review date rather than a threshold:

- how many callouts and pins get created, by whom, and on what kinds of proof;
- for the proofs that used them, whether the next round went better than comparable proofs that didn't — read directionally, never as proof;
- whether designers keep using it after the novelty passes, which at this volume is the most honest signal available.

**Then decide by asking the designers.** For a tool used by five people at this cadence, their judgement after a month of real use is better evidence than any statistic we could compute. Set a review date at build time; don't set a number.

One consequence for Phase 0: because it applies to every change request rather than a chosen few, it is the one part of this that *will* generate enough data to read. If a number is wanted anywhere, that's where to look for it.
