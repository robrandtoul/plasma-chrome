-- 000394: only keep a last-order phrase that is plausibly a card purchase.
--
-- 000393 stored what a past customer last bought, guarded only by "the source
-- invoice had exactly one product line". That rule is about AMBIGUITY (several
-- colourways flattened into one figure) and says nothing about what KIND of
-- thing the single line is. An adversarial review of the seeded data found
-- three ways that lets a false sentence reach a customer:
--
--   * An agreed-price order books ONE product line with Qty 1, because Xero
--     derives a per-unit price from Qty and a lump sum has no honest per-unit
--     figure (see _shared/invoiceBuild.ts). The real card count survives only
--     in the description, so the phrase came out as "1 stainless steel card".
--   * Prototypes and samples are genuine single lines of one or two units.
--   * Some invoices book a summary line — "1 order ORD-AF95F31904" — which is
--     an internal reference, not a product, and meaningless to the customer.
--   * Letterheads, flyers and card wallets are real products, but this desk
--     re-approaches people about CARDS: "you last ordered 1,000 letterheads"
--     above business-card artwork misdescribes the visit.
--
-- Two plausibility rules, applied here and documented for any future
-- enrichment run:
--   1. The phrase must name a card. Everything in the card catalogue reads
--      "… cards (…)", so requiring the word excludes stationery, accessories
--      and summary lines in one test.
--   2. The count must be at least 25 — the smallest quantity that appears in
--      any price tier. Below that it is a sample, a prototype, or a lump sum
--      whose quantity column was never the card count.
--
-- Anything failing either rule becomes NULL, and the band falls back to the
-- date-only sentence, which is always true.

update proofs.reorder_prospects
set last_spec = null,
    updated_at = now()
where last_spec is not null
  and (
    last_spec !~* 'card'
    or last_spec !~ '^[0-9,]+ '
    or replace(split_part(last_spec, ' ', 1), ',', '')::numeric < 25
  );
