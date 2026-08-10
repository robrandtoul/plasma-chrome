// Admin feature search — the registry of admin destinations plus the fuzzy
// matcher behind the "Search admin…" palette (src/components/AdminSearch.tsx).
//
// Deliberately pure: no React, no lucide, no router. That keeps it unit-
// testable with tsx (see adminSearch.test.ts) and lets both the sidebar
// (AdminLayout) and the palette import the same list, so the two can never
// drift. Icons are looked up separately by key in src/pages/admin/adminIcons.ts.
//
// The whole point of the fuzzy matcher is that a designer shouldn't need the
// exact feature name: partial words ("cust"→Customers), abbreviations /
// subsequences ("leadt"→Lead times), typos ("analitics"→Analytics), and plain-
// English synonyms ("email templates"→Messages, "reminders"→Follow-ups) all
// find the right page. Synonyms live in each destination's `keywords`; the rest
// is handled by scoreTokenInString below.
//
// House rule (mirrors the admin nav cleanup): when a new admin page or a new
// deep-linkable section is added, add a destination here. A new sidebar tab
// also sets `sidebar: true` so the nav picks it up from the same list.

export type AdminGroupLabel =
  | 'Performance'
  | 'Customers & orders'
  | 'Messaging & automation'
  | 'Catalogue'
  | 'System'

export interface AdminDestination {
  /** Stable id — used as the React key and in tests. */
  id: string
  /** The name shown in results and (for sidebar tabs) in the nav. */
  label: string
  /** Router path. May carry a #hash to land on a Settings section. */
  path: string
  /** Which sidebar group this belongs to — also the results breadcrumb. */
  group: AdminGroupLabel
  /** Key into ADMIN_ICONS (src/pages/admin/adminIcons.ts). */
  icon: string
  /** Synonyms / related terms so search finds it without the exact name. */
  keywords?: string[]
  /** One-line description shown under the label in results. */
  description?: string
  /** True for the destinations that render as top-level sidebar tabs. */
  sidebar?: boolean
}

