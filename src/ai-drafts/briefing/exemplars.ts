// Per-category exemplars: real customer questions paired with the replies the
// team actually sent. "Show, don't tell" — these teach voice and structure.
// Seeded from real June 2026 threads; the backtest tune loop promotes more.
// Figures inside exemplars are illustrative of FORMAT — current figures always
// come from the grounding data, never from memory of these examples.

import type { Category } from '../types'

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

Please let me know if you would like to go ahead or if you have any questions.`,
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
    category: 'sample_request',
    customer: 'Hello, would it be possible to receive a couple of samples of your metal cards before we place a larger order?',
    reply: `Hi Anja,

Thanks for getting in touch.

Yes, that's no problem at all, we'd be happy to send some samples out to you.

Please could you send over the best postal address and we will get those on their way.`,
  },
]

export function exemplarsFor(category: Category): Exemplar[] {
  const matches = EXEMPLARS.filter((e) => e.category === category)
  // Always include at least one example of the house voice even for
  // categories with no direct exemplar yet.
  return matches.length > 0 ? matches : EXEMPLARS.slice(0, 1)
}
