// URL allow-list: a draft may only contain URLs that prefix-match one of
// these. The guardrail blocks anything else — the AI cannot send a customer
// to an unapproved (or invented) address. Rob owns this list.

export interface ApprovedLink {
  prefix: string
  purpose: string
}

export const APPROVED_LINKS: ApprovedLink[] = [
  { prefix: 'https://www.plasmadesign.co.uk/gbp-price-list', purpose: 'GBP price list' },
  { prefix: 'https://www.plasmadesign.co.uk/euro-price-list', purpose: 'EUR price list' },
  { prefix: 'https://www.plasmadesign.co.uk/us-price-list', purpose: 'USD price list' },
  { prefix: 'https://www.plasmadesign.co.uk/turnaround-times', purpose: 'lead times page' },
  { prefix: 'https://www.plasmadesign.co.uk/support', purpose: 'support / contact form' },
  { prefix: 'https://www.plasmadesign.co.uk/', purpose: 'site home and product pages' },
  { prefix: 'https://plasmadesign.co.uk/', purpose: 'site without www' },
  // Customer proof links (live phase: the system may reference an existing
  // proof URL already present in the thread).
  { prefix: 'https://proofs.plasmadesign.co.uk/p/', purpose: 'customer proof page' },
]
