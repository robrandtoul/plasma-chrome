import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DesignerChrome, PanelShell, Pill, ButtonInk, ButtonGhost, Textarea } from '../design'
import { useAuth } from '../lib/auth'
import { formatPrice } from '../lib/currency'
import { getExchangeRates, currencyToGbp, type ExchangeRates } from '../lib/exchangeRates'
import { customerOrderUrl, customerOrderGroupUrl } from '../lib/customerOrderUrl'
import { orderTotal, specLabel as specLabelShared, customerLabel as customerLabelShared, usTariffDutyBilling } from '../lib/orderDisplay'
import { logAudit } from '../lib/audit'
import { getOrderingEnabled } from '../lib/orderingEnabled'
import { keepApprovedNoOrder, invalidateApprovedNoOrderCount } from '../lib/approvedNoOrder'
import { splitByChaseNeed, chaseReason, groupNeedsAttention, type TriageOrder } from '../lib/ordersTriage'
import { materialNeedsStockColour, fetchStockColours, type StockColour } from '../lib/stockColours'
import { downloadBlob } from '../lib/downloadFile'
import { signThumbnails, type ThumbInfo } from '../lib/thumbnails'
import type { Currency } from '../lib/types'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import { mergeInvestigation, requestAcknowledge, requestInvestigation } from '../lib/useProofCheck'
import { ackKey, type AckReason, type AckTarget } from '../lib/artworkAcks'
import { holdState, holdBlockReason, repliedLine, HOLD_COPY } from '../lib/orderHolds'
import OrderBuilderModal from '../components/OrderBuilderModal'
import GroupOrdersModal, { type GroupCandidate } from '../components/GroupOrdersModal'
import RecordOfflinePaymentModal from '../components/RecordOfflinePaymentModal'
import EditOrderModal from '../components/EditOrderModal'
import CardActionsMenu, { type CardMenuItem } from '../components/CardActionsMenu'
import Modal from '../components/Modal'
import { useConfirm } from '../components/ConfirmDialog'
import SendPayLinkModal from '../components/SendPayLinkModal'
import DesignerAvatar from '../components/DesignerAvatar'
import ApprovedArtworkPanel from '../components/ApprovedArtworkPanel'
import ArtworkCheckReportView, { type ArtworkCheckReport } from '../components/ArtworkCheckReportView'
import HoldOrderDialog from '../components/HoldOrderDialog'
import { ChevronDown, StickyNote } from 'lucide-react'

// Orders / "to order" surface (Ordering & checkout, Step 6 — overhauled).
//
// The hand-off queue between "customer paid" and Stock Control. Fulfilment
// (production + shipping) is Stock Control's job, not this app's; here a paid
// order is compiled and PLACED — into production (in-house) or with a supplier
// — and then drops off. Phase 1 wires the in-house route: posting the
// structured production note onto the Help Scout thread (the
// helpscout-inhouse-order webhook ingests it) lands once Dropbox is connected;
// for now the page captures the two things that gate placing an order — the
// date required and the Dropbox order folder (the prepped source artwork +
// the order number/project) — and marks the order placed.
//
// Reads orders directly (authenticated designers have RLS select on
// proofs.orders, 000229) joined to the proof's contact/company, the chosen
// variant, and the material's production route + lead time.

// Reactivating an expired link extends it by the same window create-order uses.
const ORDER_EXPIRY_DAYS = 14

interface OrderRow {
  id: string
  status: string
  token: string
  expires_at: string | null
  sent_at: string | null
  pay_link_opened_at: string | null
  // Open-spec (000298): the customer picks these at checkout; help_requested_at
  // is the pay page's "Not sure? Ask us" stamp for the amber chip below.
  help_requested_at: string | null
  thickness_open: boolean
  finish_open: boolean
  quantity_open: boolean
  // Combined-payment group membership (bundle orders Slice 2, migration
  // 000309). Non-null = this order pays through the group's one link.
  order_group_id: string | null
  // The order's material (000298 — stamped on every order, whether variant-
  // derived or open-spec). Drives thumbForOrder: a proof can carry orders in
  // two materials, and only one can match the current version's artwork.
  material_id: string | null
  material_variant_id: string | null
  material_option_id: string | null
  currency: Currency
  quantity: number | null
  names_count: number
  has_personalisation: boolean
  custom_quote_total: number | null
  amount_cards: number | null
  amount_tooling: number | null
  amount_personalisation: number | null
  amount_shipping: number | null
  amount_us_tariff: number | null
  // US-bound checkout: did the customer opt out of the import-duty service?
  // (migration 000249.) On a grouped member this is false/0 — the tariff is
  // billed once at group level, so read it from the group there.
  us_tariff_opted_out: boolean | null
  // Designer-set cards discount: the config + the amount stamped at checkout.
  card_discount_type: 'none' | 'percent' | 'fixed' | null
  card_discount_value: number | null
  amount_card_discount: number | null
  payment_method: string | null
  // 'production' (default) | 'prototype' — the flat-fee prototyping service.
  order_kind: string | null
  payment_reference: string | null
  xero_invoice_id: string | null
  xero_invoice_error: string | null
  paid_at: string | null
  fulfilled_at: string | null
  revised_at: string | null
  // On hold while a question is out with the customer (migration 000377).
  // held_at set = the database refuses to let this order be placed, so this is
  // a real block rather than a UI hint. held_by_name is stamped SERVER-side by
  // the trigger — proofs.profiles SELECT is self-or-admin, so the browser can't
  // read a colleague's name to write it, and a client-supplied one would be
  // spoofable. Never send it; never send held_by either.
  held_at: string | null
  hold_reason: string | null
  held_by_name: string | null
  // What the artwork check said when the hold went on, snapshotted because a
  // re-run overwrites orders.artwork_check wholesale. Fetched so a refetched
  // row keeps it; this page doesn't render it (the review page does).
  hold_artwork_flag: Record<string, unknown> | null
  // Hand-off to Stock Control (000332, docs/order-handoff-spec.md §3.4).
  // Placing an order now writes the workshop's job FIRST and sends the human
  // message SECOND, so the two can fail apart: handoff_at set = the job exists;
  // the route's send stamp says whether the message that goes with it actually
  // left. handoff_error is the last failure of the write itself, cleared on
  // success — and in shadow mode carries harmless notes prefixed "shadow:".
  handoff_at: string | null
  handoff_error: string | null
  production_note_posted_at: string | null
  supplier_email_sent_at: string | null
  // Stamped when the order was placed with a supplier — replayed on a retry so
  // the message goes to the same supplier, with the same spoilage overs, as the
  // job already sitting in Stock Control.
  supplier_id: string | null
  supplier_overs: number | null
  // Blanks ride a sibling order's supplier batch (000382): the hand-off is the
  // WORKSHOP NOTE and no supplier email ever sends, whatever the material's
  // route says — handoffState must judge these by the note.
  blanks_source_order_id: string | null
  // Artwork sanity check (000336): the latest run's verdict + stamp — the chip
  // on To-order / Recently-ordered cards. The full report jsonb is fetched
  // lazily when the chip is clicked, never in the list select.
  artwork_check_verdict: 'clear' | 'flagged' | 'defect' | 'error' | null
  artwork_checked_at: string | null
  // Order-placement fields (000252).
  date_required: string | null
  dropbox_folder_url: string | null
  stock_order_number: string | null
  project_name: string | null
  // Specific Stock Control colour for plastic/acrylic cards (000289).
  stock_colour: string | null
  person_quantities: { name: string; quantity: number }[] | null
  // The designer's destination hint / the customer's rated destination —
  // pre-fills the combine modal's country picker.
  ship_dest_country: string | null
  ship_to_name: string | null
  ship_to_email: string | null
  // Recipient contact number from checkout (Stripe Address Element) — the
  // courier paperwork (FedEx especially) needs it.
  ship_to_phone: string | null
  // Optional customer VAT / EORI number captured at EU checkout (migration
  // 000341), for the customs paperwork.
  customs_tax_id: string | null
  ship_to_address: {
    line1?: string | null
    line2?: string | null
    city?: string | null
    region?: string | null
    postal_code?: string | null
    country?: string | null
  } | null
  proof_id: string
  material_variants: {
    display_name: string | null
    materials: { code: string | null; display_name: string | null; production_route: string | null; lead_time_max_days: number | null; outsourced_supplier_ids: string[] | null } | null
  } | null
  // The order's finish (material_option) — pinned by the designer or picked by
  // the customer on an open-spec order. Null until picked / for option-less
  // materials.
  material_options: { display_name: string | null } | null
  proofs: {
    // The PROOF's status (in_progress | approved | dormant | abandoned), not
    // the order's. Only used to tell a revision the customer has re-approved
    // (→ ready to place) from one still being redesigned — see isPlaceable.
    status: string | null
    // Thread-wide reply stamps (000208) — drive the specific grace-pause label.
    helpscout_last_reply_at: string | null
    helpscout_last_customer_reply_at: string | null
    // Whether a Help Scout conversation is linked — gates the combine modal's
    // "Send to customer" action (bundle orders Slice 2).
    helpscout_conversation_id: string | null
    // The thread itself. A held order's whole point is that a question is out
    // with the customer, so the card needs a one-click route to go and read it.
    helpscout_conversation_url: string | null
    contacts: { full_name: string | null; companies: { name: string | null } | null } | null
  } | null
}

const SELECT = `
  id, status, token, expires_at, sent_at, pay_link_opened_at, help_requested_at, thickness_open, finish_open, quantity_open, order_group_id, material_id, material_variant_id, material_option_id, currency, quantity, names_count, has_personalisation,
  custom_quote_total, amount_cards, amount_tooling, amount_personalisation, amount_shipping, amount_us_tariff, us_tariff_opted_out,
  card_discount_type, card_discount_value, amount_card_discount, payment_method, order_kind,
  payment_reference, xero_invoice_id, xero_invoice_error, paid_at, fulfilled_at, revised_at,
  held_at, hold_reason, held_by_name, hold_artwork_flag,
  handoff_at, handoff_error, production_note_posted_at, supplier_email_sent_at, supplier_id, supplier_overs, blanks_source_order_id,
  artwork_check_verdict, artwork_checked_at,
  date_required, dropbox_folder_url, stock_order_number, project_name, stock_colour, person_quantities,
  ship_to_name, ship_to_email, ship_to_phone, ship_to_address, customs_tax_id, ship_dest_country, proof_id,
  material_variants(display_name, materials(code, display_name, production_route, lead_time_max_days, outsourced_supplier_ids)),
  material_options(display_name),
  proofs(status, helpscout_last_reply_at, helpscout_last_customer_reply_at, helpscout_conversation_id, helpscout_conversation_url, contacts(full_name, companies(name)))
`

// The dropbox-folder edge function response (uniform { ok } shape).
interface DropboxFolderResult {
  ok: boolean
  error?: string
  name?: string
  order_number?: string | null
  project_name?: string | null
  file_count?: number
}

// Per-card state for the order-folder lookup against Dropbox.
type FolderLookup =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; orderNumber: string | null; projectName: string | null; fileCount: number | null }
  | { status: 'error'; error: string }

// A 'sent' order whose window has passed. Status stays 'sent' in the DB (the
// pay-page + this list derive expiry from the timestamp); reactivation just
// pushes expires_at forward.
function isExpired(o: OrderRow): boolean {
  return o.status === 'sent' && o.expires_at != null && new Date(o.expires_at).getTime() < Date.now()
}

// A combined-payment group this page's orders belong to (bundle orders
// Slice 2, proofs.order_groups). Only the fields the banner + actions need.
interface OrderGroupRow {
  id: string
  status: 'sent' | 'paid' | 'cancelled'
  currency: Currency
  token: string
  payment_reference: string | null
  expires_at: string | null
  pay_link_opened_at: string | null
  xero_invoice_id: string | null
  xero_invoice_error: string | null
  // The tariff is billed once at group level (members are zeroed), so the
  // US import-duty choice for a grouped order lives here.
  amount_us_tariff: number | null
  us_tariff_opted_out: boolean | null
}

// Can this awaiting-payment order join a combined payment? Mirrors the
// order-group edge function's rules so the checkbox only appears where create
// would succeed: online, not already grouped, priceable. Open-spec orders
// (customer picks quantity/thickness/finish) qualify — the group pay page
// runs the same guided choosers as a single-order link.
function canJoinGroup(o: OrderRow): boolean {
  return (
    o.status === 'sent' &&
    (o.payment_method ?? 'online') === 'online' &&
    o.order_group_id == null &&
    (o.quantity != null || o.quantity_open || o.custom_quote_total != null)
  )
}

// Production route from the order's material. 'supplier' is the outsourced
// route (phase 2 — the supplier-email hand-off); 'in_house' posts the
// production note. Null when the material is unknown (custom quote).
function routeOf(o: OrderRow): 'in_house' | 'supplier' | null {
  const r = o.material_variants?.materials?.production_route
  return r === 'supplier' ? 'supplier' : r === 'in_house' ? 'in_house' : null
}

// ── Hand-off to Stock Control (docs/order-handoff-spec.md §3.4) ─────────────
// Placing an order writes the workshop's job first and sends the human message
// (the in-house production note / the supplier email) second, so there are now
// three states worth showing:
//   'failed' — Stock Control wouldn't take the order. Nothing was written and
//              nothing was sent, so placing it again is safe.
//   'unsent' — the job IS in Stock Control, but its message never left. The
//              order is invisible to whoever has to make it until it does.
//   'done'   — job written, message sent. The quiet happy path.
type HandoffState =
  | { kind: 'none' }
  | { kind: 'failed'; reason: string }
  | { kind: 'unsent'; what: 'note' | 'email' | 'message' }
  | { kind: 'done' }

function handoffState(o: OrderRow): HandoffState {
  if (!o.handoff_at) {
    const reason = (o.handoff_error ?? '').trim()
    // While the direct hand-off is in shadow mode the same column records
    // harmless "here's what wouldn't have mapped" notes, prefixed "shadow:".
    // Nothing failed in that case, so those must never read as a problem.
    if (!reason || reason.toLowerCase().startsWith('shadow:')) return { kind: 'none' }
    return { kind: 'failed', reason }
  }
  let route = routeOf(o)
  // A blanks-source order (000382) is a supplier-MATERIAL order that
  // deliberately sends no supplier email — its blanks ride a sibling order's
  // batch and its message is the workshop note. Judged by the material alone it
  // would read "supplier email wasn't sent" forever (live: Apex 403960).
  if (route === 'supplier' && o.blanks_source_order_id) route = 'in_house'
  if (route === 'supplier') return o.supplier_email_sent_at ? { kind: 'done' } : { kind: 'unsent', what: 'email' }
  if (route === 'in_house') return o.production_note_posted_at ? { kind: 'done' } : { kind: 'unsent', what: 'note' }
  // Route unknown (custom quote — no priced material on the order). Only claim
  // a message is missing when neither one went, so we can never nag about a
  // message that did in fact send.
  if (o.production_note_posted_at || o.supplier_email_sent_at) return { kind: 'done' }
  return { kind: 'unsent', what: 'message' }
}

// Plain-English name for the message that goes out with an order.
function handoffMessageName(what: 'note' | 'email' | 'message'): string {
  return what === 'email' ? 'supplier email' : what === 'note' ? 'workshop note' : 'order message'
}

// Keep a raw Stock Control / Help Scout error readable inside a card or chip.
function shorten(text: string, max = 200): string {
  const s = text.trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

// Edge functions return their failures as a non-2xx body, which supabase-js
// hands back on error.context rather than in `data`. Read whichever is
// populated so the real message is never lost. (Mirrors OrderReviewPage's
// helper of the same name — kept local so the two pages stay independent.)
async function readFnErrorBody(err: unknown): Promise<{ error?: string; code?: string } | null> {
  const ctx = (err as { context?: { json?: () => Promise<unknown> } } | null)?.context
  if (ctx && typeof ctx.json === 'function') {
    try {
      return (await ctx.json()) as { error?: string; code?: string }
    } catch {
      /* body wasn't JSON — fall back to the error message */
    }
  }
  return null
}

// The suppliers a supplier-route order may go to, from the material's
// admin-editable config (materials.outsourced_supplier_ids → live Stock Control
// names). Drives the button: one names it ("…from QX Metals"), several offer a
// choice ("…choose supplier"). The actual supplier is picked + confirmed on the
// review page. Empty = none configured / names not loaded yet.
function allowedSupplierLabels(o: OrderRow, supplierNames: Record<string, string>): string[] {
  const ids = o.material_variants?.materials?.outsourced_supplier_ids ?? []
  return ids.map((id) => supplierNames[id]).filter((n): n is string => !!n)
}

// Thin adapters from this page's nested OrderRow onto the shared display
// helpers (src/lib/orderDisplay.ts), so the work queue and the admin Order log
// can't drift on a displayed total / label. orderTotal is used directly — an
// OrderRow already satisfies the helper's OrderAmounts shape.
function customerLabel(o: OrderRow): string {
  return customerLabelShared(o.proofs?.contacts?.companies?.name, o.proofs?.contacts?.full_name)
}

function specLabel(o: OrderRow): string {
  const base = specLabelShared(
    o.material_variants?.materials?.display_name,
    o.material_variants?.display_name,
    o.custom_quote_total,
    o.material_options?.display_name,
  )
  // A prototype keeps its material/variant, so the base reads as the material
  // it samples; mark it so the work queue distinguishes a flat-fee sample run
  // from a full production order at the same material. A reprint reads the same
  // way (free remake of that material) and is marked too.
  if (o.order_kind === 'prototype') return `${base} · Prototype sample`
  if (o.order_kind === 'reprint') return `${base} · Free reprint`
  return base
}

// Add N working days to a date (skips Sat/Sun). Used to suggest the date
// required from the material's lead time (a business-day figure); the designer
// confirms or overrides it on the card.
function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from)
  let added = 0
  while (added < n) {
    d.setDate(d.getDate() + 1)
    const day = d.getDay()
    if (day !== 0 && day !== 6) added++
  }
  return d
}

// Build the ISO date from LOCAL components. toISOString() converts to UTC, so
// for a UK user in BST a date computed near local midnight could roll back a
// day — and addBusinessDays counts on local getDay(), so the two would disagree
// at the boundary. This keeps the date the designer sees == the date we store.
function toISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Suggested date required: today + the material's max lead time (working days).
// Null when there's no lead time to base it on.
function suggestedDate(o: OrderRow): string | null {
  const lead = o.material_variants?.materials?.lead_time_max_days
  if (typeof lead !== 'number' || lead <= 0) return null
  return toISODate(addBusinessDays(new Date(), lead))
}

// Whole days since an ISO timestamp (for the "paid N days ago" ageing cue).
function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}

// Turn the stored Xero rejection into one human-readable line. The raw value
// is usually "<status> <JSON body>" from Xero's API; the useful part is the
// validation message(s) buried in Elements[].ValidationErrors[].Message.
function friendlyInvoiceError(raw: string | null): string | null {
  if (!raw) return null
  const braceIdx = raw.indexOf('{')
  if (braceIdx !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(braceIdx))
      const msgs: string[] = []
      const elements = Array.isArray(parsed?.Elements) ? parsed.Elements : []
      for (const el of elements) {
        for (const v of (Array.isArray(el?.ValidationErrors) ? el.ValidationErrors : [])) {
          if (v?.Message) msgs.push(String(v.Message))
        }
        for (const li of (Array.isArray(el?.LineItems) ? el.LineItems : [])) {
          for (const v of (Array.isArray(li?.ValidationErrors) ? li.ValidationErrors : [])) {
            if (v?.Message) msgs.push(String(v.Message))
          }
        }
      }
      if (msgs.length > 0) return Array.from(new Set(msgs)).join('; ')
      if (parsed?.Message) return String(parsed.Message)
    } catch {
      // not JSON — fall through to the trimmed raw string
    }
  }
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

const DAY_MS = 24 * 60 * 60 * 1000

// The funnel's invisible first leg: a proof approved but never turned into an
// order. The (disabled) approved_no_order needs-attention rule uses 2 working
// days; reuse it so the sidebar and that rule stay in lockstep.
const APPROVED_NO_ORDER_MIN_BUSINESS_DAYS = 2

// Working days (Mon–Fri) strictly after `iso` up to today inclusive — same
// inclusive-at-end shape as the DB's business_days_between (000160). Bank
// holidays aren't subtracted (a display cutoff, not a billing figure).
function businessDaysSince(iso: string): number {
  const start = new Date(iso)
  if (Number.isNaN(start.getTime())) return 0
  start.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  let count = 0
  const d = new Date(start)
  while (d < today) {
    d.setDate(d.getDate() + 1)
    const day = d.getDay()
    if (day !== 0 && day !== 6) count++
  }
  return count
}

// One approved proof with no order link sent yet — a row in the "Links to send"
// worklist. Mirrors the dashboard row's info (customer, designer, material,
// approved-when) plus the Help Scout thread, so the designer can work down the
// list and create each order link without leaving the page. `currentVersionId`
// + `hasHelpscoutConversation` come straight from the dashboard view; the rest
// the order builder needs (variant/option/currency/names) is fetched on click.
interface ApprovedNoOrderItem {
  proofId: string
  currentVersionId: string | null
  label: string
  contactName: string | null
  contactEmail: string | null
  companyName: string | null
  approvedAt: string
  /** Working days since approval; drives the "Overdue" flag + "approved today". */
  businessDays: number
  overdue: boolean
  materialDisplay: string | null
  versionNumber: number | null
  versionCreatedAt: string | null
  designerName: string | null
  designerInitials: string | null
  designerColour: string | null
  designerAvatarUrl: string | null
  helpscoutUrl: string | null
  hasHelpscoutConversation: boolean
  /** An unanswered customer reply newer than both our last reply and the current
   *  version (the dashboard's isCustomerReplied gate) — drives the "customer
   *  replied" chip. Null when there's no fresh, unanswered reply. */
  customerRepliedAt: string | null
}

// A short shared note pinned to a Links-to-send card — "why is this still here"
// (usually waiting on the customer). One per proof, editable by anyone, stamped
// with the last editor's identity. Discarded when the order link is sent
// (create-order deletes the row; migration 000296).
interface LinkNote {
  note: string
  byName: string | null
  byInitials: string | null
  byColour: string | null
  updatedAt: string
}

