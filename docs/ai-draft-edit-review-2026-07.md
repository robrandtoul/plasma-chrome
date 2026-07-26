# AI draft edit review — July 2026

A manual pass of what the Phase 3c edit-miner *would* have found, done by hand so we can
see the quality of the signal before deciding whether to build the miner.

**Method.** Read every AI draft alongside the reply the team actually sent, from the
`ai_drafts` ledger:

| Set | Rows | Read |
| --- | --- | --- |
| `lightly_edited` (similarity 0.80–0.97) | 38 | all 38 |
| `rewritten` (0.45–0.80) | 88 | all 88 |
| `discarded` (< 0.45) | 248 | 26 most recent |
| `sent_as_is` (≥ 0.97) | 154 | none (nothing to learn) |

Every proposal below is backed by counted, repeated instances. Where something appears
once it is marked as such, and kept only when it contradicts a briefing rule outright.

> **Status: filed as pending proposals on 2026-07-26**, batch
> `493f5aa7-1ea6-4ded-b83e-370e76bf1bb2` — 8 `house_rule_edit`, 5 `house_rule_add`, 1
> `category_flag`, all awaiting review in **Admin → AI drafts → Proposals**. Nothing has
> reached the live briefing: `apply_ai_draft_proposal` is the only write path and it runs
> on Approve. `recurrence_count` and the `evidence` arrays on each row were derived by
> query rather than by hand, so the counts below (written from reading) are sometimes
> higher than the count stored on the proposal — the stored figure is the conservative,
> machine-checkable one. The three exemplar additions in §3.2 were **not** filed; they need
> their customer-side text pulling from Help Scout first, since `ai_drafts` stores only the
> draft and the sent reply.

---

## 1. First: the acceptance metric is reading worse than reality

About a third of the `discarded` rows are not bad drafts at all. The feedback matcher
takes *the latest sent staff reply* on the conversation and compares it to the draft. When
the next thing the team sends is a different kind of message entirely, the score collapses
through no fault of the draft.

Of 26 recent `discarded` rows, 8 were this:

