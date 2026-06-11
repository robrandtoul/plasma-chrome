// Per-category exemplars: real customer questions paired with the replies the
// team actually sent (lightly edited where the review set a new convention).
// "Show, don't tell" — these teach voice and structure. Figures inside
// exemplars are illustrative of FORMAT — current figures always come from the
// grounding data, never from memory of these examples.
//
// Cycle 1 additions (Rob/Chris review, 2026-06-11): Vincent (explain the why),
// Lisa (reorder playbook), Aidan (route-to-Graphics handoff).

import type { Category } from '../types.ts'

export interface Exemplar {
  category: Category
  customer: string
  reply: string
}

export const EXEMPLARS: Exemplar[] = [
  {
    category: 'quote_request',
    customer:
      'Hi, I was wondering if we are able to get 20 cards for VIP Cards for our pub. However, they will all be different due to individual names on them all. Are you able to do this? If so, how much is it for either Acrylic or Gold Metal Cards? Thanks.',
    reply: `Hi Mia,

Yes, we can produce personalised VIP cards with individual names on each card.

For acrylic cards, our minimum order quantity is 50. However, for gold metal cards our MOQ is 25, which is closer to your requested quantity.

For our mid-thickness metal cards in natural gold, the pricing would be:

25 Gold Metal Cards, 500 micron with natural finish: £279
Personalisation: £50

Total: £329 inc VAT
£274.17 ex VAT

This quote excludes shipping.

We are currently quoting around 13-15 business days for gold metal cards.

Please let me know if any further information would help.`,
  },
  {
    // Real reply, kept because it explains the WHY behind an artwork
    // adjustment (CNC bit radius) — the house style for recommendations.
    category: 'quote_request',
    customer: 'I am curious about incorporating my card designs onto carbon fibre and the costs associated.',
    reply: `Hi Vincent,

Thanks very much for your message. It's great to hear from you.

We'd be happy to work on a batch of carbon fibre cards for you.

When we produced your metal cards before, the cut through details were created using a chemical milling process. Carbon fibre needs a different method. To create cut throughs in CF we use CNC with a 0.5 mm bit, which means the minimum internal radius we can achieve is 1 mm.

To work within that limit, we have made adjustments to the artwork. The cut through text has been increased in size so that it can be machined cleanly. I have attached proofs for the front and back of the carbon fibre card so you can see how this translates in practice. Pricing for various quantities can be found on the left side of these proofs.

I look forward to hearing your thoughts. Very happy to adjust things to your preference.`,
  },
  {
    // Real reply: the reorder playbook — assume same specs, confirm them
    // back, reference the previous proof, no re-asking, momentum preserved.
    category: 'quote_request',
    customer:
      "Hi there, I'd like to get a quote for placing another order for metal business cards, please. It'll be the same Galt Strategies design from the past, just a new name & contact. Will you please send over the cost breakdown + shipping expectations?",
    reply: `Hi Lisa,

Happy to help with a new set of the Galt Strategies metal cards.

I'll attach a copy of the proof from the last order dated November 2024. Pricing for the different quantities is shown on the left side of that document. For reference, your previous batches were produced in 500 micron steel with a natural surface finish.

Current turnaround time is 11 to 13 business days.

Please feel free to send through the details for the new colleague. Once we have their name and contact information, we'll revise the artwork and send a fresh proof for approval.`,
  },
  {
    category: 'capability_question',
    customer:
      'Could you please let me know whether it is possible to have both cut-out (openwork) sections and engraved elements on the same card? I would also like to know if double-sided printing or engraving is available.',
    reply: `Hi,

Thanks for getting in touch. I can confirm that all the methods you have outlined are possible on the same card.

- Etching
- Cut-throughs
- Printing (double sided)

I hope this info helps. Please feel free to reply with any questions.`,
  },
  {
    category: 'capability_question',
    customer: 'Can you print onto your Metal Black Business cards? I have attached some designs we would like to recreate.',
    reply: `Hi Chloe,

Thanks for sending the images over.

Yes, we can recreate these quite closely. For this type of design, we would suggest producing them onto bare stainless steel, printing a white layer down first, then printing the CMYK full colour design on top. The printed inks have a slightly textured/matte feel.

We can also leave a steel border around the edge of the card if they would like to show off the metal properties a little more.

QR codes are absolutely fine too, and can be used to link to a digital vCard so customers can add the details directly to their phone. We can take care of setting this up if that's easier.

Due to the setup costs involved, we typically don't produce fewer than 25 cards of a given design. However, in cases where a one-off sample or single card is essential, we can produce one for £180 including VAT. Please note this charge is non-refundable. This would cover two cards if required.

I hope this information is helpful. Please don't hesitate to come back to me with any further questions.`,
  },
  {
    // UK evidence in-thread -> free dispatch. Contrast with the next example.
    category: 'sample_request',
    customer:
      'Hello, would it be possible to receive a couple of samples of your metal cards before we place a larger order? We are based in Manchester.',
    reply: `Hi Anja,

Thanks for getting in touch.

Yes, that's no problem at all, we'd be happy to send some samples out to you.

Please could you send over the best postal address and we will get those on their way.`,
  },
  {
    // No UK evidence (or clearly international) -> the samples page, where
    // anyone can order a pack and cover the shipping.
    category: 'sample_request',
    customer:
      'I am considering your cards for my business and would love to see the quality in person before ordering. Do you offer samples?',
    reply: `Hi Preston,

Thanks for getting in touch, and happy to help with that.

The easiest route is to order a sample pack through our site, so it ships straight to you: https://www.plasmadesign.co.uk/order-samples

Please let me know if any further information would help while you compare the options.`,
  },
  {
    // The route-to-Graphics handoff: design work is acknowledged warmly in
    // two lines, never quoted — the proof carries pricing.
    category: 'artwork',
    customer:
      "Hi Jack, hope you're well! We haven't spoken since my last order but I was hoping you could provide a quote for 100 white and 100 blue cards with a few minor tweaks. I'd like to add my name, position, and landline to the cards. The feedback I've had so far has been nothing short of WOW.",
    reply: `Hi Aidan,

Lovely to hear from you, and thank you for the kind words about the cards.

I'm handing this over to our graphics team now — they'll update the design with your name, position and landline and be in touch shortly with a fresh proof, which will include pricing for the quantities.`,
  },
]

export function exemplarsFor(category: Category): Exemplar[] {
  const matches = EXEMPLARS.filter((e) => e.category === category)
  // Always include at least one example of the house voice even for
  // categories with no direct exemplar yet.
  return matches.length > 0 ? matches : EXEMPLARS.slice(0, 1)
}
