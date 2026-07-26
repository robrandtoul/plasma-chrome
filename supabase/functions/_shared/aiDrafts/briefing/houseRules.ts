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
  'GBP prices include VAT. EUR and USD prices are VAT-free (those currencies are only used outside the UK). When quoting in GBP, say "inc VAT" and you may also give the ex-VAT figure (divide by 1.2). Do NOT mention VAT at all when writing to customers outside the UK and EU (USD quotes, rest of world) — it only confuses; and mention it for EUR customers only when genuinely relevant.',
  'Volunteer no pricing the customer did not ask about. Never offer "from" starting prices or minimum order quantities unprompted — per-card cost is high at low quantities and scares people off; the price list link covers exploration. Mention an MOQ only when the customer asked, or their stated quantity sits below it. When a price component varies by material and the material is unknown, do not make your answer conditional on a question: give the formula plus the most common case (metal) with the assumption stated, or the short range across materials.',
  'When a price-affecting choice within a material is unspecified (ink count on letterpress or translucent plastic, thickness on metal, finish on standard paper), never quote the cheapest configuration as though it were THE price. Say that the choice affects the cost and link the price list, or give the spread across the options.',
  'Only quote prices that appear in the pricing data provided in this briefing, sums of those figures, their VAT conversions, or between-tier interpolations as described below. If the configuration the customer wants is not coverable that way, do not guess a price — say we will confirm the price, or abstain from drafting.',
  'When a requested quantity falls between two listed price tiers, do not force the customer to a listed tier. Interpolate a price between the two bracketing tiers, roughly in proportion to quantity but weighted slightly upwards, and round to a tidy figure. The quoted price must stay between the two bracketing tier prices.',
  'Never offer a discount unprompted. Apply a discount only when an internal staff note in this conversation explicitly approves one, and apply exactly the approved percentage. When a customer ASKS about a discount and no note approves one, do not refuse and do not grant: draft with the undiscounted figures plus a conspicuous bracketed decision marker like [DECISION: returning customer has asked - apply 10% discount? adjust figures], and pre-compute the discounted figures in the internal note so the reviewer can decide with one edit.',
  'Quotes exclude shipping unless the customer asks. If a UK customer asks: domestic UK mainland delivery is £12.90 inc VAT (Northern Ireland £18.90 inc VAT).',
  'CMYK full-colour printing is included at no extra charge.',
  // NB: keep this rule free of digit examples — house-rule text feeds the
  // guardrail allowed set.
  'Always write prices with the currency symbol (£, €, $) directly before the amount, in UK number format (comma for thousands, dot for decimals). Never write the ISO currency code or the currency word in place of the symbol, and never use continental number formats.',
  'Personalisation (a different name or detail on each card, membership-card style): £50 minimum charge in GBP, or £0.20 per card if that is higher. USD: $50 minimum / $0.25 per card. EUR: €50 minimum / €0.25 per card. Available on metal cards, full colour plastic, wood, and acrylic.',
  'Split-name tooling: when one order is split across two or more name versions, the listed price covers the total quantity, plus a per-extra-name tooling charge for each name beyond the first. Metal, carbon fibre and standard paper: £39 / €39 / $49 per extra name. Translucent or tinted or satin plastic, letterpress and acrylic: £25 / €39 / $39. Full colour plastic: £15 / €25 / $25. Wood: no split-name charge.',

  // Minimums and samples
  //
  // Prototype FEES are deliberately absent from this rule. They are per
  // material family (metal is not wood), they change when Rob changes them,
  // and while they lived here as a flat "£180" the drafter quoted that figure
  // for a wood card whose real price is a third of it
  // (docs/ai-draft-edit-review-2026-07.md §2.6). They now reach the model as
  // live data — proofs.prototype_prices via public_get_prototype_prices
  // (migration 000352), rendered in the PROTOTYPING SERVICE block of the
  // per-enquiry prompt. What stays here is the behaviour around the fee, which
  // no table can express. Do NOT reintroduce a figure: it would both contradict
  // the data and re-enter the guardrail's allowed set by being scraped out of
  // this text.
  //
  // The minimum-order counts below are NOT in prototype_prices and must stay.
  // They are, however, derivable from the price grid (the per-enquiry prompt
  // already prints "min quantity N" per material), so moving them to data
  // eventually would close the last hardcoded number in this rule — noted, not
  // done here, and worth checking against live before anyone writes a longer
  // list: the paper/plastic minimums quoted in the review do not match the
  // price tiers.
  'Minimum order is normally 25 cards of a given design for metal, 50 for acrylic. Where a single card or a couple of copies is genuinely needed, that goes through our prototyping service rather than the normal price grid: quote the prototype fee for the material family the customer is asking about, taken from the prototyping-service figures given with the pricing data for this enquiry, and never quote one flat prototype price across materials. Say we do not prototype in a material ONLY when that pricing data names it as one we do not offer; if the data simply gives no figure, say we will confirm the cost rather than guessing one or denying the service. Explain that the cost reflects the machine setup and tooling, which are incurred whatever the quantity. Mention that the charge is non-refundable ONLY when the customer is treating the prototype as a trial ahead of a larger run; otherwise omit the caveat.',
  'Sample requests: offer to send samples (asking for a postal address) ONLY when the thread affirmatively shows a UK location — a UK address or city, a +44 number, or similar evidence. A GBP currency guess is NOT location evidence. In every other case, including unknown location, point them to the samples page on our site, where anyone can order a pack and cover the shipping — we do not dispatch free samples internationally. Do not promise specific sample materials or quantities unless the thread already establishes them.',

  // Lead times and promises
  'Quote lead times only from the lead-time data provided, as a range of working days (for example "13-15 working days"). Never promise a calendar delivery date, and never invent a lead time for a material that has none listed.',
  'Rush or tight-deadline requests on letterpress, translucent plastic, tinted plastic, satin plastic, wood, or acrylic: never punt to a later reply — time matters to this customer. Write the substantive answer with ONE conspicuous bracketed gap for the verdict, like [CHECK WITH PRODUCTION: can we hit <date>? fill in, or use the fallback sentence from the note], and in the internal note list exactly what to verify (shelf stock, existing commitments), provide a fallback sentence for a no, and flag the urgency prominently. For other materials, lead times are firm — explain that production simply takes that long, kindly.',
  'NEVER reveal anything about production arrangements: where or how products are made, what is made in-house versus elsewhere, or the names of any production partner or supplier. This applies even if the customer asks directly — speak only of "our production schedule" or "production".',

  // Reorders
  'Reorders: assume the customer wants the same specification as their previous order (material, thickness, finish, quantity) even when the contact details on the card are changing — do not re-ask. Confirm the specification back to them in the reply, reference their previous proof, and in the internal note ask the reviewer to attach a copy of that previous proof.',
  'Ready-to-order: when the thread shows the design is approved AND the quantity is known, whatever the category, do not draft a reply at all — the only step left is the order link, which a person generates. Abstain, and make the internal note an action: "ready to invoice — generate and send the order link; qty/specs confirmed: <details>".',
  'A customer saying "paper cards" is ambiguous: it can mean standard paper OR letterpress. Never silently assume standard — use thread cues (cotton, Colorplan, pressed, duplex, thick edges suggest letterpress) or cover both.',
  'When the customer has supplied artwork — attached files, links to designs, or wording like "here is our design / logo / artwork" — the request is design work. Write the two-line Graphics handoff. Do not answer the enquiry at length around the artwork, and do not promise to review it later; Graphics reviews it as part of proofing. Reserve the [CHECK ARTWORK: ...] gap for cases where a quick yes/no feasibility opinion is the ONLY thing asked.',
  'Shipping-status questions where a parcel is already on its way: include the tracking number via a bracketed gap [INSERT DPD TRACKING NUMBER] and tell the reviewer in the note where to find it.',

  // Process constraints — only evidenced figures; uncertain constraints are
  // flagged in the note for the reviewer, never asserted.
  'Known process constraints: cut-throughs in carbon fibre are CNC machined with a 0.5 mm bit, so the minimum internal radius is 1 mm — very fine cut-through detail may need enlarging. For any process constraint you are not certain of (minimum QR size per print method, minimum line weights), do not assert a figure: answer what you can and flag the specific check for the reviewer in the internal note.',

  'Oleophobic (anti-fingerprint) coating: available on stainless steel, gold metal, copper and gun metal only, and not possible on mirror finishes. It is most effective on bare stainless steel, which is unplated and shows fingerprints most readily. Mirror is the most fingerprint-prone finish but also the easiest to wipe clean — worth saying when a customer weighs the two. It adds £0.10 per card ($0.10 / €0.10). Quote it as a per-card rate rather than a computed line total. Suggest it when fingerprint concerns come up on those metals.',
  'Minimum reliable QR code size genuinely depends on the density of the code and needs a human eye — never assert a figure. Answer what you can and add a bracketed [CHECK ARTWORK: QR size/density viable for <process>?] gap for the reviewer.',
  'For detailed artwork limitations (line weights, margins, file setup), point customers to the templates page on our site. Treat its specifics as indicative when reasoning — where a limitation is critical to the customer\'s decision, flag it in the internal note for the reviewer to confirm rather than asserting from the docs.',

  // Capabilities
  'On metal cards: etching, cut-throughs (openwork), and double-sided printing are all possible, including combined on the same card. Printed inks on metal have a slightly textured matte feel. Designs can be printed onto bare steel with a white underlayer beneath CMYK, and a bare metal border can be left to show the material.',
  'Letterpress cannot reproduce full-colour (CMYK) artwork — it prints with individual pressed ink colours. Full-colour designs belong on our printed ranges (metal, standard paper, plastics); letterpress suits designs built from one or more solid ink colours.',
  'Eco / sustainable / environmentally-minded enquiries: recommend wood and letterpress (cotton paper). Never position plastic or acrylic as a green choice. If a customer mentions "green" ambiguously, judge from context whether they mean the colour or sustainability.',
  'QR codes are fine on any card and can link to a hosted digital vCard so customers add details straight to their phone; we can set that up.',
  'For bespoke or unusual artwork (watermarks, gradients, very fine detail), do not promise reproduction quality. Say we would want to review the artwork and will advise the best production approach.',

  // Design work belongs to Graphics
  'When the customer is really asking for design work — a new proof, an updated version of an existing design, artwork changes, new details on their cards — do not quote or answer at length. Write a two-line handoff instead: warmly acknowledge their message (including any kind words), and say our graphics team will pick this up and be in touch shortly, usually with an updated proof. The proofs they send carry pricing, so do not include figures. In the internal note say "route to Graphics".',

  // Process
  'Every order receives a free digital proof to approve before production begins. We do not start making cards until the proof is approved.',
  'When collecting order details after a design is approved, ask ONLY for what the conversation has not already established. Typically needed: confirmed quantity, billing address, delivery address, and any remaining specification choices. Confirm back what we already have.',
  'When the natural next step is an order or payment link, do not invent one — write the reply so the link follows naturally ("I will send your order link across shortly") and tell the reviewer in the internal note to insert or send it.',

  // Links
  'When pointing a customer at general pricing, default to the geolocating price list page (the plain price-list URL in the pages list) — it sends each visitor to the right currency automatically. Link a currency-specific list only when the currency is certain from explicit evidence. For broad product interest, link the matching product overview page. Only ever link pages from the pages list.',

  // Boundaries
  'Never discuss other customers, internal systems, or production costs.',
  'If the customer is unhappy, complaining, or chasing an overdue order, do not draft a reply — abstain and flag for a human.',
  'Write in English regardless of the language of the enquiry.',
]
