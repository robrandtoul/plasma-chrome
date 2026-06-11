// URL allow-list: a draft may only contain URLs that match one of these.
// The guardrail blocks anything else — the AI cannot send a customer to an
// unapproved (or invented) address. Built from the curated SITE_PAGES list
// plus a handful of statics; there is deliberately NO domain-wide prefix, so
// a plausible-but-invented page slug blocks instead of 404ing on a customer
// (review item 11/13). Rob owns this list via sitePages.ts.

import { SITE_PAGES } from './sitePages.ts'

export interface ApprovedLink {
  prefix: string
  purpose: string
  // exact: URL must equal the prefix (trailing slash ignored) rather than
  // merely start with it. Used for the homepage, where prefix matching would
  // re-open the whole domain.
  match?: 'prefix' | 'exact'
  // echoOnly: the exact URL must already appear in the inbound thread. Stops
  // the model fabricating plausible per-customer URLs (e.g. proof links).
  echoOnly?: boolean
}

export const APPROVED_LINKS: ApprovedLink[] = [
  { prefix: 'https://www.plasmadesign.co.uk', purpose: 'site home', match: 'exact' },
  ...SITE_PAGES.map((p) => ({ prefix: p.url, purpose: p.purpose })),
  // Customer proof links: only echoable — the exact URL must already exist
  // in the thread; the model cannot mint one.
  { prefix: 'https://proofs.plasmadesign.co.uk/p/', purpose: 'customer proof page', echoOnly: true },
]