// ── The registry ──────────────────────────────────────────────────────────────
// Authored in sidebar order (group by group) so ADMIN_NAV_GROUPS below can be
// derived by a single pass, and so equal-scoring results tie-break sensibly.
export const ADMIN_DESTINATIONS: AdminDestination[] = [
  // ── Performance ──
  {
    id: 'analytics',
    label: 'Analytics',
    path: '/admin/analytics',
    group: 'Performance',
    icon: 'analytics',
    sidebar: true,
    keywords: ['reports', 'conversion', 'funnel', 'stats', 'insights', 'metrics', 'performance', 'hot leads', 'designer performance', 'team performance', 'weekly', 'trends', 'won', 'approval rate', 'loss reasons', 'why we lose', 'segments', 'artwork check usage', 'proof check usage', 'who ran checks', 'check verdicts', 'flagged rate', 're-engagement', 'reorder desk', 'back book', 'outreach results'],
    description: 'Conversion funnel, weekly trends, hot leads, team performance and artwork-check usage.',
  },

  // ── Customers & orders ──
  {
    id: 'customers',
    label: 'Customers',
    path: '/admin/customers',
    group: 'Customers & orders',
    icon: 'customers',
    sidebar: true,
    keywords: ['companies', 'contacts', 'clients', 'people', 'accounts', 'address book', 'projects', 'company', 'contact'],
    description: 'Companies and contacts, with their projects.',
  },
  {
    id: 'orders',
    label: 'Order log',
    path: '/admin/orders',
    group: 'Customers & orders',
    icon: 'orders',
    sidebar: true,
    keywords: ['orders', 'payments', 'paid', 'invoices', 'checkout', 'purchases', 'sales', 'transactions', 'pay links', 'order history'],
    description: 'Every order and its payment status.',
  },
  {
    id: 'reorder-register',
    label: 'Reorder register',
    path: '/admin/reorder-register',
    group: 'Customers & orders',
    icon: 'reorderregister',
    sidebar: true,
    keywords: ['reorder register', 'back book', 'past customers', 're-engagement', 'reengagement', 'win back', 'winback', 'lapsed customers', 'old customers', 'former customers', 'reorder desk', 'outreach', 'lifetime value', 'repeat customers', 'xero history', 'prospects', 'who to call'],
    description: 'Every past customer, what they last bought and when they are due.',
  },
  {
    id: 'shipping',
    label: 'Shipping',
    path: '/admin/shipping',
    group: 'Customers & orders',
    icon: 'shipping',
    sidebar: true,
    keywords: ['delivery', 'dispatch', 'despatch', 'address', 'courier', 'deliver to', 'postage', 'ship to', 'delivery details'],
    description: 'Delivery details a paid order needs before it ships.',
  },
  {
    id: 'outsourcing',
    label: 'Outsourcing',
    path: '/admin/outsourcing',
    group: 'Customers & orders',
    icon: 'outsourcing',
    sidebar: true,
    keywords: ['suppliers', 'subcontractors', 'production', 'third party', 'vendors', 'partners', 'outsourced'],
    description: 'Suppliers and outsourced production.',
  },

  // ── Messaging & automation ──
  {
    id: 'follow-ups',
    label: 'Follow-ups',
    path: '/admin/needs-attention',
    group: 'Messaging & automation',
    icon: 'followups',
    sidebar: true,
    keywords: ['reminders', 'nudges', 'chase', 'chasing', 'needs attention', 'automation', 'rules', 'dormant', 'dormant cutoff', 'stranded approvals', 'auto reminders', 'reminder rules', 'attention'],
    description: 'Reminder rules, dormant cutoff and follow-up automation.',
  },
  {
    id: 'ai-drafts',
    label: 'AI drafts',
    path: '/admin/ai-drafts',
    group: 'Messaging & automation',
    icon: 'ai',
    sidebar: true,
    keywords: ['ai', 'drafts', 'help scout replies', 'briefing', 'proposals', 'artificial intelligence', 'auto replies', 'draft replies', 'house rules', 'exemplars'],
    description: 'AI reply drafts, briefing editor and proposals.',
  },
  {
    id: 'content',
    label: 'Content',
    path: '/admin/content',
    group: 'Messaging & automation',
    icon: 'content',
    sidebar: true,
    keywords: ['copy', 'wording', 'text', 'messages', 'templates', 'site copy', 'customer copy'],
    description: 'Everything customers read — messages and page copy.',
  },
  {
    id: 'content-messages',
    label: 'Messages',
    path: '/admin/content/messages',
    group: 'Messaging & automation',
    icon: 'content',
    keywords: ['reply templates', 'email templates', 'message bodies', 'confirmations', 'proof messages', 'reminder wording', 'templates', 'approve confirmation', 'change request confirmation', 'nudge templates', 'order messages', 'project messages', 'project closed', 'abandon message', 'closing a project'],
    description: 'The message bodies sent to customers.',
  },
  {
    id: 'content-site-copy',
    label: 'Site copy',
    path: '/admin/content/site-copy',
    group: 'Messaging & automation',
    icon: 'content',
    keywords: ['customer copy', 'page wording', 'login page', 'thickness notes', 'qr panel', 'about proof', 'editable copy'],
    description: 'Editable wording on the customer-facing pages.',
  },

  // ── Catalogue ──
  {
    id: 'materials',
    label: 'Materials',
    path: '/admin/materials',
    group: 'Catalogue',
    icon: 'materials',
    sidebar: true,
    keywords: ['products', 'card types', 'metal', 'paper', 'plastic', 'wood', 'acrylic', 'carbon fibre', 'letterpress', 'finishes', 'material editor', 'create material', 'disclaimers'],
    description: 'The product catalogue — every material and its options.',
  },
  {
    id: 'pricing',
    label: 'Pricing',
    path: '/admin/pricing',
    group: 'Catalogue',
    icon: 'pricing',
    sidebar: true,
    keywords: ['prices', 'price tiers', 'cost', 'import pricing', 'price list', 'rates', 'quantities', 'surcharges', 'price editor'],
    description: 'Price tiers per material, with import.',
  },
  {
    id: 'catalogue',
    label: 'Catalogue data',
    path: '/admin/catalogue',
    group: 'Catalogue',
    icon: 'catalogue',
    sidebar: true,
    keywords: ['reference data', 'lead times', 'card weights', 'xero item codes', 'material options', 'paper colours', 'prototype prices', 'stock materials'],
    description: 'Reference figures per material and variant.',
  },
  {
    id: 'catalogue-lead-times',
    label: 'Lead times',
    path: '/admin/catalogue/lead-times',
    group: 'Catalogue',
    icon: 'catalogue',
    keywords: ['turnaround', 'turnaround times', 'production time', 'delivery time', 'how long', 'days', 'lead time'],
    description: 'Production lead-time windows per material.',
  },
  {
    id: 'catalogue-card-weights',
    label: 'Card weights',
    path: '/admin/catalogue/card-weights',
    group: 'Catalogue',
    icon: 'catalogue',
    keywords: ['weight', 'grams', 'fedex weight', 'parcel weight', 'shipping weight'],
    description: 'Per-variant card weight for shipping maths.',
  },
  {
    id: 'catalogue-prototype-prices',
    label: 'Prototype prices',
    path: '/admin/catalogue/prototype-prices',
    group: 'Catalogue',
    icon: 'catalogue',
    keywords: ['sample prices', 'mockup prices', 'proto', 'prototype'],
    description: 'Prototype pricing per material.',
  },
  {
    id: 'catalogue-xero-item-codes',
    label: 'Xero item codes',
    path: '/admin/catalogue/xero-item-codes',
    group: 'Catalogue',
    icon: 'catalogue',
    keywords: ['accounting codes', 'invoice codes', 'xero', 'item codes', 'self test', 'invoice self-test', 'accounting'],
    description: 'Xero item codes and the invoice self-test.',
  },
  {
    id: 'catalogue-material-options',
    label: 'Material options',
    path: '/admin/catalogue/material-options',
    group: 'Catalogue',
    icon: 'catalogue',
    keywords: ['finishes', 'options', 'surcharges', 'mirror', 'brushed', 'cnc', 'gilding'],
    description: 'The choices offered within a material.',
  },
  {
    id: 'catalogue-paper-colours',
    label: 'Paper colours',
    path: '/admin/catalogue/paper-colours',
    group: 'Catalogue',
    icon: 'catalogue',
    keywords: ['colorplan', 'letterpress core colours', 'paper colors', 'colours', 'swatches', 'core colours'],
    description: 'Colorplan / letterpress colour palette.',
  },
  {
    id: 'catalogue-stock-materials',
    label: 'Stock materials',
    path: '/admin/catalogue/stock-materials',
    group: 'Catalogue',
    icon: 'catalogue',
    keywords: ['stock control', 'material mapping', 'hand-off', 'handoff', 'workshop system', 'stock material', 'production mapping'],
    description: 'Map each material to its Stock Control counterpart for the order hand-off.',
  },

  // ── System ──
  {
    id: 'users',
    label: 'Users',
    path: '/admin/users',
    group: 'System',
    icon: 'users',
    sidebar: true,
    keywords: ['staff', 'team', 'accounts', 'designers', 'admins', 'passwords', 'add user', 'deactivate', 'permissions', 'roles'],
    description: 'Staff accounts and passwords.',
  },
  {
    id: 'settings',
    label: 'Settings',
    path: '/admin/settings',
    group: 'System',
    icon: 'settings',
    sidebar: true,
    keywords: ['configuration', 'options', 'preferences', 'toggles', 'config'],
    description: 'Operational switches and defaults.',
  },
  {
    id: 'settings-customer-approvals',
    label: 'Customer approvals',
    path: '/admin/settings#customer-approvals',
    group: 'System',
    icon: 'settings',
    keywords: ['approve', 'request changes', 'approval flow', 'confirmation copy', 'customer approvals'],
    description: 'Settings › the customer approve / request-changes flow.',
  },
  {
    id: 'settings-ordering-checkout',
    label: 'Ordering & checkout',
    path: '/admin/settings#ordering-checkout',
    group: 'System',
    icon: 'settings',
    keywords: ['stripe', 'payment mode', 'test live', 'xero connection', 'clearing account', 'vat rates', 'tax rates', 'order reminders', 'reminder cadence', 'decline discount', 'recovery discount', 'ordering enabled', 'checkout', 'payments', 'go live'],
    description: 'Settings › Stripe, Xero, order reminders and discounts.',
  },
  {
    id: 'settings-workshop-handoff',
    label: 'Workshop hand-off',
    path: '/admin/settings#workshop-handoff',
    group: 'System',
    icon: 'settings',
    keywords: ['stock control', 'handoff', 'hand-off', 'direct handoff', 'production note', 'supplier email', 'workshop', 'place order', 'order import', 'shadow live'],
    description: 'Settings › how a placed order reaches Stock Control.',
  },
  {
    id: 'settings-order-tracking',
    label: 'Order tracking',
    path: '/admin/settings#order-tracking',
    group: 'System',
    icon: 'settings',
    keywords: ['customer tracking', 'progress strip', 'delivery tracking', 'supplier tracking', 'tracking level'],
    description: 'Settings › the customer order-progress strip.',
  },
  {
    id: 'settings-reorder-desk',
    label: 'Reorder desk',
    path: '/admin/settings#reorder-desk',
    group: 'System',
    icon: 'settings',
    keywords: ['reorder desk', 'back book', 're-engagement', 'past customers', 'win back', 'outreach', 'daily limit', 'follow up'],
    description: 'Settings › the Reorder desk daily list and follow-up timing.',
  },
  {
    id: 'artwork-check',
    label: 'Artwork check',
    path: '/admin/artwork-check',
    group: 'Messaging & automation',
    icon: 'ai',
    sidebar: true,
    keywords: ['artwork check', 'sanity check', 'pre-print check', 'supplied vs printed', 'transcription', 'typo check', 'ai check', 'shadow live', 'mandatory check', 'place order gate', 'claude model', 'model', 'qr check'],
    description: 'The pre-print supplied-vs-printed check: mode, run gate and model.',
  },
  {
    id: 'settings-designer-defaults',
    label: 'Designer defaults',
    path: '/admin/settings#designer-defaults',
    group: 'System',
    icon: 'settings',
    keywords: ['default currency', 'default pricing display', 'new version defaults', 'defaults'],
    description: 'Settings › defaults for new versions.',
  },
  {
    id: 'settings-push',
    label: 'Push notifications',
    path: '/admin/settings#notifications',
    group: 'System',
    icon: 'settings',
    keywords: ['push notifications', 'push enabled', 'alerts', 'notifications', 'master switch'],
    description: 'Settings › the push-notification master switch.',
  },
  {
    id: 'settings-help-scout',
    label: 'Help Scout',
    path: '/admin/settings#help-scout',
    group: 'System',
    icon: 'settings',
    keywords: ['helpscout', 'help scout', 'test connection', 'mailbox', 'email integration'],
    description: 'Settings › the Help Scout connection.',
  },
  {
    id: 'settings-shipping-rates',
    label: 'Shipping rates',
    path: '/admin/settings#shipping',
    group: 'System',
    icon: 'settings',
    keywords: ['fedex box weight', 'fedex adjustment', 'domestic uk rates', 'dpd', 'northern ireland', 'shipping rates', 'postage rates'],
    description: 'Settings › FedEx and domestic shipping rates.',
  },
  {
    id: 'settings-us-tariff',
    label: 'US tariff',
    path: '/admin/settings#us-tariff',
    group: 'System',
    icon: 'settings',
    keywords: ['us tariff', 'customs', 'import duty', 'tariff fee', 'usa', 'united states', 'duty'],
    description: 'Settings › the US tariff & customs charge.',
  },
  {
    id: 'activity',
    label: 'Activity',
    path: '/admin/activity',
    group: 'System',
    icon: 'activity',
    sidebar: true,
    keywords: ['audit log', 'history', 'changes', 'who did what', 'audit', 'log', 'trail'],
    description: 'The audit log of who changed what.',
  },
  {
    id: 'demo-data',
    label: 'Demo data',
    path: '/admin/demo-data',
    group: 'System',
    icon: 'settings',
    // Deliberately NOT sidebar: true. The house rule reserves a sidebar entry for
    // a genuinely new job, and resetting test fixtures is a tool for demos and
    // the e2e suite, not something a designer does — it would sit in the nav in
    // front of five people who never need it. Reachable by admin search and by
    // its URL, like the Settings sub-features.
    keywords: [
      'demo', 'demo data', 'test data', 'fixtures', 'fixture', 'atari', 'reset',
      'sample', 'seed', 'test project', 'staging', 'e2e', 'playwright',
    ],
    description: 'Reset the Atari test projects to a known state for demos and tests.',
  },
]

