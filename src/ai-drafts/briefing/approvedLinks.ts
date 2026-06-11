// URL allow-list: a draft may only contain URLs that prefix-match one of
// these. The guardrail blocks anything else — the AI cannot send a customer
// to an unapproved (or invented) address. Rob owns this list.

export interface ApprovedLink {
  prefix: string
  purpose: string
  // echoOnly: the prefix alone is not enough — the exact URL must already
  // appear in the inbound thread. Stops the model fabricating plausible
  // per-customer URLs (e.g. proof links) under an approved prefix.
  echoOnly?: boolean
}

export const APPROVED_LINKS: ApprovedLink[] = [
  { prefix: 'https://www.plasmadesign.co.uk/gbp-price-list', purpose: 'GBP price list' },
  { prefix: 'https://www.plasmadesign.co.uk/euro-price-list', purpose: 'EUR price list' },
  { prefix: 'https://www.plasmadesign.co.uk/us-price-list', purpose: 'USD price list' },
  { prefix: 'https://www.plasmadesign.co.uk/turnaround-times', purpose: 'lead times page' },
  { prefix: 'https://www.plasmadesign.co.uk/support', purpose: 'support / contact form' },
  { prefix: 'https://www.plasmadesign.co.uk/', purpose: 'site home and product pages' },
  { prefix: 'https://plasmadesign.co.uk/', purpose: 'site without www' },
  // Customer proof links: only echoable — the exact URL must already exist
  // in the thread; the model cannot mint one.
  { prefix: 'https://proofs.plasmadesign.co.uk/p/', purpose: 'customer proof page', echoOnly: true },
]