// The hydrated props the OrderBuilderModal needs, gathered from a worklist row
// plus a single proof_versions fetch on click. Mirrors the subset of
// OrderBuilderModalProps the modal can't fetch for itself.
interface OrderBuilderArgs {
  proofId: string
  currentVersionId: string
  materialId: string | null
  displayedVariantIds: string[]
  materialOptionCodes: string[]
  customerLabel: string | null
  materialDisplay: string | null
  currency: Currency | null
  namesCount: number
  hasPersonalisation: boolean
  versionIsCustomQuote: boolean
  hasHelpScoutConversation: boolean
}

// Per-order roll-up of the unpaid-order reminder ledger (order_nudges), used to
// show the auto-chase progress on the awaiting-payment card.
// The latest ledger row's meaning, when it was a skip / fail: a deliberate
// 'pause' (grace window, follow-up tag — the chase is holding, fine) vs a
// 'problem' (something is stopping it that may need a human).
interface ReminderNote {
  kind: 'pause' | 'problem'
  text: string
}

interface ReminderSummary {
  sentCount: number
  lastSentAt: string | null
  /** Highest reminder stage actually sent (drives "next reminder is N+1"). */
  highestSentNo: number
  /** Raw outcome of the latest run when it wasn't a send (else null). The card
   *  turns this into a note, since the friendly text for a grace pause needs the
   *  proof's reply stamps + grace-days, which only the card has to hand. */
  latestOutcome: string | null
}

// Admin-set chase cadence (settings, migration 000270) + whether the auto-chase
// is switched on. Defaults mirror the edge function's fallbacks. graceDays is the
// shared comms-grace knob (site_settings.needs_attention_rules
// .helpscout_reply_grace_days) the order sender re-uses to pause after a reply.
interface ReminderCadence {
  max: number
  intervalDays: number
  autoEnabled: boolean
  graceDays: number
}

// The reply stamps + grace days needed to explain a grace pause in full: which
// reply (staff vs customer) paused the chase, when, and when it lifts.
interface GraceContext {
  lastReplyAt: string | null
  lastCustomerReplyAt: string | null
  graceDays: number
}

// Turn an order_nudges skip / fail outcome into one plain line for staff,
// tagged pause vs problem. A successful / would-send outcome isn't either, so
// returns null. For a grace pause, `grace` (when supplied) lets us name the
// reply and date instead of the vague generic line.
function classifyReminderOutcome(outcome: string | null, grace?: GraceContext): ReminderNote | null {
  if (!outcome) return null
  if (outcome.startsWith('would_send') || outcome === 'sent' || outcome === 'sending') return null
  // Deliberate pauses — the chase is holding on purpose, not broken.
  if (outcome.includes('grace_window') || outcome.includes('recent_reply'))
    return graceNote(grace)
  if (outcome.includes('followup_tag'))
    return { kind: 'pause', text: 'Paused — the “follow up” tag is set on the Help Scout thread.' }
  // Problems — something is stopping the chase that may need a look.
  if (outcome.includes('no_conversation')) return { kind: 'problem', text: 'No Help Scout conversation linked — the reminder can’t send.' }
  if (outcome.includes('recipient_mismatch')) return { kind: 'problem', text: 'Contact email doesn’t match the Help Scout thread — not sent.' }
  if (outcome.includes('closed') || outcome.includes('conversation_missing')) return { kind: 'problem', text: 'Help Scout conversation is closed or missing — not sent.' }
  if (outcome.includes('unconfigured') || outcome.includes('no_base_url')) return { kind: 'problem', text: 'Reminder system isn’t fully configured — not sent.' }
  if (outcome.startsWith('render_failed')) return { kind: 'problem', text: 'Reminder template problem — not sent.' }
  if (outcome.startsWith('failed')) return { kind: 'problem', text: 'Help Scout rejected the last reminder — not sent.' }
  return { kind: 'problem', text: 'The last reminder didn’t send.' }
}

// Build the friendly grace-pause line. The chase pauses whenever EITHER stamp
// (staff OR customer reply) lands within the grace window — same `Math.max` the
// sender uses — so name whichever is newest and show when the pause lifts.
// Returns null when the window has already cleared (so the card shows its normal
// next-due line instead of a stale pause), falling back to the vague line only
// when the stamps are missing.
function graceNote(grace?: GraceContext): ReminderNote | null {
  const FALLBACK: ReminderNote = { kind: 'pause', text: 'Paused — recent reply on the Help Scout thread.' }
  if (!grace) return FALLBACK
  const staffMs = grace.lastReplyAt ? Date.parse(grace.lastReplyAt) : -Infinity
  const customerMs = grace.lastCustomerReplyAt ? Date.parse(grace.lastCustomerReplyAt) : -Infinity
  const newest = Math.max(staffMs, customerMs)
  if (!Number.isFinite(newest)) return FALLBACK
  const clearsMs = newest + grace.graceDays * DAY_MS
  if (clearsMs <= Date.now()) return null // window cleared — no longer paused
  // customer wins ties: a customer reply is the more meaningful signal to show.
  const fromCustomer = customerMs >= staffMs
  const who = fromCustomer ? 'the customer replied' : 'a reply was sent'
  return {
    kind: 'pause',
    text: `Paused — ${who} on the thread on ${formatDate(new Date(newest).toISOString())}. Resumes ${formatDate(new Date(clearsMs).toISOString())}.`,
  }
}

// The order's charged total expressed in GBP, so mixed-currency buckets can be
// summed into one headline figure. EUR/USD convert at the live ECB rate; GBP
// passes through. Null totals (custom quote with no priced parts) drop out of
// the sum. NB GBP order totals are VAT-inclusive while EUR/USD are VAT-free —
// the converted figure mixes the two, so the summary labels it a rough guide.
function gbpValueOf(o: OrderRow, rates: ExchangeRates | null): number {
  const total = orderTotal(o)
  if (total == null) return 0
  return currencyToGbp(total, o.currency, rates)
}

function sumGbp(orders: OrderRow[], rates: ExchangeRates | null): number {
  return orders.reduce((acc, o) => acc + gbpValueOf(o, rates), 0)
}

// Is this order ready to be placed?
//
// 'paid' is the ordinary case. The subtle one is 'revision': a revised order
// NEVER returns to 'paid' — nothing in the system writes that status except the
// Stripe webhook and offline-payment recording, and the customer already paid —
// so it stays 'revision' until it goes straight to 'fulfilled'. It becomes
// placeable again the moment the customer approves the replacement artwork, and
// before this it sat in the collapsed "Being revised" block with nothing
// signalling that (Rob, 2026-08-02: "once approved it needs to go back to
// Place… It doesn't require a second order link or payment").
//
// ⚠ `proofs.status === 'approved'` is exactly the predicate OrderReviewPage
// uses for revisionNeedsApproval, and place-order's own 409 mirrors it. If one
// of the three changes they must all change, or the page will offer a card the
// server then refuses.
//
// ⚠ Used by BOTH the filtered section buckets and the unfiltered header counts.
// Route every one of them through this, never through a re-typed status test:
// the counts and the sections disagreeing is the drift this page has been
// bitten by before.
function isPlaceable(o: OrderRow): boolean {
  if (o.status === 'paid') return true
  return o.status === 'revision' && o.proofs?.status === 'approved'
}

/** A revision still waiting on the customer to approve the replacement. */
function isAwaitingReapproval(o: OrderRow): boolean {
  return o.status === 'revision' && o.proofs?.status !== 'approved'
}

// Free-text match across the fields a designer would search by: customer /
// company, payment + stock order references, project name, and the spec label.
// The hold reason joins them for the same reason the Links-to-send note does —
// it's the most distinctive free text anyone types about an order ("waiting on
// the mobile number"), so it's how they'll go looking for it again.
function matchesSearch(o: OrderRow, q: string): boolean {
  if (!q) return true
  const haystack = [
    customerLabel(o),
    o.payment_reference,
    o.stock_order_number,
    o.project_name,
    specLabel(o),
    o.hold_reason,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}

// Which work-queue section a Fix pointer row should reveal. There is no
// longer a user-facing stage filter — the four pipeline tiles that set it are
// gone (a count can't tell you what to do next, and every count was already
// repeated in the section heading a scroll below).
type ViewKey = 'awaiting' | 'to_order'

// Shared shape for every chip on this page. whitespace-nowrap + shrink-0 are
// load-bearing on a phone: a chip is a label, not a paragraph, and without
// them a squeezed row wrapped "In Stock Control" onto three lines inside its
// own pill, turning each chip into a green blob (Rob's screenshot, 28 Jul).
// Rows that hold chips wrap, so a chip that keeps its width just moves down.
const CHIP_BASE =
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1'

// One tick in a To-order card's readiness row: the prep steps (folder / date /
// colour) as scannable chips, so a collapsed card still says exactly what's
// left before the order can be placed.
function PrepChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`${CHIP_BASE} ${
        ok
          ? 'bg-[var(--c-in-stock-soft)] text-in-stock ring-[var(--c-in-stock)]/40'
          : 'bg-[var(--c-low-soft)] text-low ring-[var(--c-low)]/40'
      }`}
    >
      {ok ? '✓' : '•'} {label}
      {ok ? '' : ' needed'}
    </span>
  )
}

// The artwork sanity-check verdict as a clickable chip (000336) — green when
// the last run was clear, amber when flagged or failed, red when at least one
// flag graded to the "bet a reprint on it" defect bar. Click opens the stored
// report in a modal (the in-app archive; no SQL needed to read past checks).
function ArtworkChip({ verdict, onOpen }: { verdict: 'clear' | 'flagged' | 'defect' | 'error'; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open the artwork check report"
      className={`${CHIP_BASE} hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)] ${
        verdict === 'clear'
          ? 'bg-[var(--c-in-stock-soft)] text-in-stock ring-[var(--c-in-stock)]/40'
          : verdict === 'defect'
            ? 'bg-[var(--c-out-soft)] text-out ring-[var(--c-out)]/40'
            : 'bg-[var(--c-low-soft)] text-low ring-[var(--c-low)]/40'
      }`}
    >
      {verdict === 'clear' ? '✓' : verdict === 'defect' ? '✗' : verdict === 'flagged' ? '⚠' : '!'} Artwork check
    </button>
  )
}

// Where an order got to on its way into Stock Control, as a chip in the same
// family as PrepChip / ArtworkChip. Green when the job is in and its message
// went out (quiet — this is the happy path); amber when the job is in but the
// message never left; rose when Stock Control refused the order outright. The
// fix lives next to the chip, not on it: the card's own error block for a
// refused order, the "Needs action" panel for an unsent message.
function HandoffChip({ state }: { state: HandoffState }) {
  if (state.kind === 'none') return null
  const base = CHIP_BASE
  if (state.kind === 'done') {
    return (
      <span className={`${base} bg-[var(--c-in-stock-soft)] text-in-stock ring-[var(--c-in-stock)]/40`} title="This order is in Stock Control and the message that goes with it was sent.">
        ✓ In Stock Control
      </span>
    )
  }
  if (state.kind === 'unsent') {
    const name = handoffMessageName(state.what)
    return (
      <span
        className={`${base} bg-[var(--c-low-soft)] text-low ring-[var(--c-low)]/40`}
        title={`The order reached Stock Control, but the ${name} never went. Send it from the Needs action panel.`}
      >
        ⚠ {name.charAt(0).toUpperCase()}{name.slice(1)} not sent
      </span>
    )
  }
  // Rose, matching the blocking treatment the card's own error block uses (and
  // the failed-invoice pill): this order isn't going anywhere until it's fixed.
  return (
    <span className={`${base} bg-[var(--c-out-soft)] text-out ring-[var(--c-out)]/40`} title={shorten(state.reason, 300)}>
      ⚠ Not in Stock Control
    </span>
  )
}

// A short GBP figure for the To-order value / section subtotals.
function gbpLabel(amount: number): string {
  return formatPrice(Math.round(amount), 'GBP')
}

// Section headers pin below the sticky top bar on mobile, so mid-scroll you
// can always see which stage you're in. The offset clears the condensed
// header (safe-area + 9px padding ×2 + 32px wordmark + border); z sits below
// the header's z-[5]. Desktop keeps in-flow headers (the sidebar layout keeps
// sections short enough).
const SECTION_HEADER_STICKY =
  'max-md:sticky max-md:top-[calc(env(safe-area-inset-top)+50px)] max-md:z-[4] max-md:-mx-4 max-md:px-4 max-md:py-2 max-md:bg-canvas/95 max-md:backdrop-blur-sm'

