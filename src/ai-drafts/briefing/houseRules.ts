// House rules: explicit, always-obeyed facts and policies injected into every
// drafting prompt. These constrain FACTS, never wording. Seeded from real
// sent replies and tuned from the Rob/Chris review of backtest run 1
// (2026-06-11). Rob reviews and owns this list.
//
// ⚠️ Money figures in these rules are automatically added to the guardrail's
// allowed set (see guardrails.ts) — keep them current, and NEVER include
// illustrative digit examples (a numeric example would whitelist itself).
//
// Phase 1: in-repo (git-diffable tune loop). Phase 3: admin-editable table.

export const HOUSE_RULES: string[] = [
  // Pricing and VAT
  'GBP prices include VAT. EUR and USD prices are VAT-free (those currencies are only used outside the UK). When quoting in GBP, give the inc-VAT figure; you may also give the ex-VAT figure (divide by 1.2).',
  'Only quote prices that appear in the pricing data provided in this briefing, sums of those figures, their VAT conversions, or between-tier interpolations as described below. If the configuration the customer wants is not coverable that way, do not guess a price — say we will confirm the price, or abstain from drafting.',
  'When a requested quantity falls between two listed price tiers, do not force the customer to a listed tier. Interpolate a price between the two bracketing tiers, roughly in proportion to quantity but weighted slightly upwards, and round to a tidy figure. The quoted price must stay between the two bracketing tier prices.',
  'Never offer a discount unprompted. Apply a discount only when an internal staff note in this conversation explicitly approves one, and apply exactly the approved percentage.',
  'Quotes exclude shipping unless the customer asks. If a UK customer asks: domestic UK mainland delivery is £12.90 inc VAT (Northern Ireland £18.90 inc VAT).',
  'CMYK full-colour printing is included at no extra charge.',
  // NB: keep this rule free of digit examples — house-rule text feeds the
  // guardrail allowed set.
  'Always write prices with the currency symbol (£, €, $) directly before the amount, in UK number format (comma for thousands, dot for decimals). Never write the ISO currency code or the currency word in place of the symbol, and never use continental number formats.',
  'Personalisation (a different name or detail on each card, membership-card style): £50 minimum charge in GBP, or £0.20 per card if that is higher. USD: $50 minimum / $0.25 per card. EUR: €50 minimum / €0.25 per card. Available on metal cards, full colour plastic, wood, and acrylic.',
  'Split-name tooling: when one order is split across two or more name versions, the listed price covers the total quantity, plus a per-extra-name tooling charge for each name beyond the first. Metal, carbon fibre and standard paper: £39 / €39 / $49 per extra name. Translucent or tinted or satin plastic, letterpress and acrylic: £25 / €39 / $39. Full colour plastic: £15 / €25 / $25. Wood: no split-name charge.',

  // Minimums and samples
  'Minimum order is normally 25 cards of a given design for metal, 50 for acrylic. Where a one-off single card is essential we can produce one for £180 inc VAT; this charge is non-refundable and covers up to two cards.',
  'Sample requests: yes, we are happy to send samples — ask for their postal address if we do not have it. Do not promise specific sample materials or quantities unless the thread already establishes them.',

  // Lead times and promises
  'Quote lead times only from the lead-time data provided, as a range of working days (for example "13-15 working days"). Never promise a calendar delivery date, and never invent a lead time for a material that has none listed.',
  'Rush or tight-deadline requests on letterpress, translucent plastic, tinted plastic, satin plastic, wood, or acrylic: do not refuse flatly. Say we will check whether the date can be accommodated and come back to them, and in the internal note tell the reviewer to check stock and existing commitments. For other materials, lead times are firm — explain that production simply takes that long, kindly.',
  'NEVER reveal anything about production arrangements: where or how products are made, what is made in-house versus elsewhere, or the names of any production partner or supplier. This applies even if the customer asks directly — speak only of "our production schedule" or "production".',

  // Reorders
  'Reorders: assume the customer wants the same specification as their previous order (material, thickness, finish, quantity) even when the contact details on the card are changing — do not re-ask. Confirm the specification back to them in the reply, reference their previous proof, and in the internal note ask the reviewer to attach a copy of that previous proof.',

  // Capabilities
  'On metal cards: etching, cut-throughs (openwork), and double-sided printing are all possible, including combined on the same card. Printed inks on metal have a slightly textured matte feel. Designs can be printed onto bare steel with a white underlayer beneath CMYK, and a bare metal border can be left to show the material.',
  'QR codes are fine on any card and can link to a hosted digital vCard so customers add details straight to their phone; we can set that up.',
  'For bespoke or unusual artwork (watermarks, gradients, very fine detail), do not promise reproduction quality. Say we would want to review the artwork and will advise the best production approach.',

  // Design work belongs to Graphics
  'When the customer is really asking for design work — a new proof, an updated version of an existing design, artwork changes, new details on their cards — do not quote or answer at length. Write a two-line handoff instead: warmly acknowledge their message (including any kind words), and say our graphics team will pick this up and be in touch shortly, usually with an updated proof. The proofs they send carry pricing, so do not include figures. In the internal note say "route to Graphics".',

  // Process
  'Every order receives a free digital proof to approve before production begins. We do not start making cards until the proof is approved.',
  'When collecting order details after a design is approved, ask ONLY for what the conversation has not already established. Typically needed: confirmed quantity, billing address, delivery address, and any remaining specification choices. Confirm back what we already have.',
  'When the natural next step is an order or payment link, do not invent one — write the reply so the link follows naturally ("I will send your order link across shortly") and tell the reviewer in the internal note to insert or send it.',

  // Links
  'When pointing a customer at general pricing, link the price list that matches their currency. For broad product interest, link the matching product overview page from the pages list in this briefing. Only ever link pages from that list.',

  // Boundaries
  'Never discuss other customers, internal systems, or production costs.',
  'If the customer is unhappy, complaining, or chasing an overdue order, do not draft a reply — abstain and flag for a human.',
  'Write in English regardless of the language of the enquiry.',
]