// ── Sidebar groups, derived from the registry ─────────────────────────────────
// Single source of truth: the top-level `sidebar: true` destinations, grouped
// in registry order. The sidebar nav and the Admin home hub both build off this
// — the hub uses the full objects (for each card's description), the nav reduces
// them to what NavLink needs. Icons resolve via ADMIN_ICONS at render time.
export interface AdminSidebarGroup {
  label: AdminGroupLabel
  items: AdminDestination[]
}

export const ADMIN_SIDEBAR_GROUPS: AdminSidebarGroup[] = (() => {
  const groups: AdminSidebarGroup[] = []
  for (const d of ADMIN_DESTINATIONS) {
    if (!d.sidebar) continue
    let g = groups.find((x) => x.label === d.group)
    if (!g) {
      g = { label: d.group, items: [] }
      groups.push(g)
    }
    g.items.push(d)
  }
  return groups
})()

export interface AdminNavTab {
  to: string
  label: string
  icon: string
}
export interface AdminNavGroup {
  label: AdminGroupLabel
  tabs: AdminNavTab[]
}

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = ADMIN_SIDEBAR_GROUPS.map((g) => ({
  label: g.label,
  tabs: g.items.map((d) => ({ to: d.path, label: d.label, icon: d.icon })),
}))

// ── Fuzzy matcher ─────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase()
}