export default function OrdersPage() {
  const { session, role } = useAuth()
  // Replaces the window.confirm / window.alert this page used to fire — a grey
  // OS box in the middle of an otherwise carefully-built interface, and (for
  // the alerts) the only way failures on the money path were ever reported.
  const { confirm, alert: showAlert, dialog: confirmDialog } = useConfirm()
  // The order whose pay link we're sending / re-sending, if any.
  const [sendLinkFor, setSendLinkFor] = useState<OrderRow | null>(null)
  // The signed-in staffer's id — stamped as the author when they write a
  // Links-to-send note (the table's RLS requires created_by = auth.uid()).
  const userId = session?.user.id ?? null
  // Opening this page marks all payments "seen" — the Orders nav badge counts
  // orders paid since this stamp (profiles.orders_seen_at, 000325).
  useEffect(() => {
    if (!userId) return
    // .then makes the lazy builder actually execute (see teamChatStore's
    // stampSeen note) — without it the header Orders badge never cleared.
    void supabase
      .from('profiles')
      .update({ orders_seen_at: new Date().toISOString() })
      .eq('id', userId)
      .then(({ error }) => {
        if (error) console.error('[orders] seen stamp failed:', error.message)
      })
  }, [userId])
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<OrderRow[]>([])
  // True when the 300-row fetch ceiling was hit, so the page can say so rather
  // than silently dropping older orders (the full history lives in the log).
  const [capped, setCapped] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, ThumbInfo | null>>({})
  // Newest artwork per material within a proof, keyed `${proofId}:${materialId}`.
  // Lets an order card show its OWN material's artwork when the proof's current
  // version is a different material (see thumbForOrder).
  const [materialThumbs, setMaterialThumbs] = useState<Record<string, ThumbInfo>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // The order whose hand-off to Stock Control is being finished off right now,
  // plus the last failure per order so the message stays on the card / row it
  // belongs to instead of vanishing with a toast.
  const [handoffBusyId, setHandoffBusyId] = useState<string | null>(null)
  const [handoffErrors, setHandoffErrors] = useState<Record<string, string>>({})
  // Artwork check (000336): chips render only when the feature is live; the
  // full report jsonb is fetched lazily per click, never in the list select.
  const [artworkChipsOn, setArtworkChipsOn] = useState(false)
  const [artworkReportModal, setArtworkReportModal] = useState<{
    orderId: string
    label: string
    loading: boolean
    report: ArtworkCheckReport | null
  } | null>(null)
  const [investigatingKey, setInvestigatingKey] = useState<string | null>(null)
  const [investigationError, setInvestigationError] = useState<{ key: string; message: string } | null>(null)
  const [staleNotice, setStaleNotice] = useState<string | null>(null)

  async function openArtworkReport(order: OrderRow) {
    setInvestigationError(null)
    setStaleNotice(null)
    setArtworkReportModal({ orderId: order.id, label: customerLabel(order), loading: true, report: null })
    const { data } = await supabase.from('orders').select('artwork_check').eq('id', order.id).maybeSingle()
    setArtworkReportModal((m) => m && {
      ...m,
      loading: false,
      report: ((data as { artwork_check?: ArtworkCheckReport | null } | null)?.artwork_check ?? null),
    })
  }

  // Per-flag history walk from the archive modal (see ArtworkCheckReportView).
  async function investigateFlag(orderId: string, flag: { card: string; field: string }) {
    const key = `${flag.card}::${flag.field}`
    setInvestigatingKey(key)
    setInvestigationError(null)
    setStaleNotice(null)
    const out = await requestInvestigation({ order_id: orderId }, flag)
    if (out.investigation) {
      const inv = out.investigation
      setArtworkReportModal((m) => m && m.report
        ? { ...m, report: mergeInvestigation(m.report, [out.key, key], inv) }
        : m)
    } else if (out.staleReport) {
      // Re-run underneath the open modal — swap in what's actually stored.
      const fresh = out.staleReport
      setArtworkReportModal((m) => m && { ...m, report: fresh })
      setStaleNotice(out.message ?? 'This check has been re-run — the flags below are the current ones.')
    } else {
      setInvestigationError({ key, message: out.message ?? 'The investigation couldn’t run — try again.' })
    }
    setInvestigatingKey(null)
  }

  // Per-advisory "Mark as addressed" tick from the archive modal — same
  // adjudication the review page offers, so a designer working the queue
  // doesn't have to reopen the Place-order screen just to tick a flag off.
  const [acknowledgingKey, setAcknowledgingKey] = useState<string | null>(null)
  const [acknowledgeError, setAcknowledgeError] = useState<{ key: string; message: string } | null>(null)

  async function acknowledgeFromModal(orderId: string, target: AckTarget, reason: AckReason | null, undo: boolean) {
    const report = artworkReportModal?.report
    if (!report) return
    const key = ackKey(target)
    setAcknowledgingKey(key)
    setAcknowledgeError(null)
    const out = await requestAcknowledge(
      { order_id: orderId },
      { target, ...(undo ? { undo: true } : { reason: reason ?? undefined }), checkedAt: report.checked_at },
    )
    if (out.report) {
      const fresh = out.report
      setArtworkReportModal((m) => m && { ...m, report: fresh })
    } else if (out.staleReport) {
      const fresh = out.staleReport
      setArtworkReportModal((m) => m && { ...m, report: fresh })
      setStaleNotice(out.message ?? 'This check has been re-run — the items below are the current ones.')
    } else {
      setAcknowledgeError({ key, message: out.message ?? 'Couldn’t save that — try again.' })
    }
    setAcknowledgingKey(null)
  }
  // The awaiting-payment order being recorded as paid offline (bank transfer),
  // or null when the modal is closed.
  const [recordOffline, setRecordOffline] = useState<OrderRow | null>(null)
  // Combined-payment groups (bundle orders Slice 2): the groups referenced by
  // the loaded orders, keyed by id; the ticked order ids while picking a set
  // to combine; and whether the combine modal is open.
  const [groups, setGroups] = useState<Record<string, OrderGroupRow>>({})
  // Current version id per proof, for the orders on this page. Re-sending a pay
  // link posts on the Help Scout thread via send-helpscout-reply, which requires
  // a version_id — the orders query has no route to it (proof_versions isn't
  // embedded), so it's fetched alongside and merged in at send time.
  const [currentVersionByProof, setCurrentVersionByProof] = useState<Record<string, string>>({})
  const [groupSelect, setGroupSelect] = useState<Set<string>>(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  // The unpaid order being edited in place (thickness/quantity/etc.), if any.
  const [editingOrder, setEditingOrder] = useState<OrderRow | null>(null)
  // The unpaid order the cancel confirm dialog is open for, plus the dialog's
  // "email the customer" choice (ticked by default — untick to cancel silently,
  // e.g. when correcting a mistake before sending a fresh link) and any error
  // from the last attempt so it shows inside the dialog.
  const [cancelTarget, setCancelTarget] = useState<OrderRow | null>(null)
  const [cancelNotify, setCancelNotify] = useState(true)
  const [cancelError, setCancelError] = useState<string | null>(null)
  // The order whose hold dialog is open, and which way it's going: 'put' asks
  // for a reason, 'take_off' quotes the existing one back. Busy + error live
  // here so a failed write is reported inside the dialog rather than vanishing.
  const [holdTarget, setHoldTarget] = useState<{ order: OrderRow; mode: 'put' | 'take_off' } | null>(null)
  const [holdBusy, setHoldBusy] = useState(false)
  const [holdError, setHoldError] = useState<string | null>(null)
  // The live hold on whichever order the dialog is open for — the take-off
  // dialog quotes its reason back before you confirm. No reply context here on
  // purpose: this dialog is about the hold itself, not about who has answered.
  const holdDialogState = holdTarget ? holdState(holdTarget.order) : null
  const navigate = useNavigate()
  // Per-order reminder roll-up (the automated unpaid-order chase, 000238).
  const [reminders, setReminders] = useState<Record<string, ReminderSummary>>({})
  // Chase cadence + on/off, read once from settings. Defaults match the edge fn.
  const [cadence, setCadence] = useState<ReminderCadence>({ max: 3, intervalDays: 3, autoEnabled: false, graceDays: 3 })
  // Stock Control supplier id → name, for the supplier-route button labels
  // (the routing stores ids; names live in Stock Control). Best-effort.
  const [supplierNames, setSupplierNames] = useState<Record<string, string>>({})
  // Current-version material code per proof, so the Stock colour picker keys off
  // the PROOF's material (always set) rather than the order's priced variant —
  // a custom-quote order carries no variant, so the picker would otherwise never
  // show for it. Best-effort.
  const [proofMaterialCodes, setProofMaterialCodes] = useState<Record<string, string | null>>({})
  // Live GBP→EUR/USD rates so mixed-currency totals collapse to one GBP figure
  // in the summary bar + section subtotals (null until the first fetch lands).
  const [rates, setRates] = useState<ExchangeRates | null>(null)
  // Work-queue search + which section is shown (picked via the pipeline tiles).
  const [search, setSearch] = useState('')
  // The order card a "Needs action" row just jumped to — briefly ringed so the
  // eye lands on the right card after the scroll.
  const [flashOrderId, setFlashOrderId] = useState<string | null>(null)
  // Recently ordered is reference material, not work, so it starts collapsed;
  // an active search auto-opens it so matches there aren't invisible.
  // Collapsed-by-default reference sections. null = "follow the default",
  // true/false = "the designer has chosen". Not a plain boolean because a search
  // transiently opens them, and with `search || open` the toggle flipped a value
  // the OR already overrode — it did visibly nothing while searching.
  const [recentOpen, setRecentOpen] = useState<boolean | null>(null)
  const [waitingOpen, setWaitingOpen] = useState<boolean | null>(null)
  // Approved proofs with no order link sent yet — the "Links to send" worklist.
  // Fetched separately because these have no order row, so they appear nowhere
  // else on this page.
  const [approvedNoOrder, setApprovedNoOrder] = useState<ApprovedNoOrderItem[]>([])
  // The shared "why is this still here" note per Links-to-send proof, keyed by
  // proofId (migration 000296). Fetched alongside the worklist and merged into
  // each card; edits update this map in place so a save doesn't refetch the page.
  const [notesByProof, setNotesByProof] = useState<Record<string, LinkNote>>({})
  // Worklist sort: oldest-approved first by default so the longest-waiting
  // customers lead the list.
  const [linksSort, setLinksSort] = useState<'oldest' | 'newest'>('oldest')
  // The order builder, opened inline from a worklist row. Null = closed; set to
  // the hydrated props once the proof's current version has been fetched.
  const [orderBuilder, setOrderBuilder] = useState<OrderBuilderArgs | null>(null)
  // The worklist row whose "Create order link" is currently loading its version.
  const [preparingProofId, setPreparingProofId] = useState<string | null>(null)
  // The ordering master switch (settings.ordering_enabled). The worklist's
  // create-order path is hidden unless this is true — same fail-safe gate the
  // proof page uses, so turning ordering off makes the whole surface inert.
  // null = not yet read; only `=== true` reveals the create affordance.
  const [orderingEnabled, setOrderingEnabled] = useState<boolean | null>(null)
  // Bumped to re-run the page's data fetch (e.g. after an order is created, so a
  // just-ordered proof drops out of the worklist and its link appears under
  // Awaiting payment).
  const [reloadKey, setReloadKey] = useState(0)
  // Conversion health since launch: how many sent pay links were paid, and how
  // quickly. Computed across all orders (the work-queue fetch is status-scoped).

  useEffect(() => {
    let cancelled = false
    void (async () => {
      void getExchangeRates().then((r) => { if (!cancelled) setRates(r) })
      void getOrderingEnabled().then((v) => { if (!cancelled) setOrderingEnabled(v) })

      // Representative thumbnail per proof — a recognition aid so a card can be
      // identified at a glance; the card links to the proof for the authoritative
      // approved artwork. Scoped to the CURRENT version so an earlier version's
      // artwork doesn't show (e.g. a v1 plastic card for a proof now approved in
      // wood), falling back to the newest version when the current one has no
      // artwork yet. Shared by every card type that shows a thumbnail: To order,
      // Being revised, Awaiting payment, and the Links-to-send worklist.
      //
      // Alongside that, map each material appearing in the proof's versions to
      // its newest artwork (materialThumbs). A proof can carry orders in TWO
      // materials — e.g. a steel + letterpress pair built as two versions of one
      // project — and the current version can only match one of them, so order
      // cards resolve by the ORDER's material first (thumbForOrder). The current
      // version wins for its own material, keeping today's thumbnail whenever
      // the materials agree.
      //
      // Performance (same approach as the dashboard): one query for every
      // version across all the requested proofs, then ONE dashboard-thumbnails
      // call that signs a small ~200px rendition per version server-side — not
      // a per-proof customer-proof-images round trip each downloading the full
      // originals. See src/lib/thumbnails.ts.
      const loadThumbs = async (proofIds: string[]) => {
        if (proofIds.length === 0) return
        try {
          const { data: versionRows } = await supabase
            .from('proof_versions')
            .select('id, proof_id, material_id, is_current')
            .in('proof_id', proofIds)
            .order('created_at', { ascending: false })
          const versions = (versionRows ?? []) as {
            id: string; proof_id: string; material_id: string | null; is_current: boolean
          }[]

          // Per proof, pick the versions we need a thumbnail for: the current
          // one, the newest one overall (a belt-and-braces fallback for a proof
          // whose current version predates its newest), and the newest version
          // in each material. `versions` is newest-first, so the first entry
          // seen for a proof / material is the newest.
          const currentByProof = new Map<string, string>()
          const newestByProof = new Map<string, string>()
          const materialVersion = new Map<string, string>() // `${proofId}:${materialId}` -> versionId
          for (const v of versions) {
            if (!newestByProof.has(v.proof_id)) newestByProof.set(v.proof_id, v.id)
            if (v.is_current && !currentByProof.has(v.proof_id)) currentByProof.set(v.proof_id, v.id)
            if (v.material_id) {
              const key = `${v.proof_id}:${v.material_id}`
              if (!materialVersion.has(key)) materialVersion.set(key, v.id)
            }
          }

          // One batched, server-side-transformed sign for every version we need.
          const wanted = new Set<string>([
            ...currentByProof.values(),
            ...newestByProof.values(),
            ...materialVersion.values(),
          ])
          const signed = await signThumbnails(Array.from(wanted))
          if (cancelled) return

          setThumbs((prev) => {
            const next = { ...prev }
            for (const proofId of proofIds) {
              const currentId = currentByProof.get(proofId)
              const newestId = newestByProof.get(proofId)
              let info: ThumbInfo | undefined =
                (currentId ? signed.get(currentId) : undefined) ??
                (newestId ? signed.get(newestId) : undefined)
              // Last resort: any material thumbnail we signed for this proof.
              if (!info) {
                for (const [key, versionId] of materialVersion) {
                  if (key.startsWith(`${proofId}:`)) {
                    const m = signed.get(versionId)
                    if (m) { info = m; break }
                  }
                }
              }
              next[proofId] = info ?? null
            }
            return next
          })
          setMaterialThumbs((prev) => {
            const next = { ...prev }
            for (const [key, versionId] of materialVersion) {
              const info = signed.get(versionId)
              if (info) next[key] = info
            }
            return next
          })
        } catch {
          // ignore — cards render without a thumbnail
        }
      }

      // Approved-but-not-ordered proofs. Cross-reference every proof that has
      // any order (any status), then keep approved proofs past the threshold.
      void (async () => {
        const [{ data: approvedRows }, { data: orderRows }] = await Promise.all([
          supabase.from('public_dashboard_projects').select('proof_id, current_version_id, current_version_number, version_created_at, company_name, contact_name, contact_email, approved_at, material_display, designer_name, designer_initials, designer_colour, designer_avatar_url, helpscout_conversation_url, helpscout_conversation_id, helpscout_last_reply_at, helpscout_last_customer_reply_at').eq('status', 'approved'),
          supabase.from('orders').select('proof_id, created_at, sent_at, paid_at'),
        ])
        if (cancelled) return
        const orderList = (orderRows ?? []) as { proof_id: string; created_at: string | null; sent_at: string | null; paid_at: string | null }[]
        // The worklist shows every approved proof with no order link sent —
        // immediately, so it's a live to-do, not a delayed nag. The shared
        // keepApprovedNoOrder filter (no order of any status, approved on/after
        // go-live) is the SAME predicate the nav-pill count uses, so the badge
        // can't drift from this list. The 2-working-day mark only flags a row as
        // "overdue"; it no longer gates whether the row appears.
        const items: ApprovedNoOrderItem[] = keepApprovedNoOrder(
          (approvedRows ?? []) as {
            proof_id: string
            current_version_id: string | null
            current_version_number: number | null
            version_created_at: string | null
            company_name: string | null
            contact_name: string | null
            contact_email: string | null
            approved_at: string | null
            material_display: string | null
            designer_name: string | null
            designer_initials: string | null
            designer_colour: string | null
            designer_avatar_url: string | null
            helpscout_conversation_url: string | null
            helpscout_conversation_id: string | null
            helpscout_last_reply_at: string | null
            helpscout_last_customer_reply_at: string | null
          }[],
          orderList,
        )
          .map((r) => {
            const businessDays = businessDaysSince(r.approved_at!)
            // Only surface "customer replied" when it's a genuinely unanswered,
            // post-version reply — the same gate the dashboard's isCustomerReplied
            // uses: newer than our last staff reply AND newer than the current
            // version. helpscout_last_customer_reply_at is thread-wide, so without
            // this it would fire on ordinary pre-approval back-and-forth we've
            // already handled and read as a false "customer is chasing" signal.
            const replyAt = r.helpscout_last_customer_reply_at
            const ourReplyAt = r.helpscout_last_reply_at
            const versionAt = r.version_created_at
            const unansweredReplyAt =
              replyAt &&
              (!ourReplyAt || new Date(replyAt).getTime() > new Date(ourReplyAt).getTime()) &&
              (!versionAt || new Date(replyAt).getTime() > new Date(versionAt).getTime())
                ? replyAt
                : null
            return {
              proofId: r.proof_id,
              currentVersionId: r.current_version_id,
              label: customerLabelShared(r.company_name, r.contact_name),
              contactName: r.contact_name,
              contactEmail: r.contact_email,
              companyName: r.company_name,
              approvedAt: r.approved_at as string,
              businessDays,
              overdue: businessDays >= APPROVED_NO_ORDER_MIN_BUSINESS_DAYS,
              materialDisplay: r.material_display,
              versionNumber: r.current_version_number,
              versionCreatedAt: r.version_created_at,
              designerName: r.designer_name,
              designerInitials: r.designer_initials,
              designerColour: r.designer_colour,
              designerAvatarUrl: r.designer_avatar_url,
              helpscoutUrl: r.helpscout_conversation_url,
              hasHelpscoutConversation: !!r.helpscout_conversation_id,
              customerRepliedAt: unansweredReplyAt,
            }
          })
          .sort((a, b) => new Date(a.approvedAt).getTime() - new Date(b.approvedAt).getTime())
        setApprovedNoOrder(items)
        void loadThumbs(items.map((i) => i.proofId))
        // The shared "why is this still here" notes for the visible worklist
        // (migration 000296). Bounded — the table only holds notes for proofs
        // still awaiting a link. Replaces the whole map so a refetch (e.g. after
        // a link is sent) drops notes whose proofs have left the worklist.
        const noteProofIds = items.map((i) => i.proofId)
        if (noteProofIds.length > 0) {
          const { data: noteRows } = await supabase
            .from('order_link_notes')
            .select('proof_id, note, created_by_name, created_by_initials, created_by_colour, updated_at')
            .in('proof_id', noteProofIds)
          if (!cancelled) {
            setNotesByProof(
              Object.fromEntries(
                ((noteRows ?? []) as {
                  proof_id: string
                  note: string
                  created_by_name: string | null
                  created_by_initials: string | null
                  created_by_colour: string | null
                  updated_at: string
                }[]).map((r) => [
                  r.proof_id,
                  { note: r.note, byName: r.created_by_name, byInitials: r.created_by_initials, byColour: r.created_by_colour, updatedAt: r.updated_at },
                ]),
              ),
            )
          }
        } else if (!cancelled) {
          setNotesByProof({})
        }
      })()
      // Artwork check chips (000336): only meaningful once the feature is live
      // — in shadow the reports exist but stay invisible, matching the review
      // page's contract. Tolerant read: any failure just keeps chips off.
      void supabase.from('settings').select('artwork_check_mode').eq('id', 1).maybeSingle().then(({ data }) => {
        setArtworkChipsOn((data as { artwork_check_mode?: string | null } | null)?.artwork_check_mode === 'live')
      })
      void supabase.schema('public').from('outsourced_suppliers').select('id, name').then(({ data }) => {
        if (cancelled || !data) return
        setSupplierNames(Object.fromEntries((data as { id: string; name: string }[]).map((s) => [s.id, s.name])))
      })
      const { data } = await supabase
        .from('orders')
        .select(SELECT)
        .in('status', ['sent', 'paid', 'fulfilled', 'revision'])
        .order('sent_at', { ascending: false })
        .limit(300)
      if (cancelled) return
      const rows = (data ?? []) as unknown as OrderRow[]
      setOrders(rows)
      setCapped(rows.length >= 300)
      setLoading(false)

      // The current version of each order's proof, so "Re-send link" can post on
      // the Help Scout thread (send-helpscout-reply requires a version_id).
      const proofIds = Array.from(new Set(rows.map((r) => r.proof_id).filter(Boolean)))
      if (proofIds.length > 0) {
        void supabase
          .from('proof_versions')
          .select('id, proof_id')
          .in('proof_id', proofIds)
          .eq('is_current', true)
          .then(({ data: versionRows, error: versionErr }) => {
            if (cancelled) return
            if (versionErr) { console.error('[orders] current versions failed', versionErr); return }
            setCurrentVersionByProof(
              Object.fromEntries(
                (versionRows as { id: string; proof_id: string }[]).map((v) => [v.proof_id, v.id]),
              ),
            )
          })
      }

      // The combined-payment groups those orders belong to (banner + actions).
      const groupIds = Array.from(new Set(rows.map((r) => r.order_group_id).filter((g): g is string => !!g)))
      if (groupIds.length > 0) {
        void supabase
          .from('order_groups')
          .select('id, status, currency, token, payment_reference, expires_at, pay_link_opened_at, xero_invoice_id, xero_invoice_error, amount_us_tariff, us_tariff_opted_out')
          .in('id', groupIds)
          .then(({ data: groupRows }) => {
            if (cancelled || !groupRows) return
            setGroups(Object.fromEntries((groupRows as unknown as OrderGroupRow[]).map((g) => [g.id, g])))
          })
      } else {
        setGroups({})
      }
      // Selection can't survive a refetch — a ticked order may have changed.
      setGroupSelect(new Set())
      setSelectMode(false)

      // Current-version material per proof — the Stock colour picker keys off
      // this (not the order's priced variant, which is null on a custom quote),
      // matching the material place-order reads when it composes the hand-off.
      const orderProofIds = Array.from(new Set(rows.map((r) => r.proof_id)))
      if (orderProofIds.length) {
        void supabase
          .from('proof_versions')
          .select('proof_id, materials(code)')
          .in('proof_id', orderProofIds)
          .eq('is_current', true)
          .then(({ data: pvm }) => {
            if (cancelled || !pvm) return
            // supabase-js types the embedded `materials` as possibly an array;
            // it's a to-one FK so at runtime it's a single object — normalise both.
            const pvRows = pvm as unknown as { proof_id: string; materials: { code: string | null } | { code: string | null }[] | null }[]
            setProofMaterialCodes(Object.fromEntries(
              pvRows.map((r) => {
                const m = Array.isArray(r.materials) ? r.materials[0] : r.materials
                return [r.proof_id, m?.code ?? null]
              }),
            ))
          })
      }

      // Chase cadence + on/off, for the "next reminder due" line, plus the comms
      // grace window (shared with the proof chase) so a grace pause can name when
      // it lifts. Best-effort; both reads run in parallel.
      void Promise.all([
        supabase
          .from('settings')
          .select('order_reminders_max, order_reminder_interval_days, auto_order_reminders_enabled')
          .eq('id', 1)
          .maybeSingle(),
        supabase
          .from('site_settings')
          .select('needs_attention_rules')
          .eq('id', 1)
          .maybeSingle(),
      ]).then(([{ data: s }, { data: site }]) => {
        if (cancelled || !s) return
        const rules = (site?.needs_attention_rules ?? {}) as Record<string, unknown>
        const graceDays = Math.max(0, Number(rules['helpscout_reply_grace_days'] ?? 3))
        setCadence({
          max: Math.min(5, Math.max(1, Number(s.order_reminders_max ?? 3))),
          intervalDays: Math.min(30, Math.max(1, Number(s.order_reminder_interval_days ?? 3))),
          autoEnabled: s.auto_order_reminders_enabled === true,
          graceDays: Number.isFinite(graceDays) ? graceDays : 3,
        })
      })

      const sentIds = rows.filter((r) => r.status === 'sent').map((r) => r.id)
      if (sentIds.length > 0) {
        // Pull the full ledger (not just sends) so a skip / failure surfaces
        // on the card rather than the chase just going quiet.
        const { data: nudgeData } = await supabase
          .from('order_nudges')
          .select('order_id, reminder_no, state, outcome, created_at')
          .in('order_id', sentIds)
        if (!cancelled && nudgeData) {
          const byOrder = new Map<string, { reminder_no: number; state: string; outcome: string | null; created_at: string }[]>()
          for (const n of nudgeData as { order_id: string; reminder_no: number; state: string; outcome: string | null; created_at: string }[]) {
            const arr = byOrder.get(n.order_id) ?? []
            arr.push(n)
            byOrder.set(n.order_id, arr)
          }
          const map: Record<string, ReminderSummary> = {}
          for (const [orderId, list] of byOrder) {
            list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) // newest first
            const sentRows = list.filter((r) => r.state === 'sent')
            const latest = list[0]
            const latestOutcome =
              latest && (latest.state === 'failed' || latest.state === 'skipped')
                ? latest.outcome
                : null
            map[orderId] = {
              sentCount: sentRows.length,
              lastSentAt: sentRows.length > 0 ? sentRows[0].created_at : null,
              highestSentNo: sentRows.reduce((m, r) => Math.max(m, r.reminder_no), 0),
              latestOutcome,
            }
          }
          setReminders(map)
        }
      }

      // Thumbnails for every order card that shows one: paid (To order),
      // revision (Being revised), and sent (Awaiting payment). The Links-to-send
      // worklist's thumbnails are loaded in the approved-no-order block above.
      await loadThumbs(
        Array.from(new Set(
          rows
            .filter((r) => r.status === 'paid' || r.status === 'revision' || r.status === 'sent')
            .map((r) => r.proof_id),
        )),
      )
    })()
    return () => { cancelled = true }
  }, [reloadKey])

  // Thumbnail for an ORDER card: the newest artwork in the ORDER's material,
  // falling back to the proof's current-version thumbnail. The two only differ
  // when a proof carries orders in more than one material — without this, a
  // steel order wears the letterpress artwork that happens to be current. The
  // Being-revised card deliberately does NOT use this: its job is to show the
  // artwork that will replace what was bought, i.e. always the current version.
  function thumbForOrder(o: OrderRow): ThumbInfo | null {
    return (o.material_id ? materialThumbs[`${o.proof_id}:${o.material_id}`] : undefined) ?? thumbs[o.proof_id] ?? null
  }

  // Jump from a Fix pointer row to the order's card further down the page:
  // clear any search that could hide it, make sure the section holding it is
  // open, then scroll to it and ring it briefly.
  //
  // Since the stage filter was retired every work row is always on the page, so
  // this no longer has to focus a section — it only has to OPEN one, because
  // Waiting and Recently ordered are collapsed by default and a jump into a
  // closed section would otherwise scroll to nothing.
  function jumpToOrder(orderId: string, section: ViewKey) {
    setSearch('')
    if (section === 'awaiting') setWaitingOpen(true)
    setFlashOrderId(orderId)
    window.setTimeout(() => {
      document.getElementById(`order-card-${orderId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    window.setTimeout(() => setFlashOrderId((v) => (v === orderId ? null : v)), 2600)
  }

  // Same jump, for an order that has already been placed — those live in the
  // Recently-ordered list, which starts collapsed, so open it before scrolling.
  // (It no longer has to clear a stage filter: that filter is gone, and every
  // section is always on the page.)
  function jumpToPlacedOrder(orderId: string) {
    setSearch('')
    setRecentOpen(true)
    setFlashOrderId(orderId)
    window.setTimeout(() => {
      document.getElementById(`order-card-${orderId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    window.setTimeout(() => setFlashOrderId((v) => (v === orderId ? null : v)), 2600)
  }

  // Persist a single order field (the date / Dropbox folder edits), merging into
  // local state so the gate + UI reflect it immediately. Returns whether the
  // write actually landed — these two fields gate placing the order, so a silent
  // failure must NOT leave the card showing a saved value the DB never got. On
  // failure we revert to the DB's truth (re-fetch the row) and report false so
  // the caller can show an inline error and keep the gate closed.
  async function saveOrderField(orderId: string, patch: Partial<OrderRow>): Promise<boolean> {
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, ...patch } : o)))
    const { error } = await supabase
      .from('orders')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', orderId)
    if (error) {
      // Revert the optimistic patch to whatever is actually persisted.
      const { data: fresh } = await supabase.from('orders').select(SELECT).eq('id', orderId).maybeSingle()
      if (fresh) {
        const row = fresh as unknown as OrderRow
        setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, ...row } : o)))
      }
      return false
    }
    return true
  }

  async function retryInvoice(o: OrderRow) {
    setBusyId(o.id)
    try {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; invoiceId?: string; error?: string }>(
        'retry-order-invoice',
        { body: { order_id: o.id } },
      )
      if (error || !data?.ok) {
        const msg = data?.error ?? error?.message ?? 'Could not create the invoice. Please try again.'
        setOrders((prev) => prev.map((r) => (r.id === o.id ? { ...r, xero_invoice_error: msg } : r)))
        return
      }
      const invoiceId = data.invoiceId ?? null
      setOrders((prev) =>
        prev.map((r) => (r.id === o.id ? { ...r, xero_invoice_id: invoiceId, xero_invoice_error: null } : r)),
      )
      void logAudit({
        action: 'order.invoice_retried',
        targetType: 'order',
        targetId: o.id,
        targetLabel: `Order ${o.payment_reference ?? o.id}`,
        afterValue: { xero_invoice_id: invoiceId },
      })
    } finally {
      setBusyId(null)
    }
  }

  // Finish a hand-off that stopped half way (docs/order-handoff-spec.md §3.4).
  // One call covers both stuck states, because both are fixed the same way —
  // by confirming the order again:
  //   · Stock Control wouldn't take it — nothing was written, nothing sent, so
  //     this simply places it again.
  //   · Stock Control took it but the note / supplier email never went — the
  //     place-order function recognises that and re-sends the message only. It
  //     cannot create a second job or email a supplier twice.
  // The supplier and any spoilage overs are replayed from the order so a
  // re-sent email matches the job already sitting in Stock Control.
  async function retryHandoff(o: OrderRow) {
    setHandoffBusyId(o.id)
    setHandoffErrors((prev) => {
      const next = { ...prev }
      delete next[o.id]
      return next
    })
    try {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; error?: string; code?: string }>(
        'place-order',
        {
          body: {
            order_id: o.id,
            mode: 'confirm',
            ...(o.supplier_id ? { supplier_id: o.supplier_id } : {}),
            ...(o.supplier_overs && o.supplier_overs > 0 ? { supplier_overs: o.supplier_overs } : {}),
          },
        },
      )
      // Failures come back as a non-2xx body on error.context, not in `data`.
      const body = data ?? (await readFnErrorBody(error))
      if (error || !data?.ok) {
        setHandoffErrors((prev) => ({
          ...prev,
          [o.id]: body?.error ?? error?.message ?? 'Couldn’t send it. Please try again.',
        }))
        return
      }
      // Pick up the new stamps so the chips and the panel settle immediately.
      // place-order writes its own audit rows, so nothing to log here.
      await refetchOrder(o.id)
    } finally {
      setHandoffBusyId(null)
    }
  }

  async function copyLink(o: OrderRow) {
    try {
      await navigator.clipboard.writeText(customerOrderUrl(o.id, o.token))
      setCopiedId(o.id)
      window.setTimeout(() => setCopiedId((c) => (c === o.id ? null : c)), 2000)
    } catch {
      // Clipboard blocked (rare on https) — designer can retry; no hard failure.
    }
  }

  async function reactivate(o: OrderRow) {
    setBusyId(o.id)
    try {
      const nextExpiry = new Date(Date.now() + ORDER_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
      const { error } = await supabase
        .from('orders')
        .update({ expires_at: nextExpiry, updated_at: new Date().toISOString() })
        .eq('id', o.id)
        .eq('status', 'sent')
      if (error) {
        void showAlert(`Could not reactivate the link: ${error.message}`)
        return
      }
      setOrders((prev) => prev.map((r) => (r.id === o.id ? { ...r, expires_at: nextExpiry } : r)))
      void logAudit({
        action: 'order.link_reactivated',
        targetType: 'order',
        targetId: o.id,
        targetLabel: `Order ${o.payment_reference ?? o.id}`,
        beforeValue: { expires_at: o.expires_at },
        afterValue: { expires_at: nextExpiry },
      })
      // Reactivating only moved the expiry — the customer was never told, and
      // a reactivated link has already spent its reminders, so nothing would
      // chase it. Go straight into the send step so the live link actually
      // reaches someone.
      setSendLinkFor({ ...o, expires_at: nextExpiry })
    } finally {
      setBusyId(null)
    }
  }

  // Cancel an unpaid order link (abort). Confirmed via the CancelOrderDialog,
  // where the designer chooses whether the customer is told: notify=true posts
  // the order_cancelled reply on the Help Scout thread (the edge function only
  // sends it when asked); notify=false cancels silently. order-lifecycle flips
  // sent→cancelled and writes the audit row server-side — so no client logAudit
  // here (that would double-log). The page never refetches, so drop the row
  // locally to remove the card.
  async function cancelOrder(o: OrderRow, notify: boolean) {
    setBusyId(o.id)
    setCancelError(null)
    try {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; status?: string; error?: string }>(
        'order-lifecycle',
        { body: { order_id: o.id, action: 'cancel', reason: 'abort', notify } },
      )
      if (error || !data?.ok) {
        setCancelError(`Could not cancel the order: ${error?.message ?? data?.error ?? 'unknown error'}`)
        return
      }
      setCancelTarget(null)
      setOrders((prev) => prev.filter((r) => r.id !== o.id))
    } finally {
      setBusyId(null)
    }
  }

  // ── Combined-payment group actions (bundle orders Slice 2) ─────────
  function toggleGroupSelect(orderId: string) {
    setGroupSelect((prev) => {
      const next = new Set(prev)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }

  async function copyGroupLink(g: OrderGroupRow) {
    try {
      await navigator.clipboard.writeText(customerOrderGroupUrl(g.id, g.token))
      setCopiedId(g.id)
      window.setTimeout(() => setCopiedId((c) => (c === g.id ? null : c)), 2000)
    } catch {
      // Clipboard blocked — designer can retry.
    }
  }

  async function reactivateGroup(g: OrderGroupRow) {
    setBusyId(g.id)
    try {
      const nextExpiry = new Date(Date.now() + ORDER_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
      const { error } = await supabase
        .from('order_groups')
        .update({ expires_at: nextExpiry, updated_at: new Date().toISOString() })
        .eq('id', g.id)
        .eq('status', 'sent')
      if (!error) {
        setGroups((prev) => ({ ...prev, [g.id]: { ...prev[g.id], expires_at: nextExpiry } }))
        void logAudit({
          action: 'order.link_reactivated',
          targetType: 'order_group',
          targetId: g.id,
          targetLabel: `Payment group ${g.payment_reference ?? g.id}`,
          beforeValue: { expires_at: g.expires_at },
          afterValue: { expires_at: nextExpiry },
        })
      }
    } finally {
      setBusyId(null)
    }
  }

  // Release one order back out of an unpaid group (its own pay link becomes
  // the live one again — "release a ready card early", spec §7.1).
  async function releaseFromGroup(o: OrderRow) {
    if (!o.order_group_id) return
    setBusyId(o.id)
    try {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; remaining?: number; error?: string }>(
        'order-group',
        { body: { action: 'release', group_id: o.order_group_id, order_id: o.id } },
      )
      if (error || !data?.ok) {
        void showAlert(`Could not release the order: ${data?.error ?? error?.message ?? 'unknown error'}`)
        return
      }
      setReloadKey((k) => k + 1)
    } finally {
      setBusyId(null)
    }
  }

  // Unwind a whole unpaid group — every order back to its own pay link.
  async function dissolveGroup(g: OrderGroupRow) {
    if (!(await confirm({
      title: 'Split this combined payment?',
      message: 'Each order goes back to its own pay link.',
      confirmLabel: 'Split them',
    }))) return
    setBusyId(g.id)
    try {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; released?: number; error?: string }>(
        'order-group',
        { body: { action: 'dissolve', group_id: g.id } },
      )
      if (error || !data?.ok) {
        void showAlert(`Could not split the combined payment: ${data?.error ?? error?.message ?? 'unknown error'}`)
        return
      }
      setReloadKey((k) => k + 1)
    } finally {
      setBusyId(null)
    }
  }

  async function retryGroupInvoice(g: OrderGroupRow) {
    setBusyId(g.id)
    try {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; invoiceId?: string; error?: string }>(
        'retry-order-invoice',
        { body: { group_id: g.id } },
      )
      if (error || !data?.ok) {
        const msg = data?.error ?? error?.message ?? 'Could not create the invoice. Please try again.'
        setGroups((prev) => ({ ...prev, [g.id]: { ...prev[g.id], xero_invoice_error: msg } }))
        return
      }
      setGroups((prev) => ({ ...prev, [g.id]: { ...prev[g.id], xero_invoice_id: data.invoiceId ?? null, xero_invoice_error: null } }))
    } finally {
      setBusyId(null)
    }
  }

  // After the record-offline-payment edge function flips a sent order to
  // paid/offline, refetch that single row so its newly-stamped amounts
  // (cards / tooling / shipping) are accurate. The useMemo re-buckets it from
  // Awaiting payment into To order automatically.
  async function refetchOrder(orderId: string) {
    const { data } = await supabase.from('orders').select(SELECT).eq('id', orderId).maybeSingle()
    if (data) {
      const row = data as unknown as OrderRow
      setOrders((prev) => prev.map((r) => (r.id === orderId ? row : r)))
    }
  }

  // Put a paid order on hold, or take it off (migration 000377). Two rules from
  // that migration, both load-bearing:
  //
  //   · Never send held_by / held_by_name. The trigger stamps them from
  //     auth.uid() server-side, because proofs.profiles SELECT is self-or-admin
  //     — the browser cannot read a colleague's name to write it, and a
  //     client-supplied one would be spoofable on a row five people can edit.
  //   · A release is exactly `held_at = null`. The trigger nulls the reason,
  //     the attribution and the artwork-flag snapshot itself, so sending the one
  //     field can't trip orders_hold_shape_check.
  //
  // Refetched rather than patched locally: the name the band is about to show
  // is written by the database, so only a read-back can know it.
  async function applyHold(order: OrderRow, mode: 'put' | 'take_off', reason: string) {
    setHoldBusy(true)
    setHoldError(null)
    const now = new Date().toISOString()
    const patch =
      mode === 'put'
        ? { held_at: now, hold_reason: reason, updated_at: now }
        : { held_at: null, updated_at: now }
    // Awaited, so the lazy PostgREST builder actually runs and its error is
    // seen — a bare `void supabase.from(...)` here would send nothing at all.
    const { error } = await supabase.from('orders').update(patch).eq('id', order.id)
    if (error) {
      setHoldBusy(false)
      // The raw PostgREST string is jargon to a non-coder ("JWT expired", "new
      // row for relation \"orders\" violates check constraint …"), and the
      // realistic causes here are a lapsed session or a dropped connection.
      // Keep the detail in the console for diagnosis, not in Rob's face.
      console.error('[orders] hold write failed:', error)
      setHoldError('Couldn’t save that. Check your connection, and if it keeps happening sign out and back in.')
      return
    }
    await refetchOrder(order.id)
    setHoldBusy(false)
    setHoldTarget(null)
    void logAudit({
      action: mode === 'put' ? 'order.held' : 'order.hold_cleared',
      targetType: 'order',
      targetId: order.id,
      targetLabel: `Order ${order.payment_reference ?? order.id}`,
      beforeValue: mode === 'put' ? null : { hold_reason: order.hold_reason },
      afterValue: mode === 'put' ? { hold_reason: reason } : null,
    })
  }

  // Add or replace the shared note on a Links-to-send card. Upsert keyed on
  // proof_id (one note per proof); the DB trigger stamps the editor's identity +
  // updated_at, which we read back so the card updates without a refetch. RLS
  // requires created_by = auth.uid(), so a missing session / blank note is a
  // no-op. Returns false on failure so the editor can keep its draft open.
  async function saveLinkNote(proofId: string, text: string): Promise<boolean> {
    const body = text.trim()
    if (!userId || body.length === 0) return false
    const { data, error } = await supabase
      .from('order_link_notes')
      .upsert({ proof_id: proofId, note: body, created_by: userId }, { onConflict: 'proof_id' })
      .select('note, created_by_name, created_by_initials, created_by_colour, updated_at')
      .single()
    if (error || !data) return false
    const row = data as {
      note: string
      created_by_name: string | null
      created_by_initials: string | null
      created_by_colour: string | null
      updated_at: string
    }
    setNotesByProof((prev) => ({
      ...prev,
      [proofId]: { note: row.note, byName: row.created_by_name, byInitials: row.created_by_initials, byColour: row.created_by_colour, updatedAt: row.updated_at },
    }))
    return true
  }

  // Clear a note — anyone can, it's a shared transient annotation.
  async function clearLinkNote(proofId: string): Promise<boolean> {
    const { error } = await supabase.from('order_link_notes').delete().eq('proof_id', proofId)
    if (error) return false
    setNotesByProof((prev) => {
      const next = { ...prev }
      delete next[proofId]
      return next
    })
    return true
  }

  // Open the order builder inline for an approved-but-unordered proof. The
  // worklist row already carries the proof-level fields; the one thing it lacks
  // is the current version's variant / option / currency / names, so fetch that,
  // then hand the modal fully-hydrated props (it doesn't self-fetch these). On a
  // missing version we bail to the proof page rather than open a broken modal.
  async function openOrderBuilder(item: ApprovedNoOrderItem) {
    setPreparingProofId(item.proofId)
    try {
      const { data: v, error } = await supabase
        .from('proof_versions')
        .select('id, material_id, displayed_variant_ids, material_options, currency, has_personalisation, custom_quote, names')
        .eq('proof_id', item.proofId)
        .eq('is_current', true)
        .maybeSingle()
      if (error || !v) {
        void showAlert('Could not load this proof to start an order. Open the proof and use Create order there.')
        return
      }
      const ver = v as {
        id: string
        material_id: string | null
        displayed_variant_ids: string[] | null
        material_options: string[] | null
        currency: string | null
        has_personalisation: boolean | null
        custom_quote: boolean | null
        names: string[] | null
      }
      setOrderBuilder({
        proofId: item.proofId,
        currentVersionId: ver.id,
        materialId: ver.material_id ?? null,
        displayedVariantIds: ver.displayed_variant_ids ?? [],
        materialOptionCodes: ver.material_options ?? [],
        customerLabel: item.label,
        materialDisplay: item.materialDisplay,
        currency: (ver.currency as Currency | null) ?? null,
        namesCount: ver.names?.length ?? 0,
        hasPersonalisation: !!ver.has_personalisation,
        versionIsCustomQuote: !!ver.custom_quote,
        hasHelpScoutConversation: item.hasHelpscoutConversation,
      })
    } finally {
      setPreparingProofId(null)
    }
  }

  // The search box narrows every section at once; the view tabs pick which
  // section(s) render. Buckets recompute only when the orders or query change.
  const hasInvoiceProblem = (o: OrderRow) => !o.xero_invoice_id && !!o.xero_invoice_error
  const { awaitingPayment, toOrder, recentlyOrdered, beingRevised } = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = orders.filter((o) => matchesSearch(o, q))
    return {
      // Awaiting payment: expired links (need reactivating) float up, then
      // NEWEST first — a just-created order lands at the top of the section,
      // right under the Combine-payments control (Rob, 9 Jul). The oldest
      // unpaid chases still surface via the Cold sidebar.
      awaitingPayment: filtered
        .filter((o) => o.status === 'sent')
        .sort((a, b) => {
          const ae = isExpired(a) ? 0 : 1
          const be = isExpired(b) ? 0 : 1
          if (ae !== be) return ae - be
          return new Date(b.sent_at ?? 0).getTime() - new Date(a.sent_at ?? 0).getTime()
        }),
      // To order: paid (or a revision the customer has re-approved), not yet
      // placed. A blocking problem (failed invoice) floats to the top;
      // otherwise newest-paid-first so the most recently paid order sits at
      // the top.
      toOrder: filtered
        .filter(isPlaceable)
        .sort((a, b) => {
          const ap = hasInvoiceProblem(a) ? 0 : 1
          const bp = hasInvoiceProblem(b) ? 0 : 1
          if (ap !== bp) return ap - bp
          return new Date(b.paid_at ?? b.sent_at ?? 0).getTime() - new Date(a.paid_at ?? a.sent_at ?? 0).getTime()
        }),
      recentlyOrdered: filtered.filter((o) => o.status === 'fulfilled').slice(0, 30),
      // Orders parked while the proof is being redesigned. Only the ones still
      // waiting on the customer — once they re-approve, the order is ready to
      // place and moves up to PLACE with the rest of the work.
      beingRevised: filtered.filter(isAwaitingReapproval),
    }
  }, [orders, search])

  // The "Links to send" worklist, filtered by the shared search box and sorted
  // oldest- or newest-approved. approvedNoOrder is already oldest-first from the
  // fetch; the memo re-sorts so the toggle is instant.
  const filteredLinks = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matched = q
      ? approvedNoOrder.filter((i) =>
          // The shared note is the most distinctive free text on a card ("waiting
          // on metal thickness"), so let staff find a card by what they jotted.
          [i.label, i.contactName, i.contactEmail, i.materialDisplay, notesByProof[i.proofId]?.note]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(q),
        )
      : approvedNoOrder
    return [...matched].sort((a, b) => {
      const at = new Date(a.approvedAt).getTime()
      const bt = new Date(b.approvedAt).getTime()
      return linksSort === 'oldest' ? at - bt : bt - at
    })
  }, [approvedNoOrder, search, linksSort, notesByProof])


  // Combined-payment derivations (bundle orders Slice 2). Eligible = the
  // awaiting-payment orders the combine action could actually group; active
  // groups = the unpaid groups whose members are in the list (each gets a
  // banner above the cards). The modal receives display-ready candidates.
  const eligibleForGroup = awaitingPayment.filter(canJoinGroup)
  const selectedCandidates: GroupCandidate[] = awaitingPayment
    .filter((o) => groupSelect.has(o.id))
    .map((o) => ({
      id: o.id,
      proofId: o.proof_id,
      label: customerLabel(o),
      // Flag open choices so the designer sees which cards the customer will
      // configure on the group page (same phrasing as the pay-link rows).
      spec:
        specLabel(o) +
        (o.thickness_open && o.material_variant_id == null ? ' · customer picks thickness' : '') +
        (o.finish_open && o.material_option_id == null ? ' · customer picks finish' : '') +
        (o.quantity_open && o.quantity == null ? ' · customer picks quantity' : ''),
      quantity: o.quantity,
      currency: o.currency,
      reference: o.payment_reference,
      shipDestCountry: o.ship_dest_country,
      hasHelpScoutConversation: !!o.proofs?.helpscout_conversation_id,
    }))
  const activeGroups = Object.values(groups)
    .filter((g) => g.status === 'sent' && awaitingPayment.some((o) => o.order_group_id === g.id))
    .sort((a, b) => (a.payment_reference ?? '').localeCompare(b.payment_reference ?? ''))
  // Members of an active (unpaid) group render NESTED inside their group's
  // block, so the grouping reads as containment; everything else renders as a
  // standalone card in the list below the blocks.
  const groupedAwaitingIds = new Set(
    activeGroups.flatMap((g) => awaitingPayment.filter((o) => o.order_group_id === g.id).map((o) => o.id)),
  )
  const ungroupedAwaiting = awaitingPayment.filter((o) => !groupedAwaitingIds.has(o.id))

  // ── Work vs waiting ────────────────────────────────────────────────────────
  // The one question that decides where a row goes: if nobody opens this page
  // today, does something go wrong? An unpaid link is NOT work by default —
  // send-order-reminders has chased them automatically since 28 June 2026, and
  // each card says so ("Next reminder due …"). A person is needed only when the
  // automation has run out of road or the customer has spoken.
  //
  // The predicate lives in src/lib/ordersTriage.ts with tests proving the two
  // buckets are exact complements: collapsing rows into WAITING is the one
  // change here that could genuinely lose work, so the split is property-tested
  // rather than trusted. One call returns both lists, so they can't drift.
  const triageOf = (o: OrderRow): TriageOrder => ({
    expired: isExpired(o),
    remindersSent: reminders[o.id]?.highestSentNo ?? 0,
    // The customer used "Not sure? Ask us" on the pay page (000298). Nothing
    // automatic answers a question, so this always wants a person.
    askedForHelp: o.help_requested_at != null,
  })
  const { needsYou: awaitingNeedsYou, waiting: awaitingHealthy } = splitByChaseNeed(
    ungroupedAwaiting,
    triageOf,
    cadence.max,
  )
  const chaseReasonFor = (o: OrderRow) => chaseReason(triageOf(o), cadence.max)
  // A group whose own link has expired needs a person; the automatic chaser
  // skips grouped orders entirely, so an expired group is chased by nothing.
  const groupIsExpired = (g: OrderGroupRow) => groupNeedsAttention(g.expires_at)
  const groupsNeedingYou = activeGroups.filter(groupIsExpired)
  const groupsWaiting = activeGroups.filter((g) => !groupIsExpired(g))
  // Paid orders whose invoice failed live in PLACE (you must place them
  // regardless) and appear in Fix as a pointer row that jumps to the card.
  const invoiceFailedOrders = toOrder.filter(hasInvoiceProblem)
  const waitingCountShown = awaitingHealthy.length + groupsWaiting.length + beingRevised.length

  // A being-revised order's card. Extracted only so the Waiting block can render
  // it without duplicating a dozen props — identical to the card the standalone
  // "Being revised" section used before it moved in there.
  const revisedCard = (o: OrderRow) => (
    <OrderCard
      order={o}
      thumb={thumbs[o.proof_id] ?? null}
      route={routeOf(o)}
      supplierLabels={allowedSupplierLabels(o, supplierNames)}
      supplierCount={o.material_variants?.materials?.outsourced_supplier_ids?.length ?? 0}
      suggested={suggestedDate(o)}
      proofMaterialCode={proofMaterialCodes[o.proof_id] ?? null}
      busy={busyId === o.id}
      copied={copiedId === o.id}
      onReview={() => navigate(`/orders/${o.id}/place`)}
      onCopy={() => void copyLink(o)}
      onSaveField={(patch) => saveOrderField(o.id, patch)}
      onRetryInvoice={() => void retryInvoice(o)}
      handoffBusy={handoffBusyId === o.id}
      handoffError={handoffErrors[o.id] ?? null}
      onRetryHandoff={() => void retryHandoff(o)}
      showArtworkChip={artworkChipsOn}
      onOpenArtworkReport={() => void openArtworkReport(o)}
      /* Holds work here too. A revision order becomes placeable again the
         moment the customer approves the new version — while still being
         'revision' — so a question arising at that point needs the same block
         a paid order gets. */
      onHold={(mode) => { setHoldError(null); setHoldTarget({ order: o, mode }) }}
      usTariff={usTariffDutyBilling(o.order_group_id ? groups[o.order_group_id] ?? o : o)}
    />
  )

  // Whole-pipeline counts for the header tiles (unfiltered — the header is a
  // status overview, independent of the queue's search/filter). The £ on To
  // order is the one figure that's real: paid money awaiting placement.
  const sentAll = orders.filter((o) => o.status === 'sent')
  // Same two predicates the sections use, so the header can't drift from the
  // list below it. paidAll therefore includes re-approved revisions — they ARE
  // paid money awaiting placement, which is exactly what the £ figure claims to
  // count, and they now sit in PLACE where that figure points.
  const paidAll = orders.filter(isPlaceable)
  const revisionCount = orders.filter(isAwaitingReapproval).length

  // Orders that reached Stock Control but whose workshop note / supplier email
  // never went (docs/order-handoff-spec.md §3.4). Nobody is making these until
  // the message goes, and nothing else on the page would say so — the order has
  // already dropped out of "To order" into the collapsed Recently-ordered list.
  const unsentMessageItems = orders.flatMap((o) => {
    const state = handoffState(o)
    if (state.kind !== 'unsent') return []
    return [{
      orderId: o.id,
      label: o.stock_order_number ? `Order ${o.stock_order_number} · ${customerLabel(o)}` : customerLabel(o),
      reason: `In Stock Control, but the ${handoffMessageName(state.what)} wasn’t sent.`,
      busy: handoffBusyId === o.id,
      error: handoffErrors[o.id] ?? null,
    }]
  })
  const fixCount =
    unsentMessageItems.length + invoiceFailedOrders.length + groupsNeedingYou.length + awaitingNeedsYou.length

  // The summary line's two figures, computed from the SAME splits the sections
  // below use, over the UNFILTERED order list, and counting ROWS rather than
  // orders — a combined payment is one row holding several orders. Counting
  // orders instead made the header disagree with the section headings, which is
  // exactly the tile-vs-list drift the dashboard has been bitten by twice.
  const sentGroupedIds = new Set(
    Object.values(groups)
      .filter((g) => g.status === 'sent')
      .flatMap((g) => sentAll.filter((o) => o.order_group_id === g.id).map((o) => o.id)),
  )
  const sentUngroupedAll = sentAll.filter((o) => !sentGroupedIds.has(o.id))
  const sentNeedsYouAll = splitByChaseNeed(sentUngroupedAll, triageOf, cadence.max).needsYou
  const sentGroupsAll = Object.values(groups).filter(
    (g) => g.status === 'sent' && sentAll.some((o) => o.order_group_id === g.id),
  )
  // invoiceFailedOrders is deliberately NOT added: those rows are status 'paid'
  // and already inside paidAll, and their Fix entry is only a pointer to the
  // card in PLACE. unsentMessageItems IS added — those are status 'fulfilled',
  // so they overlap nothing else here.
  const toDoCount =
    sentNeedsYouAll.length +
    sentGroupsAll.filter(groupIsExpired).length +
    approvedNoOrder.length +
    paidAll.length +
    unsentMessageItems.length
  const waitingCount =
    sentUngroupedAll.length -
    sentNeedsYouAll.length +
    sentGroupsAll.filter((g) => !groupIsExpired(g)).length +
    revisionCount

  return (
    <DesignerChrome active="orders">
      {confirmDialog}
      {sendLinkFor && (
        <SendPayLinkModal
          open
          order={{
            id: sendLinkFor.id,
            proof_id: sendLinkFor.proof_id,
            token: sendLinkFor.token,
            current_version_id: currentVersionByProof[sendLinkFor.proof_id] ?? null,
          }}
          customerLabel={customerLabel(sendLinkFor)}
          // Every order on this list has had a link created; sent_at is
          // stamped at creation, so anything here is a re-send.
          resend
          onSent={() => setReloadKey((k) => k + 1)}
          onClose={() => setSendLinkFor(null)}
        />
      )}
      <div className="mx-auto max-w-[1320px] px-4 py-8 sm:px-7">
        <h1 className="text-xl font-semibold text-ink">Orders</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Send pay links, chase payment, and place paid orders — then hand them to Stock Control.
        </p>

        {loading ? (
          <p className="mt-8 text-sm text-ink-mute">Loading orders…</p>
        ) : (
          /* Single column. The right-hand "Needs action" sidebar is gone — its
             rows are the FIX section now, with the fix on the row itself. The
             panel's idea was the best thing on this page, but a 320px static
             column was the wrong container: it used ~6% of its own height,
             scrolled away for good, and between 768 and 1023px it rendered
             full-width above everything, pushing the whole queue below the fold
             (its desktop/mobile split keyed on `md` while this layout only
             became two-column at `lg`). Dropping the column removes that whole
             class of bug rather than patching the breakpoint. */
          <div className="mt-6">
            <div className="min-w-0">
            {(orders.length > 0 || approvedNoOrder.length > 0) && (
              /* One line of plain text where four tappable tiles used to be.
                 The tiles counted a page you're already standing on — every
                 figure was repeated in the section heading a scroll below, and
                 a count can't tell you what to do next — so they were deleted
                 along with the stage filter they doubled as. What survives is
                 the only genuinely useful pair: how much is waiting on you, and
                 the one money figure that's real (paid, awaiting placement).
                 Awaiting-payment value is deliberately absent: most links are
                 open-quantity, so it isn't knowable until checkout.
                 Deliberately not a button and not a box — nothing left to
                 ignore. The conversion-rate line moved to Admin → Analytics,
                 where the rest of the funnel figures live. */
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-ink-soft">
                <span className="whitespace-nowrap">
                  <span className="font-semibold text-ink">{toDoCount}</span> to do
                </span>
                <span aria-hidden="true" className="text-ink-dim">·</span>
                <span className="whitespace-nowrap">
                  <span className="font-semibold text-ink">{waitingCount}</span> waiting
                </span>
                {paidAll.length > 0 && (
                  <>
                    <span aria-hidden="true" className="text-ink-dim">·</span>
                    <span className="whitespace-nowrap">
                      <span className="font-semibold text-ink">{gbpLabel(sumGbp(paidAll, rates))}</span> paid and
                      waiting to be placed
                    </span>
                  </>
                )}
              </p>
            )}

            {(orders.length > 0 || approvedNoOrder.length > 0) && (
              <>
                <div className="mt-4">
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search customer, reference or project…"
                    className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] sm:max-w-xs"
                  />
                </div>

                {capped && (
                  <p className="mt-3 text-[12px] text-ink-mute">
                    Showing the 300 most recent orders. Older orders are in Admin → Order log.
                  </p>
                )}
              </>
            )}

            {search.trim() &&
              filteredLinks.length + awaitingPayment.length + toOrder.length + beingRevised.length + recentlyOrdered.length === 0 && (
                <PanelShell className="mt-6 text-center">
                  <p className="text-sm text-ink-soft">No orders match “{search.trim()}”.</p>
                </PanelShell>
              )}

            {/* ── FIX ───────────────────────────────────────────────────────
                Gone wrong or gone quiet, across every stage. This is the old
                right-hand "Needs action" sidebar promoted to the top of the
                page: the panel's idea was right (look across all stages, show
                only exceptions) but it lived in a 320px static column that was
                ~6% used, scrolled away for good, and rendered full-width and
                broken between 768 and 1023px.

                Renders nothing at all, heading included, when the list is
                empty, so a good day opens straight onto SEND. */}
            {fixCount > 0 && (
              <section className="mt-6">
                <div className={SECTION_HEADER_STICKY}>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-out">
                    Fix · {fixCount}
                  </h2>
                  <p className="mt-1 text-[13px] text-ink-mute">
                    Gone wrong or gone quiet — the automatic chaser can't clear these.
                  </p>
                </div>

                {/* First: an order the workshop or the supplier hasn't been told
                    about. The customer has paid and nothing is being made, so
                    this outranks everything else here. Carries its own send
                    button (docs/order-handoff-spec.md §3.4). */}
                {unsentMessageItems.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {unsentMessageItems.map((i) => (
                      <div
                        key={`fix-msg-${i.orderId}`}
                        className="rounded-xl border border-l-[3px] border-line border-l-[var(--c-critical)] bg-surface px-4 py-3"
                      >
                        <p className="text-sm text-ink">
                          <span className="font-semibold">Not sent to production</span>
                          <span className="text-ink-soft"> — {i.label}</span>
                        </p>
                        <p className="mt-0.5 text-[12.5px] text-ink-mute">{i.reason}</p>
                        {i.error && <p className="mt-0.5 break-words text-[12.5px] text-out">{i.error}</p>}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <ButtonInk
                            size="sm"
                            disabled={i.busy}
                            onClick={() => {
                              const o = orders.find((r) => r.id === i.orderId)
                              if (o) void retryHandoff(o)
                            }}
                            className="max-md:h-11"
                          >
                            {i.busy ? 'Sending…' : 'Send it now'}
                          </ButtonInk>
                          <ButtonGhost size="sm" onClick={() => jumpToPlacedOrder(i.orderId)} className="max-md:h-11">
                            Go to it
                          </ButtonGhost>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Paid orders whose invoice failed keep their canonical home in
                    PLACE (they must be placed regardless), so Fix carries a
                    pointer row that jumps to and rings the card. */}
                {invoiceFailedOrders.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {invoiceFailedOrders.map((o) => (
                      <div
                        key={`fix-inv-${o.id}`}
                        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-l-[3px] border-line border-l-[var(--c-critical)] bg-surface px-4 py-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-ink">
                            <span className="font-semibold">Invoice didn't go out</span>
                            <span className="text-ink-soft"> — {customerLabel(o)}</span>
                          </p>
                          <p className="mt-0.5 text-[12.5px] text-ink-mute">
                            Paid, but Xero rejected the invoice. Fix it on the card below.
                          </p>
                        </div>
                        <ButtonGhost size="sm" onClick={() => jumpToOrder(o.id, 'to_order')} className="max-md:h-11">
                          Go to it
                        </ButtonGhost>
                      </div>
                    ))}
                  </div>
                )}

                {/* An expired combined payment: the automatic chaser skips
                    grouped orders entirely, so nothing is chasing this. */}
                {groupsNeedingYou.map((g) => {
                  const memberOrders = awaitingPayment.filter((o) => o.order_group_id === g.id)
                  return (
                    <div
                      key={`fix-grp-${g.id}`}
                      className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-l-[3px] border-line border-l-[var(--c-out)] bg-surface px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-ink">
                          <span className="font-semibold">Combined pay link expired</span>
                          <span className="text-ink-soft"> — {g.payment_reference}</span>
                        </p>
                        <p className="mt-0.5 text-[12.5px] text-ink-mute">
                          {memberOrders.length} order{memberOrders.length === 1 ? '' : 's'} in one payment · expired{' '}
                          {g.expires_at ? formatDate(g.expires_at) : ''} · automatic reminders don't run on grouped orders
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <ButtonInk size="sm" onClick={() => void reactivateGroup(g)} disabled={busyId === g.id} className="max-md:h-11">
                          {busyId === g.id ? 'Reactivating…' : 'Reactivate link'}
                        </ButtonInk>
                        <ButtonGhost size="sm" onClick={() => void copyGroupLink(g)} className="max-md:h-11">
                          {copiedId === g.id ? 'Copied' : 'Copy link'}
                        </ButtonGhost>
                      </div>
                    </div>
                  )
                })}

                {/* Unpaid links the chaser can no longer help: expired, out of
                    reminders, or the customer asked a question. Full cards, not
                    pointers — every action that clears them is already on one. */}
                <div className="mt-3 space-y-3">
                  {awaitingNeedsYou.map((o) => (
                    /* The reason and its card read as one unit: a shared left
                       accent ties "why this is here" to the card that clears it,
                       rather than leaving a red sentence floating above an
                       otherwise ordinary card. */
                    <div key={o.id} id={`order-card-${o.id}`} className="border-l-[3px] border-l-[var(--c-out)] pl-3">
                      <p className="mb-1.5 text-[12.5px] font-medium text-out">{chaseReasonFor(o)}</p>
        <AwaitingPaymentCard
                        order={o}
                        thumb={thumbForOrder(o)}
                        expired={isExpired(o)}
                        busy={busyId === o.id}
                        copied={copiedId === o.id}
                        flash={flashOrderId === o.id}
                        summary={reminders[o.id] ?? null}
                        cadence={cadence}
                        group={o.order_group_id ? groups[o.order_group_id] ?? null : null}
                        selectable={selectMode && canJoinGroup(o)}
                        selected={groupSelect.has(o.id)}
                        onToggleSelect={() => toggleGroupSelect(o.id)}
                        onRelease={() => void releaseFromGroup(o)}
                        onCopy={() => void copyLink(o)}
                        onReactivate={() => void reactivate(o)}
                        onSendLink={() => setSendLinkFor(o)}
                        onEdit={() => setEditingOrder(o)}
                        onCancel={() => { setCancelNotify(true); setCancelError(null); setCancelTarget(o) }}
                        onRecordOffline={() => setRecordOffline(o)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {filteredLinks.length > 0 && (
              <section className="mt-6">
                <div className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 ${SECTION_HEADER_STICKY}`}>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink">
                    Send · {filteredLinks.length}
                  </h2>
                  <label className="flex items-center gap-2">
                    <span className="text-[12px] text-ink-mute">Sort</span>
                    <select
                      value={linksSort}
                      onChange={(e) => setLinksSort(e.target.value as 'oldest' | 'newest')}
                      className="h-8 rounded-lg border border-line bg-surface px-2 text-[12px] text-ink-soft focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                    >
                      <option value="oldest">Oldest approved first</option>
                      <option value="newest">Newest approved first</option>
                    </select>
                  </label>
                </div>
                <p className="mt-1 text-[13px] text-ink-mute">
                  Approved proofs with no order link sent yet. Work down the list and send each customer their link.
                </p>
                <div className="mt-3 space-y-3">
                  {filteredLinks.map((item) => (
                    <LinkToSendCard
                      key={item.proofId}
                      item={item}
                      thumb={thumbs[item.proofId] ?? null}
                      preparing={preparingProofId === item.proofId}
                      canCreateOrder={orderingEnabled === true}
                      onCreate={() => void openOrderBuilder(item)}
                      note={notesByProof[item.proofId] ?? null}
                      canEditNote={userId != null}
                      onSaveNote={(text) => saveLinkNote(item.proofId, text)}
                      onClearNote={() => clearLinkNote(item.proofId)}
                    />
                  ))}
                </div>
              </section>
            )}

            {(toOrder.length > 0 || !search.trim()) && (
              <section className="mt-10">
                <div className={`flex items-baseline justify-between gap-3 ${SECTION_HEADER_STICKY}`}>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink">
                    Place · {toOrder.length}
                    {toOrder.length > 0 ? ` · ${gbpLabel(sumGbp(toOrder, rates))}` : ''}
                  </h2>
                  {toOrder.length > 0 && <span className="text-[12px] text-ink-mute">Newest paid first</span>}
                </div>

                {/* A paid combined payment whose ONE Xero invoice failed: the
                    error lives on the GROUP (not any member order), so surface
                    + retry it here where its paid members now sit. */}
                {Object.values(groups)
                  .filter((g) => g.status === 'paid' && !g.xero_invoice_id && !!g.xero_invoice_error && toOrder.some((o) => o.order_group_id === g.id))
                  .map((g) => (
                    <div key={g.id} className="mt-3 rounded-xl border border-out bg-out-soft px-4 py-3">
                      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-ink">
                            Combined payment {g.payment_reference} — invoice failed
                          </p>
                          <p className="mt-0.5 break-words text-[13px] text-ink-soft">{friendlyInvoiceError(g.xero_invoice_error)}</p>
                        </div>
                        <ButtonInk size="sm" onClick={() => void retryGroupInvoice(g)} disabled={busyId === g.id} className="shrink-0">
                          {busyId === g.id ? 'Retrying…' : 'Retry invoice'}
                        </ButtonInk>
                      </div>
                    </div>
                  ))}

                <div className="mt-3">
                  {toOrder.length === 0 ? (
                    !search.trim() && (
                      <PanelShell className="text-center">
                        <p className="text-sm text-ink-soft">Nothing waiting to be ordered right now.</p>
                      </PanelShell>
                    )
                  ) : (
                    <div className="space-y-4">
                      {toOrder.map((o) => (
                        <div key={o.id} id={`order-card-${o.id}`}>
                          <OrderCard
                            order={o}
                            thumb={thumbForOrder(o)}
                            route={routeOf(o)}
                            supplierLabels={allowedSupplierLabels(o, supplierNames)}
                            supplierCount={o.material_variants?.materials?.outsourced_supplier_ids?.length ?? 0}
                            suggested={suggestedDate(o)}
                            proofMaterialCode={proofMaterialCodes[o.proof_id] ?? null}
                            busy={busyId === o.id}
                            copied={copiedId === o.id}
                            flash={flashOrderId === o.id}
                            onReview={() => navigate(`/orders/${o.id}/place`)}
                            onCopy={() => void copyLink(o)}
                            onSaveField={(patch) => saveOrderField(o.id, patch)}
                            onRetryInvoice={() => void retryInvoice(o)}
                            handoffBusy={handoffBusyId === o.id}
                            handoffError={handoffErrors[o.id] ?? null}
                            onRetryHandoff={() => void retryHandoff(o)}
                            showArtworkChip={artworkChipsOn}
                            onOpenArtworkReport={() => void openArtworkReport(o)}
                            onHold={(mode) => { setHoldError(null); setHoldTarget({ order: o, mode }) }}
                            usTariff={usTariffDutyBilling(o.order_group_id ? groups[o.order_group_id] ?? o : o)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* ── WAITING ───────────────────────────────────────────────────
                Everything the automatic chaser or the customer is already
                handling: healthy unpaid links, combined payments still in date,
                and paid orders parked while artwork is redone. Collapsed to a
                single line by default — these rows were two thirds of the page
                while needing nothing from anyone.

                Three things keep it trustworthy rather than hiding work: the
                header states its contents in WORDS rather than a bare number, a
                search opens it, and every row inside is the same full card it
                has always been. Any row that develops a problem MOVES up into
                Fix, which is why the two lists are exact complements of one
                property-tested predicate. */}
            {waitingCountShown > 0 && (() => {
              // Select mode force-opens it and is NOT overridable — the orders
              // you are ticking live in here. A search only supplies the
              // DEFAULT (inside the ??, not an ||), so an explicit Hide still
              // wins while searching.
              const shown = selectMode || (waitingOpen ?? search.trim().length > 0)
              const says = [
                awaitingHealthy.length > 0 ? `${awaitingHealthy.length} chasing ${awaitingHealthy.length === 1 ? 'itself' : 'themselves'}` : null,
                groupsWaiting.length > 0 ? `${groupsWaiting.length} combined payment${groupsWaiting.length === 1 ? '' : 's'}` : null,
                beingRevised.length > 0 ? `${beingRevised.length} being revised` : null,
              ].filter(Boolean).join(' · ')
              return (
                <section className="mt-10">
                  {/* The heading takes the whole width on a phone so Combine
                      payments… drops to its own line. Sharing the line squeezed
                      the heading to half the screen — its three-word summary
                      wrapped to three lines around a stranded "Hide", and the
                      button hung off the right edge. */}
                  <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 ${SECTION_HEADER_STICKY}`}>
                    <h2 className="min-w-0 flex-1 text-sm font-semibold uppercase tracking-wide text-ink-mute max-md:w-full max-md:flex-none">
                      <button
                        type="button"
                        onClick={() => setWaitingOpen(!shown)}
                        aria-expanded={shown}
                        className="flex w-full items-center justify-between gap-3 rounded py-1 text-left uppercase tracking-wide focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)] max-md:min-h-[44px]"
                      >
                        <span className="min-w-0">
                          Waiting · {waitingCountShown}
                          {/* A real separator, not a margin: without it the
                              button's accessible NAME concatenates to
                              "Waiting · 42 chasing themselves". */}
                          {' · '}
                          <span className="text-[12px] font-normal normal-case tracking-normal text-ink-dim">{says}</span>
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-normal normal-case tracking-normal text-ink-mute">
                          {shown ? 'Hide' : 'Show'}
                          <ChevronDown size={14} className={`transition-transform ${shown ? 'rotate-180' : ''}`} aria-hidden="true" />
                        </span>
                      </button>
                    </h2>
                    {/* Combine payments lives here because the combinable orders
                        are the healthy unpaid links inside this block; switching
                        it on force-opens the section. A solid primary button —
                        the subtle pill was too easy to miss (Rob, 9 Jul). */}
                    {eligibleForGroup.length >= 2 && (
                      <ButtonInk
                        size="sm"
                        onClick={() => { setSelectMode((v) => !v); setGroupSelect(new Set()) }}
                      >
                        {selectMode ? 'Done selecting' : 'Combine payments…'}
                      </ButtonInk>
                    )}
                  </div>
                  {shown && (
                    <>
                      <p className="mt-1 text-[13px] text-ink-mute">
                        Nothing here needs you. Unpaid links are chased automatically; copy a link to re-send it by hand,
                        or reactivate an expired one (extends it {ORDER_EXPIRY_DAYS} days).
                        {selectMode ? ' Tick two or more orders for the same customer to combine them into one payment.' : ''}
                      </p>

                      {/* Each unpaid combined payment renders as ONE tinted
                          block: the group header (its link is the live, payable
                          one) with the member cards nested inside it, so the
                          grouping reads as containment rather than a banner plus
                          matching reference codes on cards that may sit anywhere
                          in the list. */}
                      {groupsWaiting.map((g) => {
                        const memberOrders = awaitingPayment.filter((o) => o.order_group_id === g.id)
                        const groupExpired = g.expires_at != null && new Date(g.expires_at).getTime() < Date.now()
                        return (
                          <div key={g.id} className="mt-3 rounded-2xl border border-[var(--c-brand)]/50 bg-[var(--c-brand)]/[0.05] p-3">
                            <div className="flex flex-col gap-2 px-1 md:flex-row md:items-center md:justify-between">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-ink">
                                  Combined payment {g.payment_reference}
                                  <span className="font-normal text-ink-soft"> · these {memberOrders.length} orders, one pay link</span>
                                  {groupExpired && <span className="font-normal text-out"> · link expired</span>}
                                </p>
                                <p className="mt-0.5 text-[13px] text-ink-mute">
                                  {g.expires_at ? `${groupExpired ? 'Expired' : 'Expires'} ${formatDate(g.expires_at)} · ` : ''}
                                  {/* The group's own opened stamp — the members' stamps stay
                                      frozen while grouped (their links are dormant), so this
                                      is the only honest "has the customer seen it" signal. */}
                                  {g.pay_link_opened_at
                                    ? <span title={formatAbsoluteDateTime(g.pay_link_opened_at)}>pay link opened {relativeTime(g.pay_link_opened_at)}</span>
                                    : 'pay link not opened yet'}
                                  {' · automatic reminders pause while the orders are grouped.'}
                                </p>
                              </div>
                              <div className="flex shrink-0 flex-wrap gap-2">
                                <ButtonGhost size="sm" onClick={() => void copyGroupLink(g)} className="max-md:h-11">
                                  {copiedId === g.id ? 'Copied' : 'Copy combined link'}
                                </ButtonGhost>
                                {groupExpired && (
                                  <ButtonInk size="sm" onClick={() => void reactivateGroup(g)} disabled={busyId === g.id} className="max-md:h-11">
                                    {busyId === g.id ? 'Reactivating…' : 'Reactivate link'}
                                  </ButtonInk>
                                )}
                                <ButtonGhost size="sm" onClick={() => void dissolveGroup(g)} disabled={busyId === g.id} className="max-md:h-11">
                                  Split back up
                                </ButtonGhost>
                              </div>
                            </div>
                            <div className="mt-3 space-y-3">
                              {memberOrders.map((o) => (
                                <div key={o.id} id={`order-card-${o.id}`}>
                                  <AwaitingPaymentCard
                                    order={o}
                                    thumb={thumbForOrder(o)}
                                    expired={isExpired(o)}
                                    busy={busyId === o.id}
                                    copied={copiedId === o.id}
                                    flash={flashOrderId === o.id}
                                    nested
                                    summary={reminders[o.id] ?? null}
                                    cadence={cadence}
                                    group={g}
                                    selectable={false}
                                    selected={false}
                                    onToggleSelect={() => {}}
                                    onRelease={() => void releaseFromGroup(o)}
                                    onCopy={() => void copyLink(o)}
                                    onReactivate={() => void reactivate(o)}
                                    onSendLink={() => setSendLinkFor(o)}
                                    onEdit={() => setEditingOrder(o)}
                                    onCancel={() => { setCancelNotify(true); setCancelError(null); setCancelTarget(o) }}
                                    onRecordOffline={() => setRecordOffline(o)}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      })}

                      <div className="mt-3 space-y-3">
                        {awaitingHealthy.map((o) => (
                          <div key={o.id} id={`order-card-${o.id}`}>
                            <AwaitingPaymentCard
                              order={o}
                              thumb={thumbForOrder(o)}
                              expired={isExpired(o)}
                              busy={busyId === o.id}
                              copied={copiedId === o.id}
                              flash={flashOrderId === o.id}
                              summary={reminders[o.id] ?? null}
                              cadence={cadence}
                              group={o.order_group_id ? groups[o.order_group_id] ?? null : null}
                              selectable={selectMode && canJoinGroup(o)}
                              selected={groupSelect.has(o.id)}
                              onToggleSelect={() => toggleGroupSelect(o.id)}
                              onRelease={() => void releaseFromGroup(o)}
                              onCopy={() => void copyLink(o)}
                              onReactivate={() => void reactivate(o)}
                              onSendLink={() => setSendLinkFor(o)}
                              onEdit={() => setEditingOrder(o)}
                              onCancel={() => { setCancelNotify(true); setCancelError(null); setCancelTarget(o) }}
                              onRecordOffline={() => setRecordOffline(o)}
                            />
                          </div>
                        ))}
                      </div>

                      {/* Paid orders parked while the artwork is redone. They
                          belong with the other waiting rows: the customer owes
                          us a re-approval, so nothing here needs us either. */}
                      {beingRevised.length > 0 && (
                        <div className="mt-6">
                          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-mute">
                            Being revised · {beingRevised.length}
                            {` · ${gbpLabel(sumGbp(beingRevised, rates))}`}
                          </h3>
                          <p className="mt-1 text-[13px] text-ink-mute">
                            Waiting on the customer to approve the new proof. Once they do, the order moves
                            back up to Place — no new link or payment needed — and you replace the files in
                            the Dropbox order folder before placing it.
                          </p>
                          <div className="mt-3 space-y-4">
                            {beingRevised.map((o) => (
                              <div key={o.id} id={`order-card-${o.id}`}>
                                {revisedCard(o)}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )
            })()}

            {/* Recently ordered is reference material, not work — collapsed
                by default so it doesn't add 30 rows to the everyday scroll.
                An active search opens it so matches there aren't invisible. */}
            {recentlyOrdered.length > 0 && (() => {
              const recentShown = recentOpen || search.trim().length > 0
              return (
                <section className="mt-10">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">
                    <button
                      type="button"
                      onClick={() => setRecentOpen((v) => !v)}
                      aria-expanded={recentShown}
                      className="flex w-full items-center justify-between gap-3 rounded py-1 text-left uppercase tracking-wide focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)] max-md:min-h-[44px]"
                    >
                      <span>Recently ordered · {recentlyOrdered.length}</span>
                      <span className="inline-flex items-center gap-1 text-[12px] font-normal normal-case tracking-normal text-ink-mute">
                        {recentShown ? 'Hide' : 'Show'}
                        <ChevronDown size={14} className={`transition-transform ${recentShown ? 'rotate-180' : ''}`} aria-hidden="true" />
                      </span>
                    </button>
                  </h2>
                  {recentShown && (
                    <>
                      {/* One row per order on a desktop; on a phone the same
                          parts stack — customer + reference across the top, then
                          the facts and the chips wrapping under it. The row used
                          to be a single unwrappable line, so a phone broke the
                          customer's name mid-word and pushed Copy link off the
                          screen entirely. */}
                      <div className="mt-3 divide-y divide-line-soft rounded-xl border border-line bg-surface">
                        {recentlyOrdered.map((o) => (
                          <div
                            key={o.id}
                            id={`order-card-${o.id}`}
                            className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm transition-shadow duration-500 ${
                              flashOrderId === o.id ? 'rounded-lg ring-2 ring-[var(--c-brand)]' : ''
                            }`}
                          >
                            <div className="min-w-0 max-md:w-full">
                              <Link to={`/proofs/${o.proof_id}`} className="font-medium text-ink hover:underline">
                                {customerLabel(o)}
                              </Link>
                              {/* The reference never breaks mid-code — it drops
                                  whole onto the next line when the name is long. */}
                              <span className="ml-2 whitespace-nowrap text-ink-mute">{o.payment_reference}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-ink-soft max-md:w-full md:flex-nowrap">
                              {/* Did this order actually land in Stock Control, message
                                  and all? Quiet green when it did; amber when the
                                  message still needs sending (the Needs action panel
                                  above carries the button). */}
                              <HandoffChip state={handoffState(o)} />
                              {artworkChipsOn && o.artwork_check_verdict && (
                                <ArtworkChip verdict={o.artwork_check_verdict} onOpen={() => void openArtworkReport(o)} />
                              )}
                              {/* What and when, as one quiet line. On a phone it
                                  leads the row (order-first) so the facts sit under
                                  the customer's name and the chips fall below them;
                                  the inner gap matches the row's, so a desktop row
                                  looks exactly as it always has. */}
                              <span className="flex items-center gap-x-3 max-md:order-first max-md:w-full">
                                <span className="whitespace-nowrap">{o.quantity != null ? `${o.quantity.toLocaleString()} cards` : 'Custom'}</span>
                                <span className="whitespace-nowrap text-ink-mute">Ordered {formatDate(o.fulfilled_at)}</span>
                              </span>
                              {/* Pushed to the end of the row on a phone, where it
                                  is the only thing here you can actually press. */}
                              <button
                                type="button"
                                onClick={() => void copyLink(o)}
                                title="Copy the customer's order link (doubles as their tracking page)"
                                className="shrink-0 rounded px-2 py-1 text-[12px] text-ink-soft ring-1 ring-line hover:bg-canvas max-md:ml-auto max-md:min-h-[36px] max-md:px-3"
                              >
                                {copiedId === o.id ? 'Copied' : 'Copy link'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                      {role === 'admin' && (
                        <p className="mt-2 text-[12px] text-ink-mute">
                          The full history lives in the{' '}
                          <Link to="/admin/orders" className="text-ink underline underline-offset-2 hover:no-underline">
                            order log
                          </Link>
                          .
                        </p>
                      )}
                    </>
                  )}
                </section>
              )
            })()}
            </div>
          </div>
        )}

        {/* Combine-payments selection bar: pinned to the viewport bottom so
            the confirm stays in reach while ticking cards far apart in the
            list (it used to sit above the cards, a long scroll away by the
            second tick). Sits clear of the mobile tab bar; a centred float
            on desktop. */}
        {selectMode && (() => {
          const currencyMismatch = new Set(selectedCandidates.map((c) => c.currency)).size > 1
          return (
            <div className="pointer-events-none fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom)+10px)] z-30 px-4 md:bottom-6">
              <div className="pointer-events-auto mx-auto flex w-full max-w-[600px] flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl border border-line bg-surface px-4 py-3 shadow-lg">
                <p className="text-[13px] text-ink-soft">
                  {groupSelect.size === 0
                    ? 'Tick two or more orders for one customer'
                    : `${groupSelect.size} selected`}
                  {currencyMismatch ? ' · different currencies — a combined payment needs one' : ''}
                </p>
                <div className="flex items-center gap-2">
                  <ButtonGhost size="sm" onClick={() => { setSelectMode(false); setGroupSelect(new Set()) }}>
                    Cancel
                  </ButtonGhost>
                  <ButtonInk
                    size="sm"
                    onClick={() => setGroupModalOpen(true)}
                    disabled={groupSelect.size < 2 || currencyMismatch}
                  >
                    Combine into one payment
                  </ButtonInk>
                </div>
              </div>
            </div>
          )
        })()}

        {orderBuilder && (
          <OrderBuilderModal
            {...orderBuilder}
            onClose={() => { setOrderBuilder(null); setReloadKey((k) => k + 1); invalidateApprovedNoOrderCount() }}
          />
        )}

        {recordOffline && (
          <RecordOfflinePaymentModal
            order={recordOffline}
            title={customerLabel(recordOffline)}
            spec={specLabel(recordOffline)}
            onClose={() => setRecordOffline(null)}
            onRecorded={(orderId) => void refetchOrder(orderId)}
          />
        )}

        {/* Artwork check report — the in-app archive (000336). Read-only: the
            stored supplied-vs-printed report for whichever card's chip was
            clicked; re-runs live on the Place-order review page. */}
        {artworkReportModal && (
          // A long report must not spill off the top/bottom of the screen. On
          // desktop the panel is a capped flex column — pinned label + Close,
          // scrolling report between — so the whole thing stays on-screen and
          // Close is always reachable. Mobile keeps the sheet (92dvh + scroll)
          // from .modal-mobile-sheet, so the md:-only classes leave it alone.
          <Modal
            open
            onClose={() => setArtworkReportModal(null)}
            ariaLabel="Artwork check report"
            panelClassName="w-full max-w-xl rounded-2xl bg-white shadow-xl md:flex md:max-h-[85vh] md:flex-col"
          >
            <div className="shrink-0 px-5 pt-5 pb-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">{artworkReportModal.label}</p>
            </div>
            <div className="px-5 text-[13px] text-ink md:min-h-0 md:flex-1 md:overflow-y-auto">
              {artworkReportModal.loading ? (
                <p className="text-sm text-ink-mute">Loading the report…</p>
              ) : artworkReportModal.report ? (
                <ArtworkCheckReportView
                  report={artworkReportModal.report}
                  notice={staleNotice}
                  onInvestigate={(flag) => void investigateFlag(artworkReportModal.orderId, flag)}
                  investigatingKey={investigatingKey}
                  investigationError={investigationError}
                  onAcknowledge={(target, reason) => void acknowledgeFromModal(artworkReportModal.orderId, target, reason, false)}
                  onUnacknowledge={(target) => void acknowledgeFromModal(artworkReportModal.orderId, target, null, true)}
                  acknowledgingKey={acknowledgingKey}
                  acknowledgeError={acknowledgeError}
                  history={{ orderId: artworkReportModal.orderId }}
                />
              ) : (
                <p className="text-sm text-ink-mute">No stored report for this order yet — open its Place order screen to run one.</p>
              )}
            </div>
            <div className="mt-1 flex shrink-0 justify-end border-t border-line-soft px-5 py-3">
              <ButtonGhost size="sm" onClick={() => setArtworkReportModal(null)}>Close</ButtonGhost>
            </div>
          </Modal>
        )}

        {editingOrder && (
          <EditOrderModal
            orderId={editingOrder.id}
            customerLabel={customerLabel(editingOrder)}
            materialDisplay={specLabel(editingOrder)}
            onClose={() => setEditingOrder(null)}
            onUpdated={() => void refetchOrder(editingOrder.id)}
          />
        )}

        {groupModalOpen && (
          <GroupOrdersModal
            candidates={selectedCandidates}
            onClose={() => { setGroupModalOpen(false); setReloadKey((k) => k + 1) }}
            onCreated={() => { setSelectMode(false); setGroupSelect(new Set()) }}
          />
        )}

        {cancelTarget && (
          <CancelOrderDialog
            customer={customerLabel(cancelTarget)}
            reference={cancelTarget.payment_reference}
            notify={cancelNotify}
            onNotifyChange={setCancelNotify}
            working={busyId === cancelTarget.id}
            errorMsg={cancelError}
            onConfirm={() => void cancelOrder(cancelTarget, cancelNotify)}
            onClose={() => { setCancelTarget(null); setCancelError(null) }}
          />
        )}

        {holdTarget && (
          <HoldOrderDialog
            mode={holdTarget.mode}
            customerLabel={customerLabel(holdTarget.order)}
            state={holdDialogState?.held ? holdDialogState : null}
            working={holdBusy}
            errorMsg={holdError}
            onConfirm={(reason) => void applyHold(holdTarget.order, holdTarget.mode, reason)}
            onCancel={() => { setHoldTarget(null); setHoldError(null) }}
          />
        )}
      </div>
    </DesignerChrome>
  )
}

// Confirm dialog for cancelling an unpaid order link. Replaces the old
// window.confirm so the designer can choose whether the customer hears about
// it: ticked (the default, matching the old behaviour) posts the usual
// order_cancelled reply on the Help Scout thread; unticked cancels silently —
// for correcting a mistake (wrong quantity, wrong material) where a
// "your order is cancelled" email would only confuse, typically just before
// sending a fresh link.
function CancelOrderDialog({
  customer,
  reference,
  notify,
  onNotifyChange,
  working,
  errorMsg,
  onConfirm,
  onClose,
}: {
  customer: string
  reference: string | null
  notify: boolean
  onNotifyChange: (v: boolean) => void
  working: boolean
  errorMsg: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal
      open
      onClose={onClose}
      preventClose={working}
      ariaLabelledBy="cancel-order-dialog-title"
      ariaDescribedBy="cancel-order-dialog-msg"
      panelClassName="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl"
    >
      <h2 id="cancel-order-dialog-title" className="text-lg font-semibold text-ink">Cancel this order link?</h2>
      <p id="cancel-order-dialog-msg" className="mt-2 text-sm text-ink-soft">
        The unpaid order for {customer}{reference ? ` (${reference})` : ''} will be cancelled and its payment
        link will stop working. No payment has been taken.
      </p>
      <label className="mt-4 flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => onNotifyChange(e.target.checked)}
          disabled={working}
          className="mt-0.5"
        />
        <span>Email the customer to let them know</span>
      </label>
      <p className="mt-1.5 pl-6 text-[13px] text-ink-mute">
        {notify
          ? 'We’ll post the usual cancellation note on their Help Scout thread.'
          : 'Cancel silently — the customer won’t be told. Handy when you’re correcting a mistake and sending a fresh link.'}
      </p>
      {errorMsg && (
        <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{errorMsg}</p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <ButtonGhost size="sm" onClick={onClose} disabled={working}>Keep order</ButtonGhost>
        <ButtonInk size="sm" onClick={onConfirm} disabled={working}>
          {working ? 'Cancelling…' : notify ? 'Cancel order' : 'Cancel silently'}
        </ButtonInk>
      </div>
    </Modal>
  )
}

function OrderCard({
  order,
  thumb,
  route,
  supplierLabels,
  supplierCount,
  suggested,
  busy,
  copied,
  flash = false,
  onReview,
  onCopy,
  onSaveField,
  onRetryInvoice,
  handoffBusy = false,
  handoffError = null,
  onRetryHandoff,
  proofMaterialCode,
  showArtworkChip = false,
  onOpenArtworkReport,
  onHold,
  usTariff = null,
}: {
  order: OrderRow
  thumb: ThumbInfo | null
  route: 'in_house' | 'supplier' | null
  supplierLabels: string[]
  supplierCount: number
  suggested: string | null
  busy: boolean
  copied: boolean
  /** Briefly ring the card after a "Needs action" jump lands on it. */
  flash?: boolean
  onReview: () => void
  onCopy: () => void
  onSaveField: (patch: Partial<OrderRow>) => Promise<boolean>
  onRetryInvoice: () => void
  /** True while this order's hand-off to Stock Control is being retried. */
  handoffBusy?: boolean
  /** Why the last retry didn't work, if it didn't. */
  handoffError?: string | null
  onRetryHandoff?: () => void
  proofMaterialCode: string | null
  showArtworkChip?: boolean
  onOpenArtworkReport?: () => void
  /** Opens the hold dialog (000377). Omitted = the menu offers no hold action. */
  onHold?: (mode: 'put' | 'take_off') => void
  /** US import-duty billing, resolved group-aware by the caller. */
  usTariff?: ReturnType<typeof usTariffDutyBilling>
}) {
  const total = orderTotal(order)
  const invoiceError = !order.xero_invoice_id ? friendlyInvoiceError(order.xero_invoice_error) : null
  // Where this order got to on its way into Stock Control. On a card that means
  // one of two things: nothing happened yet ('none'), or the last attempt to
  // write the job was refused ('failed') — the placed states belong to orders
  // that have already left this list.
  const handoff = handoffState(order)
  // Is a question out with the customer about this order (000377)? The reply
  // stamps are thread-wide and already on the row, so this costs no extra
  // query — and holdState is shared with the review page so the two surfaces
  // can't disagree about whether an order is held.
  const hold = holdState(order, {
    lastCustomerReplyAt: order.proofs?.helpscout_last_customer_reply_at ?? null,
    lastStaffReplyAt: order.proofs?.helpscout_last_reply_at ?? null,
  })
  const helpscoutUrl = order.proofs?.helpscout_conversation_url ?? null
  const addr = order.ship_to_address
  // Address lines in postal order — county (region) sits between the town/
  // postcode line and the country, matching the admin Order log. Stripe stores
  // it as region (the state/county field); .filter(Boolean) drops it when blank,
  // so UK orders that leave the optional county empty show no stray line.
  const addrLines = addr
    ? [order.ship_to_name, addr.line1, addr.line2, [addr.city, addr.postal_code].filter(Boolean).join(' '), addr.region, addr.country]
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
    : []
  const paidDays = daysSince(order.paid_at)

  // Two-state card: a compact triage row by default (customer, pills,
  // readiness ticks), expanding to the full prep form — date required, the
  // Dropbox folder, stock colour, delivery details — for the one order being
  // worked on. Embedding the form in every card made seven paid orders nearly
  // a whole page of form fields. A failed invoice — or an order Stock Control
  // refused — auto-expands so the problem and its fix are in view without a tap.
  const [expanded, setExpanded] = useState<boolean>(
    () => (!order.xero_invoice_id && !!order.xero_invoice_error) || handoffState(order).kind === 'failed',
  )

  // Local drafts for the two placement fields. Date seeds from the saved value,
  // else the lead-time suggestion (the designer still has to engage with it to
  // place — the gate checks the value is set).
  const [dateValue, setDateValue] = useState<string>(order.date_required ?? suggested ?? '')
  const [folderDraft, setFolderDraft] = useState<string>(order.dropbox_folder_url ?? '')

  // Whether the date is actually persisted — gates placing. A pre-filled
  // lead-time suggestion is NOT saved until the designer confirms it, and a
  // failed save must not leave the gate open. Plus transient save feedback.
  const [datePersisted, setDatePersisted] = useState<boolean>(!!order.date_required)
  const [dateSaving, setDateSaving] = useState(false)
  const [dateError, setDateError] = useState(false)
  const [dateSaved, setDateSaved] = useState(false)

  async function handleDateChange(v: string) {
    setDateValue(v)
    setDateError(false)
    setDateSaved(false)
    setDateSaving(true)
    const ok = await onSaveField({ date_required: v || null })
    setDateSaving(false)
    if (ok) {
      setDatePersisted(!!v)
      if (v) { setDateSaved(true); window.setTimeout(() => setDateSaved(false), 2000) }
    } else {
      setDatePersisted(false)
      setDateError(true)
    }
  }

  // Download the Xero invoice as a PDF. There's no public PDF URL, so the
  // order-invoice-pdf edge function fetches it from Xero with the org's token
  // and streams it back; we save the returned blob via the shared helper.
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfError, setPdfError] = useState(false)

  async function handleDownloadInvoice() {
    setPdfBusy(true)
    setPdfError(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')
      const supabaseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl
      const resp = await fetch(`${supabaseUrl}/functions/v1/order-invoice-pdf?order_id=${encodeURIComponent(order.id)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!resp.ok) throw new Error(`Download failed (${resp.status})`)
      const blob = await resp.blob()
      const header = resp.headers.get('Content-Disposition') ?? ''
      const filename = header.match(/filename="([^"]+)"/)?.[1] ?? `Invoice ${order.payment_reference ?? order.id}.pdf`
      downloadBlob(blob, filename)
    } catch {
      setPdfError(true)
      window.setTimeout(() => setPdfError(false), 4000)
    } finally {
      setPdfBusy(false)
    }
  }

  // Folder lookup: pasting the order-folder link verifies it against Dropbox and
  // pulls the order number + project from its name (the values the Stock Control
  // hand-off needs). Seeds from saved values so a revisit shows the confirmation
  // without re-fetching (the live file count is only known on a fresh check).
  const [lookup, setLookup] = useState<FolderLookup>(() =>
    order.stock_order_number || order.project_name
      ? { status: 'ok', orderNumber: order.stock_order_number, projectName: order.project_name, fileCount: null }
      : { status: 'idle' },
  )

  async function runLookup(rawLink: string) {
    const link = rawLink.trim()
    if (!link) {
      setLookup({ status: 'idle' })
      await onSaveField({ dropbox_folder_url: null, stock_order_number: null, project_name: null })
      return
    }
    setLookup({ status: 'loading' })
    const { data, error } = await supabase.functions.invoke<DropboxFolderResult>('dropbox-folder', { body: { link } })
    if (error || !data?.ok) {
      // Keep the URL so it isn't lost, but clear the parsed fields it couldn't fill.
      await onSaveField({ dropbox_folder_url: link, stock_order_number: null, project_name: null })
      setLookup({ status: 'error', error: data?.error ?? error?.message ?? 'Could not read that Dropbox link.' })
      return
    }
    const orderNumber = data.order_number ?? null
    const projectName = data.project_name ?? null
    // Only treat the folder as verified once the DB write lands — otherwise the
    // gate could open off a folder the order row never actually got.
    const saved = await onSaveField({ dropbox_folder_url: link, stock_order_number: orderNumber, project_name: projectName })
    if (!saved) {
      setLookup({ status: 'error', error: 'Verified the folder, but couldn’t save it — please Check again.' })
      return
    }
    setLookup({ status: 'ok', orderNumber, projectName, fileCount: data.file_count ?? null })
  }

  // Stock colour (satin / tinted / acrylic). Proof-viewer only records the
  // generic material, but Stock Control stocks each colour separately and must
  // be told which one to allocate. Captured here, sourced live from Stock
  // Control's own catalogue so the saved name resolves exactly.
  // Prefer the PROOF's current-version material (always set — incl. custom
  // quotes, which carry no priced variant on the order); fall back to the
  // order's variant material. Matches the material place-order reads.
  const materialCode = proofMaterialCode ?? order.material_variants?.materials?.code ?? null
  const needsColour = materialNeedsStockColour(materialCode)
  const [colourOptions, setColourOptions] = useState<StockColour[]>([])
  const [colourValue, setColourValue] = useState<string>(order.stock_colour ?? '')
  const [otherMode, setOtherMode] = useState(false)
  const [colourSaving, setColourSaving] = useState(false)
  const [colourError, setColourError] = useState(false)
  const [colourSaved, setColourSaved] = useState(false)

  useEffect(() => {
    if (!needsColour) return
    let cancelled = false
    void fetchStockColours(materialCode).then((opts) => {
      if (cancelled) return
      setColourOptions(opts)
      // A saved colour that isn't a stocked option is a free-typed "Other".
      if (order.stock_colour && !opts.some((o) => o.name === order.stock_colour)) setOtherMode(true)
    })
    return () => { cancelled = true }
  }, [needsColour, materialCode, order.stock_colour])

  async function persistColour(name: string) {
    setColourError(false)
    setColourSaved(false)
    setColourSaving(true)
    const ok = await onSaveField({ stock_colour: name || null })
    setColourSaving(false)
    if (ok) {
      if (name) { setColourSaved(true); window.setTimeout(() => setColourSaved(false), 2000) }
    } else {
      setColourError(true)
    }
  }

  // The <select> shows the stocked colours plus an "Other" escape. Its value is
  // derived from the saved colour: a known name selects that option; any other
  // non-empty value (or an explicit Other pick) selects "__other__" and reveals
  // the free-text field.
  const colourIsKnown = colourOptions.some((o) => o.name === colourValue)
  const colourSelectValue = otherMode || (colourValue && !colourIsKnown) ? '__other__' : colourValue
  const showColourOther = colourSelectValue === '__other__'

  function handleColourSelect(v: string) {
    if (v === '__other__') { setOtherMode(true); return }
    setOtherMode(false)
    setColourValue(v)
    void persistColour(v)
  }

  // The folder is usable for the hand-off only once it's verified AND its name
  // yields an order number (which becomes the Help Scout subject Stock Control
  // matches on). Artwork presence is informational, not a gate.
  const folderVerified = lookup.status === 'ok' && !!lookup.orderNumber
  // A colour-bearing material can't be placed until its specific stock colour is
  // saved (we gate on the persisted value, not the local draft, so a failed save
  // can't leave the gate open). Materials without a colour picker pass straight
  // through.
  const colourReady = !needsColour || !!order.stock_colour
  // Both routes need a verified folder (its name = the order number) + a SAVED
  // date before the order can be reviewed & placed; the review page picks the
  // route (in-house note vs supplier email) and confirms. The date must be
  // persisted (not just a pre-filled suggestion) so the place-order edge fn,
  // which reads the DB, doesn't reject an order whose gate looked green.
  const canOrder = folderVerified && datePersisted && colourReady

  // A revision order (paid/placed, held while the proof was redesigned) uses the
  // same prep card: an order revised BEFORE its docket was prepped (folder/date/
  // colour never set) still needs those fields to satisfy the place gate.
  const isRevision = order.status === 'revision'
  // A revision the customer has approved: placeable again, and now shown in
  // Place rather than Being revised. Same test as isPlaceable / the review
  // page's revisionNeedsApproval — keep all three together.
  const reapproved = isRevision && order.proofs?.status === 'approved'
  const wasPlaced = !!order.fulfilled_at

  return (
    <PanelShell className={`transition-shadow duration-500 ${flash ? 'ring-2 ring-[var(--c-brand)]' : ''}`}>
      {isRevision && (
        <div className="mb-3 rounded-lg bg-out-soft px-3 py-2 text-[13px] font-semibold text-out ring-1 ring-out">
          {/* "in progress" stops being true the moment the customer signs off
              the replacement, and this banner rides the card into Place. The
              warning it carries — don't make the OLD cards — matters just as
              much then, so only the stale half changes. */}
          {reapproved
            ? 'Paid · revised artwork approved — do not produce the previous artwork.'
            : 'Paid · revision in progress — do not produce the previous artwork.'}
        </div>
      )}

      {/* On hold, waiting on the customer (000377). Top of the card, like the
          revision banner, because it's the one thing about this order anybody
          needs to know before touching it — and the card stays in Place, so
          without it a held order looks exactly like one nobody got round to.

          Amber, NOT green: on this page var(--c-in-stock) means finished (a
          ticked Folder / Date chip, an artwork check that came back clear), so
          a green band would read as "ready" — the opposite of the truth.
          Amber text is --c-low-ink; the bright --c-low is a fill colour and is
          barely readable on its own tint. */}
      {hold.held && (
        <div className="mb-3 rounded-lg bg-[var(--c-low-soft)] px-3 py-2 ring-1 ring-[var(--c-low)]/50">
          <p className="text-[13px] font-semibold text-[var(--c-low-ink)]">
            On hold
            {hold.byName ? ` · ${hold.byName}` : ''}
            {formatDate(hold.heldAt) ? ` · ${formatDate(hold.heldAt)}` : ''}
          </p>
          {/* The reason verbatim — it is what tells a colleague whether to wait
              or to go ahead, so it is never summarised or truncated. */}
          <p className="mt-0.5 break-words text-[13px] text-ink">{hold.reason}</p>
          {repliedLine(hold) && (
            <p className="mt-1 text-[12px] text-ink-soft">
              {repliedLine(hold)}
              {helpscoutUrl && (
                <>
                  {' '}
                  <a
                    href={helpscoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-ink underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
                  >
                    Open in Help Scout ↗
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {thumb && (
          <img
            src={thumb.thumb_url}
            alt="Proof artwork"
            className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-line"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proofs/${order.proof_id}`} className="text-base font-semibold text-ink hover:underline">
              {customerLabel(order)}
            </Link>
            {order.order_kind === 'prototype' && (
              <Pill colour="brand" title="Prototyping service — a flat-fee sample run (up to 3 copies of the approved design).">Prototype</Pill>
            )}
            {order.order_kind === 'reprint' && (
              <Pill colour="allocated" title="A free remake after a complaint or damage — £0, no payment or invoice. Link a new Dropbox folder (next order number) and place it like any job.">Free reprint</Pill>
            )}
            {isRevision ? <Pill colour="out">Revision</Pill> : <Pill colour="in-stock">Paid</Pill>}
            {/* The at-a-glance signal. Held orders deliberately stay in Place
                (leaving them there keeps them nagging, and moving them would
                silently drop their failed-invoice alerts), which means the ONLY
                thing separating a held card from a placeable one while scanning
                the list is this pill — the band explaining it sits further down
                the card, past the fold on a phone. Amber, not green: on this
                page in-stock means finished. */}
            {hold.held && (
              <Pill
                colour="low"
                title={hold.byName ? `${hold.byName} is waiting on the customer` : 'Waiting on the customer'}
              >
                On hold
              </Pill>
            )}
            {/* A reprint is offline too, but "Free reprint" already says so — and it
                must NOT prompt the manual-invoice path (there's nothing to invoice). */}
            {order.payment_method === 'offline' && order.order_kind !== 'reprint' && (
              <Pill colour="low" title="Recorded as paid offline (bank transfer etc.) — no Stripe/Xero record; raise the invoice manually.">Offline</Pill>
            )}
            {order.xero_invoice_id && (
              <a
                href={`https://go.xero.com/app/invoicing/view/${order.xero_invoice_id}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this invoice in Xero to check product codes and tax rates"
                className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
              >
                <Pill colour="allocated">Invoiced ↗</Pill>
              </a>
            )}
            {!order.xero_invoice_id && order.xero_invoice_error && (
              <Pill colour="critical" title={invoiceError ?? undefined}>Invoice failed</Pill>
            )}
            {route && (
              <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-soft">
                {route === 'in_house' ? 'In-house' : 'Supplier'}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">
            {specLabel(order)}
            {' · '}
            {order.quantity != null ? `${order.quantity.toLocaleString()} cards` : 'Quantity TBC'}
            {order.names_count > 1 ? ` · ${order.names_count} people` : ''}
            {order.has_personalisation ? ' · personalisation' : ''}
          </p>

          <p className="mt-0.5 text-[13px] text-ink-mute">
            Ref {order.payment_reference}
            {order.paid_at ? ` · paid ${paidDays === 0 ? 'today' : paidDays === 1 ? 'yesterday' : `${paidDays} days ago`}` : ''}
            {total != null ? ` · ${formatPrice(total, order.currency)}` : ''}
            {isRevision && order.revised_at ? ` · being revised since ${formatDate(order.revised_at)}` : ''}
          </p>

          {/* Readiness at a glance — which prep steps are done, which are
              left — so a collapsed card can be triaged without opening it. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <PrepChip ok={folderVerified} label="Folder" />
            <PrepChip ok={datePersisted} label="Date" />
            {needsColour && <PrepChip ok={!!order.stock_colour} label="Colour" />}
            <HandoffChip state={handoff} />
            {showArtworkChip && order.artwork_check_verdict && onOpenArtworkReport && (
              <ArtworkChip verdict={order.artwork_check_verdict} onOpen={onOpenArtworkReport} />
            )}
          </div>

          {/* A re-approved revision shows this even COLLAPSED, and tinted: it
              is now sitting in Place looking like ordinary work, but the
              Dropbox folder still holds the artwork the customer rejected until
              someone swaps it. Placing it in that state sends the wrong cards
              to the supplier, which is the one mistake this whole flow exists
              to prevent. The still-being-revised case stays quiet until opened
              — nothing can go wrong there yet. */}
          {isRevision && (expanded || reapproved) && (
            <p
              className={`mt-2 text-[13px] ${
                // Tinted for every re-approved revision, INCLUDING one that
                // already went to production. That case is the riskier of the
                // two — there is a supplier job out there as well as stale
                // files in the folder — so it must not be the quieter of them.
                reapproved
                  ? 'rounded-lg bg-[var(--c-low-soft)]/50 px-3 py-2 text-ink'
                  : 'text-ink-soft'
              }`}
            >
              {reapproved
                ? wasPlaced
                  ? 'Revised and re-approved — no new payment needed. This one already went to production, so cancel the old Stock Control job and swap the Dropbox folder to the NEW artwork before re-placing.'
                  : 'Revised and re-approved — no new payment needed. Check the Dropbox order folder holds the NEW artwork before placing.'
                : wasPlaced
                  ? 'Already went to production. Cancel the old Stock Control job, and replace the Dropbox files once the customer approves the new proof.'
                  : 'Waiting on the customer to approve the new proof. It comes back to Place once they do.'}
            </p>
          )}

          {expanded && order.person_quantities && order.person_quantities.length > 0 && (
            <div className="mt-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink-soft">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Make</span>
              {order.person_quantities.map((p, i) => (
                <span key={i} className="mr-3 inline-block">
                  <span className="text-ink">{p.quantity.toLocaleString()}</span> {p.name}
                </span>
              ))}
            </div>
          )}

          {expanded && order.card_discount_type && order.card_discount_type !== 'none' && (
            <p className="mt-2 text-[13px] text-in-stock">
              Cards discount: {order.card_discount_type === 'percent'
                ? `${order.card_discount_value ?? 0}% off`
                : `${formatPrice(Number(order.card_discount_value ?? 0), order.currency)} off`}
              {order.amount_card_discount != null && order.amount_card_discount > 0
                ? ` (−${formatPrice(order.amount_card_discount, order.currency)})`
                : ''}
            </p>
          )}

          {expanded && invoiceError && (
            <div className="mt-2 rounded-lg bg-out-soft px-3 py-2 ring-1 ring-out">
              <p className="break-words text-[13px] text-out">
                <span className="font-medium">Invoice not created.</span> {invoiceError}
              </p>
              {/* Retry is for AUTO invoices only — an offline order has no
                  auto-invoice (raised manually in Xero), so retrying would
                  create a duplicate. */}
              {order.payment_method !== 'offline' && (
                <ButtonInk size="sm" onClick={onRetryInvoice} disabled={busy} className="mt-2 max-md:h-11">
                  {busy ? 'Retrying…' : 'Retry invoice'}
                </ButtonInk>
              )}
            </div>
          )}

          {/* Stock Control refused the order the last time it was placed. Nothing
              was written and nothing was sent, so trying again is safe — but the
              reason usually needs fixing first (an unmapped material, a folder
              name with no order number in it). The card opens itself in this
              state, so the explanation is in view without a tap; the rose chip
              above keeps saying so if someone collapses it again. */}
          {expanded && handoff.kind === 'failed' && (
            <div className="mt-2 rounded-lg bg-out-soft px-3 py-2 ring-1 ring-out">
              <p className="break-words text-[13px] text-out">
                <span className="font-medium">Stock Control wouldn’t accept this order.</span>{' '}
                {shorten(handoffError ?? handoff.reason)}
              </p>
              <p className="mt-1 text-[12px] text-ink-soft">
                Nothing was sent — fix the reason above, then try again.
              </p>
              {/* Try again is the card's SECOND route into production — it calls
                  place-order confirm, exactly as the place button does. It must
                  therefore respect the hold too, and say so in its own words:
                  left live it would return the 409, and that message would land
                  under "Stock Control wouldn't accept this order", blaming the
                  supplier for a hold one of us put on. */}
              {onRetryHandoff && (
                <>
                  <ButtonInk
                    size="sm"
                    onClick={onRetryHandoff}
                    disabled={handoffBusy || hold.held}
                    className="mt-2 max-md:h-11"
                  >
                    {handoffBusy ? 'Trying again…' : 'Try again'}
                  </ButtonInk>
                  {hold.held && (
                    <p className="mt-1.5 text-[12px] text-ink-soft">{holdBlockReason(hold)}</p>
                  )}
                </>
              )}
            </div>
          )}

          {expanded && (
            <>
          {/* Placement fields: date required + the Dropbox order folder (the gate). */}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Date required</span>
              {/* An unconfirmed lead-time suggestion is shown in an amber,
                  clearly-provisional field rather than looking identical to a
                  saved one. Before this, the input displayed a date, the
                  readiness chip said "Date needed" and the button was disabled
                  with no visible link between them — and the only way out was
                  to re-pick the date already on screen. The "Use this date"
                  button makes that one click instead of a date-picker round
                  trip, while keeping Rob's rule that the designer has to
                  actively confirm it. */}
              <input
                type="date"
                value={dateValue}
                onChange={(e) => void handleDateChange(e.target.value)}
                aria-describedby={!datePersisted && dateValue ? `date-hint-${order.id}` : undefined}
                className={`mt-1 h-[38px] max-md:h-12 w-full rounded-lg border bg-surface px-3 text-sm focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-focus)] ${
                  !datePersisted && dateValue
                    ? 'border-low text-ink-mute focus:border-[var(--c-focus)]'
                    : 'border-line text-ink focus:border-[var(--c-focus)]'
                }`}
              />
              <div className="mt-1 space-y-0.5 text-[11px]">
                {dateSaving && <span className="block text-ink-mute">Saving…</span>}
                {dateError && <span className="block text-out">Couldn’t save — try again</span>}
                {dateSaved && !dateError && <span className="block text-in-stock">✓ Saved</span>}
                {!dateSaving && !dateError && !dateSaved && !datePersisted && dateValue && (
                  <span id={`date-hint-${order.id}`} className="flex flex-wrap items-center gap-2 text-low">
                    <span>Not confirmed yet — suggested from the lead time.</span>
                    <button
                      type="button"
                      onClick={() => void handleDateChange(dateValue)}
                      className="inline-flex h-[26px] max-md:min-h-[44px] items-center rounded-[4px] border border-low bg-surface px-2 text-[11px] font-medium text-ink-soft hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
                    >
                      Use this date
                    </button>
                  </span>
                )}
              </div>
            </label>
            <label className="block">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Order folder (Dropbox)</span>
              <div className="mt-1 flex gap-2">
                <input
                  type="url"
                  value={folderDraft}
                  onChange={(e) => setFolderDraft(e.target.value)}
                  onBlur={() => { if (folderDraft.trim() !== (order.dropbox_folder_url ?? '')) void runLookup(folderDraft) }}
                  placeholder="Paste the order folder link…"
                  className="h-[38px] max-md:h-12 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                />
                <button
                  type="button"
                  onClick={() => void runLookup(folderDraft)}
                  disabled={lookup.status === 'loading' || folderDraft.trim().length === 0}
                  className="h-[38px] max-md:h-12 shrink-0 rounded-lg border border-line px-3 text-[13px] text-ink-soft hover:bg-canvas disabled:opacity-50"
                >
                  {lookup.status === 'loading' ? 'Checking…' : 'Check'}
                </button>
              </div>
              <div className="mt-1 space-y-0.5 text-[11px]">
                {lookup.status === 'idle' && (
                  <span className="block text-low">Prep the artwork, then paste the folder link</span>
                )}
                {lookup.status === 'loading' && <span className="block text-ink-mute">Checking folder…</span>}
                {lookup.status === 'error' && <span className="block text-out">{lookup.error}</span>}
                {lookup.status === 'ok' && lookup.orderNumber && (
                  <span className="block text-in-stock">✓ Order {lookup.orderNumber} · {lookup.projectName}</span>
                )}
                {lookup.status === 'ok' && !lookup.orderNumber && (
                  <span className="block text-low">
                    Folder linked, but its name isn’t “Order &lt;number&gt; – &lt;project&gt;” — rename it so Stock Control can match it.
                  </span>
                )}
                {lookup.status === 'ok' && lookup.fileCount != null && (
                  <span className={`block ${lookup.fileCount > 0 ? 'text-ink-mute' : 'text-low'}`}>
                    {lookup.fileCount > 0
                      ? `${lookup.fileCount} artwork file${lookup.fileCount === 1 ? '' : 's'} in the folder`
                      : 'No artwork files in the folder yet'}
                  </span>
                )}
              </div>
            </label>
          </div>

          {/* Stock colour: which specific colour Stock Control should pull, for
              materials proof-viewer only records generically (satin/tinted/acrylic). */}
          {needsColour && (
            <div className="mt-3">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Stock colour</span>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <select
                  value={colourSelectValue}
                  onChange={(e) => handleColourSelect(e.target.value)}
                  className="h-[38px] max-md:h-12 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                >
                  <option value="">Select the colour…</option>
                  {colourOptions.map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.name}{o.quantityOnShelf != null ? ` — ${o.quantityOnShelf.toLocaleString()} in stock` : ''}
                    </option>
                  ))}
                  <option value="__other__">Other (not listed)…</option>
                </select>
                {showColourOther && (
                  <input
                    type="text"
                    value={colourValue}
                    onChange={(e) => setColourValue(e.target.value)}
                    onBlur={() => { if (colourValue.trim() !== (order.stock_colour ?? '')) void persistColour(colourValue.trim()) }}
                    placeholder="Type the colour name…"
                    className="h-[38px] max-md:h-12 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                  />
                )}
              </div>
              <div className="mt-1 space-y-0.5 text-[11px]">
                {colourSaving && <span className="block text-ink-mute">Saving…</span>}
                {colourError && <span className="block text-out">Couldn’t save — try again</span>}
                {colourSaved && !colourError && <span className="block text-in-stock">✓ Saved</span>}
                {!colourSaving && !colourError && !colourSaved && !order.stock_colour && (
                  <span className="block text-low">Stock Control needs this to allocate the right material</span>
                )}
                {!colourSaving && !colourError && !colourSaved && showColourOther && !!order.stock_colour && (
                  <span className="block text-ink-mute">Not a stocked colour — Stock Control will be asked to source it</span>
                )}
              </div>
            </div>
          )}

          {/* Approved artwork — the production files this order was approved on,
              downloadable straight from the prep area (individually or as the
              hand-off ZIP), so the designer needn't open the proof to fetch
              them. Skipped for a revision order: its current version may be the
              new artwork still being changed, not the approved set. */}
          {!isRevision && (
            <ApprovedArtworkPanel
              proofId={order.proof_id}
              projectName={order.proofs?.contacts?.full_name ?? customerLabel(order)}
              customerName={order.proofs?.contacts?.companies?.name ?? '—'}
              materialDisplay={order.material_variants?.materials?.display_name ?? null}
              materialOptionId={order.material_option_id}
            />
          )}
            </>
          )}

          {/* Delivery details from checkout — shown only in the expanded
              "Prepare order" view, so the collapsed triage card stays compact.
              Carries the recipient name, address, email and phone that
              fulfilment and the courier paperwork need to hand the order off. */}
          {expanded && (addrLines.length > 0 ? (
            <>
              {/* Desktop: full address block. */}
              <div className="mt-3 hidden rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink-soft md:block">
                <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Deliver to</span>
                {addrLines.map((line, i) => (
                  <span key={i} className="block">{line}</span>
                ))}
                {order.ship_to_email && <span className="block text-ink-mute">{order.ship_to_email}</span>}
                {order.ship_to_phone && <span className="block text-ink-mute">{order.ship_to_phone}</span>}
                {order.customs_tax_id && <span className="block text-ink-mute">VAT/EORI: {order.customs_tax_id}</span>}
                {usTariff && (
                  <span className={`mt-1 block ${usTariff.optedOut ? 'font-medium text-low' : 'text-ink-mute'}`}>
                    US duties: {usTariff.choice} — {usTariff.action}.
                  </span>
                )}
              </div>
              {/* Mobile: a 48px disclosure with the postcode line as a peek so
                  the full address doesn't stretch the card. */}
              <details className="mt-3 rounded-lg border border-line bg-canvas px-3 text-[13px] text-ink-soft md:hidden">
                <summary className="flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Delivery details</span>
                  <span className="truncate text-ink-mute">{addrLines[addrLines.length - 1]}</span>
                </summary>
                <div className="pb-2">
                  {addrLines.map((line, i) => (
                    <span key={i} className="block">{line}</span>
                  ))}
                  {order.ship_to_email && <span className="block text-ink-mute">{order.ship_to_email}</span>}
                  {order.ship_to_phone && <span className="block text-ink-mute">{order.ship_to_phone}</span>}
                  {order.customs_tax_id && <span className="block text-ink-mute">VAT/EORI: {order.customs_tax_id}</span>}
                  {usTariff && (
                    <span className={`mt-1 block ${usTariff.optedOut ? 'font-medium text-low' : 'text-ink-mute'}`}>
                      US duties: {usTariff.choice} — {usTariff.action}.
                    </span>
                  )}
                </div>
              </details>
            </>
          ) : (
            <p className="mt-3 text-[13px] text-ink-mute">Delivery address on the Stripe payment / Xero invoice.</p>
          ))}
        </div>

        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          {/* One visible primary + the "⋯" menu. While prep is unfinished the
              primary is "Prepare order" (opens the form); once every gate is
              green it becomes the review-and-place action itself. That one
              wraps rather than holding a single line on a phone: buttons are
              whitespace-nowrap by default, so a long supplier name ("Review and
              order from QX Metals") refused to shrink and shoved the "⋯" menu
              off the screen on a narrower handset — taking Copy order link and
              Download invoice with it. min-h, not h, so two lines fit. */}
          <div className="flex items-center gap-2 max-md:w-full">
            {!canOrder && !expanded ? (
              <ButtonInk onClick={() => setExpanded(true)} className="max-md:h-[50px] max-md:flex-1 max-md:text-[15px]">
                Prepare order
              </ButtonInk>
            ) : (
              /* A hold disables placing, but deliberately NOT preparing: the
                 folder, date and colour can all be sorted out while the
                 question is with the customer, and canOrder is left alone so
                 the Details toggle below still renders. */
              <ButtonInk onClick={onReview} disabled={!canOrder || hold.held} className="max-md:min-h-[50px] max-md:min-w-0 max-md:flex-1 max-md:whitespace-normal max-md:py-1.5 max-md:text-[15px] max-md:leading-tight">
                {route !== 'supplier'
                  ? 'Review and push to production'
                  : supplierCount > 1
                    ? 'Review and choose supplier'
                    : supplierCount === 1
                      ? `Review and order from ${supplierLabels[0] ?? 'supplier'}`
                      : 'Review and order from supplier'}
              </ButtonInk>
            )}
            <CardActionsMenu
              items={[
                { label: 'View proof & artwork', to: `/proofs/${order.proof_id}` },
                { label: copied ? 'Link copied' : 'Copy order link', onClick: onCopy },
                ...(helpscoutUrl
                  ? [{
                      label: 'Open in Help Scout ↗',
                      href: helpscoutUrl,
                      title: 'Read the customer’s thread for this project',
                    } satisfies CardMenuItem]
                  : []),
                ...(order.xero_invoice_id
                  ? [{
                      label: pdfBusy ? 'Downloading…' : pdfError ? 'Download failed — try again' : 'Download invoice',
                      onClick: () => void handleDownloadInvoice(),
                      disabled: pdfBusy,
                      title: "Download this order's Xero invoice as a PDF",
                    } satisfies CardMenuItem]
                  : []),
                /* The hold lives here, never in the primary slot beside it: on
                   a phone that slot is a full-width thumb target, and putting
                   the action that REMOVES the protection there would make the
                   easiest tap on the card the one that unblocks production.
                   Last in the menu, so a held order reads top-to-bottom as
                   "go and read the thread, then take it off".

                   Offered on a REVISION order too. It was suppressed there at
                   first, on the reasoning that revision plus an unapproved
                   proof already blocks placement — but that has a hole: once
                   the customer approves the new version the order is placeable
                   again while STILL being 'revision', so a fresh question at
                   that point had no button. The database always honoured a
                   hold there (the trigger's block isn't scoped to paid); only
                   the UI declined to offer one. */
                ...(onHold && hold.held
                  ? [{
                      label: HOLD_COPY.take_off,
                      onClick: () => onHold('take_off'),
                      title: 'Only once the question has been settled — after this it can go to production',
                    } satisfies CardMenuItem]
                  : onHold
                    ? [{
                        label: HOLD_COPY.put,
                        onClick: () => onHold('put'),
                        title: 'Stops it being pushed into production from here while you wait on the customer',
                      } satisfies CardMenuItem]
                    : []),
              ]}
              label={`More actions for ${customerLabel(order)}`}
            />
          </div>
          {/* Why the place button is unavailable. The hold wins over the prep
              hints — it's the stronger statement and the only one that needs a
              decision from a person. Shown whenever the place button itself is
              on screen (the same `expanded || canOrder` test the ternary above
              uses), so nothing changes for an order that isn't held. */}
          {(expanded || canOrder) && (hold.held || !canOrder) && (
            <span className="text-right text-[11px] text-ink-mute max-md:text-center max-md:w-full md:max-w-[240px]">
              {hold.held
                ? holdBlockReason(hold)
                : !folderVerified
                  ? 'Link & check the order folder to enable'
                  : !datePersisted
                    ? (dateValue ? 'Confirm the date required to enable' : 'Set a date required to enable')
                    : 'Choose the stock colour to enable'}
            </span>
          )}
          {copied && <span className="text-[11px] text-in-stock md:text-right max-md:w-full max-md:text-center">Link copied</span>}
          {(expanded || canOrder) && (
            <ButtonGhost size="sm" onClick={() => setExpanded((v) => !v)} className="max-md:h-11 max-md:w-full">
              {expanded ? 'Hide details' : 'Details'}
            </ButtonGhost>
          )}
        </div>
      </div>
    </PanelShell>
  )
}

function AwaitingPaymentCard({
  order,
  thumb,
  expired,
  busy,
  copied,
  flash,
  nested = false,
  summary,
  cadence,
  group,
  selectable,
  selected,
  onToggleSelect,
  onRelease,
  onCopy,
  onReactivate,
  onSendLink,
  onEdit,
  onCancel,
  onRecordOffline,
}: {
  order: OrderRow
  thumb: ThumbInfo | null
  expired: boolean
  busy: boolean
  copied: boolean
  /** Briefly ring the card after a "Needs action" jump lands on it. */
  flash: boolean
  /** Rendered inside its combined-payment group block. The wrapper carries
   *  the group identity, expiry, opened status and reminders-pause note, so
   *  the card drops its own group pill, its dormant per-order link expiry,
   *  its opened line and the pause sentence — they'd repeat (or contradict)
   *  the header. */
  nested?: boolean
  summary: ReminderSummary | null
  cadence: ReminderCadence
  // The combined-payment group this order belongs to (bundle orders Slice 2),
  // when one exists in the loaded set. While it's active ('sent'), the
  // member's own link isn't payable, so the per-link actions swap for a
  // "Release" that returns the order to standalone.
  group: { id: string; status: string; payment_reference: string | null } | null
  // Combine-payments selection mode: whether this card can be ticked, and
  // whether it currently is.
  selectable: boolean
  selected: boolean
  onToggleSelect: () => void
  onRelease: () => void
  onCopy: () => void
  onReactivate: () => void
  onSendLink: () => void
  onEdit: () => void
  onCancel: () => void
  onRecordOffline: () => void
}) {
  const total = orderTotal(order)
  const inActiveGroup = group?.status === 'sent'

  // Rare actions live in the "⋯" menu so the card shows one visible action —
  // stacked full-width buttons for cancel/edit/offline were most of the card's
  // height on mobile, with the destructive Cancel a thumb-slip from Copy.
  const menuItems: CardMenuItem[] = inActiveGroup
    ? [{ label: 'Cancel order', onClick: onCancel, tone: 'danger', disabled: busy }]
    : [
        { label: 'Record offline payment', onClick: onRecordOffline, disabled: busy },
        ...((order.order_kind ?? 'production') === 'production'
          ? [{ label: 'Edit order', onClick: onEdit, disabled: busy } satisfies CardMenuItem]
          : []),
        { label: 'Cancel order', onClick: onCancel, tone: 'danger', disabled: busy },
      ]

  // Auto-chase progress for this order. "Next due" is computed the same way
  // the edge function decides: reminder (highestSent+1) is due once that many
  // intervals have passed since the link was sent, while it's still live.
  const sentCount = summary?.sentCount ?? 0
  const highestNo = summary?.highestSentNo ?? 0
  // Build the note here (not at fetch time): the friendly grace-pause line needs
  // the proof's reply stamps + grace-days, which live on the order + cadence. A
  // since-cleared grace pause comes back null → the next-due line shows instead.
  const note = classifyReminderOutcome(summary?.latestOutcome ?? null, {
    lastReplyAt: order.proofs?.helpscout_last_reply_at ?? null,
    lastCustomerReplyAt: order.proofs?.helpscout_last_customer_reply_at ?? null,
    graceDays: cadence.graceDays,
  })
  const allRemindersSent = highestNo >= cadence.max
  let nextDue: string | null = null
  if (!expired && !allRemindersSent && cadence.autoEnabled && order.sent_at) {
    const nextNo = highestNo + 1
    const dueAtMs = new Date(order.sent_at).getTime() + nextNo * cadence.intervalDays * DAY_MS
    const expMs = order.expires_at ? new Date(order.expires_at).getTime() : null
    if (expMs != null && dueAtMs >= expMs) {
      nextDue = null // would fall after the link expires — the chase won't fire
    } else if (dueAtMs <= Date.now()) {
      nextDue = 'due on the next working-day run'
    } else {
      nextDue = `due ${formatDate(new Date(dueAtMs).toISOString())}`
    }
  }

  return (
    <PanelShell className={`transition-shadow duration-500 ${flash ? 'ring-2 ring-[var(--c-brand)]' : ''}`}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        {selectable && (
          <label className="flex shrink-0 items-start pt-1">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              aria-label={`Include ${customerLabel(order)} in the combined payment`}
              className="h-5 w-5 rounded border-line accent-[var(--c-brand)]"
            />
          </label>
        )}
        {thumb && (
          <img
            src={thumb.thumb_url}
            alt="Proof artwork"
            className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-line"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proofs/${order.proof_id}`} className="text-base font-semibold text-ink hover:underline">
              {customerLabel(order)}
            </Link>
            {inActiveGroup ? (
              nested ? null : (
                <Pill colour="brand" title="Part of a combined payment — the customer pays every order in it with one link.">
                  Combined payment{group?.payment_reference ? ` · ${group.payment_reference}` : ''}
                </Pill>
              )
            ) : expired ? <Pill colour="out">Expired</Pill> : <Pill colour="low">Awaiting payment</Pill>}
            {order.help_requested_at && (
              <Pill colour="brand" title={`Asked from the pay page ${relativeTime(order.help_requested_at)} — reply on the Help Scout thread.`}>
                Asked for help
              </Pill>
            )}
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">
            {specLabel(order)}
            {order.thickness_open && order.material_variant_id == null ? ' · customer picks thickness' : ''}
            {order.finish_open && order.material_option_id == null ? ' · customer picks finish' : ''}
            {' · '}
            {order.quantity != null ? `${order.quantity.toLocaleString()} cards` : 'Customer picks quantity'}
            {total != null ? ` · ${formatPrice(total, order.currency)}` : ''}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            Ref {order.payment_reference}
            {order.sent_at ? ` · sent ${formatDate(order.sent_at)}` : ''}
            {/* A nested member's own link is dormant (the group's link is the
                payable one), so its expiry would only contradict the group's. */}
            {order.expires_at && !nested ? ` · ${expired ? 'expired' : 'expires'} ${formatDate(order.expires_at)}` : ''}
          </p>
          {!nested && (
            <p className="mt-0.5 text-[13px] text-ink-mute">
              {order.pay_link_opened_at
                ? <span title={formatAbsoluteDateTime(order.pay_link_opened_at)}>Pay link opened {relativeTime(order.pay_link_opened_at)}</span>
                : 'Pay link not opened yet'}
            </p>
          )}
          {/* Auto-chase progress: how many reminders have gone, what's next,
              and any problem stopping the chase. A grouped member is skipped
              by the reminder sender (its own link isn't payable): nested cards
              say nothing (the group header carries the pause note once);
              a stray non-nested grouped card keeps the one-line explanation. */}
          <div className="mt-1 space-y-0.5 text-[13px]">
            {inActiveGroup ? (
              nested ? null : (
                <span className="block text-ink-mute">
                  Paid through the combined payment link — automatic reminders pause while it&rsquo;s grouped.
                </span>
              )
            ) : (
              <>
                {sentCount > 0 && (
                  <span className="block text-ink-soft">
                    {sentCount} of {cadence.max} reminder{cadence.max === 1 ? '' : 's'} sent
                    {summary?.lastSentAt ? ` · last ${formatDate(summary.lastSentAt)}` : ''}
                  </span>
                )}
                {note ? (
                  <span className={`block ${note.kind === 'problem' ? 'text-out' : 'text-ink-mute'}`}>
                    {note.kind === 'problem' ? '⚠ ' : ''}{note.text}
                  </span>
                ) : allRemindersSent ? (
                  <span className="block text-ink-mute">All {cadence.max} reminders sent — no more scheduled.</span>
                ) : nextDue ? (
                  <span className="block text-ink-mute">Next reminder {nextDue}.</span>
                ) : !cadence.autoEnabled && sentCount === 0 ? (
                  <span className="block text-ink-mute">Automatic reminders are off.</span>
                ) : null}
              </>
            )}
          </div>
        </div>
        {/* One visible action + the "⋯" menu, in a single row: Release for a
            grouped member (its own link isn't payable — the group's is);
            Reactivate + Copy for an expired link; Copy otherwise. */}
        <div className="flex shrink-0 items-center gap-2 max-md:w-full md:self-start">
          {inActiveGroup ? (
            <ButtonGhost size="sm" onClick={onRelease} disabled={busy} className="max-md:h-11 max-md:flex-1">
              {busy ? 'Releasing…' : 'Release from combined payment'}
            </ButtonGhost>
          ) : (
            <>
              {expired ? (
                <ButtonInk size="sm" onClick={onReactivate} disabled={busy} className="max-md:h-11 max-md:flex-1">
                  {busy ? 'Reactivating…' : 'Reactivate link'}
                </ButtonInk>
              ) : (
                // The Orders page had no way to send anything: reactivating a
                // link told the customer nothing, and the only route was copy
                // → open Help Scout → find the thread → paste. A reactivated
                // link has also spent its reminders, so nothing would chase
                // it either.
                <ButtonInk size="sm" onClick={onSendLink} disabled={busy || !order.token} className="max-md:h-11 max-md:flex-1">
                  Re-send link
                </ButtonInk>
              )}
              <ButtonGhost size="sm" onClick={onCopy} className="max-md:h-11">
                {copied ? 'Copied' : 'Copy link'}
              </ButtonGhost>
            </>
          )}
          <CardActionsMenu items={menuItems} label={`More actions for ${customerLabel(order)}`} />
        </div>
      </div>
    </PanelShell>
  )
}

// One row in the "Links to send" worklist: an approved proof with no order link
// sent yet. Mirrors the dashboard row (customer, designer, material, approved-
// when) and adds the actions a designer needs here — create the order link
// inline, open the Help Scout thread, or view the proof. The "Overdue" flag
// marks proofs waiting beyond the working-day threshold.
function LinkToSendCard({
  item,
  thumb,
  preparing,
  canCreateOrder,
  onCreate,
  note,
  canEditNote,
  onSaveNote,
  onClearNote,
}: {
  item: ApprovedNoOrderItem
  thumb: ThumbInfo | null
  preparing: boolean
  canCreateOrder: boolean
  onCreate: () => void
  note: LinkNote | null
  canEditNote: boolean
  onSaveNote: (text: string) => Promise<boolean>
  onClearNote: () => Promise<boolean>
}) {
  // Sub-line: the contact (only when a company is the headline, else it'd repeat
  // the title) plus their email.
  const sub = [item.companyName ? item.contactName : null, item.contactEmail].filter(Boolean).join(' · ')
  const approvedAgo = item.businessDays <= 0 ? 'approved today' : `approved ${formatDate(item.approvedAt)}`
  const designerTooltip = item.designerName
    ? (item.versionNumber != null && item.versionCreatedAt
        ? `${item.designerName} — v${item.versionNumber} created ${formatAbsoluteDateTime(item.versionCreatedAt)}`
        : item.designerName)
    : undefined
  return (
    <PanelShell>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        {thumb && (
          <img
            src={thumb.thumb_url}
            alt="Proof artwork"
            className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-line"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proofs/${item.proofId}`} className="text-base font-semibold text-ink hover:underline">
              {item.label}
            </Link>
            <Pill colour="in-stock">Approved</Pill>
            {item.overdue && (
              <Pill colour="low" title={`No order link ${item.businessDays} working days after approval`}>
                Overdue · {item.businessDays} working days
              </Pill>
            )}
            {item.customerRepliedAt && (
              <Pill colour="allocated" title={formatAbsoluteDateTime(item.customerRepliedAt)}>
                Customer replied {relativeTime(item.customerRepliedAt)}
              </Pill>
            )}
          </div>
          {sub && <p className="mt-0.5 text-sm text-ink-soft">{sub}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-mute">
            {item.materialDisplay && <span>{item.materialDisplay}</span>}
            {item.versionNumber != null && <span>v{item.versionNumber}</span>}
            <span>{approvedAgo}</span>
            {item.designerName && (
              <span className="inline-flex items-center gap-1.5">
                <DesignerAvatar
                  initials={item.designerInitials}
                  colour={item.designerColour}
                  avatarUrl={item.designerAvatarUrl}
                  tooltip={designerTooltip}
                />
                {item.designerName}
              </span>
            )}
          </div>
        </div>
        {/* One visible action (create the link) + the "⋯" menu for the
            rest. When ordering is switched off, View proof stands in as the
            visible action so the card isn't left with only a menu. */}
        <div className="flex shrink-0 items-center gap-2 max-md:w-full md:self-start">
          {canCreateOrder ? (
            <ButtonInk onClick={onCreate} busy={preparing} className="max-md:h-[50px] max-md:flex-1 max-md:text-[15px]">
              Create order link
            </ButtonInk>
          ) : (
            <Link to={`/proofs/${item.proofId}`} className="max-md:flex-1">
              <ButtonGhost size="sm" className="w-full max-md:h-11">View proof</ButtonGhost>
            </Link>
          )}
          <CardActionsMenu
            items={[
              ...(item.helpscoutUrl ? [{ label: 'Open in Help Scout ↗', href: item.helpscoutUrl } satisfies CardMenuItem] : []),
              { label: 'View proof', to: `/proofs/${item.proofId}` },
            ]}
            label={`More actions for ${item.label}`}
          />
        </div>
      </div>
      <LinkNoteSection note={note} canEdit={canEditNote} onSave={onSaveNote} onClear={onClearNote} />
    </PanelShell>
  )
}

// The shared "why is this still here" note on a Links-to-send card. Three states:
// an empty "Add a note" prompt, the note shown as a small amber callout (with who
// wrote it + when), and an edit mode with a textarea. Editing is collaborative —
// anyone signed in can add, change, or clear the note; saving stamps them as the
// author server-side. Local state only; the parent owns the persisted note.
function LinkNoteSection({
  note,
  canEdit,
  onSave,
  onClear,
}: {
  note: LinkNote | null
  canEdit: boolean
  onSave: (text: string) => Promise<boolean>
  onClear: () => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function startEdit() {
    setDraft(note?.note ?? '')
    setErr(null)
    setEditing(true)
  }

  async function handleSave() {
    if (draft.trim().length === 0) {
      // An empty save on an existing note means "clear it"; on no note it's a no-op.
      if (note) await handleClear()
      else setEditing(false)
      return
    }
    setBusy(true)
    setErr(null)
    const ok = await onSave(draft)
    setBusy(false)
    if (ok) setEditing(false)
    else setErr('Could not save the note. Please try again.')
  }

  async function handleClear() {
    setBusy(true)
    setErr(null)
    const ok = await onClear()
    setBusy(false)
    if (ok) setEditing(false)
    else setErr('Could not remove the note. Please try again.')
  }

  if (editing) {
    return (
      <div className="mt-3 border-t border-line pt-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          maxLength={500}
          autoFocus
          placeholder="Why is this still here? e.g. waiting on metal thickness — chased today"
          aria-label="Note for this project"
        />
        <p className="mt-1 text-[12px] text-ink-mute">
          Shared with the team · cleared automatically once the order link is sent.
        </p>
        {err && <p className="mt-1 text-[13px] text-out">{err}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ButtonInk size="sm" onClick={() => void handleSave()} busy={busy}>Save note</ButtonInk>
          <ButtonGhost size="sm" onClick={() => { setEditing(false); setErr(null) }} disabled={busy}>Cancel</ButtonGhost>
          {note && (
            <ButtonGhost size="sm" onClick={() => void handleClear()} disabled={busy} className="text-out">Remove note</ButtonGhost>
          )}
        </div>
      </div>
    )
  }

  if (note) {
    const meta = [note.byName, relativeTime(note.updatedAt)].filter(Boolean).join(' · ')
    return (
      <div className="mt-3 rounded-lg border border-line border-l-4 border-l-[var(--c-low)] bg-[var(--c-low-soft)] px-3 py-2">
        <div className="flex items-start gap-2">
          <StickyNote size={15} className="mt-0.5 shrink-0 text-[var(--c-low)]" aria-hidden="true" />
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-ink">{note.note}</p>
          {canEdit && <ButtonGhost size="sm" onClick={startEdit} className="shrink-0">Edit</ButtonGhost>}
        </div>
        {/* Author + time on its own line, indented to sit under the note text
            (icon 15px + gap 8px) so the Edit button stays cleanly top-right. */}
        {meta && <p className="mt-1 pl-[23px] text-[12px] text-ink-mute">{meta}</p>}
      </div>
    )
  }

  if (!canEdit) return null
  return (
    <div className="mt-3">
      <ButtonGhost size="sm" onClick={startEdit}>
        <span className="inline-flex items-center gap-1.5">
          <StickyNote size={14} aria-hidden="true" /> Add a note
        </span>
      </ButtonGhost>
    </div>
  )
}
