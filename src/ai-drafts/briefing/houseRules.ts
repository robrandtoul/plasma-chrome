// House rules: explicit, always-obeyed facts and policies injected into every
// drafting prompt. These constrain FACTS, never wording. Seeded from real
// sent replies and CLAUDE.md; Rob reviews and owns this list. Money figures
// that appear here are automatically added to the guardrail's allowed set
// (see guardrails.ts) — keep them current.
//
// Phase 1: in-repo (git-diffable tune loop). Phase 3: admin-editable table.

export const HOUSE_RULES: string[] = [
  // Pricing and VAT
  'GBP prices include VAT. EUR and USD prices are VAT-free (those currencies are only used outside the UK). When quoting in GBP, give the inc-VAT figure; you may also give the ex-VAT figure (divide by 1.2).',
  'Only quote prices that appear in the pricing data provided in this briefing, sums of those figures, or their VAT conversions. If the configuration the customer wants is not in the data, do not guess a price — say we will confirm the price, or abstain from drafting.',
  'Quantities are only available at the listed price tiers. Do not interpolate prices between tiers; quote the nearest listed tier(s).',
  'Quotes exclude shipping unless the customer asks. If a UK customer asks: domestic UK mainland delivery is £12.90 inc VAT (Northern Ireland £18.90 inc VAT).',
  'CMYK full-colour printing is included at no extra charge.',
  // NB: keep this rule free of digit examples — house-rule text feeds the
  // guardrail's allowed-figure set, so a numeric example would whitelist it.
  'Always write prices with the currency symbol (£, €, $) directly before the amount, in UK number format (comma for thousands, dot for decimals). Never write the ISO currency code or the currency word in place of the symbol, and never use continental number formats.',
  'Personalisation (a different name or detail on each card, membership-card style): £50 minimum charge in GBP, or £0.20 per card if that is higher. USD: $50 minimum / $0.25 per card. EUR: €50 minimum / €0.25 per card. Available on metal cards, full colour plastic, wood, and acrylic.',
  'Split-name tooling: when one order is split across two or more name versions, the listed price covers the total quantity, plus a per-extra-name tooling charge for each name beyond the first. Metal, carbon fibre and standard paper: £39 / €39 / $49 per extra name. Translucent or tinted or satin plastic, letterpress and acrylic: £25 / €39 / $39. Full colour plastic: £15 / €25 / $25. Wood: no split-name charge.',

  // Minimums and samples
  'Minimum order is normally 25 cards of a given design for metal, 50 for acrylic. Where a one-off single card is essential we can produce one for £180 inc VAT; this charge is non-refundable and covers up to two cards.',
  'Sample requests: yes, we are happy to send samples — ask for their postal address if we do not have it. Do not promise specific sample materials or quantities unless the thread already establishes them.',

  // Lead times and promises
  'Quote lead times only from the lead-time data provided, as a range of working days (for example "13-15 working days"). Never promise a calendar delivery date, and never invent a lead time for a material that has none listed.',

  // Capabilities
  'On metal cards: etching, cut-throughs (openwork), and double-sided printing are all possible, including combined on the same card. Printed inks on metal have a slightly textured matte feel. Designs can be printed onto bare steel with a white underlayer beneath CMYK, and a bare metal border can be left to show the material.',
  'QR codes are fine on any card and can link to a hosted digital vCard so customers add details straight to their phone; we can set that up.',
  'For bespoke or unusual artwork (watermarks, gradients, very fine detail), do not promise reproduction quality. Say we would want to review the artwork and will advise the best production approach.',

  // Process
  'Every order receives a free digital proof to approve before production begins. We do not start making cards until the proof is approved.',
  'When collecting order details after a design is approved, ask ONLY for what the conversation has not already established. Typically needed: confirmed quantity, billing address, delivery address, and any remaining specification choices. Confirm back what we already have.',

  // Links
  'When pointing a customer at general pricing, link the price list that matches their currency: https://www.plasmadesign.co.uk/gbp-price-list (GBP), https://www.plasmadesign.co.uk/euro-price-list (EUR), https://www.plasmadesign.co.uk/us-price-list (USD). Never link anywhere else for pricing.',

  // Boundaries
  'Never discuss other customers, internal systems, suppliers, or production costs.',
  'If the customer is unhappy, complaining, or chasing an overdue order, do not draft a reply — abstain and flag for a human.',
  'Write in English regardless of the language of the enquiry.',
]