// Split into lowercase alphanumeric words, dropping punctuation ("&", "-", "/").
function wordsOf(s: string): string[] {
  return norm(s).split(/[^a-z0-9]+/).filter(Boolean)
}

// Bounded Levenshtein: the true distance, or cap+1 once it's clear it exceeds
// cap. Cheap early-outs keep it fast enough to run over the whole registry on
// every keystroke.
function editDistance(a: string, b: string, cap: number): number {
  const al = a.length
  const bl = b.length
  if (Math.abs(al - bl) > cap) return cap + 1
  let prev = new Array<number>(bl + 1)
  let curr = new Array<number>(bl + 1)
  for (let j = 0; j <= bl; j++) prev[j] = j
  for (let i = 1; i <= al; i++) {
    curr[0] = i
    let rowMin = curr[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      curr[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > cap) return cap + 1
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[bl]
}

// How many typos to forgive, by token length. Short tokens must be exact so a
// two-letter typo doesn't match half the registry.
function maxEdits(len: number): number {
  if (len <= 3) return 0
  if (len <= 6) return 1
  return 2
}

// Do all of `q`'s characters appear in `t` in order? ("leadt" in "lead times")
function isSubsequence(q: string, t: string): boolean {
  let i = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (q.charCodeAt(i) === t.charCodeAt(j)) i++
  }
  return i === q.length
}

// Score one query token against one target string. 0 = no match; higher is
// better. The tiers are ordered so exact ≥ prefix ≥ word-start ≥ substring ≥
// subsequence ≥ typo, and the numbers sit in one comparable band across tiers.
function scoreTokenInString(token: string, target: string): number {
  const t = norm(target)
  if (!t) return 0
  if (t === token) return 1
  if (t.startsWith(token)) return 0.9

  const words = wordsOf(target)
  let wordStart = 0
  for (const w of words) {
    if (w === token) {
      wordStart = 0.88
      break
    }
    if (w.startsWith(token)) wordStart = Math.max(wordStart, 0.82)
  }
  if (wordStart) return wordStart

  // Compact form (spaces/punctuation removed) so a query that runs across a
  // word boundary still counts as contiguous: "leadt" → "lead times",
  // "cardweights" → "card weights". A stronger signal than a lone typo below.
  const compact = t.replace(/[^a-z0-9]+/g, '')
  if (compact !== t) {
    if (compact.startsWith(token)) return 0.86
    if (token.length >= 3 && compact.includes(token)) return 0.72
  }

  if (t.includes(token)) return 0.68

  if (token.length >= 2 && isSubsequence(token, t)) {
    // Tighter (shorter) targets get a small bump — a subsequence spread thin
    // across a long string is a weaker signal.
    return 0.42 + Math.min(token.length / t.length, 1) * 0.12
  }

  const cap = maxEdits(token.length)
  if (cap > 0) {
    let best = editDistance(token, t, cap)
    for (const w of words) {
      if (best === 1) break
      if (Math.abs(w.length - token.length) > cap) continue
      const d = editDistance(token, w, cap)
      if (d < best) best = d
    }
    if (best <= cap) return 0.5 - (best - 1) * 0.12 // dist 1 → 0.5, dist 2 → 0.38
  }

  return 0
}

// Relative pull of each field. Label wins; a keyword synonym is nearly as good;
// group and description are weak tie-breakers.
const FIELD_WEIGHT = { label: 1, keyword: 0.92, group: 0.5, description: 0.55 }

function scoreTokenInDestination(token: string, d: AdminDestination): number {
  let best = scoreTokenInString(token, d.label) * FIELD_WEIGHT.label
  if (d.keywords) {
    for (const k of d.keywords) {
      best = Math.max(best, scoreTokenInString(token, k) * FIELD_WEIGHT.keyword)
    }
  }
  best = Math.max(best, scoreTokenInString(token, d.group) * FIELD_WEIGHT.group)
  if (d.description) {
    best = Math.max(best, scoreTokenInString(token, d.description) * FIELD_WEIGHT.description)
  }
  return best
}

// Every query token must clear this in at least one field, or the destination
// is dropped. Keeps "order tracking" from matching a page that only knows
// "order" and nothing like "tracking".
const MATCH_THRESHOLD = 0.3

/** Score a whole query (0 = no match). Exported for the unit tests. */
export function scoreDestination(query: string, d: AdminDestination): number {
  const qts = wordsOf(query)
  if (qts.length === 0) return 0

  let total = 0
  for (const qt of qts) {
    const s = scoreTokenInDestination(qt, d)
    if (s < MATCH_THRESHOLD) return 0 // AND semantics — every token must match
    total += s
  }
  // Average, not sum, so a two-word query isn't inherently worth more than a
  // one-word one. (Within a single search the divisor is constant, so this only
  // matters for the fixed bonuses below.)
  let score = total / qts.length

  // Whole-query bonuses: a clean hit on the label itself should out-rank the
  // same words scattered across keywords.
  const nq = norm(query.trim())
  const nl = norm(d.label)
  if (nl === nq) score += 0.6
  else if (nl.startsWith(nq)) score += 0.35
  else if (nl.includes(nq)) score += 0.15

  return score
}

export interface AdminSearchResult {
  destination: AdminDestination
  score: number
}

/**
 * Rank the registry against `query`. A blank query returns every destination in
 * registry order (score 0) so the palette can show a browsable directory.
 */
export function searchAdminDestinations(
  query: string,
  destinations: AdminDestination[] = ADMIN_DESTINATIONS,
): AdminSearchResult[] {
  const q = query.trim()
  if (!q) return destinations.map((destination) => ({ destination, score: 0 }))

  const scored: { destination: AdminDestination; score: number; index: number }[] = []
  destinations.forEach((destination, index) => {
    const score = scoreDestination(q, destination)
    if (score > 0) scored.push({ destination, score, index })
  })
  // Highest score first; registry order breaks ties (stable, predictable).
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map(({ destination, score }) => ({ destination, score }))
}
