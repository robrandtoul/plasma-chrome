# Where the reorder register came from

The Reorder desk (migration `000389`) works off `proofs.reorder_prospects` — a
scored register of 2,758 past customers. This directory is the record of how
those rows were produced.

It exists because, until now, there wasn't one. The register was seeded on
**2026-08-09** by running these scripts ad-hoc against the Xero MCP in a Claude
Code session, and the only copy lived in that session's temp directory. The
database holds the outputs; nothing held the rules. These files were rescued
before that directory was cleaned up.

> **⚠ This is an as-run archive, not a maintained tool.** The logic is
> unchanged from what actually ran — including the three defects below. Its
> value is that it describes what really happened to 2,758 customer records.
> Fixing it in place would make it stop being a record of anything. The only
> edit was replacing a hardcoded temp path with `REGISTER_DATA_DIR`.

## What ran, in order

| # | Stage | Script | In → out |
| --- | --- | --- | --- |
| 1 | Pull invoice **headers** from Xero | *(no script — done conversationally)* | 14 quarterly windows, 1 Apr 2023 → 7 Aug 2026 → `xero-window-*.json`, 4,665 records |
| 2 | Score and enrol | `aggregate.mjs` | headers → `register.json`, `seed-chunks/` |
| 3 | Pull contact **emails** from Xero | *(no script)* | 17 batches → `emails.json` |
| 4 | Merge emails, chunk for insert | `make-seed.mjs` | → `final-seed/` |
| 5 | Pull invoices **with line items** | *(no script)* | same 14 windows → `spec/spec-*.json`, 4,664 records |
| 6 | Compose the "what they last bought" phrase | `aggregate-spec.mjs` | → `spec-seed/` |
| 7 | Insert into `proofs.reorder_prospects` | *(chunked SQL via MCP)* | → live |

**Stages 1, 3 and 5 have no script.** The Xero pulls and their reduction to
those compact record shapes were done conversationally. In particular, the rule
that decided which invoice lines counted as a *product* line — the `n` field
that stage 6 depends on — is written down nowhere. **That is the biggest
reproducibility gap here**, and re-deriving it is the first task for anyone
rebuilding this properly (see `docs/reorder-register-rescrape-spec.md`, Step 0).

## Running them

```bash
REGISTER_DATA_DIR=/path/to/pulls node scripts/reorder-register/aggregate.mjs
```

`REGISTER_AS_AT` overrides the scoring date on `aggregate.mjs` (default
`2026-08-09`, the day live was scored). Recency, cadence and therefore the whole
score are relative to it, so re-running today gives different numbers — which is
correct, and is why `reconcile_reorder_register()` exists.

⚠ **Do not re-run these against live to "refresh" the register.** They emit a
full seed, not an upsert, and they know nothing about desk state — `state`,
`contacted_at`, `proof_id`, `outcome_note`, `suppressed_until`,
`matched_contact_id`. The nightly reconcile is the supported way to keep the
register current.

## The scoring model, in words

`aggregate.mjs` gives each customer a score out of ~90:

- **How often they've bought** — 5+ orders: 30 pts · 3–4: 22 · 2: 15 · 1: 5
- **How long ago** — 6–24 months: 25 pts · 4–6 months: 15 · 24–36 months: 12 ·
  over 36 months: 5. (Under 4 months scores nothing and is suppressed outright.)
- **What they're worth** — £2,000+: 20 pts · £1,000+: 15 · £500+: 10 · £250+: 6 ·
  under: 3
- **Overdue by their own rhythm** — 15 pts when the gap since their last order is
  1–2.5× their usual cadence; 8 pts beyond that. This is the clause that
  actually separates a high score from a middling one.

Two groups are born `suppressed`: anyone who bought in the **last 120 days**
(they're covered by the in-app reorder flow, and the suppression lifts 180 days
after their last order), and anything matching `/atari|joe bloggs|plasmadesign|test/i`
as a test fixture.

## Known defects

All three are real and present in the live data. Two are marked inline at the
exact lines; the fixes are scoped in
`docs/reorder-register-rescrape-spec.md` §6.

**1 — 41 rows paired an old purchase with a new date. FIXED on live by
migration `000406`.**
`aggregate-spec.mjs` filters to single-product invoices *first* and takes the
latest of the survivors, while `last_order_on` comes from the latest invoice
regardless. So a customer whose newest invoice carried two products got a phrase
describing a different, older order. `recognitionLine()` renders that pair as
one sentence, which made it a confident false claim about the customer's own
history. Verified example: Gestion AHD inc. was going to be told *"you last
ordered 100 matte black metal cards (800 micron) in July 2026"*; the July 2026
invoice was 500 foiled paper cards and 50 metal.
Detector: `find-stale-specs.mjs`. **Still present in this script** — a re-run
would reintroduce it.

**2 — 40 rows read "carbon Fibre Cards".**
`leadIn()` lowercases only the first character, so a Title Case Xero item name
keeps its inner capitals. Cosmetic, but it's customer-facing copy. Not fixed.

**3 — 23 rows carry an inflated lifetime value.**
`lifetime_value` sums invoice totals across currencies *without* converting, and
stores the result labelled with the customer's modal currency: £500 + $600
becomes "£1,100". Affects only the 23 contacts who bought in more than one
currency. **The score is not affected** — scoring uses a properly converted
figure — so this is a display defect on the register page, not a queue-ordering
one. Cheap to fix only while the original pull exists.

## What the register does NOT know, and why

**There is no finish anywhere on the register** — no mirror, no brushed, no
natural. The cause is one line in `aggregate-spec.mjs`: it reads the Xero
**item name**, not the line **description**.

```
description  "Gold metal business cards (500 micron with brushed finish)"
item_name    "Gold metal cards (500 micron)"        ← what we stored
```

Four proofs it's the item name: only 63 distinct labels across 4,389 records (a
controlled vocabulary, not free text); a spelling discriminator (Xero INV-25885
has "Matt" in the description and "Matte" in the item name — live says "matte");
the finish discriminator above; and zero live rows containing any finish word or
the description's em-dash shape.

This is why extending the register to answer *"what thickness and finish did
they have last time?"* — the thing that would feed the order builder — is a
**re-scrape reading descriptions**, not a wider date range. See the spec.
