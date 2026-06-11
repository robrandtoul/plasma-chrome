// Curated list of real marketing-site pages the model may link, with a
// one-line purpose so it links the RIGHT page. Doubles as the URL gate's
// allow-list source: any plasmadesign.co.uk URL not on this list blocks, so
// an invented-but-plausible slug can never 404 on a customer.
// Source: live sitemap, curated 2026-06-11 (review item 11/13).

export interface SitePage {
  url: string
  purpose: string
}

export const SITE_PAGES: SitePage[] = [
  // Pricing and process
  { url: 'https://www.plasmadesign.co.uk/price-list', purpose: 'price list (geolocating — sends the visitor to their currency page; the DEFAULT pricing link)' },
  { url: 'https://www.plasmadesign.co.uk/gbp-price-list', purpose: 'GBP price list (only when deliberately targeting GBP)' },
  { url: 'https://www.plasmadesign.co.uk/euro-price-list', purpose: 'EUR price list' },
  { url: 'https://www.plasmadesign.co.uk/us-price-list', purpose: 'USD price list' },
  { url: 'https://www.plasmadesign.co.uk/turnaround-times', purpose: 'current lead times' },
  { url: 'https://www.plasmadesign.co.uk/shipping-and-delivery', purpose: 'shipping and delivery info' },
  { url: 'https://www.plasmadesign.co.uk/how-do-i-get-started', purpose: 'how the ordering process works' },
  { url: 'https://www.plasmadesign.co.uk/frequently-asked-questions', purpose: 'FAQ' },
  { url: 'https://www.plasmadesign.co.uk/order-samples', purpose: 'order a sample pack' },
  { url: 'https://www.plasmadesign.co.uk/templates', purpose: 'artwork templates' },
  { url: 'https://www.plasmadesign.co.uk/support', purpose: 'support / contact form' },

  // Product overview pages
  { url: 'https://www.plasmadesign.co.uk/metal-business-cards', purpose: 'metal cards overview (whole range)' },
  { url: 'https://www.plasmadesign.co.uk/gold-metal-business-cards', purpose: 'gold metal cards' },
  { url: 'https://www.plasmadesign.co.uk/black-metal-cards', purpose: 'matte black metal cards' },
  { url: 'https://www.plasmadesign.co.uk/white-metal-cards', purpose: 'matte white metal cards' },
  { url: 'https://www.plasmadesign.co.uk/gunmetal-business-cards', purpose: 'gun metal cards' },
  { url: 'https://www.plasmadesign.co.uk/copper-business-cards', purpose: 'copper cards' },
  { url: 'https://www.plasmadesign.co.uk/mini-metal-cards', purpose: 'mini metal cards' },
  { url: 'https://www.plasmadesign.co.uk/carbon-fibre-cards', purpose: 'carbon fibre cards' },
  { url: 'https://www.plasmadesign.co.uk/letterpress-business-cards', purpose: 'letterpress cards' },
  { url: 'https://www.plasmadesign.co.uk/standard-cards', purpose: 'standard paper cards' },
  { url: 'https://www.plasmadesign.co.uk/translucent-plastic-cards', purpose: 'translucent plastic cards' },
  { url: 'https://www.plasmadesign.co.uk/tinted-translucent-cards', purpose: 'tinted translucent cards' },
  { url: 'https://www.plasmadesign.co.uk/satin-plastic-cards', purpose: 'satin plastic cards' },
  { url: 'https://www.plasmadesign.co.uk/full-colour-plastic-cards', purpose: 'full colour plastic cards' },
  { url: 'https://www.plasmadesign.co.uk/plastic-business-cards', purpose: 'plastic cards overview' },
  { url: 'https://www.plasmadesign.co.uk/wood-business-cards', purpose: 'wood cards' },
  { url: 'https://www.plasmadesign.co.uk/acrylic-business-cards', purpose: 'acrylic cards' },
  { url: 'https://www.plasmadesign.co.uk/perspex-cards', purpose: 'perspex cards' },
  { url: 'https://www.plasmadesign.co.uk/card-holders', purpose: 'card holders' },
  { url: 'https://www.plasmadesign.co.uk/card-accessories', purpose: 'card accessories' },

  // Galleries and social proof
  { url: 'https://www.plasmadesign.co.uk/portfolio', purpose: 'portfolio of past work' },
  { url: 'https://www.plasmadesign.co.uk/black-metal-card-gallery', purpose: 'matte black gallery' },
  { url: 'https://www.plasmadesign.co.uk/gold-metal-card-gallery', purpose: 'gold gallery' },
  { url: 'https://www.plasmadesign.co.uk/carbon-fibre-card-gallery', purpose: 'carbon fibre gallery' },
  { url: 'https://www.plasmadesign.co.uk/letterpress-gallery', purpose: 'letterpress gallery' },
  { url: 'https://www.plasmadesign.co.uk/wood-card-gallery', purpose: 'wood gallery' },
  { url: 'https://www.plasmadesign.co.uk/testimonials', purpose: 'customer testimonials' },

  // Reference
  { url: 'https://www.plasmadesign.co.uk/ink-swatches', purpose: 'ink colour swatches' },
  { url: 'https://www.plasmadesign.co.uk/paper-swatches', purpose: 'paper swatches (letterpress stocks)' },
  { url: 'https://www.plasmadesign.co.uk/perspex-swatches', purpose: 'perspex colour swatches' },
  { url: 'https://www.plasmadesign.co.uk/terms-of-sale', purpose: 'terms of sale' },
]