- draft answered the customer; the next staff message was a **proof delivery** ("Here's v5
  of your cards", with a proof link) — Lee 23 Jul, Billy 22 Jul, Paul 21 Jul
- next staff message was an **automated-style follow-up nudge** — Celia 24 Jul
- next staff message was an **order-cancelled notice** — Andrew 21 Jul
- next staff message was the **order-link email** — Chris 21 Jul
- next staff message was a graphics note about a font substitution — Kim 24 Jul
- next staff message was a one-line joke ("Top notch is my middle name.") — Dean 23 Jul

So the headline acceptance rate on the Drafts panel is pessimistic by a meaningful margin,
and the rising `discarded` share partly tracks *proof-delivery volume*, not draft quality.

**Fix (cheap):** exclude replies that are recognisably a different message type before
scoring — a reply containing a `proofs.plasmadesign.co.uk/p/` or `/order/` link where the
draft contained none is almost certainly not an edit of the draft. Better: only match a
staff reply sent within a short window of the draft, and skip when the reply is the first
proof delivery on the thread.

Until that lands, read the acceptance chart as a floor, not a measure.

---

## 2. Proposed house-rule changes

Ranked by weight of evidence. Text is written to paste straight into
**Admin → AI drafts → Briefing**.

### 2.1 Paste the order link, don't promise it — 9 instances

The single strongest pattern in the whole dataset. Rule 34 currently says to write the
reply so the link *follows* ("I will send your order link across shortly") and tell the
reviewer to send it. In practice the team pastes the live URL into that same reply, using
almost the same sentence every time.

> Gavin 15 Jun · Lisa 6 Jul · Jack 10 Jul · Tom 10 Jul · Nikkhil 15 Jul · Awa 16 Jul ·
> Chris 21 Jul · Douglas 22 Jul · Lee 23 Jul

The recurring sentence, near-verbatim across several: *"If you're happy to proceed on this
basis, the order can be placed using the link below."*

**Proposed replacement for rule 34:**

> When the natural next step is an order or payment link, do not invent a URL — the token
> is unguessable. Instead write the reply so the link sits inline at the right point,
> using the house sentence "If you're happy to proceed on this basis, the order can be
> placed using the link below." followed by a `[INSERT ORDER LINK]` gap on its own line.
> Tell the reviewer in the internal note to paste the live order URL there. Do not end the
> reply with a promise to send the link separately — the team sends it in the same message.

### 2.2 Sample dispatch — always leave a gap for the tracking number — 5 instances

Rule 21 covers tracking only for "shipping-status questions where a parcel is already on
its way". It does not cover *confirming a sample is being sent*, which is where the team
adds a tracking number every single time.

> David 12 Jun · Simon 16 Jun · Fenella 22 Jun · Parris 25 Jun · Michelle 19 Jul

**Proposed new rule:**

> When confirming that samples or a sample pack are being posted, include the courier
> tracking number via a `[INSERT DPD TRACKING NUMBER]` gap in the same sentence as the
> dispatch confirmation, and tell the reviewer in the internal note where to find it. Add
> the expected arrival day only if the thread already establishes it.

### 2.3 State the shipping position explicitly on every quote — ~10 instances

Rule 7 says quotes exclude shipping "unless the customer asks". The team says it anyway,
usually as a standalone line, and often with the actual figure.

> Aaron 16 Jun · Matthew 17 Jun · Naz 23 Jun · Laurence 24 Jun · Gregory 24 Jun ·
> Fenella 25 Jun · Steve 1 Jul · James 14 Jul · Jean-Philippe 14 Jul · Molly 23 Jul

**Proposed replacement for rule 7:**

> Every quote must state the shipping position explicitly, even when the customer has not
> asked — a bare figure reads as all-in and causes a follow-up. Use "This quote excludes
> shipping." For a UK mainland delivery you may give the figure: £12.90 inc VAT by DPD,
> next business day (Northern Ireland £18.90 inc VAT). For international destinations, do
> not estimate — say we will confirm the shipping cost, and ask for the delivery address
> so we can quote it.

### 2.4 Link the proof page instead of promising to attach it — ~8 instances

When a proof exists, the team pastes its URL. The draft says "I will attach a copy of your
proof", which is both extra work and slower for the customer. The drafter clearly *can* do
this — it did on Tanem 3 Jul and Aleron 22 Jul — it just isn't consistent.

> Dennitza 16 Jun · Freddy 25 Jun · Sarah 25 Jun · Joe 26 Jun · Nikkhil 27 Jun ·
> Lisa 6 Jul · Aleron 22 Jul

**Proposed new rule:**

> When the thread contains a proof URL (`proofs.plasmadesign.co.uk/p/...`), link it
> directly rather than saying we will attach a copy. Write "The proofs can be viewed by
> clicking the link below" followed by the URL. Only fall back to "I will attach a copy"
> when no proof link exists in the thread.

### 2.5 Cut the second pleasantry — ~9 instances

The most common edit of all is a deletion: the draft opens warmly, then adds a *second*
sentence that restates the customer's own message or editorialises. The team keeps the
first and deletes the second.

Deleted: *"We're really pleased the cards are looking the part."* (Tom 12 Jun) ·
*"These things happen."* (Victoria 26 Jun) · *"and that you would like to go ahead with 100
translucent plastic cards"* (Jessica 22 Jul) · *"We hope the wedding cards turn out
beautifully."* (Nathan 8 Jul) · *"The premium plastic range is a fine starting point for a
clean, modern and executive look."* (Mahendra 7 Jul) · *"and for providing the new details
separately to keep the font consistent"* (Craig 9 Jul) · *"Bespoke, idea-led cards are
exactly the kind of work we enjoy."* (Amit 18 Jun)

This pairs with rule 42 (don't pass judgement on someone's idea) — same instinct, wider
scope.

**Proposed new rule:**

> One opening pleasantry, not two. Acknowledge the customer warmly in a single short
> sentence and move to the substance. Do not add a second sentence that restates what they
> just told you, praises their concept, or speculates about how their project will go.

### 2.6 The single-card / prototype price is per material — not a flat £180 — 3 instances, and it is wrong

Rule 12 hardcodes "£180 inc VAT, covering up to two cards". The live `prototype_prices`
table says otherwise:

| Family | GBP | EUR | USD |
| --- | --- | --- | --- |
| Metal | £179 | €189 | $189 |
| Carbon fibre | £179 | €189 | $189 |
| Acrylic | £89 | €99 | $99 |
| Wood | £59 | €79 | $79 |
| Paper, plastic | not offered | | |

The drafter quoted **£180 for a wood card**; the correct figure is **£59** (Nathan 28 Jun —
the team corrected it and explained the prototyping service). It quoted £180 for metal and
the team sent £170 (Parris 24 Jun); the table says £179. The "covers up to two cards" claim
does not appear in the table at all.

This is the only case in the review where the drafter put a materially wrong price in front
of a customer, so it is the highest-value single fix here.

**Proposed replacement for rule 12:**

> Minimum order is normally 25 cards of a given design for metal, 50 for acrylic and wood,
> 100 for plastic, 250 for standard paper. Where a single card is essential we offer it
> through our prototyping service, priced per material family: metal and carbon fibre £179
> / €189 / $189; acrylic £89 / €99 / $99; wood £59 / €79 / $79. Paper and plastic
> prototypes are not offered. Never quote a single flat prototype price across materials.
> Explain that the cost reflects machine setup and tooling, which are incurred whatever the
> quantity. Mention that the charge is non-refundable ONLY when the customer is treating it
> as a trial ahead of a larger run.

> **Better still:** add `prototype_prices` to the grounding data the drafter reads, the way
> pricing and lead times already are, so the figures can never drift from the admin table
> again. See §5.

### 2.7 Samples are examples from previous work, not the customer's own design — 2 instances

> Parris 24 Jun · Jessica 8 Jul

**Proposed new rule:**

> When offering samples, make clear they are examples of cards produced for previous
> customers rather than a sample of the customer's own design — tooling and machine setup
> make a one-off of their design impractical. Pair it with the digital proof, which is how
> they judge their own artwork.

### 2.8 Two factual corrections that contradict the current briefing

Both are single instances, but each is a flat contradiction of something the briefing
currently asserts, so the drafter will keep repeating them.

**Wood cannot be colour printed** (Faith 24 Jul). The draft offered "printed colour,
etching and laser cut detail on our wood cards"; the team replied "we don't offer colour
printing on our wood cards" and offered etching and laser cut-throughs instead. Martin
21 Jul is the same correction in miniature — draft said the design is "printed" on wood,
team changed it to "laser etched", and added that wood cards are 3mm thick, about four
times a standard plastic card.

> **Proposed new rule:** Wood cards are etched and laser cut, not colour printed — we do
> not offer printing on wood. They are 3mm thick, roughly four times the thickness of a
> standard plastic card, which is worth flagging when a customer is comparing materials.

**We do offer a biodegradable plastic** (Art 26 Jul). The draft said "We don't offer a
biodegradable plastic, and our plastic range isn't something we'd put forward as an eco
option" — which is rule 28 working exactly as written. The team replied that we can do
biodegradable cards, in a 760 micron translucent biodegradable material. Rule 28 is
actively producing a wrong answer and losing an enquiry.

> **Proposed amendment to rule 28:** Eco / sustainable enquiries: recommend wood and
> letterpress (cotton paper) first. We also offer a biodegradable translucent plastic,
> available in 760 micron only — mention it when a customer asks specifically about
> biodegradable or compostable options. Do not position the rest of the plastic or acrylic
> range as a green choice. If a customer mentions "green" ambiguously, judge from context
> whether they mean the colour or sustainability.

### 2.9 Pre-write the discount sentence instead of a bare decision marker — 6 of 9 resolved the same way

Rule 6's `[DECISION: ...]` marker works, but the reviewer nearly always resolves it the
same way, which means they are typing the sentence by hand each time.

Granted at 10%: Jordan 17 Jun · Laurence 24 Jun · Damian 25 Jun · Peter 14 Jul ·
Aleron 22 Jul. Granted at 15%: Jack 29 Jun. Declined or deleted: Jean-Philippe 14 Jul ·
Nikkhil 15 Jul · James 7 Jul (already at 10%, customer pushing further).

**Proposed amendment to rule 6** (keep the first half as-is, replace the marker guidance):

> ...When a customer ASKS about a discount and no note approves one, do not refuse and do
> not grant. Draft the undiscounted figures, then add the goodwill sentence as ready-to-use
> default text inside a marker, so the reviewer's edit is a deletion rather than a
> rewrite — for example: `[DECISION — delete if not approving: As a gesture of goodwill I
> can discount this by 10%, bringing the total to £X.]` Pre-compute the discounted figure.
> Never volunteer a discount where the customer has not raised price.

### 2.10 Two smaller ones

**Production starts at payment, not just proof approval** (David 17 Jul · Lee 13 Jul ·
Gregory 24 Jun · Lisa 6 Jul — the team edits "from proof approval" to "from proof
approval/payment" or "from payment"). Rule 32 predates the self-serve checkout.

> **Proposed amendment to rule 32:** Every order receives a free digital proof to approve
> before production begins, and production is scheduled once the proof is approved and
> payment is complete. When quoting a lead time, count it from proof approval and payment
> rather than approval alone.

**The workshop location is not a secret** (Karen 5 Jul, twice). Rule 16 correctly protects
production arrangements, but it is making the drafter evasive about something the team
says freely: "our workshop is just outside Winchester but we primarily work as an online
studio and send everything out by courier". The draft's flat "we are not set up for
in-person collection" reads colder than the team's answer.

> **Proposed amendment to rule 16:** ...You may say that our workshop is near Winchester
> and that we work as an online studio shipping by courier — that much is public. What
> stays confidential is where or how products are made, what is made in-house versus
> elsewhere, and the names of any production partner or supplier.

---

## 3. Proposed exemplar changes

Only 8 exemplars exist and none has been touched since they were seeded on 13 June. This is
the biggest untouched lever in the briefing.

### 3.1 Exemplar 8 contradicts house rule 40 — fix immediately

Rule 40 says *"Please avoid using the word 'lovely'. It feels out of character."*
Exemplar 8's reply opens **"Lovely to hear from you, and thank you for the kind words about
the cards."** The exemplar is teaching the model to do the thing the rule forbids, and it
is winning: the drafter opened with "Lovely to hear from you" to Nikolas on 16 Jun and the
team changed it to "Great to hear from you".

Worth noting the rule is slightly too blunt — the team happily kept *"a lovely tactile,
engraved finish"* (12 Jun) and *"Lovely to hear the client has settled on the copper"*
(16 Jun). It is the stock greeting that grates, not the word.

- **Change exemplar 8's opening** to "Great to hear from you, and thank you for the kind
  words about the cards."
- **Sharpen rule 40** to: *Do not open a reply with "Lovely to hear from you" or similar —
  use "Great to hear from you" or "Good to hear from you". The word is fine mid-sentence
  when describing a material or finish.*

### 3.2 Three exemplars worth adding

These are the reply shapes the team writes repeatedly and the drafter has never seen.

**A. Order link in the reply** (order_details_collection) — drawn from Douglas 22 Jul,
which is the cleanest example of the pattern in §2.1.

**B. The production update** (order_details_collection) — near-verbatim across George
30 Jun, Meliha 9 Jul and Harry 21 Jul:

> We've now compiled the artwork and created the tooling necessary to produce your order.
> Both have been passed to our manufacturing team and your order is scheduled to leave us
> between [DATES]. We'll send you a further update once they're ready to go!

**C. A price table rather than "see the left of your proof"** (quote_request) — Matthew
17 Jun, Freddy 25 Jun, Paul 20 Jul. The team lays out quantity/total rows in the reply even
when a proof link is also given.

Exact `customer_text` / `reply_text` for all three can be lifted verbatim from those ledger
rows.

---

## 4. Not a briefing problem — catalogue data to fix

These showed up as "corrections" but the drafter was faithfully quoting the catalogue. The
fix is in Admin → Catalogue data, not in the briefing.

**Metal lead times look stale.** `materials.lead_time_updated_at` for every metal is
**13 May 2026** — over two months old. The team keeps overriding the drafter's (correct)
figures, in both directions:

| Material | Catalogue | What the team sent | When |
| --- | --- | --- | --- |
| Gun metal | 13–15 | 11–13 | 24 Jul |
| Matte black | 13–15 | 12–14 | 26 Jun |
| Metal (Fishies order) | 12–14 | 13–15 | 21 Jul |
| Black stainless | 13–15 | 12–14 | 24 Jul |

They are not consistent with each other either, which suggests there is no single agreed
current figure. Worth Rob setting the real numbers once and updating the table.

> Note: the plastics and letterpress figures that look wrong in June/early-July drafts were
> correct at the time — those lead times were updated on 18–19 July. Not a drafter fault.

**Full colour plastic pricing** (Paul 20 Jul): draft quoted £159 / £189 / £269 for
100 / 250 / 500; the team sent £189 / £219 / £329. Worth a spot-check of the
`plastic_full_colour` GBP tiers against the current price list.

**Standard paper MOQ** (Julie 13 Jul): the drafter said 100, the team said 250 in total per
design. Rule 12's MOQ list does not cover paper — folded into the §2.6 rewrite above.

---

## 5. What the miner would need to do this automatically

Nothing here required intelligence the pipeline lacks — it required *joining a draft to its
sent reply and counting*. A Phase 3c miner would be:

1. Pull `ai_drafts` rows with `edit_class IN ('lightly_edited','rewritten')` and both bodies
   present, since the last run.
2. Filter out the mismatches described in §1 before they poison the signal.
3. Group by category and ask a model to name recurring differences across the group, not
   one pair at a time — every pattern above only became visible at n ≥ 2.
4. File each as an `ai_draft_proposals` row with its supporting `evidence` array and
   `recurrence_count`, gated at n ≥ 3 for a rule change and n ≥ 2 for a factual
   contradiction of an existing rule.
5. Leave it pending. The apply RPC already ensures nothing reaches the live briefing until
   an admin clicks Approve.

The one thing worth adding beyond the original design: **grounding for prototype prices**.
§2.6 exists because a figure was hardcoded into a house rule instead of read from the
table it lives in. `public_get_price_list` and `public_get_lead_times` already set the
pattern; a `prototype_prices` equivalent would close the last hardcoded-pricing gap in the
briefing.
